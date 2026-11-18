/**
 * intent.ts - authenticated payment intents, signed with the owner's
 * ML-DSA-87 key (QoreSign).
 *
 * Before the agent executes a leashed payment, the owner signs a payment
 * intent: a small JSON message naming the contract, the schedule, the
 * payment number, the payee, and the exact amount. The signature is a
 * real ML-DSA-87 (Dilithium-5) signature over the intent's canonical
 * bytes, made with the owner's ML-DSA-87 key — the same key derived from
 * the owner's mnemonic that the chain already has registered
 * (`scripts/window.ts register`). The agent verifies, before executing:
 *
 *   1. the signature is valid under the owner's PQC public key AS
 *      REGISTERED ON CHAIN (fetched from REST, not trusted from the
 *      file), so a forged intent file cannot pass with a swapped key;
 *   2. the intent names this contract, this schedule, the schedule's
 *      current payee and amount, and the NEXT payment number
 *      (payments + 1), so an intent cannot be replayed for a later
 *      payment or retargeted at another payee or amount.
 *
 * HONEST SCOPE. This layer is verified OFF-CHAIN by the runner, before
 * it relays a payment. It is NOT enforced by the contract: the contract
 * has no pqcVerify precompile call and cannot check ML-DSA signatures,
 * so a runner that skips verification could still pay (within the
 * contract's own caps and the leash's spending rule). What the layer
 * does is bind each leashed payment to a post-quantum-signed owner
 * authorisation that anyone can re-verify from the intent file plus the
 * owner's on-chain registered key — the intent file is the audit trail.
 * The leash runner (`scripts/leash.ts pay`) verifies a signed intent
 * whenever one exists for the next payment, refuses to relay on any
 * mismatch, and with `--require-intent` refuses to relay without one.
 *
 * Usage (testnet only, from the repo directory):
 *   npx tsx scripts/intent.ts sign <scheduleId>
 *       sign the intent for the schedule's NEXT payment and write it to
 *       deployments/intents/intent-<id>-<n>.json (refuses unless the
 *       schedule is due and the derived ML-DSA key matches the key the
 *       chain has registered for the owner)
 *   npx tsx scripts/intent.ts verify <file>
 *       verify a signed intent file against the owner's on-chain
 *       registered PQC key and the schedule's live on-chain state
 *
 * Secrets are read into memory only to sign; nothing here prints a
 * mnemonic, a private key, or an ML-DSA secret key. The signed intent
 * file contains only public data (the owner's ML-DSA public key, which
 * is already registered on-chain, and the signature) and is safe to
 * commit.
 */
import {
  deriveUnifiedAccount,
  fetchPqcStatus,
  isRegisteredPqcKey,
  pqcSign,
  pqcStatusPublicKey,
  pqcVerify,
  type PqcKeypair,
  type UnifiedAccount,
} from "@qorechain/sdk";
import { createEvmClient, readContract } from "@qorechain/evm";
import { type Address } from "viem";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { billPayGuardAbi } from "../contracts/BillPayGuard.artifact.js";

/** QoreChain testnet (qorechain-diana). Nothing else is allowed. */
const CHAIN_ID = "qorechain-diana";
const TESTNET_CHAIN_ID = 9800;
const REST = "https://api-testnet.qore.host";
const EVM_RPC = "https://evm-testnet.qore.host";

/** The owner (deployer), as recorded in deployments/demo.json. */
const EXPECTED_OWNER_EVM = "0x326697b1a1EAd2E0FCa024754Fd5530D7e5cBDee";

/** Domain separator: an intent signed for BillPay Guard is not valid anywhere else. */
const INTENT_KIND = "billpay-payment";
const INTENT_VERSION = 1;

/** A payment intent: everything the owner authorises, nothing more. */
export interface PaymentIntent {
  version: number;
  kind: string;
  chainId: string;
  contract: string;
  scheduleId: number;
  /** The payment count AFTER this payment: the schedule's payments + 1. */
  paymentNumber: number;
  payee: string;
  /** Exact amount in wei, decimal string. */
  amountWei: string;
  /** The schedule's on-chain expiry; the intent dies with the schedule. */
  expiryUnix: number;
}

/** A signed intent, as stored in deployments/intents/*.json. */
export interface SignedIntent {
  intent: PaymentIntent;
  signer: { evm: string; cosmos: string };
  /** The owner's ML-DSA-87 public key, base64 (2592 bytes). Public data. */
  publicKeyBase64: string;
  /** The ML-DSA-87 signature over the intent's canonical bytes, base64 (4627 bytes). */
  signatureBase64: string;
  signedAt: string;
}

/** The live on-chain schedule state an intent is checked against. */
export interface ScheduleView {
  payee: Address;
  amountPerPayment: bigint;
  payments: bigint;
  expiry: bigint;
}

function repoFile(...parts: string[]): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", ...parts);
}

/** Minimal .env reader (KEY=value lines, comments and quotes handled). */
function readEnvFile(name: string): Record<string, string> {
  const file = repoFile(name);
  if (!fs.existsSync(file)) throw new Error(`Missing ${name}: run the setup steps in the README first.`);
  const out: Record<string, string> = {};
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 0) continue;
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[trimmed.slice(0, eq).trim()] = value;
  }
  return out;
}

function contractAddress(): Address {
  const fromEnv = (process.env.BILLPAY_GUARD_ADDRESS ?? "").trim();
  if (fromEnv) return fromEnv as Address;
  const file = repoFile("deployments/testnet.json");
  if (!fs.existsSync(file)) throw new Error("No contract address: set BILLPAY_GUARD_ADDRESS or run `npm run deploy` first.");
  const deployment = JSON.parse(fs.readFileSync(file, "utf8")) as { contract?: string };
  if (!deployment.contract) throw new Error("deployments/testnet.json has no contract address.");
  return deployment.contract as Address;
}

async function ownerAccount(): Promise<UnifiedAccount> {
  const env = readEnvFile(".env");
  if (env.QORE_NETWORK && env.QORE_NETWORK !== "testnet") {
    throw new Error(`Refusing to run: .env says QORE_NETWORK=${env.QORE_NETWORK}; this script is testnet-only.`);
  }
  const mnemonic = env.QORE_MNEMONIC?.trim();
  if (!mnemonic) throw new Error("Set QORE_MNEMONIC in .env (the owner/deployer mnemonic).");
  const acc = await deriveUnifiedAccount(mnemonic, 0);
  if (acc.evm.toLowerCase() !== EXPECTED_OWNER_EVM.toLowerCase()) {
    throw new Error(`The .env mnemonic derives ${acc.evm}, not the expected owner ${EXPECTED_OWNER_EVM}. Refusing to continue.`);
  }
  return acc;
}

/**
 * The canonical bytes of an intent: JSON with the fields in a fixed
 * order. Signers and verifiers both build the bytes this way, so the
 * signature commits to exactly these fields — reordering or re-encoding
 * the file cannot change what was signed.
 */
export function canonicalIntentBytes(intent: PaymentIntent): Uint8Array {
  const canonical = {
    version: intent.version,
    kind: intent.kind,
    chainId: intent.chainId,
    contract: intent.contract.toLowerCase(),
    scheduleId: intent.scheduleId,
    paymentNumber: intent.paymentNumber,
    payee: intent.payee.toLowerCase(),
    amountWei: intent.amountWei,
    expiryUnix: intent.expiryUnix,
  };
  return new TextEncoder().encode(JSON.stringify(canonical));
}

function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

function fromBase64(value: string): Uint8Array | null {
  try {
    const bytes = Buffer.from(value, "base64");
    // Reject non-canonical base64 (Buffer silently drops bad characters).
    if (bytes.toString("base64") !== value.replace(/\s+/g, "")) return null;
    return new Uint8Array(bytes);
  } catch {
    return null;
  }
}

/**
 * Sign an intent with an ML-DSA-87 keypair (deterministic FIPS-204
 * signing, so the same intent always yields the same signature).
 */
export function signIntent(
  keypair: PqcKeypair,
  intent: PaymentIntent,
  signer: { evm: string; cosmos: string },
): SignedIntent {
  const signature = pqcSign(keypair.secretKey, canonicalIntentBytes(intent));
  return {
    intent,
    signer,
    publicKeyBase64: toBase64(keypair.publicKey),
    signatureBase64: toBase64(signature),
    signedAt: new Date().toISOString(),
  };
}

/**
 * Verify a signed intent's signature. When `publicKey` is given it is
 * used (callers pass the owner's ON-CHAIN registered key); otherwise the
 * key embedded in the file is used — which proves the signature matches
 * the file's key, but NOT that the key is the owner's. Returns false for
 * any malformed input, exactly as for a bad signature.
 */
export function verifyIntentSignature(signed: SignedIntent, publicKey?: Uint8Array): boolean {
  const key = publicKey ?? fromBase64(signed.publicKeyBase64);
  const signature = fromBase64(signed.signatureBase64);
  if (!key || !signature) return false;
  return pqcVerify(key, canonicalIntentBytes(signed.intent), signature);
}

/**
 * Check an intent against the schedule's live on-chain state. Returns a
 * list of mismatches (empty = the intent matches the schedule exactly).
 * The paymentNumber check is the anti-replay rule: an intent authorises
 * exactly one payment, the schedule's next one.
 */
export function checkIntentAgainstSchedule(
  intent: PaymentIntent,
  contract: Address,
  schedule: ScheduleView,
): string[] {
  const problems: string[] = [];
  if (intent.version !== INTENT_VERSION) problems.push(`version ${intent.version} is not ${INTENT_VERSION}`);
  if (intent.kind !== INTENT_KIND) problems.push(`kind "${intent.kind}" is not "${INTENT_KIND}"`);
  if (intent.chainId !== CHAIN_ID) problems.push(`chainId "${intent.chainId}" is not "${CHAIN_ID}"`);
  if (intent.contract.toLowerCase() !== contract.toLowerCase()) {
    problems.push(`contract ${intent.contract} is not the guard contract ${contract}`);
  }
  if (intent.payee.toLowerCase() !== schedule.payee.toLowerCase()) {
    problems.push(`payee ${intent.payee} is not the schedule's payee ${schedule.payee}`);
  }
  if (BigInt(intent.amountWei) !== schedule.amountPerPayment) {
    problems.push(`amount ${intent.amountWei} wei is not the schedule's ${schedule.amountPerPayment} wei per payment`);
  }
  if (BigInt(intent.paymentNumber) !== schedule.payments + 1n) {
    problems.push(
      `paymentNumber ${intent.paymentNumber} is not the schedule's next payment (${schedule.payments + 1n}) — ` +
        `an intent authorises exactly one payment and cannot be replayed`,
    );
  }
  if (BigInt(intent.expiryUnix) !== schedule.expiry) {
    problems.push(`expiry ${intent.expiryUnix} is not the schedule's expiry ${schedule.expiry}`);
  }
  return problems;
}

/** The owner's ML-DSA-87 public key as registered on chain (REST). */
export async function fetchRegisteredPqcPublicKey(rest: string, ownerCosmos: string): Promise<Uint8Array> {
  const status = await fetchPqcStatus({ rest, address: ownerCosmos });
  const key = pqcStatusPublicKey(status);
  if (!key) throw new Error(`The owner ${ownerCosmos} has no readable ML-DSA-87 key registered on chain.`);
  return key;
}

/**
 * Full verification of a signed intent: the embedded public key must be
 * the owner's ON-CHAIN registered key, the signature must verify under
 * that key, and the intent must match the schedule's live state.
 * Returns the list of problems (empty = verified).
 */
export async function verifySignedIntent(
  signed: SignedIntent,
  opts: { rest: string; ownerCosmos: string; contract: Address; schedule: ScheduleView },
): Promise<string[]> {
  const problems: string[] = [];
  let registered: Uint8Array;
  try {
    registered = await fetchRegisteredPqcPublicKey(opts.rest, opts.ownerCosmos);
  } catch (err) {
    return [`could not fetch the owner's registered PQC key: ${err instanceof Error ? err.message : err}`];
  }
  const embedded = fromBase64(signed.publicKeyBase64);
  if (!embedded) {
    problems.push("the intent file's publicKeyBase64 does not decode");
  } else if (embedded.length !== registered.length || !embedded.every((b, i) => b === registered[i])) {
    problems.push("the intent file's public key is NOT the owner's on-chain registered ML-DSA-87 key");
  }
  if (!verifyIntentSignature(signed, registered)) {
    problems.push("the ML-DSA-87 signature does not verify under the owner's registered key");
  }
  problems.push(...checkIntentAgainstSchedule(signed.intent, opts.contract, opts.schedule));
  return problems;
}

export function intentFileName(scheduleId: number | bigint, paymentNumber: number | bigint): string {
  return `intent-${scheduleId}-${paymentNumber}.json`;
}

export function intentFilePath(scheduleId: number | bigint, paymentNumber: number | bigint): string {
  return repoFile("deployments", "intents", intentFileName(scheduleId, paymentNumber));
}

export function loadSignedIntent(file: string): SignedIntent {
  const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as SignedIntent;
  if (!parsed || typeof parsed !== "object" || !parsed.intent || typeof parsed.signatureBase64 !== "string") {
    throw new Error(`${file} is not a signed intent file.`);
  }
  return parsed;
}

async function readSchedule(contract: Address, scheduleId: bigint): Promise<ScheduleView & { due: boolean; reason: string }> {
  const client = await createEvmClient({ endpoints: { evmRpc: EVM_RPC } });
  const chainId = await client.getChainId();
  if (chainId !== TESTNET_CHAIN_ID) throw new Error(`Refusing to run: EVM chain id is ${chainId}, expected testnet ${TESTNET_CHAIN_ID}.`);
  const [due, reason] = (await readContract(client.publicClient, {
    address: contract, abi: billPayGuardAbi, functionName: "checkDue", args: [scheduleId],
  })) as [boolean, string];
  const s = (await readContract(client.publicClient, {
    address: contract, abi: billPayGuardAbi, functionName: "getSchedule", args: [scheduleId],
  })) as unknown as ScheduleView;
  return { ...s, due, reason };
}

async function sign(scheduleIdArg: string | undefined): Promise<void> {
  const scheduleId = BigInt(scheduleIdArg ?? "");
  if (scheduleId < 0n) throw new Error("scheduleId must be a non-negative integer.");
  const owner = await ownerAccount();
  const contract = contractAddress();

  // The agent verifies against the key the CHAIN has registered, so refuse
  // to sign with any other key — otherwise the intent could never verify.
  const status = await fetchPqcStatus({ rest: REST, address: owner.cosmos });
  if (isRegisteredPqcKey(status, owner.pqc.publicKey) !== true) {
    throw new Error(
      "The derived ML-DSA-87 key is not the key registered on chain for the owner. " +
        "Sign with the keypair that registered the account, or rotate the key first.",
    );
  }

  const schedule = await readSchedule(contract, scheduleId);
  if (!schedule.due) {
    throw new Error(`Schedule ${scheduleId} is not due (${schedule.reason}) — signing an intent for a payment the contract would refuse.`);
  }
  const paymentNumber = Number(schedule.payments + 1n);
  const intent: PaymentIntent = {
    version: INTENT_VERSION,
    kind: INTENT_KIND,
    chainId: CHAIN_ID,
    contract: contract.toLowerCase(),
    scheduleId: Number(scheduleId),
    paymentNumber,
    payee: schedule.payee.toLowerCase(),
    amountWei: schedule.amountPerPayment.toString(),
    expiryUnix: Number(schedule.expiry),
  };
  const signed = signIntent(owner.pqc, intent, { evm: owner.evm, cosmos: owner.cosmos });

  // Self-check before writing: the file must verify under the registered key.
  const problems = await verifySignedIntent(signed, { rest: REST, ownerCosmos: owner.cosmos, contract, schedule });
  if (problems.length > 0) {
    throw new Error(`The freshly signed intent does not verify (this should not happen): ${problems.join("; ")}`);
  }

  const file = intentFilePath(scheduleId, paymentNumber);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(signed, null, 2)}\n`);
  console.log(`signed intent for schedule ${scheduleId} payment #${paymentNumber} (${schedule.amountPerPayment} wei to ${schedule.payee})`);
  console.log(`wrote ${path.relative(process.cwd(), file)}`);
  console.log("INTENT SIGNED.");
}

async function verify(fileArg: string | undefined): Promise<void> {
  if (!fileArg) throw new Error("Usage: npx tsx scripts/intent.ts verify <file>");
  const file = path.resolve(fileArg);
  const signed = loadSignedIntent(file);
  const contract = contractAddress();
  const ownerCosmos = signed.signer.cosmos;
  const schedule = await readSchedule(contract, BigInt(signed.intent.scheduleId));
  const problems = await verifySignedIntent(signed, { rest: REST, ownerCosmos, contract, schedule });
  console.log(`intent: schedule ${signed.intent.scheduleId} payment #${signed.intent.paymentNumber}, ${signed.intent.amountWei} wei to ${signed.intent.payee}`);
  console.log(`signer: ${signed.signer.evm} (${signed.signer.cosmos}), signed ${signed.signedAt}`);
  console.log(`schedule now: ${schedule.payments} payments, ${schedule.due ? "due" : `not due (${schedule.reason})`}`);
  if (problems.length > 0) {
    console.log("VERIFICATION FAILED:");
    for (const p of problems) console.log(`  - ${p}`);
    process.exitCode = 1;
    return;
  }
  console.log("VERIFIED: ML-DSA-87 signature valid under the owner's on-chain registered key; intent matches the live schedule.");
}

const commands: Record<string, (arg?: string) => Promise<void>> = { sign, verify };

const isMain =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  const cmd = process.argv[2] ?? "";
  const run = commands[cmd];
  if (!run) {
    console.error(`Unknown command "${cmd}". Use: sign <scheduleId> | verify <file>`);
    process.exit(1);
  }
  run(process.argv[3]).catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  });
}
