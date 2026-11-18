/**
 * leash.ts - the abstract-account "leash" for the BillPay Guard agent.
 *
 * The guard contract already limits what the agent may do (per-payment and
 * total caps, allowed payee, expiry), but the agent still pays from its own
 * key inside its own EVM window. This script adds a second, chain-enforced
 * layer on top, using QoreChain's abstract-account module:
 *
 *   1. the owner (deployer) gets an abstract account
 *      (MsgCreateAbstractAccount, accountType "session_based");
 *   2. the agent key is linked to that account as an authenticator with the
 *      `evm` permission only, bound by a spending rule that mirrors
 *      schedule 1: at most 0.05 QOR per execution, 0.50 QOR per day, and
 *      only the `executePayment(uint256)` function of the guard contract;
 *   3. the agent signs a payment as a meta-transaction
 *      (MsgExecuteEVM, EIP-191 personal_sign) and the owner relays it,
 *      paying the fee. The chain checks the rule before the call runs, and
 *      the EVM call executes FROM the owner's address, so the contract sees
 *      msg.sender == owner. No EVM window is needed on either account for
 *      the leashed path.
 *
 * The leashed path is an ADDITION, not a replacement: the agent's normal
 * EOA path (agent.ts, drill-pay.ts) keeps working independently, and the
 * drill-day payment still uses it.
 *
 * Usage (testnet only, from the repo directory; no --env-file needed — the
 * script reads .env for the owner mnemonic and .env.agent for the agent
 * key itself, because the two files define the same variable names):
 *   npx tsx scripts/leash.ts status   show the abstract account, rules,
 *                                     authenticators and schedule 1 state
 *   npx tsx scripts/leash.ts setup    create the abstract account (once)
 *                                     and link the agent key with its rule
 *   npx tsx scripts/leash.ts pay      pay schedule 1 once through the leash
 *                                     (verifies a signed payment intent when
 *                                     one exists; --require-intent refuses
 *                                     to relay without one — see intent.ts)
 *   npx tsx scripts/leash.ts reject   prove the rule bites: send ONE
 *                                     agent-signed execution the rule
 *                                     forbids (withdraw, outside the
 *                                     allowlist) and record the chain's
 *                                     refusal in deployments/leash-rejection.json
 *
 * Secrets are read into memory only to sign; nothing in this script prints
 * a mnemonic or a private key.
 */
import { StargateClient } from "@cosmjs/stargate";
import type { EncodeObject } from "@cosmjs/proto-signing";
import {
  EthNativeSigner,
  buildMetaMaskExecuteEvm,
  deriveUnifiedAccount,
  fetchAuthNonce,
  fetchAuthenticators,
  fetchSpendingRules,
  linkAuthenticatorMsgs,
  msg,
  resolveEvmAuthDigestVersion,
  signAuthenticatorLinkEip191,
  verifyAuthenticatorLinkProof,
  type UnifiedAccount,
} from "@qorechain/sdk";
import { createEvmClient, readContract } from "@qorechain/evm";
import { encodeFunctionData, hexToBytes, toFunctionSelector, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { billPayGuardAbi } from "../contracts/BillPayGuard.artifact.js";
import { intentFilePath, loadSignedIntent, verifySignedIntent } from "./intent.js";

/** QoreChain testnet (qorechain-diana). Nothing else is allowed. */
const CHAIN_ID = "qorechain-diana";
const TESTNET_CHAIN_ID = 9800;
const REST = "https://api-testnet.qore.host";
const RPC = "https://rpc-testnet.qore.host";
const EVM_RPC = "https://evm-testnet.qore.host";

/** The owner (deployer) and the agent, as recorded in deployments/demo.json. */
const EXPECTED_OWNER_EVM = "0x326697b1a1EAd2E0FCa024754Fd5530D7e5cBDee";
const EXPECTED_AGENT_EVM = "0x5dA52428DE0b9928105175CF00C6435B21AB4779";

/** The schedule the leash pays. Schedule 0 is cap-reached; never touch it. */
const SCHEDULE_ID = 1n;

/**
 * The spending rule, mirroring schedule 1's caps: 0.05 QOR per payment,
 * 0.50 QOR total cap as the daily bound, only executePayment on the guard
 * contract. The authenticator expiry matches schedule 1's on-chain expiry
 * (1797362871 = 15 Dec 2026 19:27:51 UTC, from deployments/demo.json).
 */
const RULE_ID = "billpay-agent";
const RULE_PER_TX_UQOR = "50000";
const RULE_DAILY_UQOR = "500000";
const AUTH_EXPIRY_UNIX = 1797362871;
const AUTH_LABEL = "BillPay Guard agent";

/** EVM gas the leashed call may use (executePayment costs well under this). */
const EXEC_GAS_LIMIT = 200_000;

/** Native-lane fees: hybrid transactions are large, so the gas limit is generous. */
const FEE_STANDARD = { amount: [{ denom: "uqor", amount: "100000" }], gas: "800000" };
const FEE_EXECUTE = { amount: [{ denom: "uqor", amount: "150000" }], gas: "1200000" };

function repoFile(name: string): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", name);
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

function agentKey(): { privateKey: Hex; address: Address } {
  const env = readEnvFile(".env.agent");
  if (env.QORE_NETWORK && env.QORE_NETWORK !== "testnet") {
    throw new Error(`Refusing to run: .env.agent says QORE_NETWORK=${env.QORE_NETWORK}; this script is testnet-only.`);
  }
  const key = env.QORE_EVM_PRIVATE_KEY?.trim();
  if (!key || !/^0x[0-9a-fA-F]{64}$/.test(key)) {
    throw new Error("Set QORE_EVM_PRIVATE_KEY in .env.agent (the agent key).");
  }
  const address = privateKeyToAccount(key as Hex).address;
  if (address.toLowerCase() !== EXPECTED_AGENT_EVM.toLowerCase()) {
    throw new Error(`The .env.agent key derives ${address}, not the expected agent ${EXPECTED_AGENT_EVM}. Refusing to continue.`);
  }
  return { privateKey: key as Hex, address };
}

/** account_number and sequence over REST; zero for an account never seen. */
async function accountSequence(address: string): Promise<{ accountNumber: bigint; sequence: bigint }> {
  const res = await fetch(`${REST}/cosmos/auth/v1beta1/accounts/${address}`);
  if (res.status === 404) throw new Error(`${address} does not exist on chain yet: send it some QOR first`);
  if (!res.ok) throw new Error(`account query failed: HTTP ${res.status}`);
  const body = (await res.json()) as { account?: Record<string, unknown> };
  const acc = (body.account?.base_account ?? body.account ?? {}) as Record<string, string>;
  return { accountNumber: BigInt(acc.account_number ?? "0"), sequence: BigInt(acc.sequence ?? "0") };
}

interface DeliveredTx {
  hash: string;
  code: number;
  height: string;
  rawLog: string;
  events: { type: string; attributes: Record<string, string> }[];
}

/** Poll the REST tx endpoint until the transaction is in a block. */
async function waitForTx(hash: string, timeoutMs = 60_000): Promise<DeliveredTx> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await fetch(`${REST}/cosmos/tx/v1beta1/txs/${hash}`);
    if (res.ok) {
      const body = (await res.json()) as { tx_response?: Record<string, unknown> };
      const r = body.tx_response;
      if (r) {
        const events = (Array.isArray(r.events) ? r.events : []).map((e) => {
          const ev = e as { type?: string; attributes?: { key?: string; value?: string }[] };
          const attributes: Record<string, string> = {};
          for (const a of ev.attributes ?? []) if (a.key) attributes[a.key] = a.value ?? "";
          return { type: String(ev.type ?? ""), attributes };
        });
        return {
          hash: String(r.txhash ?? hash),
          code: Number(r.code ?? 0),
          height: String(r.height ?? "0"),
          rawLog: String(r.raw_log ?? ""),
          events,
        };
      }
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw new Error(`Transaction ${hash} was not seen in a block in time.`);
}

/**
 * Broadcast owner-signed native-lane messages (hybrid-signed with the
 * owner's ML-DSA-87 key) and wait for inclusion, returning the delivered
 * transaction whatever its code. Callers that expect success use
 * broadcastOwner; callers that deliberately provoke a refusal (reject)
 * need the raw result to record HOW the chain refused.
 */
async function broadcastOwnerRaw(
  acc: UnifiedAccount,
  messages: EncodeObject[],
  fee: { amount: { denom: string; amount: string }[]; gas: string },
): Promise<DeliveredTx> {
  const { accountNumber, sequence } = await accountSequence(acc.cosmos);
  const signer = new EthNativeSigner(acc, { signMode: "hybrid", rest: REST });
  const transport = await StargateClient.connect(RPC);
  let res: { transactionHash: string; code: number };
  try {
    res = await signer.signAndBroadcast(transport, { chainId: CHAIN_ID, accountNumber, sequence, fee, messages });
  } finally {
    transport.disconnect();
  }
  return waitForTx(res.transactionHash);
}

/**
 * Broadcast owner-signed native-lane messages and wait for inclusion.
 * Throws unless the delivered transaction has code 0. A refused
 * abstract-account execution still lands in a code-0 transaction with an
 * `abstractaccount_execution_failed` event, so callers that relay an
 * execution must also check the events (see checkExecution).
 */
async function broadcastOwner(
  acc: UnifiedAccount,
  messages: EncodeObject[],
  fee: { amount: { denom: string; amount: string }[]; gas: string },
): Promise<DeliveredTx> {
  const tx = await broadcastOwnerRaw(acc, messages, fee);
  if (tx.code !== 0) {
    throw new Error(`Transaction ${tx.hash} delivered with code ${tx.code}: ${tx.rawLog.slice(0, 500)}`);
  }
  return tx;
}

/** A refused MsgExecuteEVM lands in a code-0 tx with this event; fail on it. */
function checkExecution(tx: DeliveredTx): void {
  const failed = tx.events.filter((e) => e.type === "abstractaccount_execution_failed");
  if (failed.length > 0) {
    throw new Error(
      `The chain refused the leashed execution (${tx.hash}): ${JSON.stringify(failed[0].attributes)}`,
    );
  }
}

/** The inner EVM transaction hash, when the delivery events carry one. */
function innerEvmHash(tx: DeliveredTx): string | null {
  for (const e of tx.events) {
    for (const [key, value] of Object.entries(e.attributes)) {
      if (/hash/i.test(key) && /^0x[0-9a-fA-F]{64}$/.test(value)) return value;
    }
  }
  return null;
}

async function abstractAccountExists(ownerCosmos: string): Promise<boolean> {
  const res = await fetch(`${REST}/qorechain/abstractaccount/v1/accounts/${ownerCosmos}`);
  if (!res.ok) return false;
  const body = (await res.json()) as { account?: unknown };
  return Boolean(body.account);
}

/** The stored rules; an account with no abstract account has none (HTTP 404). */
async function spendingRulesOf(ownerCosmos: string) {
  try {
    return await fetchSpendingRules({ rest: REST, address: ownerCosmos });
  } catch (err) {
    if (err instanceof Error && /HTTP 404/.test(err.message)) return { rules: [], authenticatorRules: [] };
    throw err;
  }
}

/** The linked keys; an account with no abstract account has none (HTTP 404). */
async function authenticatorsOf(ownerCosmos: string) {
  try {
    return await fetchAuthenticators({ rest: REST, address: ownerCosmos });
  } catch (err) {
    if (err instanceof Error && /HTTP 404/.test(err.message)) return [];
    throw err;
  }
}

interface ScheduleState {
  due: boolean;
  reason: string;
  payee: Address;
  paid: bigint;
  totalCap: bigint;
  payments: bigint;
  maxPayments: bigint;
  amountPerPayment: bigint;
  expiry: bigint;
}

async function scheduleState(contract: Address): Promise<ScheduleState> {
  const client = await createEvmClient({ endpoints: { evmRpc: EVM_RPC } });
  const chainId = await client.getChainId();
  if (chainId !== TESTNET_CHAIN_ID) throw new Error(`Refusing to run: EVM chain id is ${chainId}, expected testnet ${TESTNET_CHAIN_ID}.`);
  const [due, reason] = (await readContract(client.publicClient, {
    address: contract, abi: billPayGuardAbi, functionName: "checkDue", args: [SCHEDULE_ID],
  })) as [boolean, string];
  const s = (await readContract(client.publicClient, {
    address: contract, abi: billPayGuardAbi, functionName: "getSchedule", args: [SCHEDULE_ID],
  })) as unknown as ScheduleState & { owner: Address; payee: Address };
  return { due, reason, payee: s.payee, paid: s.paid, totalCap: s.totalCap, payments: s.payments, maxPayments: s.maxPayments, amountPerPayment: s.amountPerPayment, expiry: s.expiry };
}

function printSchedule(s: ScheduleState): void {
  console.log(
    `schedule ${SCHEDULE_ID}: due=${s.due} (${s.reason}), paid ${s.paid}/${s.totalCap} wei, ` +
      `${s.payments}/${s.maxPayments} payments, ${s.amountPerPayment} wei per payment, expiry ${s.expiry}`,
  );
}

async function status(): Promise<void> {
  const owner = await ownerAccount();
  const contract = contractAddress();
  console.log(`owner:    ${owner.evm} (${owner.cosmos})`);
  console.log(`contract: ${contract}`);
  console.log(`abstract account: ${await abstractAccountExists(owner.cosmos) ? "exists" : "none"}`);
  const rules = await spendingRulesOf(owner.cosmos);
  console.log(`spending rules: ${JSON.stringify(rules.rules, (k, v) => (typeof v === "bigint" ? v.toString() : v))}`);
  const auths = await authenticatorsOf(owner.cosmos);
  console.log(`authenticators: ${JSON.stringify(auths, (k, v) => (typeof v === "bigint" ? v.toString() : v))}`);
  printSchedule(await scheduleState(contract));
}

async function setup(): Promise<void> {
  const owner = await ownerAccount();
  const agent = agentKey();
  const contract = contractAddress();
  const selector = toFunctionSelector("executePayment(uint256)");
  console.log(`owner:    ${owner.evm} (${owner.cosmos})`);
  console.log(`agent:    ${agent.address}`);
  console.log(`contract: ${contract} (executePayment selector ${selector})`);

  // Step 1: the owner's abstract-account record (once).
  if (await abstractAccountExists(owner.cosmos)) {
    console.log("abstract account: already exists, nothing to create.");
  } else {
    const tx = await broadcastOwner(
      owner,
      [msg.abstractaccount.createAbstractAccount({ owner: owner.cosmos, accountType: "session_based" })],
      FEE_STANDARD,
    );
    console.log(`abstract account created: ${tx.hash} (block ${tx.height})`);
  }

  // Step 2: link the agent key with the `evm` permission and its rule.
  const auths = await authenticatorsOf(owner.cosmos);
  const already = auths.find(
    (a) => a.pubkeyHex.toLowerCase() === agent.address.slice(2).toLowerCase() && !a.revoked,
  );
  if (already) {
    console.log(`agent already linked (has_spend_rule=${already.hasSpendRule}, expiry ${already.expiryUnix}, label "${already.label}").`);
  } else {
    // The agent proves it holds the key being linked (EIP-191 personal_sign
    // over the chain's link text); the owner signs the link transaction.
    const proof = signAuthenticatorLinkEip191({ chainId: CHAIN_ID, account: owner.cosmos, privateKey: agent.privateKey });
    if (!verifyAuthenticatorLinkProof({ chainId: CHAIN_ID, account: owner.cosmos, scheme: "secp256k1", pubkey: proof.pubkey, possessionProof: proof.possessionProof })) {
      throw new Error("The agent possession proof does not verify; refusing to link.");
    }
    const messages = linkAuthenticatorMsgs({
      owner: owner.cosmos,
      chainId: CHAIN_ID,
      scheme: "secp256k1",
      pubkey: proof.pubkey,
      possessionProof: proof.possessionProof,
      permissions: ["evm"],
      expiryUnix: AUTH_EXPIRY_UNIX,
      label: AUTH_LABEL,
      spendingRule: {
        id: RULE_ID,
        enabled: true,
        perTxLimit: RULE_PER_TX_UQOR,
        dailyLimit: RULE_DAILY_UQOR,
        allowedDenoms: ["uqor"],
        allowedEvmCalls: [`${contract.toLowerCase()}/${selector}`],
        denomLimits: [],
      },
    });
    const tx = await broadcastOwner(owner, messages, FEE_STANDARD);
    console.log(`agent linked: ${tx.hash} (block ${tx.height})`);
  }

  // Verify what the chain stored. The rule is account-wide: the chain
  // applies the first enabled rule to every linked key without its own
  // (see linkAuthenticatorMsgs), and no chain message sets a per-key rule
  // — the abstractaccount Msg service has no such method. The
  // authenticator's `has_spend_rule` field reports a per-key rule only, so
  // it reads false here, exactly as on Fenestella's Verified account; the
  // key is still bound by the account-wide rule below.
  const rules = await spendingRulesOf(owner.cosmos);
  const rule = rules.rules.find((r) => r.id === RULE_ID);
  if (!rule || !rule.enabled || rule.perTxLimit !== BigInt(RULE_PER_TX_UQOR) || rule.dailyLimit !== BigInt(RULE_DAILY_UQOR)) {
    throw new Error(`Spending rule ${RULE_ID} is missing or does not match: ${JSON.stringify(rules.rules)}`);
  }
  const linked = (await authenticatorsOf(owner.cosmos)).find(
    (a) => a.pubkeyHex.toLowerCase() === agent.address.slice(2).toLowerCase() && !a.revoked,
  );
  if (!linked) throw new Error("The agent authenticator is not on chain after linking.");
  if (!linked.permissions.includes("evm")) throw new Error(`The agent authenticator lacks the evm permission: ${JSON.stringify(linked.permissions)}`);
  console.log(`rule ${RULE_ID}: per-tx ${rule.perTxLimit} uqor, daily ${rule.dailyLimit} uqor, calls ${JSON.stringify(rule.allowedEvmCalls)}`);
  console.log(
    `authenticator: ${linked.scheme} ${linked.pubkeyHex}, permissions ${JSON.stringify(linked.permissions)}, ` +
      `expiry ${linked.expiryUnix}, label "${linked.label}", has_spend_rule=${linked.hasSpendRule} (per-key rule; the account-wide rule above bounds the key)`,
  );
  console.log("LEASH SETUP DONE.");
}

/** An EIP-1193 provider backed by a local key, enough for the SDK's personal_sign path. */
function keyProvider(privateKey: Hex) {
  const account = privateKeyToAccount(privateKey);
  return {
    async request({ method, params }: { method: string; params?: unknown[] }) {
      if (method === "eth_accounts" || method === "eth_requestAccounts") return [account.address];
      if (method === "personal_sign") {
        const message = String((params ?? [])[0]);
        return account.signMessage({ message: { raw: message as Hex } });
      }
      throw new Error(`Agent key provider: ${method} is not supported`);
    },
  };
}

/** The owner's deposited balance inside the guard contract (wei). */
async function ownerContractBalance(contract: Address, ownerEvm: string): Promise<bigint> {
  const client = await createEvmClient({ endpoints: { evmRpc: EVM_RPC } });
  return (await readContract(client.publicClient, {
    address: contract, abi: billPayGuardAbi, functionName: "balances", args: [ownerEvm as Address],
  })) as bigint;
}

/**
 * Prove the spending rule bites. The agent signs ONE meta-transaction the
 * rule forbids — `withdraw(1000)` on the guard contract, a function
 * outside the allowlist (the rule permits ONLY
 * `executePayment(uint256)`) — and the owner relays it. The amount is a
 * negligible 1000 wei on purpose: if the chain ever failed to refuse,
 * the call would move almost nothing (and would be recorded as executed,
 * not as a refusal). A refusal is expected in one of two forms: the
 * relay transaction itself fails (code != 0), or it lands with code 0
 * carrying an `abstractaccount_execution_failed` event. Either way the
 * full record goes to deployments/leash-rejection.json, and the schedule
 * must be unchanged afterwards.
 */
async function reject(): Promise<void> {
  const owner = await ownerAccount();
  const agent = agentKey();
  const contract = contractAddress();
  const selector = toFunctionSelector("executePayment(uint256)");
  console.log(`owner (relayer): ${owner.evm} (${owner.cosmos})`);
  console.log(`agent:           ${agent.address}`);
  console.log(`contract:        ${contract}`);

  // Confirm the rule is in place and really does allow only executePayment.
  const rules = await spendingRulesOf(owner.cosmos);
  const rule = rules.rules.find((r) => r.id === RULE_ID);
  if (!rule || !rule.enabled) throw new Error(`Spending rule ${RULE_ID} is missing or disabled — nothing to test against.`);
  const allowed = rule.allowedEvmCalls;
  if (allowed.length !== 1 || allowed[0] !== `${contract.toLowerCase()}/${selector}`) {
    throw new Error(`Spending rule ${RULE_ID} does not match the expected allowlist: ${JSON.stringify(allowed)}`);
  }
  console.log(`rule ${RULE_ID}: per-tx ${rule.perTxLimit} uqor, daily ${rule.dailyLimit} uqor, calls ${JSON.stringify(allowed)}`);

  const before = await scheduleState(contract);
  printSchedule(before);
  const balanceBefore = await ownerContractBalance(contract, owner.evm);
  console.log(`owner contract balance: ${balanceBefore} wei`);

  const digestVersion = await resolveEvmAuthDigestVersion({ rest: REST });
  const { nonce, linked } = await fetchAuthNonce({ rest: REST, address: owner.cosmos, pubkey: agent.address });
  if (!linked) throw new Error("The agent key is not linked to the owner's abstract account. Run `npx tsx scripts/leash.ts setup` first.");
  console.log(`digest ${digestVersion}, agent nonce ${nonce}`);

  // The forbidden call: withdraw(uint256) is NOT in the rule's allowlist.
  const withdrawSelector = toFunctionSelector("withdraw(uint256)");
  const data = encodeFunctionData({ abi: billPayGuardAbi, functionName: "withdraw", args: [1000n] });
  console.log(`attempting forbidden call: withdraw(uint256) selector ${withdrawSelector}, amount 1000 wei`);
  const executeMsg = await buildMetaMaskExecuteEvm({
    provider: keyProvider(agent.privateKey) as never,
    address: agent.address,
    relayer: owner.cosmos,
    chainId: CHAIN_ID,
    account: owner.cosmos,
    to: contract,
    value: "0",
    data: hexToBytes(data),
    gasLimit: EXEC_GAS_LIMIT,
    nonce,
    digestVersion,
  });
  const tx = await broadcastOwnerRaw(owner, [executeMsg], FEE_EXECUTE);
  console.log(`relay tx: ${tx.hash} (block ${tx.height}, code ${tx.code})`);

  const failedEvents = tx.events.filter((e) => e.type === "abstractaccount_execution_failed");
  const after = await scheduleState(contract);
  const balanceAfter = await ownerContractBalance(contract, owner.evm);
  const scheduleUnchanged = after.payments === before.payments && after.paid === before.paid;
  const balanceUnchanged = balanceAfter === balanceBefore;

  let outcome: string;
  let reason: string;
  if (tx.code !== 0) {
    outcome = "refused-tx-level";
    reason = tx.rawLog.slice(0, 500);
  } else if (failedEvents.length > 0) {
    outcome = "refused-by-spending-rule";
    reason = JSON.stringify(failedEvents[0].attributes);
  } else if (!balanceUnchanged || !scheduleUnchanged) {
    outcome = "EXECUTED-NOT-REFUSED";
    reason = "No refusal event and the on-chain state moved — the forbidden call ran.";
  } else {
    outcome = "unclear";
    reason = "Code 0, no abstractaccount_execution_failed event, but no state moved either — inconclusive.";
  }
  console.log(`outcome: ${outcome}`);
  console.log(`reason: ${reason}`);
  console.log(`schedule unchanged: ${scheduleUnchanged}; owner balance unchanged: ${balanceUnchanged}`);

  const record = {
    attemptedAt: new Date().toISOString(),
    rule: {
      id: RULE_ID,
      perTxLimitUqor: rule.perTxLimit.toString(),
      dailyLimitUqor: rule.dailyLimit.toString(),
      allowedDenoms: rule.allowedDenoms,
      allowedEvmCalls: rule.allowedEvmCalls,
    },
    attemptedCall: {
      to: contract,
      function: "withdraw(uint256)",
      selector: withdrawSelector,
      args: ["1000"],
      value: "0",
      note: "withdraw is outside the rule's allowlist, which permits only executePayment(uint256) on the guard contract. Amount 1000 wei is negligible by design.",
    },
    cosmosTx: tx.hash,
    block: Number(tx.height),
    code: tx.code,
    rawLog: tx.rawLog,
    events: tx.events,
    outcome,
    reason,
    scheduleBefore: { paidWei: before.paid.toString(), payments: before.payments.toString() },
    scheduleAfter: { paidWei: after.paid.toString(), payments: after.payments.toString() },
    ownerBalanceBeforeWei: balanceBefore.toString(),
    ownerBalanceAfterWei: balanceAfter.toString(),
    explorer: `https://explore.qore.network/tx/${tx.hash}`,
  };
  const file = repoFile(path.join("deployments", "leash-rejection.json"));
  fs.writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`);
  console.log(`record written to ${path.relative(process.cwd(), file)}`);

  if (outcome === "refused-tx-level" || outcome === "refused-by-spending-rule") {
    if (!scheduleUnchanged || !balanceUnchanged) {
      throw new Error("The chain refused the call, but on-chain state moved anyway — investigate before trusting the leash.");
    }
    console.log("LEASH REJECTION RECORDED: the chain refused the forbidden execution; nothing moved.");
    return;
  }
  throw new Error(`The forbidden call was NOT refused (${outcome}). See deployments/leash-rejection.json — do not claim a leash rejection.`);
}

async function pay(): Promise<void> {
  const owner = await ownerAccount();
  const agent = agentKey();
  const contract = contractAddress();
  console.log(`owner (relayer): ${owner.evm} (${owner.cosmos})`);
  console.log(`agent:           ${agent.address}`);
  console.log(`contract:        ${contract}`);

  const before = await scheduleState(contract);
  printSchedule(before);
  if (!before.due) {
    throw new Error(`Schedule ${SCHEDULE_ID} is not due (${before.reason}) — sending nothing.`);
  }

  // Authenticated messaging (scripts/intent.ts): if the owner signed an
  // intent for exactly this payment, verify it before relaying — the
  // ML-DSA-87 signature must be valid under the owner's ON-CHAIN
  // registered key and the intent must match the live schedule. Any
  // mismatch refuses the relay. With --require-intent a missing intent
  // refuses it too; without the flag a missing intent only warns, and
  // the payment proceeds under the contract's caps and the leash's
  // spending rule alone.
  const requireIntent = process.argv.includes("--require-intent");
  const nextPayment = before.payments + 1n;
  const intentPath = intentFilePath(SCHEDULE_ID, nextPayment);
  if (fs.existsSync(intentPath)) {
    const signed = loadSignedIntent(intentPath);
    const problems = await verifySignedIntent(signed, {
      rest: REST,
      ownerCosmos: owner.cosmos,
      contract,
      schedule: before,
    });
    if (problems.length > 0) {
      throw new Error(
        `Signed intent ${path.relative(process.cwd(), intentPath)} does not verify — refusing to relay: ${problems.join("; ")}`,
      );
    }
    console.log(
      `intent verified: ML-DSA-87 signature valid under the owner's registered key; ` +
        `authorises schedule ${SCHEDULE_ID} payment #${nextPayment}`,
    );
  } else if (requireIntent) {
    throw new Error(
      `--require-intent: no signed intent for schedule ${SCHEDULE_ID} payment #${nextPayment} ` +
        `(${path.relative(process.cwd(), intentPath)}). Sign one with: npx tsx scripts/intent.ts sign ${SCHEDULE_ID}`,
    );
  } else {
    console.log(
      `intent: none for schedule ${SCHEDULE_ID} payment #${nextPayment} — ` +
        `proceeding under the contract's caps and the leash's spending rule only`,
    );
  }

  const digestVersion = await resolveEvmAuthDigestVersion({ rest: REST });
  const { nonce, linked } = await fetchAuthNonce({ rest: REST, address: owner.cosmos, pubkey: agent.address });
  if (!linked) throw new Error("The agent key is not linked to the owner's abstract account. Run `npx tsx scripts/leash.ts setup` first.");
  console.log(`digest ${digestVersion}, agent nonce ${nonce}`);

  // The agent signs the payment; the owner relays it and pays the fee.
  const data = encodeFunctionData({ abi: billPayGuardAbi, functionName: "executePayment", args: [SCHEDULE_ID] });
  const executeMsg = await buildMetaMaskExecuteEvm({
    provider: keyProvider(agent.privateKey) as never,
    address: agent.address,
    relayer: owner.cosmos,
    chainId: CHAIN_ID,
    account: owner.cosmos,
    to: contract,
    value: "0",
    data: hexToBytes(data),
    gasLimit: EXEC_GAS_LIMIT,
    nonce,
    digestVersion,
  });
  const tx = await broadcastOwner(owner, [executeMsg], FEE_EXECUTE);
  checkExecution(tx);
  console.log(`leashed payment relayed: ${tx.hash} (block ${tx.height})`);
  const evmHash = innerEvmHash(tx);
  if (evmHash) console.log(`inner EVM tx: ${evmHash}`);

  const after = await scheduleState(contract);
  printSchedule(after);
  if (after.payments !== before.payments + 1n || after.paid !== before.paid + before.amountPerPayment) {
    throw new Error("The schedule did not advance by exactly one payment — check the chain state before retrying.");
  }
  console.log(`cosmosTx: ${tx.hash}`);
  if (evmHash) console.log(`evmTx: ${evmHash}`);
  console.log("LEASHED PAYMENT DONE.");
}

const commands: Record<string, () => Promise<void>> = { status, setup, pay, reject };
const cmd = process.argv[2] ?? "status";
const run = commands[cmd];
if (!run) {
  console.error(`Unknown command "${cmd}". Use: status | setup | pay | reject`);
  process.exit(1);
}
run().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
