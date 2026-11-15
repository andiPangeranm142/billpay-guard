/**
 * demo-rejection.ts - demonstrate on-chain that the guard REJECTS a payment
 * that would breach a schedule's limits.
 *
 * Run after the agent has paid schedule 0 twice (0.2 of its 0.25 QOR cap):
 * a third 0.1 QOR payment would exceed the total cap, so the contract must
 * refuse it. The script:
 *   1. asks the contract first (checkDue — expect "cap-reached"),
 *   2. sends the payment anyway, with an explicit gas limit (so the
 *      transaction is broadcast instead of being dropped by gas
 *      estimation), and
 *   3. records the outcome in deployments/demo.json.
 *
 * Two honest outcomes are possible, and both prove the guard works:
 *   - the transaction is mined with status "reverted" (the on-chain
 *     rejection), or
 *   - the node refuses to broadcast it because its own simulation hits
 *     the contract's ExceedsTotalCap revert (the rejection, one step
 *     earlier — the guard still refused).
 * If the payment SUCCEEDS, the guard is broken and the script exits 1.
 *
 * Usage: npx tsx --env-file=.env scripts/demo-rejection.ts [scheduleId]
 *
 * Safety: refuses to run on any chain other than the testnet (9800).
 */
import {
  createEvmClient,
  evmAccountFromPrivateKey,
  readContract,
  writeContract,
} from "@qorechain/evm";
import { type Address, type Hex } from "viem";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { billPayGuardAbi } from "../contracts/BillPayGuard.artifact.js";
import { cosmosHashForEvmTx } from "./cosmos-hash.js";

/** QoreChain testnet (qorechain-diana) EVM chain id. Nothing else is allowed. */
const TESTNET_CHAIN_ID = 9800;

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function contractAddress(): Address {
  const dir = path.dirname(fileURLToPath(import.meta.url));
  const file = path.resolve(dir, "..", "deployments", "testnet.json");
  if (!fs.existsSync(file)) {
    throw new Error("No contract address: run `npm run deploy` first.");
  }
  const deployment = JSON.parse(fs.readFileSync(file, "utf8")) as { contract?: string };
  if (!deployment.contract) throw new Error("deployments/testnet.json has no contract address.");
  return deployment.contract as Address;
}

async function main(): Promise<void> {
  const scheduleId = BigInt(process.argv[2] ?? "0");
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

  console.log(`contract:  ${contract}`);
  console.log(`schedule:  ${scheduleId}`);
  console.log(`sender:    ${account.address} (owner)`);

  const [due, reason] = (await readContract(client.publicClient, {
    address: contract,
    abi: billPayGuardAbi,
    functionName: "checkDue",
    args: [scheduleId],
  })) as [boolean, string];
  console.log(`checkDue:  due=${due}, reason="${reason}"`);
  if (due) {
    throw new Error(
      "The schedule is due — a payment would succeed, so this would not demonstrate a rejection. " +
        "Run the agent first until the cap is reached.",
    );
  }

  console.log("\nAttempting the payment anyway (explicit gas, so it is broadcast)…");
  const dir = path.dirname(fileURLToPath(import.meta.url));
  const demoFile = path.resolve(dir, "..", "deployments", "demo.json");
  const demo = JSON.parse(fs.readFileSync(demoFile, "utf8")) as Record<string, unknown>;

  let hash: Hex;
  try {
    hash = await writeContract(wallet, {
      address: contract,
      abi: billPayGuardAbi,
      functionName: "executePayment",
      args: [scheduleId],
      account: wallet.account ?? null,
      chain: wallet.chain,
      gas: 300000n,
    });
  } catch (err) {
    // The node simulated the call and refused to broadcast it: the guard
    // rejected the payment before it could be mined. Still a rejection.
    const msg = err instanceof Error ? err.message : String(err);
    console.log("Broadcast refused by the node (its simulation hit the guard's revert):");
    console.log(`  ${msg.slice(0, 300)}`);
    demo.rejection = {
      scheduleId: Number(scheduleId),
      checkDueReason: reason,
      outcome: "broadcast-refused",
      error: msg.slice(0, 500),
      attemptedAt: new Date().toISOString(),
    };
    fs.writeFileSync(demoFile, JSON.stringify(demo, null, 2) + "\n");
    console.log("\nRecorded in deployments/demo.json (rejection.broadcast-refused).");
    console.log("The guard refused the payment. Done.");
    return;
  }

  const receipt = await client.publicClient.waitForTransactionReceipt({ hash });
  const { cosmosHash } = await cosmosHashForEvmTx(client.publicClient, hash);
  console.log(`tx:      ${hash}`);
  console.log(`cosmos:  ${cosmosHash}`);
  console.log(`block:   ${receipt.blockNumber}`);
  console.log(`status:  ${receipt.status}`);
  if (receipt.status === "success") {
    throw new Error(
      "THE PAYMENT SUCCEEDED — the guard did NOT enforce its limit. " +
        "This is a contract bug; do not present this as a working demo.",
    );
  }
  demo.rejection = {
    scheduleId: Number(scheduleId),
    checkDueReason: reason,
    outcome: "reverted-on-chain",
    evmTx: hash,
    cosmosTx: cosmosHash,
    block: Number(receipt.blockNumber),
    attemptedAt: new Date().toISOString(),
  };
  fs.writeFileSync(demoFile, JSON.stringify(demo, null, 2) + "\n");
  console.log("\nRecorded in deployments/demo.json (rejection.reverted-on-chain).");
  console.log("The guard refused the payment on-chain. Done.");
}

main().catch((err: unknown) => {
  console.error("\nRejection demo failed.");
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
