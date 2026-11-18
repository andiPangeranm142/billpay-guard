/**
 * drill-pay.ts - Q-Day Drill one-shot payment for BillPay Guard.
 *
 * Makes exactly ONE agent payment (schedule 1: 0.05 QOR to the authorised
 * payee) from the agent account during the Q-Day Drill window
 * (18 Nov 2026, 00:00-23:59 UTC), as the drill's proof transaction:
 * it shows the project still works while its ECDSA key is leaked,
 * because the payment needs the agent's live post-quantum window
 * (hybrid-signed with the ML-DSA-87 key the attacker does not have).
 *
 * Schedule 1 was chosen at drill prep (16 Nov 2026): schedule 0 is
 * cap-reached (paid 0.20/0.25 QOR, next 0.10 QOR payment would exceed
 * the cap), while schedule 1 has 0.40 QOR of headroom
 * (paid 0.10/0.50 QOR, 2/10 payments, expiry 15 Dec 2026) and
 * checkDue(1) returns due. The script re-checks checkDue(1) at run
 * time and exits non-zero (without sending anything) if the schedule
 * is no longer due — the drill-day runner then falls back to a plain
 * transfer as the proof transaction.
 *
 * The agent's EVM window must be opened FIRST (the script refuses to
 * run without a live window):
 *   npx tsx --env-file=../.env.drill scripts/window.ts open
 *
 * Run (testnet only, from the repo directory):
 *   npx tsx --env-file=../.env.drill scripts/drill-pay.ts
 *
 * Prints the EVM tx hash AND the Cosmos tx hash; submit the hash the
 * drill form asks for on the BillPay Guard project page.
 *
 * DO NOT run before drill day: this spends a real (testnet) payment
 * slot and advances the schedule.
 */
import {
  createEvmClient,
  evmAccountFromPrivateKey,
  evmWindowStatus,
  readContract,
  writeContract,
} from "@qorechain/evm";
import { formatEther, type Address, type Hex } from "viem";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { billPayGuardAbi } from "../contracts/BillPayGuard.artifact.js";
import { cosmosHashForEvmTx } from "./cosmos-hash.js";

/** QoreChain testnet (qorechain-diana) EVM chain id. Nothing else is allowed. */
const TESTNET_CHAIN_ID = 9800;
const TESTNET_REST = "https://api-testnet.qore.host";

/** The drill payment schedule (verified due at prep; re-checked at runtime). */
const SCHEDULE_ID = 1n;

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function contractAddress(): Address {
  const fromEnv = (process.env.BILLPAY_GUARD_ADDRESS ?? "").trim();
  if (fromEnv) return fromEnv as Address;
  const dir = path.dirname(fileURLToPath(import.meta.url));
  const file = path.resolve(dir, "..", "deployments", "testnet.json");
  if (!fs.existsSync(file)) {
    throw new Error("No contract address: set BILLPAY_GUARD_ADDRESS or run `npm run deploy` first.");
  }
  const deployment = JSON.parse(fs.readFileSync(file, "utf8")) as { contract?: string };
  if (!deployment.contract) throw new Error("deployments/testnet.json has no contract address.");
  return deployment.contract as Address;
}

async function main(): Promise<void> {
  const evmRpc = process.env.QORE_EVM_RPC_URL ?? "http://localhost:8545";
  const privateKey = requireEnv("QORE_EVM_PRIVATE_KEY") as Hex;
  const contract = contractAddress();

  const client = await createEvmClient({ endpoints: { evmRpc } });
  const chainId = await client.getChainId();
  if (chainId !== TESTNET_CHAIN_ID) {
    throw new Error(`Refusing to run: chain id is ${chainId}, expected testnet ${TESTNET_CHAIN_ID}.`);
  }
  const account = evmAccountFromPrivateKey(privateKey);
  const wallet = client.getWalletClient(account);

  console.log("BillPay Guard — Q-Day Drill one-shot payment");
  console.log(`contract: ${contract}`);
  console.log(`agent:    ${account.address}`);

  // The payment needs a live window for the agent account (opened by the
  // drill-day runner just before this script runs).
  const cosmos = (process.env.QORE_AGENT_COSMOS ?? "").trim();
  if (!cosmos) {
    throw new Error("QORE_AGENT_COSMOS unset — cannot verify the agent window.");
  }
  const w = await evmWindowStatus({ rest: TESTNET_REST, address: cosmos });
  if (!w.found || !w.live) {
    throw new Error(
      "No live EVM authorisation window for the agent account. " +
        "Run `npx tsx --env-file=../.env.drill scripts/window.ts open` first.",
    );
  }
  console.log(`window:   live; ${w.remainingBlocks} blocks, ${w.remainingTxs} txs left`);

  const [due, reason] = (await readContract(client.publicClient, {
    address: contract,
    abi: billPayGuardAbi,
    functionName: "checkDue",
    args: [SCHEDULE_ID],
  })) as [boolean, string];
  const s = (await readContract(client.publicClient, {
    address: contract,
    abi: billPayGuardAbi,
    functionName: "getSchedule",
    args: [SCHEDULE_ID],
  })) as unknown as {
    owner: Address;
    payee: Address;
    amountPerPayment: bigint;
    totalCap: bigint;
    paid: bigint;
    payments: bigint;
    maxPayments: bigint;
  };
  console.log(
    `schedule ${SCHEDULE_ID}: pay ${formatEther(s.amountPerPayment)} QOR to ${s.payee} ` +
      `(paid ${formatEther(s.paid)}/${formatEther(s.totalCap)} QOR, ${s.payments}/${s.maxPayments} payments)`,
  );
  if (!due) {
    throw new Error(
      `Schedule ${SCHEDULE_ID} is not due (${reason}) — sending nothing. ` +
        "Use the fallback (plain transfer) as the drill proof transaction.",
    );
  }

  const hash = await writeContract(wallet, {
    address: contract,
    abi: billPayGuardAbi,
    functionName: "executePayment",
    args: [SCHEDULE_ID],
    account: wallet.account ?? null,
    chain: wallet.chain,
  });
  const receipt = await client.publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") {
    throw new Error(`Payment tx ${hash} FAILED on-chain (status ${receipt.status}).`);
  }
  const cosmosTx = await cosmosHashForEvmTx(client.publicClient, hash);
  console.log(`paid: ${hash} (block ${receipt.blockNumber})`);
  console.log(`evmTx: ${hash}`);
  console.log(`cosmosTx: ${cosmosTx.cosmosHash}`);
  console.log("DRILL PAYMENT DONE.");
}

main().catch((err: unknown) => {
  console.error("\nDrill payment failed.");
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
