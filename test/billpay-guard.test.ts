/**
 * billpay-guard.test.ts - end-to-end tests for the BillPayGuard contract on
 * a local in-memory Ganache chain (plain EVM, no PQC window: the window is
 * a QoreChain admission rule, not contract logic).
 *
 * The accounts are Ganache's built-in deterministic test accounts. They are
 * public test keys that exist only on this throwaway local chain; they are
 * NEVER funded anywhere and must never be used on testnet or mainnet.
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
  parseEther,
  type Abi,
  type Address,
  type Hex,
} from "viem";
import { mnemonicToAccount } from "viem/accounts";
import { billPayGuardAbi, billPayGuardBytecode } from "../contracts/BillPayGuard.artifact.js";

/**
 * The well-known public test mnemonic (Hardhat's default). It funds NOTHING
 * outside this throwaway local chain: Ganache mints its local accounts from
 * it, and viem derives the same local signers from it, so transactions go
 * through viem's local-account path (with gas estimation) exactly like the
 * real deploy script does. Never use this mnemonic anywhere else.
 */
const TEST_MNEMONIC = "test test test test test test test test test test test junk";

/** The contract ABI through viem's loose `Abi` type, so the test helpers
 *  can call any function by name without fighting the literal-type
 *  inference of the const-asserted artifact. */
const abi = billPayGuardAbi as unknown as Abi;

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

/** Assert that a write is mined with status "reverted" (the guard refused it).
 *  The call is sent with an explicit gas limit so it is broadcast instead of
 *  being dropped by gas estimation. Ganache returns only a generic revert
 *  for eth_estimateGas/eth_call, so the specific error name cannot be
 *  recovered here — the `checkDue` reason assertions in each test carry the
 *  reason coverage, and this assertion proves the on-chain refusal. */
async function assertReverts(
  clients: Clients,
  contract: Address,
  functionName: string,
  args: unknown[],
  account: TestAccount,
  value?: bigint,
): Promise<void> {
  const hash = await clients.wallet.writeContract({
    address: contract,
    abi,
    functionName,
    args,
    account,
    chain: localChain,
    gas: 500000n,
    ...(value !== undefined ? { value } : {}),
  });
  const receipt = await clients.public.waitForTransactionReceipt({ hash });
  assert.equal(receipt.status, "reverted", `${functionName} should revert on-chain`);
}

/** Decode the BillPayGuard events from a receipt (other logs are ignored). */
function decodeLogs(receipt: { logs: Array<{ data: Hex; topics: Hex[] }> }): Array<{
  eventName: string;
  args: unknown;
}> {
  const out: Array<{ eventName: string; args: unknown }> = [];
  for (const log of receipt.logs) {
    try {
      // decodeEventLog wants a non-empty topics tuple; a log with no topics
      // cannot be one of ours, so the cast is safe (it would throw below).
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

describe("BillPayGuard artifact", () => {
  it("exposes the expected ABI entries and non-empty bytecode", () => {
    const names = new Set(
      billPayGuardAbi
        .map((e) => ("name" in e ? (e as { name: string }).name : undefined))
        .filter((n): n is string => typeof n === "string"),
    );
    for (const name of [
      "deposit", "withdraw", "createSchedule", "updateSchedule", "cancelSchedule",
      "setAgent", "revokeAgent", "executePayment", "checkDue", "getSchedule",
      "schedules", "scheduleCount", "balances", "agents", "totalPayments",
      "totalVolume", "Deposited", "Withdrawn", "ScheduleCreated", "ScheduleUpdated",
      "ScheduleCancelled", "AgentSet", "AgentRevoked", "PaymentExecuted",
    ]) {
      assert.ok(names.has(name), `ABI is missing ${name}`);
    }
    assert.ok(billPayGuardBytecode.startsWith("0x"));
    assert.ok(billPayGuardBytecode.length > 100, "bytecode looks too short");
  });
});

describe("BillPayGuard contract", () => {
  let clients: Clients;
  let contract: Address;
  let owner: TestAccount;
  let agent: TestAccount;
  let landlord: TestAccount;
  let stranger: TestAccount;

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

    const hash = await clients.wallet.deployContract({
      abi: billPayGuardAbi,
      bytecode: billPayGuardBytecode as Hex,
      account: owner,
      chain: localChain,
    });
    const receipt = await clients.public.waitForTransactionReceipt({ hash });
    assert.ok(receipt.contractAddress, "deployment receipt has no contract address");
    contract = receipt.contractAddress;
    assert.equal(receipt.status, "success");
  });

  /** Send a write and wait for a successful receipt. */
  async function write(
    functionName: string,
    args: unknown[],
    account: TestAccount,
    value?: bigint,
  ) {
    const hash = await clients.wallet.writeContract({
      address: contract,
      abi,
      functionName,
      args,
      account,
      chain: localChain,
      ...(value !== undefined ? { value } : {}),
    });
    const receipt = await clients.public.waitForTransactionReceipt({ hash });
    assert.equal(receipt.status, "success", `${functionName} receipt status`);
    return receipt;
  }

  async function read(functionName: string, args: unknown[] = []): Promise<unknown> {
    return clients.public.readContract({
      address: contract,
      abi,
      functionName,
      args,
    });
  }

  async function readBigint(functionName: string, args: unknown[] = []): Promise<bigint> {
    return (await read(functionName, args)) as bigint;
  }

  async function readAddress(functionName: string, args: unknown[] = []): Promise<string> {
    return (await read(functionName, args)) as string;
  }

  async function checkDue(id: bigint): Promise<[boolean, string]> {
    return (await read("checkDue", [id])) as [boolean, string];
  }

  it("starts empty", async () => {
    assert.equal(await readBigint("scheduleCount"), 0n);
    assert.equal(await readBigint("totalPayments"), 0n);
    assert.equal(await readBigint("totalVolume"), 0n);
    assert.equal(await readBigint("balances", [owner.address]), 0n);
  });

  it("deposits and withdraws funds", async () => {
    await write("deposit", [], owner, parseEther("1"));
    assert.equal(await readBigint("balances", [owner.address]), parseEther("1"));
    await write("withdraw", [parseEther("0.25")], owner);
    assert.equal(await readBigint("balances", [owner.address]), parseEther("0.75"));
    await assertReverts(clients, contract, "withdraw", [parseEther("1")], owner);
  });

  it("rejects invalid schedules", async () => {
    const now = await latestTimestamp(clients);
    const expiry = now + 86400n;
    const zero = "0x0000000000000000000000000000000000000000" as Address;
    await assertReverts(clients, contract, "createSchedule", [zero, parseEther("0.1"), parseEther("1"), 10n, 60n, expiry], owner);
    await assertReverts(clients, contract, "createSchedule", [landlord.address, 0n, parseEther("1"), 10n, 60n, expiry], owner);
    await assertReverts(clients, contract, "createSchedule", [landlord.address, parseEther("0.5"), parseEther("0.1"), 10n, 60n, expiry], owner);
    await assertReverts(clients, contract, "createSchedule", [landlord.address, parseEther("0.1"), parseEther("1"), 0n, 60n, expiry], owner);
    await assertReverts(clients, contract, "createSchedule", [landlord.address, parseEther("0.1"), parseEther("1"), 10n, 60n, now - 1n], owner);
  });

  it("creates a schedule and authorises an agent", async () => {
    const now = await latestTimestamp(clients);
    const receipt = await write("createSchedule", [
      landlord.address, parseEther("0.1"), parseEther("0.25"), 5n, 60n, now + 86400n,
    ], owner);
    assert.equal(await readBigint("scheduleCount"), 1n);
    const created = decodeLogs(receipt).filter((e) => e.eventName === "ScheduleCreated");
    assert.equal(created.length, 1);
    const a = created[0].args as unknown as { scheduleId: bigint; payee: string };
    assert.equal(a.scheduleId, 0n);
    assert.equal(a.payee.toLowerCase(), landlord.address.toLowerCase());

    const s = (await read("getSchedule", [0n])) as unknown as {
      owner: string; payee: string; amountPerPayment: bigint; totalCap: bigint;
      maxPayments: bigint; intervalSeconds: bigint; paid: bigint; payments: bigint;
      active: boolean;
    };
    assert.equal(s.owner.toLowerCase(), owner.address.toLowerCase());
    assert.equal(s.amountPerPayment, parseEther("0.1"));
    assert.equal(s.totalCap, parseEther("0.25"));
    assert.equal(s.maxPayments, 5n);
    assert.equal(s.intervalSeconds, 60n);
    assert.equal(s.paid, 0n);
    assert.equal(s.payments, 0n);
    assert.equal(s.active, true);

    await write("setAgent", [agent.address], owner);
    assert.equal(
      (await readAddress("agents", [owner.address])).toLowerCase(),
      agent.address.toLowerCase(),
    );
  });

  it("only the owner or the authorised agent may execute a payment", async () => {
    await assertReverts(clients, contract, "executePayment", [0n], stranger);
  });

  it("executes a payment through the agent and pays only the allowlisted payee", async () => {
    const before = await clients.public.getBalance({ address: landlord.address });
    const receipt = await write("executePayment", [0n], agent);
    const after = await clients.public.getBalance({ address: landlord.address });
    assert.equal(after - before, parseEther("0.1"), "payee must receive exactly the scheduled amount");

    const paid = decodeLogs(receipt).filter((e) => e.eventName === "PaymentExecuted");
    assert.equal(paid.length, 1);
    const a = paid[0].args as unknown as { scheduleId: bigint; amount: bigint; paid: bigint; payments: bigint };
    assert.equal(a.scheduleId, 0n);
    assert.equal(a.amount, parseEther("0.1"));
    assert.equal(a.paid, parseEther("0.1"));
    assert.equal(a.payments, 1n);

    assert.equal(await readBigint("balances", [owner.address]), parseEther("0.65"));
    assert.equal(await readBigint("totalPayments"), 1n);
    assert.equal(await readBigint("totalVolume"), parseEther("0.1"));
  });

  it("rejects a payment before the interval has elapsed", async () => {
    const [due, reason] = await checkDue(0n);
    assert.equal(due, false);
    assert.equal(reason, "too-soon");
    await assertReverts(clients, contract, "executePayment", [0n], agent);
  });

  it("executes a second payment after the interval, then hits the total cap", async () => {
    await increaseTime(clients, 61);
    const [due] = await checkDue(0n);
    assert.equal(due, true);
    await write("executePayment", [0n], agent);
    assert.equal(await readBigint("totalPayments"), 2n);

    // Paid 0.2 of a 0.25 cap: one more 0.1 payment would exceed it.
    await increaseTime(clients, 61);
    const [due2, reason2] = await checkDue(0n);
    assert.equal(due2, false);
    assert.equal(reason2, "cap-reached");
    await assertReverts(clients, contract, "executePayment", [0n], agent);
  });

  it("lets the owner raise the cap, then enforces the payment count", async () => {
    const now = await latestTimestamp(clients);
    await write("updateSchedule", [
      0n, parseEther("0.1"), parseEther("1"), 2n, 60n, now + 86400n,
    ], owner);
    const [due, reason] = await checkDue(0n);
    assert.equal(due, false);
    assert.equal(reason, "max-payments");
    await assertReverts(clients, contract, "executePayment", [0n], agent);
  });

  it("rejects schedule changes from non-owners and caps below what is paid", async () => {
    const now = await latestTimestamp(clients);
    await assertReverts(clients, contract, "updateSchedule", [0n, parseEther("0.1"), parseEther("1"), 5n, 60n, now + 86400n], stranger);
    await assertReverts(clients, contract, "updateSchedule", [0n, parseEther("0.1"), parseEther("0.1"), 5n, 60n, now + 86400n], owner);
    await assertReverts(clients, contract, "cancelSchedule", [0n], stranger);
  });

  it("enforces expiry and cancellation", async () => {
    const now = await latestTimestamp(clients);
    await write("createSchedule", [
      landlord.address, parseEther("0.05"), parseEther("0.5"), 10n, 0n, now + 120n,
    ], owner);
    await increaseTime(clients, 180);
    const [due, reason] = await checkDue(1n);
    assert.equal(due, false);
    assert.equal(reason, "expired");
    await assertReverts(clients, contract, "executePayment", [1n], agent);

    await write("cancelSchedule", [0n], owner);
    const [due2, reason2] = await checkDue(0n);
    assert.equal(due2, false);
    assert.equal(reason2, "inactive");
    await assertReverts(clients, contract, "executePayment", [0n], agent);
  });

  it("revokes the agent: the owner can still pay, the agent cannot", async () => {
    const now = await latestTimestamp(clients);
    await write("createSchedule", [
      landlord.address, parseEther("0.05"), parseEther("0.5"), 10n, 0n, now + 86400n,
    ], owner);
    await write("revokeAgent", [], owner);
    assert.equal(
      await readAddress("agents", [owner.address]),
      "0x0000000000000000000000000000000000000000",
    );
    await assertReverts(clients, contract, "executePayment", [2n], agent);
    await write("executePayment", [2n], owner);
    assert.equal(await readBigint("totalPayments"), 3n);
  });

  it("reports insufficient balance honestly", async () => {
    // Drain the owner's balance, then check a fresh schedule.
    const bal = await readBigint("balances", [owner.address]);
    await write("withdraw", [bal], owner);
    const [due, reason] = await checkDue(2n);
    assert.equal(due, false);
    assert.equal(reason, "insufficient-balance");
    await assertReverts(clients, contract, "executePayment", [2n], owner);
  });

  it("rejects zero-value deposits and withdrawals, and a zero agent address", async () => {
    await assertReverts(clients, contract, "deposit", [], owner, 0n);
    await assertReverts(clients, contract, "withdraw", [0n], owner);
    await assertReverts(clients, contract, "setAgent", ["0x0000000000000000000000000000000000000000"], owner);
    // The reverts moved nothing.
    assert.equal(await readBigint("balances", [owner.address]), 0n);
  });

  it("keeps a second owner's funds and schedules fully independent", async () => {
    await write("deposit", [], stranger, parseEther("1"));
    const now = await latestTimestamp(clients);
    await write("createSchedule", [
      landlord.address, parseEther("0.1"), parseEther("0.5"), 3n, 0n, now + 86400n,
    ], stranger);
    assert.equal(await readBigint("scheduleCount"), 4n);
    // The stranger pays their own schedule directly (owner path).
    await write("executePayment", [3n], stranger);
    assert.equal(await readBigint("balances", [stranger.address]), parseEther("0.9"));
    // The first owner's balance and agent are untouched.
    assert.equal(await readBigint("balances", [owner.address]), 0n);
    assert.equal(
      await readAddress("agents", [owner.address]),
      "0x0000000000000000000000000000000000000000",
    );
    assert.equal(await readBigint("totalPayments"), 4n);
  });

  it("re-setting the agent replaces the old one", async () => {
    await write("deposit", [], owner, parseEther("0.5"));
    await write("setAgent", [agent.address], owner);
    // Schedule 2 (0.05/payment, 1/10 paid) is due again; the agent pays.
    await write("executePayment", [2n], agent);
    assert.equal(await readBigint("totalPayments"), 5n);
    // Replace the agent: the old key can no longer pay, the new one can.
    await write("setAgent", [stranger.address], owner);
    await assertReverts(clients, contract, "executePayment", [2n], agent);
    await write("executePayment", [2n], stranger);
    assert.equal(await readBigint("totalPayments"), 6n);
    assert.equal(await readBigint("balances", [owner.address]), parseEther("0.4"));
    await write("revokeAgent", [], owner);
  });

  it("enforces expiry per payment, not just at creation", async () => {
    const now = await latestTimestamp(clients);
    await write("createSchedule", [
      landlord.address, parseEther("0.05"), parseEther("0.5"), 10n, 0n, now + 120n,
    ], owner);
    // Pays fine while the schedule is live…
    await write("executePayment", [4n], owner);
    assert.equal(await readBigint("totalPayments"), 7n);
    // …then the same schedule refuses once its expiry passes.
    await increaseTime(clients, 121);
    const [due, reason] = await checkDue(4n);
    assert.equal(due, false);
    assert.equal(reason, "expired");
    await assertReverts(clients, contract, "executePayment", [4n], owner);
  });

  it("emits Deposited and Withdrawn with the running balance", async () => {
    const before = await readBigint("balances", [owner.address]);
    const depositReceipt = await write("deposit", [], owner, parseEther("0.2"));
    const deposited = decodeLogs(depositReceipt).filter((e) => e.eventName === "Deposited");
    assert.equal(deposited.length, 1);
    const d = deposited[0].args as unknown as { owner: string; amount: bigint; balance: bigint };
    assert.equal(d.owner.toLowerCase(), owner.address.toLowerCase());
    assert.equal(d.amount, parseEther("0.2"));
    assert.equal(d.balance, before + parseEther("0.2"));

    const withdrawReceipt = await write("withdraw", [parseEther("0.1")], owner);
    const withdrawn = decodeLogs(withdrawReceipt).filter((e) => e.eventName === "Withdrawn");
    assert.equal(withdrawn.length, 1);
    const w = withdrawn[0].args as unknown as { owner: string; amount: bigint; balance: bigint };
    assert.equal(w.owner.toLowerCase(), owner.address.toLowerCase());
    assert.equal(w.amount, parseEther("0.1"));
    assert.equal(w.balance, before + parseEther("0.1"));
    assert.equal(await readBigint("balances", [owner.address]), before + parseEther("0.1"));
  });
});
