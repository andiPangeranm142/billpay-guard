/**
 * topup.ts - top up the owner's deposited balance in the guard contract.
 *
 * Payments draw from the owner's `balances[owner]` inside the contract,
 * not from the contract's raw native balance — so a top-up is a
 * `deposit()` call from the owner (payable), NOT a plain transfer to the
 * contract address (which would strand funds the contract cannot spend).
 *
 * Usage (testnet only, from the repo directory, inside a live owner window):
 *   npx tsx --env-file=.env scripts/topup.ts [amountQor]
 *     amountQor defaults to 0.3. The script prints the owner's native
 *     balance and the contract balances before and after, waits for the
 *     receipt, and REFUSES to report success unless the receipt status is
 *     success AND the on-chain owner balance increased by exactly the
 *     deposited amount. It records the funding tx in
 *     deployments/topup.json (no secrets).
 *
 * Secrets are read into memory only to sign; nothing here prints a
 * mnemonic or a private key.
 */
import { createEvmClient, evmAccountFromPrivateKey, readContract } from "@qorechain/evm";
import { formatEther, parseEther, type Address, type Hex } from "viem";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { billPayGuardAbi } from "../contracts/BillPayGuard.artifact.js";
import { cosmosHashForEvmTx } from "./cosmos-hash.js";

/** QoreChain testnet (qorechain-diana) EVM chain id. Nothing else is allowed. */
const TESTNET_CHAIN_ID = 9800;
const EVM_RPC = "https://evm-testnet.qore.host";

/** The owner (deployer), as recorded in deployments/demo.json. */
const EXPECTED_OWNER_EVM = "0x326697b1a1EAd2E0FCa024754Fd5530D7e5cBDee";

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
  if (!fs.existsSync(file)) throw new Error("No contract address: set BILLPAY_GUARD_ADDRESS or run `npm run deploy` first.");
  const deployment = JSON.parse(fs.readFileSync(file, "utf8")) as { contract?: string };
  if (!deployment.contract) throw new Error("deployments/testnet.json has no contract address.");
  return deployment.contract as Address;
}

async function main(): Promise<void> {
  const amountArg = process.argv[2] ?? "0.3";
  let amount: bigint;
  try {
    amount = parseEther(amountArg);
  } catch {
    throw new Error(`"${amountArg}" is not a valid QOR amount.`);
  }
  if (amount <= 0n) throw new Error("Top-up amount must be greater than zero.");

  const privateKey = requireEnv("QORE_EVM_PRIVATE_KEY") as Hex;
  const contract = contractAddress();
  const client = await createEvmClient({ endpoints: { evmRpc: EVM_RPC } });
  const chainId = await client.getChainId();
  if (chainId !== TESTNET_CHAIN_ID) {
    throw new Error(`Refusing to run: chain id is ${chainId}, expected testnet ${TESTNET_CHAIN_ID}.`);
  }
  const account = evmAccountFromPrivateKey(privateKey);
  if (account.address.toLowerCase() !== EXPECTED_OWNER_EVM.toLowerCase()) {
    throw new Error(`The key derives ${account.address}, not the expected owner ${EXPECTED_OWNER_EVM}. Refusing to continue.`);
  }
  const wallet = client.getWalletClient(account);

  const ownerNativeBefore = await client.publicClient.getBalance({ address: account.address });
  const ownerContractBefore = (await readContract(client.publicClient, {
    address: contract, abi: billPayGuardAbi, functionName: "balances", args: [account.address],
  })) as bigint;
  const contractNativeBefore = await client.publicClient.getBalance({ address: contract });
  console.log(`owner:            ${account.address}`);
  console.log(`contract:         ${contract}`);
  console.log(`owner native:     ${formatEther(ownerNativeBefore)} QOR`);
  console.log(`owner in guard:   ${formatEther(ownerContractBefore)} QOR`);
  console.log(`contract native:  ${formatEther(contractNativeBefore)} QOR`);
  console.log(`depositing:       ${formatEther(amount)} QOR`);
  if (ownerNativeBefore <= amount) {
    throw new Error(`Owner native balance ${formatEther(ownerNativeBefore)} QOR does not cover the ${formatEther(amount)} QOR deposit plus gas. Fund the owner first.`);
  }

  const hash = await wallet.writeContract({
    address: contract,
    abi: billPayGuardAbi,
    functionName: "deposit",
    args: [],
    value: amount,
    account: wallet.account ?? null,
    chain: wallet.chain,
  });
  const receipt = await client.publicClient.waitForTransactionReceipt({ hash });
  console.log(`deposit tx: ${hash} (block ${receipt.blockNumber}, status ${receipt.status})`);
  if (receipt.status !== "success") {
    throw new Error(`Deposit tx ${hash} failed on-chain (status ${receipt.status}).`);
  }

  // Re-verify from chain state: the owner's guard balance must have grown
  // by exactly the deposited amount, and the contract's native balance too.
  const ownerContractAfter = (await readContract(client.publicClient, {
    address: contract, abi: billPayGuardAbi, functionName: "balances", args: [account.address],
  })) as bigint;
  const contractNativeAfter = await client.publicClient.getBalance({ address: contract });
  console.log(`owner in guard:   ${formatEther(ownerContractAfter)} QOR`);
  console.log(`contract native:  ${formatEther(contractNativeAfter)} QOR`);
  if (ownerContractAfter !== ownerContractBefore + amount) {
    throw new Error(
      `Owner guard balance moved from ${ownerContractBefore} to ${ownerContractAfter} wei, expected +${amount} wei — investigate before trusting the top-up.`,
    );
  }
  if (contractNativeAfter !== contractNativeBefore + amount) {
    throw new Error(
      `Contract native balance moved from ${contractNativeBefore} to ${contractNativeAfter} wei, expected +${amount} wei — investigate before trusting the top-up.`,
    );
  }

  const { cosmosHash } = await cosmosHashForEvmTx(client.publicClient, hash);
  console.log(`cosmos tx: ${cosmosHash}`);

  const dir = path.dirname(fileURLToPath(import.meta.url));
  const file = path.resolve(dir, "..", "deployments", "topup.json");
  const record = {
    depositedQor: formatEther(amount),
    from: account.address,
    contract,
    evmTx: hash,
    cosmosTx: cosmosHash,
    block: Number(receipt.blockNumber),
    ownerBalanceBeforeWei: ownerContractBefore.toString(),
    ownerBalanceAfterWei: ownerContractAfter.toString(),
    contractBalanceBeforeWei: contractNativeBefore.toString(),
    contractBalanceAfterWei: contractNativeAfter.toString(),
    toppedUpAt: new Date().toISOString(),
    explorer: `https://explore.qore.network/tx/${hash}`,
  };
  fs.writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`);
  console.log(`record written to ${path.relative(process.cwd(), file)}`);
  console.log("TOP-UP DONE: receipt success, owner guard balance and contract balance both +0.3 QOR.");
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
