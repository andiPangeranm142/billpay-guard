/**
 * setup-demo.ts - on-chain demo setup for BillPayGuard (owner account).
 *
 * Run after `npm run deploy`, inside a live owner window:
 *   1. deposits 0.5 QOR into the guard,
 *   2. creates schedule 0 ("rent"): payee = a landlord address derived
 *      from the owner's mnemonic at index 1, 0.1 QOR per payment,
 *      0.25 QOR total cap, max 5 payments, 30 s interval, 30-day expiry,
 *   3. creates schedule 1 ("subscription"): payee = the agent address,
 *      0.05 QOR per payment, 0.5 QOR total cap, max 10 payments,
 *      60 s interval, 30-day expiry,
 *   4. authorises the agent (setAgent),
 *   5. funds the agent account with 1 QOR for gas (plain EVM transfer).
 *
 * Records everything (addresses, schedule ids, tx hashes — no secrets)
 * in deployments/demo.json. The agent runner then executes the payments
 * (`npm run agent`), and scripts/demo-rejection.ts demonstrates a
 * limit rejection.
 *
 * Safety: refuses to run on any chain other than the testnet (9800).
 */
import {
  createEvmClient,
  evmAccountFromPrivateKey,
  readContract,
} from "@qorechain/evm";
import { formatEther, parseEther, type Address, type Hex } from "viem";
import { mnemonicToAccount } from "viem/accounts";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { billPayGuardAbi } from "../contracts/BillPayGuard.artifact.js";
import { cosmosHashForEvmTx } from "./deploy.js";

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
  const mnemonic = requireEnv("QORE_MNEMONIC");
  const agentAddress = requireEnv("AGENT_ADDRESS") as Address;
  const contract = contractAddress();

  const client = await createEvmClient({ endpoints: { evmRpc } });
  const chainId = await client.getChainId();
  if (chainId !== TESTNET_CHAIN_ID) {
    throw new Error(`Refusing to run: chain id is ${chainId}, expected testnet ${TESTNET_CHAIN_ID}.`);
  }
  const account = evmAccountFromPrivateKey(privateKey);
  const wallet = client.getWalletClient(account);

  // The "landlord" payee: a receiving address derived from the owner's
  // mnemonic at index 1. It is only ever a payee; its key is never used.
  const landlord = mnemonicToAccount(mnemonic, { addressIndex: 1 });
  console.log(`owner:    ${account.address}`);
  console.log(`landlord: ${landlord.address}`);
  console.log(`agent:    ${agentAddress}`);
  console.log(`contract: ${contract}`);

  const txs: Record<string, { evm: string; cosmos: string }> = {};
  async function sendAndRecord(
    label: string,
    hash: Hex,
  ): Promise<void> {
    const receipt = await client.publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") {
      throw new Error(`${label} tx ${hash} failed on-chain (status ${receipt.status}).`);
    }
    const { cosmosHash } = await cosmosHashForEvmTx(client.publicClient, hash);
    txs[label] = { evm: hash, cosmos: cosmosHash };
    console.log(`${label}: ${hash} (block ${receipt.blockNumber})`);
  }

  // 1. Deposit 0.5 QOR.
  console.log("\nDepositing 0.5 QOR…");
  await sendAndRecord(
    "deposit",
    await wallet.writeContract({
      address: contract,
      abi: billPayGuardAbi,
      functionName: "deposit",
      args: [],
      value: parseEther("0.5"),
      account: wallet.account ?? null,
      chain: wallet.chain,
    }),
  );

  // 2. Schedule 0 — rent: 0.1 QOR/payment, 0.25 QOR cap, max 5, 30 s, 30 days.
  const now = Math.floor(Date.now() / 1000);
  const expiry = BigInt(now + 30 * 24 * 3600);
  console.log("\nCreating schedule 0 (rent, 0.1 QOR/payment, 0.25 QOR cap)…");
  await sendAndRecord(
    "createSchedule0",
    await wallet.writeContract({
      address: contract,
      abi: billPayGuardAbi,
      functionName: "createSchedule",
      args: [landlord.address, parseEther("0.1"), parseEther("0.25"), 5n, 30n, expiry],
      account: wallet.account ?? null,
      chain: wallet.chain,
    }),
  );

  // 3. Schedule 1 — subscription: 0.05 QOR/payment, 0.5 QOR cap, max 10, 60 s, 30 days.
  console.log("Creating schedule 1 (subscription, 0.05 QOR/payment, 0.5 QOR cap)…");
  await sendAndRecord(
    "createSchedule1",
    await wallet.writeContract({
      address: contract,
      abi: billPayGuardAbi,
      functionName: "createSchedule",
      args: [agentAddress, parseEther("0.05"), parseEther("0.5"), 10n, 60n, expiry],
      account: wallet.account ?? null,
      chain: wallet.chain,
    }),
  );

  // 4. Authorise the agent.
  console.log("Authorising the agent…");
  await sendAndRecord(
    "setAgent",
    await wallet.writeContract({
      address: contract,
      abi: billPayGuardAbi,
      functionName: "setAgent",
      args: [agentAddress],
      account: wallet.account ?? null,
      chain: wallet.chain,
    }),
  );

  // 5. Fund the agent with 1 QOR for gas.
  console.log("Funding the agent with 1 QOR…");
  const fundHash = await wallet.sendTransaction({
    to: agentAddress,
    value: parseEther("1"),
    account: wallet.account ?? null,
    chain: wallet.chain,
  });
  await sendAndRecord("fundAgent", fundHash);

  // Read back the state.
  const balance = (await readContract(client.publicClient, {
    address: contract,
    abi: billPayGuardAbi,
    functionName: "balances",
    args: [account.address],
  })) as bigint;
  const count = (await readContract(client.publicClient, {
    address: contract,
    abi: billPayGuardAbi,
    functionName: "scheduleCount",
  })) as bigint;
  console.log(`\nguard balance: ${formatEther(balance)} QOR`);
  console.log(`schedules:     ${count}`);

  const dir = path.dirname(fileURLToPath(import.meta.url));
  const outDir = path.resolve(dir, "..", "deployments");
  fs.mkdirSync(outDir, { recursive: true });
  const demo = {
    contract,
    owner: account.address,
    landlord: landlord.address,
    agent: agentAddress,
    depositQor: "0.5",
    agentFundingQor: "1",
    schedules: [
      {
        id: 0,
        label: "rent",
        payee: landlord.address,
        amountPerPaymentQor: "0.1",
        totalCapQor: "0.25",
        maxPayments: 5,
        intervalSeconds: 30,
        expiryUnix: Number(expiry),
      },
      {
        id: 1,
        label: "subscription",
        payee: agentAddress,
        amountPerPaymentQor: "0.05",
        totalCapQor: "0.5",
        maxPayments: 10,
        intervalSeconds: 60,
        expiryUnix: Number(expiry),
      },
    ],
    txs,
    setupAt: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(outDir, "demo.json"), JSON.stringify(demo, null, 2) + "\n");
  console.log("\nWrote deployments/demo.json");
  console.log("Next: `npm run window-agent register` + `npm run window-agent open`, then `npm run agent`.");
}

main().catch((err: unknown) => {
  console.error("\nDemo setup failed.");
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
