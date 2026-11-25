/**
 * verify-live.ts - read the live BillPayGuard state from the Diana
 * testnet and print it. Read-only: no wallet, no funds, no signing.
 *
 * Run: npx tsx scripts/verify-live.ts
 *
 * The numbers this prints are the same ones the README, the demo, and
 * the project page show. If they ever disagree, this script (and the
 * chain) is right.
 */
import { createPublicClient, http, type Abi } from "viem";
import { billPayGuardAbi } from "../contracts/BillPayGuard.artifact.js";

const CONTRACT = "0xac31fb4f4b85f29f6dc72e8485fa9188b37f3b6e" as const;
const OWNER = "0x326697b1a1EAd2E0FCa024754Fd5530D7e5cBDee" as const;
const RPC = "https://evm-testnet.qore.host";

const client = createPublicClient({ transport: http(RPC) });
// Loose ABI type: the read helper takes any view function by name.
const abi = billPayGuardAbi as unknown as Abi;
const read = (functionName: string, args: unknown[] = []) =>
  client.readContract({ address: CONTRACT, abi, functionName, args });

const qor = (wei: bigint) => `${Number(wei) / 1e18} QOR`;

const [balance, totalPayments, totalVolume, scheduleCount] = (await Promise.all([
  read("balances", [OWNER]),
  read("totalPayments"),
  read("totalVolume"),
  read("scheduleCount"),
])) as bigint[];

console.log(`BillPayGuard ${CONTRACT} (Diana testnet)`);
console.log(`  owner balance:   ${qor(balance)}`);
console.log(`  total payments:  ${totalPayments}`);
console.log(`  total volume:    ${qor(totalVolume)}`);
console.log(`  schedules:       ${scheduleCount}`);

for (let i = 0n; i < scheduleCount; i++) {
  const s = (await read("getSchedule", [i])) as unknown as {
    payee: string;
    amountPerPayment: bigint;
    totalCap: bigint;
    maxPayments: bigint;
    paid: bigint;
    payments: bigint;
    active: boolean;
  };
  const [due, reason] = (await read("checkDue", [i])) as unknown as [boolean, string];
  console.log(
    `  schedule ${i}: payee ${s.payee.slice(0, 10)}… ` +
      `paid ${qor(s.paid)} / ${qor(s.totalCap)} ` +
      `(${s.payments}/${s.maxPayments} payments, ${qor(s.amountPerPayment)} each), ` +
      `active=${s.active}, due=${due} (${reason})`,
  );
}
