/**
 * attack-battery.test.ts - adversarial + model-based tests for the
 * BillPayGuard contract on a local in-memory Ganache chain (plain EVM, no
 * PQC window: the window is a QoreChain admission rule, not contract logic).
 *
 * Two batteries:
 *
 * 1. "attack battery" — targeted attacks, one test per attack: a reentrant
 *    payee, a reentrant withdrawer, nonexistent schedules, cross-owner
 *    agent calls, invalid schedule changes, event correctness, shared
 *    balance contention, and the interval-0 boundary.
 *
 * 2. "model-based fuzz battery" — three seeded runs of 150 random
 *    operations each against an off-chain model of the contract. Every
 *    operation's outcome (success / revert) is predicted from the model
 *    before it is sent, and the model's invariants (paid <= cap,
 *    payments <= max, exact balance accounting, totals match) are
 *    re-checked against the chain throughout. Deterministic: the same
 *    seed always runs the same operations.
 *
 * The accounts are Ganache's built-in deterministic test accounts. They
 * are public test keys that exist only on this throwaway local chain;
 * they are NEVER funded anywhere and must never be used on testnet or
 * mainnet.
 *
 * Run: npm test
 */
import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import Ganache from "ganache";
import {
  createPublicClient,
  createWalletClient,
  custom,
  decodeEventLog,
  defineChain,
  encodeFunctionData,
  parseEther,
  type Abi,
  type Address,
  type Hex,
} from "viem";
import { mnemonicToAccount } from "viem/accounts";
import { billPayGuardAbi, billPayGuardBytecode } from "../contracts/BillPayGuard.artifact.js";
import {
  reentrantPayeeAbi,
  reentrantPayeeBytecode,
  reentrantWithdrawerAbi,
  reentrantWithdrawerBytecode,
} from "../contracts/test/ReentrantAttacker.artifact.js";

/**
 * The well-known public test mnemonic (Hardhat's default). It funds NOTHING
 * outside this throwaway local chain. Never use this mnemonic anywhere else.
 */
const TEST_MNEMONIC = "test test test test test test test test test test test junk";

/** The contract ABI through viem's loose `Abi` type. */
const abi = billPayGuardAbi as unknown as Abi;
const payeeAbi = reentrantPayeeAbi as unknown as Abi;
const withdrawerAbi = reentrantWithdrawerAbi as unknown as Abi;

const localChain = defineChain({
  id: 1337,
  name: "Ganache Local",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["http://127.0.0.1:8545"] } },
});

type Clients = ReturnType<typeof createClients>;
type TestAccount = ReturnType<typeof mnemonicToAccount>;

function createClients(provider: ReturnType<typeof Ganache.provider>) {
  const transport = custom(provider as never);
  return {
    public: createPublicClient({ chain: localChain, transport }),
    wallet: createWalletClient({ chain: localChain, transport }),
  };
}

/** Advance the local chain's clock by `seconds` and mine a block. */
async function increaseTime(clients: Clients, seconds: number): Promise<void> {
  await clients.public.transport.request({ method: "evm_increaseTime", params: [seconds] });
  await clients.public.transport.request({ method: "evm_mine", params: [] });
}

async function latestTimestamp(clients: Clients): Promise<bigint> {
  const block = await clients.public.getBlock();
  return block.timestamp;
}

/**
 * Send a signed transaction straight through the Ganache provider and
 * return its receipt. viem's writeContract takes ~1s per call against
 * this in-process provider (its request preparation stalls on it);
 * signing locally and sending the raw transaction takes ~10ms
 * (measured 25 Nov 2026). Ganache mines instantly, so the receipt is
 * fetched right away. Gas is fixed at 800000: every call in this file
 * fits comfortably inside it, including the re-entrant ones.
 */
async function sendSigned(
  clients: Clients,
  contract: Address,
  contractAbi: Abi,
  functionName: string,
  args: unknown[],
  account: TestAccount,
  value?: bigint,
) {
  const data = encodeFunctionData({ abi: contractAbi, functionName, args });
  const nonce = await clients.public.getTransactionCount({ address: account.address });
  const raw = await account.signTransaction({
    to: contract,
    data,
    value: value ?? 0n,
    gas: 800000n,
    maxFeePerGas: 1000000000n,
    maxPriorityFeePerGas: 1000000000n,
    nonce,
    chainId: localChain.id,
    type: "eip1559",
  });
  const hash = (await clients.public.transport.request({
    method: "eth_sendRawTransaction",
    params: [raw],
  })) as Hex;
  return clients.public.waitForTransactionReceipt({ hash });
}

/**
 * Send a write with an explicit gas limit and return the receipt status.
 * Used for both expected successes and expected reverts, so the caller
 * can compare the outcome against a prediction.
 */
async function sendRaw(
  clients: Clients,
  contract: Address,
  contractAbi: Abi,
  functionName: string,
  args: unknown[],
  account: TestAccount,
  value?: bigint,
): Promise<"success" | "reverted"> {
  const receipt = await sendSigned(clients, contract, contractAbi, functionName, args, account, value);
  return receipt.status;
}

/** Send a write that must succeed, and return the receipt. */
async function writeOk(
  clients: Clients,
  contract: Address,
  contractAbi: Abi,
  functionName: string,
  args: unknown[],
  account: TestAccount,
  value?: bigint,
) {
  const receipt = await sendSigned(clients, contract, contractAbi, functionName, args, account, value);
  assert.equal(receipt.status, "success", `${functionName} receipt status`);
  return receipt;
}

async function readGuard(clients: Clients, contract: Address, functionName: string, args: unknown[] = []): Promise<unknown> {
  return clients.public.readContract({ address: contract, abi, functionName, args });
}

async function readGuardBigint(clients: Clients, contract: Address, functionName: string, args: unknown[] = []): Promise<bigint> {
  return (await readGuard(clients, contract, functionName, args)) as bigint;
}

async function deployGuard(clients: Clients, owner: TestAccount): Promise<Address> {
  const hash = await clients.wallet.deployContract({
    abi: billPayGuardAbi,
    bytecode: billPayGuardBytecode as Hex,
    account: owner,
    chain: localChain,
  });
  const receipt = await clients.public.waitForTransactionReceipt({ hash });
  assert.ok(receipt.contractAddress, "deployment receipt has no contract address");
  assert.equal(receipt.status, "success");
  return receipt.contractAddress;
}

/** Decode the BillPayGuard events from a receipt (other logs are ignored). */
function decodeLogs(receipt: { logs: Array<{ data: Hex; topics: Hex[] }> }): Array<{
  eventName: string;
  args: unknown;
}> {
  const out: Array<{ eventName: string; args: unknown }> = [];
  for (const log of receipt.logs) {
    try {
      const e = decodeEventLog({
        abi: billPayGuardAbi,
        data: log.data,
        topics: log.topics as [Hex, ...Hex[]],
      });
      out.push({ eventName: e.eventName, args: e.args });
    } catch {
      // Not a BillPayGuard event; ignore.
    }
  }
  return out;
}

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as Address;

describe("attack battery", () => {
  let clients: Clients;
  let contract: Address;
  let owner: TestAccount;
  let agent: TestAccount;
  let landlord: TestAccount;
  let stranger: TestAccount;
  let ownerB: TestAccount;
  let agentB: TestAccount;

  before(async () => {
    const provider = Ganache.provider({
      wallet: { mnemonic: TEST_MNEMONIC },
      logging: { quiet: true },
    });
    clients = createClients(provider);
    owner = mnemonicToAccount(TEST_MNEMONIC, { addressIndex: 0 });
    agent = mnemonicToAccount(TEST_MNEMONIC, { addressIndex: 1 });
    landlord = mnemonicToAccount(TEST_MNEMONIC, { addressIndex: 2 });
    stranger = mnemonicToAccount(TEST_MNEMONIC, { addressIndex: 3 });
    ownerB = mnemonicToAccount(TEST_MNEMONIC, { addressIndex: 4 });
    agentB = mnemonicToAccount(TEST_MNEMONIC, { addressIndex: 5 });
    contract = await deployGuard(clients, owner);
  });

  async function write(functionName: string, args: unknown[], account: TestAccount, value?: bigint) {
    return writeOk(clients, contract, abi, functionName, args, account, value);
  }

  async function readBigint(functionName: string, args: unknown[] = []): Promise<bigint> {
    return readGuardBigint(clients, contract, functionName, args);
  }

  async function nextScheduleId(): Promise<bigint> {
    return readBigint("scheduleCount");
  }

  it("a reentrant payee cannot double-pay: the payment lands exactly once", async () => {
    // Deploy the malicious payee, then point it at the schedule we are
    // about to create for it.
    const attackerHash = await clients.wallet.deployContract({
      abi: reentrantPayeeAbi,
      bytecode: reentrantPayeeBytecode as Hex,
      args: [contract],
      account: owner,
      chain: localChain,
    });
    const attackerReceipt = await clients.public.waitForTransactionReceipt({ hash: attackerHash });
    const attacker = attackerReceipt.contractAddress as Address;
    assert.ok(attacker, "attacker deployment has an address");

    await write("deposit", [], owner, parseEther("1"));
    const id = await nextScheduleId();
    const now = await latestTimestamp(clients);
    await write("createSchedule", [
      attacker, parseEther("0.1"), parseEther("0.5"), 5n, 0n, now + 86400n,
    ], owner);
    await writeOk(clients, attacker, payeeAbi, "arm", [id], owner);

    const before = await clients.public.getBalance({ address: attacker });
    const receipt = await write("executePayment", [id], owner);
    assert.equal(receipt.status, "success");

    // The payment landed exactly once.
    assert.equal(await readBigint("totalPayments"), 1n);
    assert.equal(await readBigint("totalVolume"), parseEther("0.1"));
    const after = await clients.public.getBalance({ address: attacker });
    assert.equal(after - before, parseEther("0.1"), "attacker must receive exactly one payment");

    // The re-entry was attempted once and never succeeded.
    const attempts = (await clients.public.readContract({
      address: attacker, abi: payeeAbi, functionName: "reentryAttempts", args: [],
    })) as bigint;
    const successes = (await clients.public.readContract({
      address: attacker, abi: payeeAbi, functionName: "reentrySuccesses", args: [],
    })) as bigint;
    assert.equal(attempts, 1n, "the payee tried to re-enter once");
    assert.equal(successes, 0n, "the re-entry must never succeed");
  });

  it("a reentrant withdrawer cannot drain: the withdrawal lands exactly once", async () => {
    const attackerHash = await clients.wallet.deployContract({
      abi: reentrantWithdrawerAbi,
      bytecode: reentrantWithdrawerBytecode as Hex,
      args: [contract],
      account: owner,
      chain: localChain,
    });
    const attackerReceipt = await clients.public.waitForTransactionReceipt({ hash: attackerHash });
    const attacker = attackerReceipt.contractAddress as Address;
    assert.ok(attacker, "attacker deployment has an address");

    // Fund the attacker's guard balance (0.5 QOR) through its own deposit().
    await writeOk(clients, attacker, withdrawerAbi, "deposit", [], owner, parseEther("0.5"));
    assert.equal(await readBigint("balances", [attacker]), parseEther("0.5"));

    const before = await clients.public.getBalance({ address: attacker });
    await writeOk(clients, attacker, withdrawerAbi, "attack", [parseEther("0.2")], owner);

    // Exactly 0.2 left the guard; the re-entry never took a second wei.
    assert.equal(await readBigint("balances", [attacker]), parseEther("0.3"));
    const after = await clients.public.getBalance({ address: attacker });
    assert.equal(after - before, parseEther("0.2"), "attacker must receive exactly the withdrawal");

    const attempts = (await clients.public.readContract({
      address: attacker, abi: withdrawerAbi, functionName: "reentryAttempts", args: [],
    })) as bigint;
    const successes = (await clients.public.readContract({
      address: attacker, abi: withdrawerAbi, functionName: "reentrySuccesses", args: [],
    })) as bigint;
    assert.equal(attempts, 1n, "the withdrawer tried to re-enter once");
    assert.equal(successes, 0n, "the re-entry must never succeed");
  });

  it("a nonexistent schedule can never pay", async () => {
    const status = await sendRaw(clients, contract, abi, "executePayment", [999n], owner);
    assert.equal(status, "reverted", "executing a nonexistent schedule must revert");
    const [due, reason] = (await readGuard(clients, contract, "checkDue", [999n])) as [boolean, string];
    assert.equal(due, false);
    assert.equal(reason, "inactive");
    const s = (await readGuard(clients, contract, "getSchedule", [999n])) as unknown as { active: boolean };
    assert.equal(s.active, false);
  });

  it("one owner's agent cannot pay another owner's schedule", async () => {
    await write("deposit", [], ownerB, parseEther("1"));
    const now = await latestTimestamp(clients);
    const idB = await nextScheduleId();
    await write("createSchedule", [
      landlord.address, parseEther("0.1"), parseEther("0.5"), 5n, 0n, now + 86400n,
    ], ownerB);
    // Owner A's agent is authorised by A only.
    await write("setAgent", [agent.address], owner);
    await write("setAgent", [agentB.address], ownerB);

    // A's agent cannot pay B's schedule, and B's agent cannot pay A's.
    assert.equal(await sendRaw(clients, contract, abi, "executePayment", [idB], agent), "reverted");
    assert.equal(await sendRaw(clients, contract, abi, "executePayment", [0n], agentB), "reverted");

    // Each agent can pay its own owner's schedule.
    assert.equal(await sendRaw(clients, contract, abi, "executePayment", [idB], agentB), "success");
    assert.equal(await readBigint("totalPayments"), 2n);
    await write("revokeAgent", [], owner);
    await write("revokeAgent", [], ownerB);
  });

  it("updateSchedule refuses every invalid change", async () => {
    const now = await latestTimestamp(clients);
    const id = await nextScheduleId();
    await write("createSchedule", [
      landlord.address, parseEther("0.05"), parseEther("0.5"), 5n, 0n, now + 86400n,
    ], owner);
    // Two payments, so maxPayments below 2 is an invalid change.
    await write("executePayment", [id], owner);
    await write("executePayment", [id], owner);

    const t = await latestTimestamp(clients);
    // maxPayments below the payments already made.
    assert.equal(
      await sendRaw(clients, contract, abi, "updateSchedule", [id, parseEther("0.05"), parseEther("0.5"), 1n, 0n, t + 86400n], owner),
      "reverted",
    );
    // maxPayments zero.
    assert.equal(
      await sendRaw(clients, contract, abi, "updateSchedule", [id, parseEther("0.05"), parseEther("0.5"), 0n, 0n, t + 86400n], owner),
      "reverted",
    );
    // amount zero.
    assert.equal(
      await sendRaw(clients, contract, abi, "updateSchedule", [id, 0n, parseEther("0.5"), 5n, 0n, t + 86400n], owner),
      "reverted",
    );
    // cap below the per-payment amount.
    assert.equal(
      await sendRaw(clients, contract, abi, "updateSchedule", [id, parseEther("0.05"), parseEther("0.01"), 5n, 0n, t + 86400n], owner),
      "reverted",
    );
    // expiry in the past.
    assert.equal(
      await sendRaw(clients, contract, abi, "updateSchedule", [id, parseEther("0.05"), parseEther("0.5"), 5n, 0n, t - 1n], owner),
      "reverted",
    );
    // On an inactive schedule.
    await write("cancelSchedule", [id], owner);
    assert.equal(
      await sendRaw(clients, contract, abi, "updateSchedule", [id, parseEther("0.05"), parseEther("0.5"), 5n, 0n, t + 86400n], owner),
      "reverted",
    );
  });

  it("cancelSchedule twice: the second cancel reverts", async () => {
    const now = await latestTimestamp(clients);
    const id = await nextScheduleId();
    await write("createSchedule", [
      landlord.address, parseEther("0.05"), parseEther("0.5"), 5n, 0n, now + 86400n,
    ], owner);
    await write("cancelSchedule", [id], owner);
    assert.equal(await sendRaw(clients, contract, abi, "cancelSchedule", [id], owner), "reverted");
    const [due, reason] = (await readGuard(clients, contract, "checkDue", [id])) as [boolean, string];
    assert.equal(due, false);
    assert.equal(reason, "inactive");
  });

  it("only the owner changes a schedule or the agent", async () => {
    const now = await latestTimestamp(clients);
    const id = await nextScheduleId();
    await write("createSchedule", [
      landlord.address, parseEther("0.05"), parseEther("0.5"), 5n, 0n, now + 86400n,
    ], owner);
    await write("setAgent", [agent.address], owner);

    // The agent can pay, but cannot change limits or cancel.
    const t = await latestTimestamp(clients);
    assert.equal(
      await sendRaw(clients, contract, abi, "updateSchedule", [id, parseEther("0.05"), parseEther("0.5"), 5n, 0n, t + 86400n], agent),
      "reverted",
    );
    assert.equal(await sendRaw(clients, contract, abi, "cancelSchedule", [id], agent), "reverted");

    // A stranger revoking "the agent" only clears their own (empty) slot:
    // the owner's agent is untouched.
    await writeOk(clients, contract, abi, "revokeAgent", [], stranger);
    const stillAgent = (await readGuard(clients, contract, "agents", [owner.address])) as string;
    assert.equal(stillAgent.toLowerCase(), agent.address.toLowerCase());
    await write("revokeAgent", [], owner);
  });

  it("ScheduleUpdated, ScheduleCancelled, AgentSet and AgentRevoked events carry the right data", async () => {
    const now = await latestTimestamp(clients);
    const id = await nextScheduleId();
    await write("createSchedule", [
      landlord.address, parseEther("0.05"), parseEther("0.5"), 5n, 0n, now + 86400n,
    ], owner);

    const t = await latestTimestamp(clients);
    const updatedReceipt = await write("updateSchedule", [
      id, parseEther("0.06"), parseEther("0.6"), 6n, 30n, t + 90000n,
    ], owner);
    const updated = decodeLogs(updatedReceipt).filter((e) => e.eventName === "ScheduleUpdated");
    assert.equal(updated.length, 1);
    const u = updated[0].args as unknown as {
      scheduleId: bigint; amountPerPayment: bigint; totalCap: bigint;
      maxPayments: bigint; intervalSeconds: bigint; expiry: bigint;
    };
    assert.equal(u.scheduleId, id);
    assert.equal(u.amountPerPayment, parseEther("0.06"));
    assert.equal(u.totalCap, parseEther("0.6"));
    assert.equal(u.maxPayments, 6n);
    assert.equal(u.intervalSeconds, 30n);

    const setReceipt = await write("setAgent", [agent.address], owner);
    const set = decodeLogs(setReceipt).filter((e) => e.eventName === "AgentSet");
    assert.equal(set.length, 1);
    const s = set[0].args as unknown as { owner: string; agent: string };
    assert.equal(s.owner.toLowerCase(), owner.address.toLowerCase());
    assert.equal(s.agent.toLowerCase(), agent.address.toLowerCase());

    const revokeReceipt = await write("revokeAgent", [], owner);
    const revoked = decodeLogs(revokeReceipt).filter((e) => e.eventName === "AgentRevoked");
    assert.equal(revoked.length, 1);

    const cancelReceipt = await write("cancelSchedule", [id], owner);
    const cancelled = decodeLogs(cancelReceipt).filter((e) => e.eventName === "ScheduleCancelled");
    assert.equal(cancelled.length, 1);
    assert.equal((cancelled[0].args as unknown as { scheduleId: bigint }).scheduleId, id);
  });

  it("updateSchedule changes the limits but never the payee", async () => {
    const now = await latestTimestamp(clients);
    const id = await nextScheduleId();
    await write("createSchedule", [
      landlord.address, parseEther("0.05"), parseEther("0.5"), 5n, 0n, now + 86400n,
    ], owner);
    const t = await latestTimestamp(clients);
    await write("updateSchedule", [
      id, parseEther("0.08"), parseEther("0.8"), 8n, 0n, t + 90000n,
    ], owner);
    const s = (await readGuard(clients, contract, "getSchedule", [id])) as unknown as {
      payee: string; amountPerPayment: bigint; totalCap: bigint; maxPayments: bigint;
    };
    assert.equal(s.payee.toLowerCase(), landlord.address.toLowerCase(), "the payee must never change");
    assert.equal(s.amountPerPayment, parseEther("0.08"));
    assert.equal(s.totalCap, parseEther("0.8"));
    assert.equal(s.maxPayments, 8n);

    // The next payment uses the new amount.
    const before = await clients.public.getBalance({ address: landlord.address });
    await write("executePayment", [id], owner);
    const after = await clients.public.getBalance({ address: landlord.address });
    assert.equal(after - before, parseEther("0.08"));
  });

  it("two schedules share one balance: paying one can starve the other", async () => {
    // Fresh owner with exactly 0.15 QOR and two 0.1 QOR schedules.
    await write("deposit", [], stranger, parseEther("0.15"));
    const now = await latestTimestamp(clients);
    const idA = await nextScheduleId();
    await write("createSchedule", [
      landlord.address, parseEther("0.1"), parseEther("0.5"), 5n, 0n, now + 86400n,
    ], stranger);
    const idB = await nextScheduleId();
    await write("createSchedule", [
      landlord.address, parseEther("0.1"), parseEther("0.5"), 5n, 0n, now + 86400n,
    ], stranger);

    await write("executePayment", [idA], stranger);
    // 0.05 left: schedule B honestly reports insufficient-balance.
    const [due, reason] = (await readGuard(clients, contract, "checkDue", [idB])) as [boolean, string];
    assert.equal(due, false);
    assert.equal(reason, "insufficient-balance");
    assert.equal(await sendRaw(clients, contract, abi, "executePayment", [idB], stranger), "reverted");

    // Top up and B pays.
    await write("deposit", [], stranger, parseEther("0.1"));
    const [due2] = (await readGuard(clients, contract, "checkDue", [idB])) as [boolean, string];
    assert.equal(due2, true);
    await write("executePayment", [idB], stranger);
  });

  it("interval 0 pays back-to-back but still respects the cap", async () => {
    const now = await latestTimestamp(clients);
    const id = await nextScheduleId();
    await write("createSchedule", [
      landlord.address, parseEther("0.05"), parseEther("0.15"), 3n, 0n, now + 86400n,
    ], owner);
    // Three payments in a row, no time travel between them.
    await write("executePayment", [id], owner);
    await write("executePayment", [id], owner);
    await write("executePayment", [id], owner);
    const [due, reason] = (await readGuard(clients, contract, "checkDue", [id])) as [boolean, string];
    assert.equal(due, false);
    assert.equal(reason, "max-payments");
    assert.equal(await sendRaw(clients, contract, abi, "executePayment", [id], owner), "reverted");
    const s = (await readGuard(clients, contract, "getSchedule", [id])) as unknown as { paid: bigint; payments: bigint };
    assert.equal(s.paid, parseEther("0.15"));
    assert.equal(s.payments, 3n);
  });
});

/** Deterministic PRNG (mulberry32) — the same seed always runs the same ops. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type FuzzSchedule = {
  ownerIdx: number;
  payee: Address;
  amount: bigint;
  cap: bigint;
  max: bigint;
  interval: bigint;
  expiry: bigint;
  paid: bigint;
  payments: bigint;
  lastPaidAt: bigint;
  active: boolean;
};

type FuzzModel = {
  balances: bigint[]; // per account index
  agents: (number | null)[]; // per owner index -> agent index
  schedules: FuzzSchedule[];
};

describe("model-based fuzz battery", () => {
  let clients: Clients;
  let accounts: TestAccount[];

  before(async () => {
    const provider = Ganache.provider({
      wallet: { mnemonic: TEST_MNEMONIC },
      logging: { quiet: true },
    });
    clients = createClients(provider);
    accounts = [0, 1, 2, 3, 4, 5].map((i) => mnemonicToAccount(TEST_MNEMONIC, { addressIndex: i }));
  });

  /**
   * Run one seeded fuzz run: `rounds` random operations against a fresh
   * guard, each outcome predicted from an off-chain model before it is
   * sent. Returns the outcome counts (the test asserts the battery
   * exercised both successes and refusals).
   */
  async function runFuzzSeed(
    seed: number,
    rounds: number,
  ): Promise<{ succeeded: number; reverted: number; skipped: number }> {
    const contract = await deployGuard(clients, accounts[0]);
    const rand = mulberry32(seed);
    const pick = <T>(arr: T[]): T => arr[Math.floor(rand() * arr.length)];
    const randInt = (min: number, max: number) => min + Math.floor(rand() * (max - min + 1));
    /** n hundredths of a QOR, in wei. */
    const q = (n: number) => BigInt(n) * 10n ** 16n;
    const landlord = accounts[2].address;
    const strangerIdx = 3;
    const owners = [0, 4];
    const agentOf = (ownerIdx: number) => (ownerIdx === 0 ? 1 : 5);

    const model: FuzzModel = {
      balances: accounts.map(() => 0n),
      agents: accounts.map(() => null),
      schedules: [],
    };
    let succeeded = 0;
    let reverted = 0;
    let skipped = 0;

    /** Would executePayment succeed for this caller right now, per the model? */
    function paymentWouldSucceed(s: FuzzSchedule | undefined, callerIdx: number, now: bigint): boolean {
      if (s === undefined) return false; // nonexistent schedule: NotAuthorized
      if (callerIdx !== s.ownerIdx && callerIdx !== model.agents[s.ownerIdx]) return false;
      if (!s.active) return false;
      if (now > s.expiry) return false;
      if (s.payments >= s.max) return false;
      if (now < s.lastPaidAt + s.interval) return false;
      if (s.paid + s.amount > s.cap) return false;
      if (model.balances[s.ownerIdx] < s.amount) return false;
      return true;
    }

    /** Re-read the whole contract state and compare it to the model. */
    async function checkInvariants(): Promise<void> {
      for (let i = 0; i < model.schedules.length; i++) {
        const m = model.schedules[i];
        const s = (await readGuard(clients, contract, "getSchedule", [BigInt(i)])) as unknown as {
          owner: string; payee: string; amountPerPayment: bigint; totalCap: bigint;
          maxPayments: bigint; intervalSeconds: bigint; expiry: bigint; paid: bigint;
          payments: bigint; lastPaidAt: bigint; active: boolean;
        };
        assert.equal(s.owner.toLowerCase(), accounts[m.ownerIdx].address.toLowerCase(), `schedule ${i} owner`);
        assert.equal(s.payee.toLowerCase(), m.payee.toLowerCase(), `schedule ${i} payee`);
        assert.equal(s.amountPerPayment, m.amount, `schedule ${i} amount`);
        assert.equal(s.totalCap, m.cap, `schedule ${i} cap`);
        assert.equal(s.maxPayments, m.max, `schedule ${i} max`);
        assert.equal(s.intervalSeconds, m.interval, `schedule ${i} interval`);
        assert.equal(s.expiry, m.expiry, `schedule ${i} expiry`);
        assert.equal(s.paid, m.paid, `schedule ${i} paid`);
        assert.equal(s.payments, m.payments, `schedule ${i} payments`);
        assert.equal(s.lastPaidAt, m.lastPaidAt, `schedule ${i} lastPaidAt`);
        assert.equal(s.active, m.active, `schedule ${i} active`);
        assert.ok(s.paid <= s.totalCap, `schedule ${i}: paid must never exceed the cap`);
        assert.ok(s.payments <= s.maxPayments, `schedule ${i}: payments must never exceed the max`);
      }
      for (const o of owners) {
        assert.equal(
          await readGuardBigint(clients, contract, "balances", [accounts[o].address]),
          model.balances[o],
          `owner ${o} balance`,
        );
      }
      const totalPayments = model.schedules.reduce((a, s) => a + s.payments, 0n);
      const totalVolume = model.schedules.reduce((a, s) => a + s.paid, 0n);
      assert.equal(await readGuardBigint(clients, contract, "totalPayments"), totalPayments, "totalPayments");
      assert.equal(await readGuardBigint(clients, contract, "totalVolume"), totalVolume, "totalVolume");
      assert.equal(
        await readGuardBigint(clients, contract, "scheduleCount"),
        BigInt(model.schedules.length),
        "scheduleCount",
      );
    }

    for (let round = 0; round < rounds; round++) {
      const now = await latestTimestamp(clients);
      const roll = rand();

      if (roll < 0.1) {
        // Deposit (always succeeds for a positive amount).
        const ownerIdx = pick(owners);
        const amount = q(randInt(5, 50));
        const status = await sendRaw(clients, contract, abi, "deposit", [], accounts[ownerIdx], amount);
        assert.equal(status, "success", `round ${round}: deposit must succeed`);
        model.balances[ownerIdx] += amount;
        succeeded++;
      } else if (roll < 0.18) {
        // Withdraw (succeeds iff 0 < amount <= balance).
        const ownerIdx = pick(owners);
        const balanceUnits = Number(model.balances[ownerIdx] / 10n ** 16n);
        const amount = q(randInt(0, balanceUnits + 10));
        const expected = amount > 0n && amount <= model.balances[ownerIdx];
        const status = await sendRaw(clients, contract, abi, "withdraw", [amount], accounts[ownerIdx]);
        assert.equal(status, expected ? "success" : "reverted", `round ${round}: withdraw ${amount} vs balance ${model.balances[ownerIdx]}`);
        if (expected) {
          model.balances[ownerIdx] -= amount;
          succeeded++;
        } else {
          reverted++;
        }
      } else if (roll < 0.33) {
        // Create a schedule (sometimes with invalid parameters).
        const ownerIdx = pick(owners);
        const payee = rand() < 0.05 ? ZERO_ADDRESS : landlord;
        const amount = rand() < 0.05 ? 0n : q(randInt(1, 10));
        const cap =
          rand() < 0.05 ? (amount > 0n ? amount - q(1) : 0n) : amount * BigInt(randInt(1, 5));
        const max = rand() < 0.05 ? 0n : BigInt(randInt(1, 5));
        const interval = BigInt(pick([0, 30, 60, 300]));
        const expiry =
          rand() < 0.05 ? now - BigInt(randInt(1, 60)) : now + BigInt(randInt(60, 86400));
        const expected =
          payee !== ZERO_ADDRESS && amount > 0n && cap >= amount && max > 0n && expiry > now;
        const status = await sendRaw(
          clients, contract, abi, "createSchedule",
          [payee, amount, cap, max, interval, expiry], accounts[ownerIdx],
        );
        assert.equal(status, expected ? "success" : "reverted", `round ${round}: createSchedule`);
        if (expected) {
          model.schedules.push({
            ownerIdx, payee, amount, cap, max, interval, expiry,
            paid: 0n, payments: 0n, lastPaidAt: 0n, active: true,
          });
          succeeded++;
        } else {
          reverted++;
        }
      } else if (roll < 0.45) {
        // Update a schedule (sometimes nonexistent, sometimes by a non-owner).
        const exists = model.schedules.length > 0 && rand() < 0.8;
        const id = exists ? randInt(0, model.schedules.length - 1) : model.schedules.length + randInt(0, 2);
        const s = model.schedules[id];
        const callerIdx = s !== undefined && rand() < 0.7 ? s.ownerIdx : strangerIdx;
        const amount = rand() < 0.05 ? 0n : q(randInt(1, 10));
        const cap =
          rand() < 0.05 ? q(randInt(0, 2)) : amount * BigInt(randInt(1, 5)) + (s?.paid ?? 0n);
        const max = rand() < 0.05 ? 0n : BigInt(randInt(1, 5)) + (s?.payments ?? 0n);
        const interval = BigInt(pick([0, 30, 60, 300]));
        const expiry =
          rand() < 0.05 ? now - BigInt(randInt(1, 60)) : now + BigInt(randInt(60, 86400));
        const expected =
          s !== undefined &&
          callerIdx === s.ownerIdx &&
          s.active &&
          amount > 0n &&
          cap >= s.paid &&
          cap >= amount &&
          max >= s.payments &&
          max > 0n &&
          expiry > now;
        const status = await sendRaw(
          clients, contract, abi, "updateSchedule",
          [BigInt(id), amount, cap, max, interval, expiry], accounts[callerIdx],
        );
        assert.equal(status, expected ? "success" : "reverted", `round ${round}: updateSchedule ${id}`);
        if (expected && s !== undefined) {
          s.amount = amount;
          s.cap = cap;
          s.max = max;
          s.interval = interval;
          s.expiry = expiry;
          succeeded++;
        } else {
          reverted++;
        }
      } else if (roll < 0.51) {
        // Cancel a schedule.
        const exists = model.schedules.length > 0 && rand() < 0.8;
        const id = exists ? randInt(0, model.schedules.length - 1) : model.schedules.length + randInt(0, 2);
        const s = model.schedules[id];
        const callerIdx = s !== undefined && rand() < 0.7 ? s.ownerIdx : strangerIdx;
        const expected = s !== undefined && callerIdx === s.ownerIdx && s.active;
        const status = await sendRaw(clients, contract, abi, "cancelSchedule", [BigInt(id)], accounts[callerIdx]);
        assert.equal(status, expected ? "success" : "reverted", `round ${round}: cancelSchedule ${id}`);
        if (expected && s !== undefined) {
          s.active = false;
          succeeded++;
        } else {
          reverted++;
        }
      } else if (roll < 0.57) {
        // Authorise an agent (sometimes the zero address).
        const ownerIdx = pick(owners);
        const agentIdx = rand() < 0.1 ? null : agentOf(ownerIdx);
        const agentAddr = agentIdx === null ? ZERO_ADDRESS : accounts[agentIdx].address;
        const expected = agentIdx !== null;
        const status = await sendRaw(clients, contract, abi, "setAgent", [agentAddr], accounts[ownerIdx]);
        assert.equal(status, expected ? "success" : "reverted", `round ${round}: setAgent`);
        if (expected) {
          model.agents[ownerIdx] = agentIdx;
          succeeded++;
        } else {
          reverted++;
        }
      } else if (roll < 0.61) {
        // Revoke the agent (always succeeds).
        const ownerIdx = pick(owners);
        const status = await sendRaw(clients, contract, abi, "revokeAgent", [], accounts[ownerIdx]);
        assert.equal(status, "success", `round ${round}: revokeAgent must succeed`);
        model.agents[ownerIdx] = null;
        succeeded++;
      } else if (roll < 0.91) {
        // Execute a payment.
        const exists = model.schedules.length > 0 && rand() < 0.85;
        const id = exists ? randInt(0, model.schedules.length - 1) : model.schedules.length + randInt(0, 2);
        const s = model.schedules[id];
        const callerRoll = rand();
        const callerIdx =
          s === undefined
            ? pick([0, 1, 3, 4, 5])
            : callerRoll < 0.4
              ? s.ownerIdx
              : callerRoll < 0.7
                ? agentOf(s.ownerIdx)
                : strangerIdx;
        // Skip rounds where the outcome depends on a boundary less than
        // 10 seconds away: the block timestamp of the mined transaction
        // can drift a few seconds past the `now` read above.
        if (s !== undefined) {
          const intervalBoundary = s.lastPaidAt + s.interval - now;
          const expiryBoundary = s.expiry - now;
          if (
            (intervalBoundary > 0n && intervalBoundary <= 10n) ||
            (expiryBoundary > -10n && expiryBoundary <= 10n)
          ) {
            skipped++;
            continue;
          }
        }
        const expected = paymentWouldSucceed(s, callerIdx, now);
        const status = await sendRaw(clients, contract, abi, "executePayment", [BigInt(id)], accounts[callerIdx]);
        assert.equal(status, expected ? "success" : "reverted", `round ${round}: executePayment ${id} by ${callerIdx}`);
        if (expected && s !== undefined) {
          s.paid += s.amount;
          s.payments += 1n;
          s.lastPaidAt = await latestTimestamp(clients);
          model.balances[s.ownerIdx] -= s.amount;
          succeeded++;
        } else {
          reverted++;
        }
      } else {
        // Advance time.
        const seconds = pick([0, 30, 90, 400, 3700]);
        await increaseTime(clients, seconds);
        succeeded++;
      }

      if ((round + 1) % 10 === 0) {
        await checkInvariants();
      }
    }

    await checkInvariants();
    return { succeeded, reverted, skipped };
  }

  for (const seed of [1, 20261125, 987654321]) {
    it(`seed ${seed}: 150 random operations match the model, invariants hold`, async () => {
      const { succeeded, reverted, skipped } = await runFuzzSeed(seed, 150);
      assert.ok(succeeded > 20, `seed ${seed} should succeed often (got ${succeeded})`);
      assert.ok(reverted > 20, `seed ${seed} should refuse often (got ${reverted})`);
      assert.ok(skipped < 30, `seed ${seed} skipped too many boundary rounds (${skipped})`);
    });
  }
});
