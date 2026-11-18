import { ConnectButton } from "@rainbow-me/rainbowkit";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import {
  formatEther,
  isAddress,
  parseAbiItem,
  parseEther,
  type Address,
} from "viem";
import {
  useAccount,
  useBalance,
  usePublicClient,
  useReadContract,
  useReadContracts,
  useWaitForTransactionReceipt,
  useWriteContract,
} from "wagmi";

import { billPayGuardAbi } from "../contracts/BillPayGuard.artifact.js";
import {
  BILLPAY_GUARD_ADDRESS,
  CONTRACT_DEPLOYED,
  EXPLORER_URL,
  TESTNET_CHAIN_ID,
} from "./config.js";
import { RECORDED_PAYMENTS, type RecordedPayment } from "./evidence.js";

function shorten(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

const REASON_LABEL: Record<string, string> = {
  due: "Due — ready to pay",
  inactive: "Cancelled",
  expired: "Expired",
  "max-payments": "Max payments reached",
  "too-soon": "Waiting for interval",
  "cap-reached": "Total cap reached",
  "insufficient-balance": "Owner balance too low",
};

function reasonLabel(reason: string): string {
  return REASON_LABEL[reason] ?? reason;
}

function formatInterval(seconds: bigint): string {
  const s = Number(seconds);
  if (s === 0) return "none";
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${s / 60}m`;
  if (s < 86400) return `${s / 3600}h`;
  const d = s / 86400;
  return `${Number.isInteger(d) ? d : d.toFixed(1)}d`;
}

type Schedule = {
  owner: Address;
  payee: Address;
  amountPerPayment: bigint;
  totalCap: bigint;
  maxPayments: bigint;
  intervalSeconds: bigint;
  expiry: bigint;
  paid: bigint;
  payments: bigint;
  lastPaidAt: bigint;
  active: boolean;
};

type PaymentRow = {
  scheduleId: bigint;
  owner: Address;
  payee: Address;
  amount: bigint;
  paid: bigint;
  payments: bigint;
  blockNumber: bigint;
  transactionHash: string;
};

const styles = {
  page: {
    fontFamily: "system-ui, -apple-system, sans-serif",
    background: "#0b1220",
    color: "#e2e8f0",
    minHeight: "100vh",
    margin: 0,
    padding: "0 16px 48px",
  } as React.CSSProperties,
  inner: { maxWidth: 960, margin: "0 auto" } as React.CSSProperties,
  header: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "flex-start",
    gap: 16,
    padding: "28px 0 8px",
    flexWrap: "wrap",
  } as React.CSSProperties,
  h1: { fontSize: 32, margin: 0 } as React.CSSProperties,
  sub: { color: "#94a3b8", margin: "6px 0 0", maxWidth: 640 } as React.CSSProperties,
  card: {
    background: "#111c2e",
    border: "1px solid #1e293b",
    borderRadius: 12,
    padding: 16,
    marginTop: 16,
  } as React.CSSProperties,
  h2: { fontSize: 18, margin: "0 0 12px" } as React.CSSProperties,
  stats: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))",
    gap: 12,
  } as React.CSSProperties,
  stat: { background: "#0f172a", borderRadius: 8, padding: 12 } as React.CSSProperties,
  statLabel: { fontSize: 12, color: "#94a3b8", textTransform: "uppercase" as const } as React.CSSProperties,
  statValue: { fontSize: 22, fontWeight: 700, marginTop: 4 } as React.CSSProperties,
  table: { width: "100%", borderCollapse: "collapse", fontSize: 14 } as React.CSSProperties,
  th: { textAlign: "left" as const, color: "#94a3b8", fontWeight: 600, padding: "8px 6px", borderBottom: "1px solid #1e293b" } as React.CSSProperties,
  td: { padding: "8px 6px", borderBottom: "1px solid #16233a", verticalAlign: "top" } as React.CSSProperties,
  badge: (tone: "ok" | "warn" | "muted") => ({
    display: "inline-block",
    padding: "2px 8px",
    borderRadius: 999,
    fontSize: 12,
    fontWeight: 600,
    background: tone === "ok" ? "#14532d" : tone === "warn" ? "#713f12" : "#1e293b",
    color: tone === "ok" ? "#bbf7d0" : tone === "warn" ? "#fde68a" : "#94a3b8",
  }) as React.CSSProperties,
  button: {
    background: "#0ea5e9",
    color: "#fff",
    border: "none",
    borderRadius: 8,
    padding: "8px 14px",
    fontSize: 14,
    fontWeight: 600,
    cursor: "pointer",
  } as React.CSSProperties,
  buttonSecondary: {
    background: "#1e293b",
    color: "#e2e8f0",
    border: "1px solid #334155",
    borderRadius: 8,
    padding: "8px 14px",
    fontSize: 14,
    fontWeight: 600,
    cursor: "pointer",
  } as React.CSSProperties,
  buttonDisabled: { opacity: 0.45, cursor: "not-allowed" } as React.CSSProperties,
  input: {
    background: "#0f172a",
    color: "#e2e8f0",
    border: "1px solid #334155",
    borderRadius: 8,
    padding: "8px 10px",
    fontSize: 14,
    width: "100%",
    boxSizing: "border-box" as const,
  } as React.CSSProperties,
  label: { display: "block", fontSize: 13, color: "#94a3b8", marginBottom: 4 } as React.CSSProperties,
  field: { marginBottom: 12 } as React.CSSProperties,
  row: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 } as React.CSSProperties,
  note: { fontSize: 13, color: "#94a3b8", marginTop: 8 } as React.CSSProperties,
  error: { color: "#fca5a5", fontSize: 13, marginTop: 8 } as React.CSSProperties,
  mono: { fontFamily: "ui-monospace, monospace", fontSize: 13 } as React.CSSProperties,
  link: { color: "#38bdf8" } as React.CSSProperties,
};

function useSchedules() {
  const { data: count } = useReadContract({
    address: BILLPAY_GUARD_ADDRESS as Address,
    abi: billPayGuardAbi,
    functionName: "scheduleCount",
    query: { refetchInterval: 15000, enabled: CONTRACT_DEPLOYED },
  });
  const ids = count === undefined ? [] : Array.from({ length: Number(count) }, (_, i) => BigInt(i));
  const contracts = ids.flatMap((id) => [
    {
      address: BILLPAY_GUARD_ADDRESS as Address,
      abi: billPayGuardAbi,
      functionName: "getSchedule",
      args: [id],
    } as const,
    {
      address: BILLPAY_GUARD_ADDRESS as Address,
      abi: billPayGuardAbi,
      functionName: "checkDue",
      args: [id],
    } as const,
  ]);
  const { data, isLoading } = useReadContracts({
    contracts,
    query: { refetchInterval: 15000, enabled: CONTRACT_DEPLOYED && ids.length > 0 },
  });
  const schedules: Array<{ id: bigint; schedule: Schedule; due: boolean; reason: string }> = [];
  if (data) {
    for (let i = 0; i < ids.length; i++) {
      const s = data[i * 2]?.result as unknown as Schedule | undefined;
      const d = data[i * 2 + 1]?.result as unknown as [boolean, string] | undefined;
      if (s && d) {
        schedules.push({ id: ids[i], schedule: s, due: d[0], reason: d[1] });
      }
    }
  }
  return { count: count ?? 0n, schedules, isLoading };
}

const PAYMENT_EVENT = parseAbiItem(
  "event PaymentExecuted(uint256 indexed scheduleId, address indexed owner, address indexed payee, uint256 amount, uint256 paid, uint256 payments)",
);

/**
 * The Diana EVM node rejects eth_getLogs over wide block ranges (even
 * 10,000 blocks fails), and deploy-to-latest spans ~182,000 blocks, so
 * the history cannot be scanned live in one call. It is built from
 * three sources instead, deduplicated by transaction hash:
 *
 * 1. RECORDED_PAYMENTS (src/evidence.ts, generated from
 *    deployments/demo.json) — the verified on-chain payments, rendered
 *    immediately so the section never hangs on "Loading…".
 * 2. Targeted re-verification: each recorded payment is re-read with a
 *    single-block getLogs call (fromBlock == toBlock == its block,
 *    always inside the node's range limit); the on-chain row replaces
 *    the recorded one when found. Results are cached per block — a
 *    confirmed payment's event never changes.
 * 3. A short backward scan from latest (RECENT_SCAN_CHUNKS chunks of
 *    LOG_CHUNK_BLOCKS blocks) that picks up payments made after the
 *    recorded evidence was last generated — e.g. a payment executed
 *    live while the demo is open.
 *
 * The leashed payment (block 10159020) has no EVM log at all — its
 * MsgExecuteEVM execution leaves nothing for eth_getLogs to find — so
 * its recorded entry is its only record, and the table links its
 * Cosmos transaction hash.
 */
const LOG_CHUNK_BLOCKS = 100;
const RECENT_SCAN_CHUNKS = 10;

function logToRow(log: {
  args: {
    scheduleId?: bigint;
    owner?: Address;
    payee?: Address;
    amount?: bigint;
    paid?: bigint;
    payments?: bigint;
  };
  blockNumber: bigint;
  transactionHash: string;
}): PaymentRow {
  return {
    scheduleId: log.args.scheduleId as bigint,
    owner: log.args.owner as Address,
    payee: log.args.payee as Address,
    amount: log.args.amount as bigint,
    paid: log.args.paid as bigint,
    payments: log.args.payments as bigint,
    blockNumber: log.blockNumber,
    transactionHash: log.transactionHash,
  };
}

function recordedToRow(p: RecordedPayment): PaymentRow {
  return {
    scheduleId: BigInt(p.scheduleId),
    owner: p.owner as Address,
    payee: p.payee as Address,
    amount: parseEther(p.amountQor),
    paid: parseEther(p.paidQor),
    payments: BigInt(p.payments),
    blockNumber: BigInt(p.block),
    // The leashed payment has no EVM tx; link its Cosmos tx instead.
    transactionHash: p.evmTx ?? p.cosmosTx ?? "",
  };
}

/** Recorded rows, newest first — rendered immediately, before any RPC. */
const RECORDED_ROWS: PaymentRow[] = RECORDED_PAYMENTS.map(recordedToRow).sort((a, b) =>
  a.blockNumber > b.blockNumber ? -1 : 1,
);

/** On-chain verification results per recorded block (null = no log found). */
const verifiedByBlock = new Map<number, PaymentRow | null>();

function usePaymentHistory() {
  const publicClient = usePublicClient();
  return useQuery({
    queryKey: ["paymentHistory", BILLPAY_GUARD_ADDRESS],
    enabled: CONTRACT_DEPLOYED && !!publicClient,
    refetchInterval: 20000,
    queryFn: async (): Promise<{ rows: PaymentRow[]; liveFailed: boolean }> => {
      const rows = new Map<string, PaymentRow>();
      for (const r of RECORDED_ROWS) rows.set(r.transactionHash.toLowerCase(), r);
      let liveFailed = false;
      if (!publicClient) return { rows: [...rows.values()], liveFailed: true };

      // 1. Targeted re-verification of each recorded payment (single-block
      // ranges, cached — a confirmed event never changes).
      const verified = await Promise.all(
        RECORDED_PAYMENTS.filter((p) => p.evmTx).map(async (p) => {
          if (verifiedByBlock.has(p.block)) return verifiedByBlock.get(p.block);
          try {
            const logs = await publicClient.getLogs({
              address: BILLPAY_GUARD_ADDRESS as Address,
              event: PAYMENT_EVENT,
              fromBlock: BigInt(p.block),
              toBlock: BigInt(p.block),
            });
            const log =
              logs.find((l) => l.transactionHash.toLowerCase() === p.evmTx!.toLowerCase()) ??
              logs[0];
            const row = log ? logToRow(log) : null;
            verifiedByBlock.set(p.block, row);
            return row;
          } catch {
            liveFailed = true;
            return undefined;
          }
        }),
      );
      for (const row of verified) {
        if (row) rows.set(row.transactionHash.toLowerCase(), row);
      }

      // 2. Short backward scan from latest for payments newer than the
      // recorded evidence (100-block chunks, inside the node limit).
      try {
        const latest = await publicClient.getBlockNumber();
        const chunkResults = await Promise.allSettled(
          Array.from({ length: RECENT_SCAN_CHUNKS }, (_, i) => {
            const to = latest - BigInt(i * LOG_CHUNK_BLOCKS);
            const from =
              to >= BigInt(LOG_CHUNK_BLOCKS - 1) ? to - BigInt(LOG_CHUNK_BLOCKS - 1) : 0n;
            return publicClient.getLogs({
              address: BILLPAY_GUARD_ADDRESS as Address,
              event: PAYMENT_EVENT,
              fromBlock: from,
              toBlock: to,
            });
          }),
        );
        for (const res of chunkResults) {
          if (res.status === "fulfilled") {
            for (const log of res.value) {
              const row = logToRow(log);
              if (!rows.has(row.transactionHash.toLowerCase())) {
                rows.set(row.transactionHash.toLowerCase(), row);
              }
            }
          } else {
            liveFailed = true;
          }
        }
      } catch {
        liveFailed = true;
      }

      return {
        rows: [...rows.values()]
          .sort((a, b) => (a.blockNumber > b.blockNumber ? -1 : 1))
          .slice(0, 20),
        liveFailed,
      };
    },
  });
}

export function App() {
  const { address, isConnected, chainId } = useAccount();
  const queryClient = useQueryClient();
  const { count, schedules, isLoading: schedulesLoading } = useSchedules();
  const history = usePaymentHistory();
  // Recorded payments render immediately; the live query only re-verifies
  // them and adds newer ones, so this section never hangs on loading.
  const displayRows = history.data?.rows ?? RECORDED_ROWS;
  const [formError, setFormError] = useState("");
  const [actionError, setActionError] = useState("");

  const { data: totalPayments } = useReadContract({
    address: BILLPAY_GUARD_ADDRESS as Address,
    abi: billPayGuardAbi,
    functionName: "totalPayments",
    query: { refetchInterval: 15000, enabled: CONTRACT_DEPLOYED },
  });
  const { data: totalVolume } = useReadContract({
    address: BILLPAY_GUARD_ADDRESS as Address,
    abi: billPayGuardAbi,
    functionName: "totalVolume",
    query: { refetchInterval: 15000, enabled: CONTRACT_DEPLOYED },
  });
  const { data: guardBalance } = useBalance({
    address: BILLPAY_GUARD_ADDRESS as Address,
    query: { refetchInterval: 15000, enabled: CONTRACT_DEPLOYED },
  });
  const { data: myBalance } = useReadContract({
    address: BILLPAY_GUARD_ADDRESS as Address,
    abi: billPayGuardAbi,
    functionName: "balances",
    args: [address ?? ("0x0000000000000000000000000000000000000000" as Address)],
    query: { refetchInterval: 15000, enabled: CONTRACT_DEPLOYED && isConnected },
  });
  const { data: myAgent } = useReadContract({
    address: BILLPAY_GUARD_ADDRESS as Address,
    abi: billPayGuardAbi,
    functionName: "agents",
    args: [address ?? ("0x0000000000000000000000000000000000000000" as Address)],
    query: { refetchInterval: 15000, enabled: CONTRACT_DEPLOYED && isConnected },
  });

  const { writeContract, data: txHash, isPending, error: writeError } = useWriteContract();
  const { isSuccess: txConfirmed } = useWaitForTransactionReceipt({ hash: txHash });
  useEffect(() => {
    if (txConfirmed) {
      void queryClient.invalidateQueries();
    }
  }, [txConfirmed, queryClient]);

  const wrongChain = isConnected && chainId !== TESTNET_CHAIN_ID;

  // Create-schedule form state.
  const [payee, setPayee] = useState("");
  const [amount, setAmount] = useState("0.1");
  const [cap, setCap] = useState("1");
  const [maxPayments, setMaxPayments] = useState("10");
  const [intervalDays, setIntervalDays] = useState("1");
  const [expiryDays, setExpiryDays] = useState("30");
  const [depositAmount, setDepositAmount] = useState("0.5");
  const [agentInput, setAgentInput] = useState("");

  function createSchedule() {
    setFormError("");
    if (!isAddress(payee)) {
      setFormError("Payee is not a valid address.");
      return;
    }
    let amountWei: bigint;
    let capWei: bigint;
    try {
      amountWei = parseEther(amount);
      capWei = parseEther(cap);
    } catch {
      setFormError("Amount and cap must be numbers (QOR).");
      return;
    }
    const max = BigInt(maxPayments || "0");
    const interval = BigInt(Math.floor(Number(intervalDays || "0") * 86400));
    const expiry = BigInt(Math.floor(Date.now() / 1000) + Math.floor(Number(expiryDays || "0") * 86400));
    if (amountWei <= 0n || capWei < amountWei || max <= 0n || expiry <= BigInt(Math.floor(Date.now() / 1000))) {
      setFormError("Check the limits: amount > 0, cap ≥ amount, max payments > 0, expiry in the future.");
      return;
    }
    writeContract({
      address: BILLPAY_GUARD_ADDRESS as Address,
      abi: billPayGuardAbi,
      functionName: "createSchedule",
      args: [payee as Address, amountWei, capWei, max, interval, expiry],
    });
  }

  function payNow(id: bigint) {
    setActionError("");
    writeContract({
      address: BILLPAY_GUARD_ADDRESS as Address,
      abi: billPayGuardAbi,
      functionName: "executePayment",
      args: [id],
    });
  }

  function cancel(id: bigint) {
    setActionError("");
    writeContract({
      address: BILLPAY_GUARD_ADDRESS as Address,
      abi: billPayGuardAbi,
      functionName: "cancelSchedule",
      args: [id],
    });
  }

  function deposit() {
    setFormError("");
    try {
      const value = parseEther(depositAmount);
      if (value <= 0n) throw new Error("zero");
      writeContract({
        address: BILLPAY_GUARD_ADDRESS as Address,
        abi: billPayGuardAbi,
        functionName: "deposit",
        args: [],
        value,
      });
    } catch {
      setFormError("Deposit amount must be a number greater than zero.");
    }
  }

  function setAgent() {
    setFormError("");
    if (!isAddress(agentInput)) {
      setFormError("Agent address is not valid.");
      return;
    }
    writeContract({
      address: BILLPAY_GUARD_ADDRESS as Address,
      abi: billPayGuardAbi,
      functionName: "setAgent",
      args: [agentInput as Address],
    });
  }

  function revokeAgent() {
    writeContract({
      address: BILLPAY_GUARD_ADDRESS as Address,
      abi: billPayGuardAbi,
      functionName: "revokeAgent",
      args: [],
    });
  }

  return (
    <div style={styles.page}>
      <div style={styles.inner}>
        <header style={styles.header}>
          <div>
            <h1 style={styles.h1}>BillPay Guard</h1>
            <p style={styles.sub}>
              An autonomous bill-payment agent with spending limits enforced on-chain. The owner
              sets the payee, the caps, and the schedule; the agent pays — and the guard contract
              refuses any payment outside the limits. Every transaction runs inside a post-quantum
              authorisation window on the QoreChain testnet.
            </p>
          </div>
          <ConnectButton />
        </header>

        {!CONTRACT_DEPLOYED && (
          <div style={styles.card}>
            <h2 style={styles.h2}>Contract not deployed yet</h2>
            <p style={styles.note}>
              This build has no contract address configured (VITE_BILLPAY_GUARD_ADDRESS). Deploy
              first: see the README.
            </p>
          </div>
        )}

        {CONTRACT_DEPLOYED && (
          <>
            <div style={styles.card}>
              <div style={styles.stats}>
                <div style={styles.stat}>
                  <div style={styles.statLabel}>Schedules</div>
                  <div style={styles.statValue}>{count.toString()}</div>
                </div>
                <div style={styles.stat}>
                  <div style={styles.statLabel}>Payments executed</div>
                  <div style={styles.statValue}>{(totalPayments ?? 0n).toString()}</div>
                </div>
                <div style={styles.stat}>
                  <div style={styles.statLabel}>Total paid</div>
                  <div style={styles.statValue}>{formatEther(totalVolume ?? 0n)} QOR</div>
                </div>
                <div style={styles.stat}>
                  <div style={styles.statLabel}>Guard balance</div>
                  <div style={styles.statValue}>
                    {guardBalance ? formatEther(guardBalance.value) : "…"} QOR
                  </div>
                </div>
              </div>
              <p style={styles.note}>
                Contract{" "}
                <a
                  style={styles.link}
                  href={`${EXPLORER_URL}/address/${BILLPAY_GUARD_ADDRESS}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  <span style={styles.mono}>{BILLPAY_GUARD_ADDRESS}</span>
                </a>{" "}
                on qorechain-diana (chain id {TESTNET_CHAIN_ID}). Reads update every 15 seconds.
              </p>
              {wrongChain && (
                <p style={styles.error}>
                  You are connected to chain {chainId}. Switch to the QoreChain testnet (chain id{" "}
                  {TESTNET_CHAIN_ID}) to use the write actions.
                </p>
              )}
            </div>

            <div style={styles.card}>
              <h2 style={styles.h2}>Schedules</h2>
              {schedulesLoading && <p style={styles.note}>Loading schedules…</p>}
              {!schedulesLoading && schedules.length === 0 && (
                <p style={styles.note}>
                  No schedules yet. Connect a wallet and create one below — or run the demo setup
                  in the README.
                </p>
              )}
              {schedules.length > 0 && (
                <div style={{ overflowX: "auto" }}>
                  <table style={styles.table}>
                    <thead>
                      <tr>
                        <th style={styles.th}>#</th>
                        <th style={styles.th}>Payee</th>
                        <th style={styles.th}>Per payment</th>
                        <th style={styles.th}>Paid / cap</th>
                        <th style={styles.th}>Payments</th>
                        <th style={styles.th}>Interval</th>
                        <th style={styles.th}>Status</th>
                        <th style={styles.th}></th>
                      </tr>
                    </thead>
                    <tbody>
                      {schedules.map(({ id, schedule: s, due, reason }) => {
                        const isOwner =
                          isConnected && address?.toLowerCase() === s.owner.toLowerCase();
                        return (
                          <tr key={id.toString()}>
                            <td style={styles.td}>{id.toString()}</td>
                            <td style={styles.td}>
                              <span style={styles.mono} title={s.payee}>
                                {shorten(s.payee)}
                              </span>
                            </td>
                            <td style={styles.td}>{formatEther(s.amountPerPayment)} QOR</td>
                            <td style={styles.td}>
                              {formatEther(s.paid)} / {formatEther(s.totalCap)} QOR
                            </td>
                            <td style={styles.td}>
                              {s.payments.toString()} / {s.maxPayments.toString()}
                            </td>
                            <td style={styles.td}>{formatInterval(s.intervalSeconds)}</td>
                            <td style={styles.td}>
                              <span
                                style={styles.badge(
                                  due ? "ok" : reason === "cap-reached" || reason === "expired" ? "warn" : "muted",
                                )}
                              >
                                {reasonLabel(reason)}
                              </span>
                            </td>
                            <td style={styles.td}>
                              {due && isConnected && (
                                <button
                                  style={{ ...styles.button, ...(isPending ? styles.buttonDisabled : {}) }}
                                  disabled={isPending}
                                  onClick={() => payNow(id)}
                                >
                                  Pay now
                                </button>
                              )}{" "}
                              {isOwner && s.active && (
                                <button
                                  style={{ ...styles.buttonSecondary, ...(isPending ? styles.buttonDisabled : {}) }}
                                  disabled={isPending}
                                  onClick={() => cancel(id)}
                                >
                                  Cancel
                                </button>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
              {actionError && <p style={styles.error}>{actionError}</p>}
              {writeError && <p style={styles.error}>{writeError.message.slice(0, 300)}</p>}
              {txHash && (
                <p style={styles.note}>
                  Transaction{" "}
                  <a style={styles.link} href={`${EXPLORER_URL}/tx/${txHash}`} target="_blank" rel="noreferrer">
                    <span style={styles.mono}>{shorten(txHash)}</span>
                  </a>
                  {txConfirmed ? " — confirmed." : " — waiting for confirmation…"}
                </p>
              )}
            </div>

            <div style={styles.card}>
              <h2 style={styles.h2}>Payment history</h2>
              {displayRows.length === 0 && history.isLoading && (
                <p style={styles.note}>Loading payment events…</p>
              )}
              {displayRows.length === 0 && !history.isLoading && (
                <p style={styles.note}>No payments recorded yet.</p>
              )}
              {history.data?.liveFailed && displayRows.length > 0 && (
                <p style={styles.note}>
                  Live chain refresh failed — showing recorded payments.
                </p>
              )}
              {displayRows.length > 0 && (
                <div style={{ overflowX: "auto" }}>
                  <table style={styles.table}>
                    <thead>
                      <tr>
                        <th style={styles.th}>Schedule</th>
                        <th style={styles.th}>Payee</th>
                        <th style={styles.th}>Amount</th>
                        <th style={styles.th}>Paid total</th>
                        <th style={styles.th}>Block</th>
                        <th style={styles.th}>Tx</th>
                      </tr>
                    </thead>
                    <tbody>
                      {displayRows.map((p) => (
                        <tr key={p.transactionHash}>
                          <td style={styles.td}>#{p.scheduleId.toString()}</td>
                          <td style={styles.td}>
                            <span style={styles.mono} title={p.payee}>
                              {shorten(p.payee)}
                            </span>
                          </td>
                          <td style={styles.td}>{formatEther(p.amount)} QOR</td>
                          <td style={styles.td}>{formatEther(p.paid)} QOR</td>
                          <td style={styles.td}>{p.blockNumber.toString()}</td>
                          <td style={styles.td}>
                            <a
                              style={styles.link}
                              href={`${EXPLORER_URL}/tx/${p.transactionHash}`}
                              target="_blank"
                              rel="noreferrer"
                            >
                              <span style={styles.mono}>{shorten(p.transactionHash)}</span>
                            </a>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            <div style={styles.card}>
              <h2 style={styles.h2}>Your guard</h2>
              {!isConnected && (
                <p style={styles.note}>
                  Connect a wallet to deposit funds, create schedules, and authorise an agent. The
                  schedules and history above are public and need no wallet.
                </p>
              )}
              {isConnected && (
                <>
                  <p style={styles.note}>
                    Your deposited balance:{" "}
                    <strong>{formatEther(myBalance ?? 0n)} QOR</strong> · Your authorised agent:{" "}
                    <span style={styles.mono}>
                      {myAgent && myAgent !== "0x0000000000000000000000000000000000000000"
                        ? shorten(myAgent as string)
                        : "none"}
                    </span>
                  </p>
                  <div style={{ ...styles.row, marginTop: 12 }}>
                    <div>
                      <div style={styles.field}>
                        <label style={styles.label}>Deposit (QOR)</label>
                        <input
                          style={styles.input}
                          value={depositAmount}
                          onChange={(e) => setDepositAmount(e.target.value)}
                          inputMode="decimal"
                        />
                      </div>
                      <button
                        style={{ ...styles.button, ...(isPending ? styles.buttonDisabled : {}) }}
                        disabled={isPending}
                        onClick={deposit}
                      >
                        Deposit
                      </button>
                    </div>
                    <div>
                      <div style={styles.field}>
                        <label style={styles.label}>Authorise agent address</label>
                        <input
                          style={styles.input}
                          value={agentInput}
                          onChange={(e) => setAgentInput(e.target.value)}
                          placeholder="0x…"
                        />
                      </div>
                      <button
                        style={{ ...styles.button, ...(isPending ? styles.buttonDisabled : {}) }}
                        disabled={isPending}
                        onClick={setAgent}
                      >
                        Set agent
                      </button>{" "}
                      <button
                        style={{ ...styles.buttonSecondary, ...(isPending ? styles.buttonDisabled : {}) }}
                        disabled={isPending}
                        onClick={revokeAgent}
                      >
                        Revoke agent
                      </button>
                    </div>
                  </div>

                  <h2 style={{ ...styles.h2, marginTop: 24 }}>Create a schedule</h2>
                  <div style={styles.field}>
                    <label style={styles.label}>Payee (the ONLY address this schedule may pay)</label>
                    <input
                      style={styles.input}
                      value={payee}
                      onChange={(e) => setPayee(e.target.value)}
                      placeholder="0x…"
                    />
                  </div>
                  <div style={styles.row}>
                    <div style={styles.field}>
                      <label style={styles.label}>Amount per payment (QOR)</label>
                      <input
                        style={styles.input}
                        value={amount}
                        onChange={(e) => setAmount(e.target.value)}
                        inputMode="decimal"
                      />
                    </div>
                    <div style={styles.field}>
                      <label style={styles.label}>Total cap (QOR)</label>
                      <input
                        style={styles.input}
                        value={cap}
                        onChange={(e) => setCap(e.target.value)}
                        inputMode="decimal"
                      />
                    </div>
                  </div>
                  <div style={styles.row}>
                    <div style={styles.field}>
                      <label style={styles.label}>Max payments</label>
                      <input
                        style={styles.input}
                        value={maxPayments}
                        onChange={(e) => setMaxPayments(e.target.value)}
                        inputMode="numeric"
                      />
                    </div>
                    <div style={styles.field}>
                      <label style={styles.label}>Interval (days between payments)</label>
                      <input
                        style={styles.input}
                        value={intervalDays}
                        onChange={(e) => setIntervalDays(e.target.value)}
                        inputMode="decimal"
                      />
                    </div>
                  </div>
                  <div style={styles.field}>
                    <label style={styles.label}>Expiry (days from now)</label>
                    <input
                      style={styles.input}
                      value={expiryDays}
                      onChange={(e) => setExpiryDays(e.target.value)}
                      inputMode="decimal"
                    />
                  </div>
                  <button
                    style={{ ...styles.button, ...(isPending ? styles.buttonDisabled : {}) }}
                    disabled={isPending}
                    onClick={createSchedule}
                  >
                    Create schedule
                  </button>
                  {formError && <p style={styles.error}>{formError}</p>}
                </>
              )}
            </div>

            <div style={styles.card}>
              <h2 style={styles.h2}>Honest notes</h2>
              <p style={styles.note}>
                Testnet only — all funds are testnet QOR with no value. The limits are enforced by
                the guard contract, not by the agent: the agent cannot pay a different address,
                exceed a cap, pay early, or pay after expiry, even if it is compromised. What the
                contract cannot do: it cannot verify that a payee is who you think it is (check
                the address before creating a schedule), and it cannot protect funds if the
                owner's own key is compromised. Every payment transaction needs a live
                post-quantum authorisation window for the sending account — open one from QoreX
                (or the repo's window script) before paying.
              </p>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
