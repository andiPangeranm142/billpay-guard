/**
 * prepare-env.ts - one-time local setup: write .env (owner) and .env.agent
 * (agent runner) from the wallets stored OUTSIDE the repo, and generate the
 * agent's fresh wallet.
 *
 * Reads:  ../deployer.json  (owner wallet: {mnemonic, evm, cosmos})
 * Writes: .env              (owner credentials — git-ignored)
 *         ../agent.json     (agent wallet: {mnemonic, evm, cosmos}, mode 600)
 *         .env.agent        (agent credentials — git-ignored)
 *
 * This script NEVER prints a mnemonic or a private key. It prints only
 * public addresses. It refuses to overwrite existing files (use --force
 * to regenerate the agent wallet — the old agent address then stops
 * working, so only do that before the agent is authorised on-chain).
 *
 * The generated agent wallet is funded later by scripts/setup-demo.ts
 * (an EVM transfer from the owner); the agent's PQC key is registered
 * with `npm run window-agent register` (its first transaction).
 */
import { deriveUnifiedAccount } from "@qorechain/sdk";
import { english, generateMnemonic, mnemonicToAccount } from "viem/accounts";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(dir, "..");
const parent = path.resolve(root, "..");
const force = process.argv.includes("--force");

function mustNotExist(file: string, label: string): void {
  if (!force && fs.existsSync(file)) {
    throw new Error(`${label} already exists (${file}). Refusing to overwrite; use --force to regenerate.`);
  }
}

function writeSecret(file: string, content: string): void {
  fs.writeFileSync(file, content, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
}

async function main(): Promise<void> {
  const deployerFile = path.join(parent, "deployer.json");
  if (!fs.existsSync(deployerFile)) {
    throw new Error(`Owner wallet not found: ${deployerFile}`);
  }
  const deployer = JSON.parse(fs.readFileSync(deployerFile, "utf8")) as {
    mnemonic: string;
    evm: string;
    cosmos: string;
  };
  if (!deployer.mnemonic || !deployer.evm) {
    throw new Error("deployer.json is missing mnemonic or evm.");
  }

  const envFile = path.join(root, ".env");
  const envAgentFile = path.join(root, ".env.agent");
  const agentFile = path.join(parent, "agent.json");
  mustNotExist(envFile, "Owner .env");
  mustNotExist(envAgentFile, "Agent .env.agent");
  mustNotExist(agentFile, "Agent wallet");

  // Owner: verify the mnemonic derives the recorded addresses, then write .env.
  const ownerUnified = await deriveUnifiedAccount(deployer.mnemonic, 0);
  if (ownerUnified.evm.toLowerCase() !== deployer.evm.toLowerCase()) {
    throw new Error("deployer.json mnemonic does not derive the recorded EVM address; refusing to continue.");
  }
  const ownerKey = mnemonicToAccount(deployer.mnemonic).getHdKey().privateKey;
  if (!ownerKey) throw new Error("Could not derive the owner private key.");

  // Agent: a fresh wallet, independent from the owner.
  const agentMnemonic = generateMnemonic(english);
  const agentUnified = await deriveUnifiedAccount(agentMnemonic, 0);
  const agentKey = mnemonicToAccount(agentMnemonic).getHdKey().privateKey;
  if (!agentKey) throw new Error("Could not derive the agent private key.");

  writeSecret(
    agentFile,
    JSON.stringify(
      { mnemonic: agentMnemonic, evm: agentUnified.evm, cosmos: agentUnified.cosmos },
      null,
      2,
    ) + "\n",
  );

  const ownerEnv = [
    "QORE_EVM_RPC_URL=https://evm-testnet.qore.host",
    `QORE_EVM_PRIVATE_KEY=0x${Buffer.from(ownerKey).toString("hex")}`,
    `QORE_MNEMONIC=${deployer.mnemonic}`,
    "QORE_NETWORK=testnet",
    "QORE_WINDOW_BLOCKS=1200",
    "QORE_WINDOW_TXS=10",
    `AGENT_ADDRESS=${agentUnified.evm}`,
    "",
  ].join("\n");
  writeSecret(envFile, ownerEnv);

  const agentEnv = [
    "QORE_EVM_RPC_URL=https://evm-testnet.qore.host",
    `QORE_EVM_PRIVATE_KEY=0x${Buffer.from(agentKey).toString("hex")}`,
    `QORE_MNEMONIC=${agentMnemonic}`,
    "QORE_NETWORK=testnet",
    "QORE_WINDOW_BLOCKS=1200",
    "QORE_WINDOW_TXS=10",
    `QORE_AGENT_COSMOS=${agentUnified.cosmos}`,
    "",
  ].join("\n");
  writeSecret(envAgentFile, agentEnv);

  console.log("Wrote .env, .env.agent (mode 600) and ../agent.json (mode 600).");
  console.log(`owner: ${ownerUnified.evm} (${ownerUnified.cosmos})`);
  console.log(`agent: ${agentUnified.evm} (${agentUnified.cosmos})`);
  console.log("Next: fund the agent with `npm run setup-demo` (after deploy),");
  console.log("then `npm run window-agent register` and `npm run window-agent open`.");
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
