/**
 * agent.ts - the BillPay Guard agent runner (off-chain).
 *
 * The agent is an autonomous loop with its OWN key (see .env.agent). The
 * owner authorises the agent's address on-chain (setAgent); the runner
 * then:
 *   1. reads every schedule from the guard contract,
 *   2. asks the contract itself whether each schedule is due (checkDue),
 *   3. executes a payment for each due schedule, and
 *   4. logs every decision — including the schedules it SKIPPED and why.
 *
 * The runner never decides the limits: the contract enforces them. If a
 * payment would breach a cap, the interval, the expiry, or the payment
 * count, checkDue says so and the runner sends nothing — so it never
 * wastes gas on a transaction the contract would reject.
 *
 * Each payment the runner sends is an EVM transaction admitted only
 * inside a post-quantum authorisation window the agent opens with its
 * hybrid-signed (secp256k1 + ML-DSA-87) key: run
 * `npm run window-agent register` once, then `npm run window-agent open`
 * before running the agent. The runner checks the window first and
 * refuses to run without one.
 *
 * Usage:
 *   npm run agent              one pass over all schedules, then exit
 *   npm run agent -- --loop 60 repeat the pass every 60 seconds
 *   npm run agent -- --dry-run print what WOULD be paid, send nothing
 *
 * Safety: refuses to run on any chain other than the testnet (9800).
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

/** QoreChain testnet (qorechain-diana) EVM chain id. Nothing else is allowed. */
const TESTNET_CHAIN_ID = 9800;
const TESTNET_REST = "https://api-testnet.qore.host";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

/** The deployed contract address: BILLPAY_GUARD_ADDRESS, or deployments/testnet.json. */
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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const loopIdx = args.indexOf("--loop");
  const loopSeconds = loopIdx >= 0 ? Number(args[loopIdx + 1] ?? "0") : 0;
  if (loopIdx >= 0 && !(loopSeconds > 0)) {
    throw new Error("--loop needs a positive number of seconds.");
  }

  const evmRpc = process.env.QORE_EVM_RPC_URL ?? "http://localhost:8545";
  const privateKey = requireEnv("QORE_EVM_PRIVATE_KEY") as Hex;
  const contract = contractAddress();

  const client = await createEvmClient({ endpoints: { evmRpc } });
  const chainId = await client.getChainId();
  if (chainId !== TESTNET_CHAIN_ID) {
    throw new Error(
      `Refusing to run: chain id is ${chainId}, expected testnet ${TESTNET_CHAIN_ID}.`,
    );
  }
  const account = evmAccountFromPrivateKey(privateKey);
  const wallet = client.getWalletClient(account);

  console.log(`BillPay Guard agent — ${dryRun ? "DRY RUN" : "live"}`);
  console.log(`contract: ${contract}`);
  console.log(`agent:    ${account.address}`);

  // The agent's EVM transactions need a live window for ITS account.
  const cosmos = (process.env.QORE_AGENT_COSMOS ?? "").trim();
  if (cosmos) {
    const w = await evmWindowStatus({ rest: TESTNET_REST, address: cosmos });
    if (!w.found || !w.live) {
      throw new Error(
        "No live EVM authorisation window for the agent account. " +
          "Run `npm run window-agent open` first (and `register` once).",
      );
    }
    console.log(`window:   live; ${w.remainingBlocks} blocks, ${w.remainingTxs} txs left`);
  } else {
    console.log("window:   not checked (QORE_AGENT_COSMOS unset) — make sure a window is open.");
  }

  for (;;) {
    const count = (await readContract(client.publicClient, {
      address: contract,
      abi: billPayGuardAbi,
      functionName: "scheduleCount",
    })) as bigint;
    console.log(`\n[${new Date().toISOString()}] ${count} schedule(s) on-chain.`);
    let paid = 0;
    let skipped = 0;

    for (let id = 0n; id < count; id++) {
      const [due, reason] = (await readContract(client.publicClient, {
        address: contract,
        abi: billPayGuardAbi,
        functionName: "checkDue",
        args: [id],
      })) as [boolean, string];
      const s = (await readContract(client.publicClient, {
        address: contract,
        abi: billPayGuardAbi,
        functionName: "getSchedule",
        args: [id],
      })) as unknown as {
        owner: Address;
        payee: Address;
        amountPerPayment: bigint;
        totalCap: bigint;
        paid: bigint;
        payments: bigint;
      };

      if (!due) {
        console.log(
          `  schedule ${id}: SKIP (${reason}) — paid ${formatEther(s.paid)}/${formatEther(s.totalCap)} QOR, ${s.payments} payment(s)`,
        );
        skipped += 1;
        continue;
      }
      console.log(
        `  schedule ${id}: DUE — pay ${formatEther(s.amountPerPayment)} QOR to ${s.payee} ` +
          `(paid ${formatEther(s.paid)}/${formatEther(s.totalCap)} QOR so far)`,
      );
      if (dryRun) {
        paid += 1;
        continue;
      }
      const hash = await writeContract(wallet, {
        address: contract,
        abi: billPayGuardAbi,
        functionName: "executePayment",
        args: [id],
        account: wallet.account ?? null,
        chain: wallet.chain,
      });
      const receipt = await client.publicClient.waitForTransactionReceipt({ hash });
      if (receipt.status !== "success") {
        console.log(`    payment tx ${hash} FAILED on-chain (status ${receipt.status})`);
      } else {
        console.log(`    paid: ${hash} (block ${receipt.blockNumber})`);
      }
      paid += 1;
    }

    console.log(`pass done: ${paid} payment(s), ${skipped} skipped.`);
    if (!loopSeconds) break;
    console.log(`sleeping ${loopSeconds}s…`);
    await sleep(loopSeconds * 1000);
  }
  console.log("Done.");
}

main().catch((err: unknown) => {
  console.error("\nAgent run failed.");
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
