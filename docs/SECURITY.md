# Security — BillPay Guard

## Audit status

No formal audit. The contract has been checked three ways, and each
result is recorded in this repo:

1. **Tests** — `npm test`: 61 tests passing (19 contract + 15 intent +
   13 leash-rule + 14 attack battery, including 3 seeded model-based
   fuzz runs of 150 operations each).
2. **Static analysis** — Slither 0.11.6 on
   `contracts/BillPayGuard.sol` (25 Nov 2026): **6 findings, 0 high,
   0 medium.** Raw output: [`docs/slither-report.txt`](slither-report.txt).
   Triage below.
3. **Live attack evidence** — 2 on-chain contract reverts and 1
   on-chain leash refusal, all hashed in
   [`deployments/demo.json`](../deployments/demo.json).

QCAI (QoreChain's AI auditor) has **not** been run on this contract
yet. It costs 150 QOR on the testnet per run and needs a dashboard
session, so it is a separate step, not part of this repo's checks.

## Slither triage (25 Nov 2026)

### `timestamp` — 4 instances (LOW)

`block.timestamp` is compared in `createSchedule`, `updateSchedule`,
`executePayment`, and `checkDue` (expiry and interval checks).
**Accepted by design.** Timestamps are the only way to express
"expiry" and "minimum interval" on-chain, and the guard's intervals
(30–60 seconds) and expiries (days) are far above the few seconds a
miner could shift a timestamp. A shifted timestamp could move a
payment by seconds, never past a cap or to a wrong payee.

### `low-level-calls` — 2 instances (LOW)

`msg.sender.call{value: amount}("")` in `withdraw` and
`s.payee.call{value: amountPerPayment}("")` in `executePayment`.
**Accepted.** Sending native QOR requires a low-level call; there is
no safer primitive. Both calls are guarded three ways: the
`nonReentrant` lock, checks-effects-interactions (balances and
schedule state are updated before the call), and a success check
that reverts the whole transaction on failure. The reentrancy
protection is proven by test, not just by reading:
`test/attack-battery.test.ts` deploys a malicious payee and a
malicious withdrawer that both try to re-enter, and both fail to
take a second wei.

## Threat model

[`docs/THREAT_MODEL.md`](THREAT_MODEL.md) — attackers, what stops
each one, and the honest residual risks (no in-contract `pqcVerify`,
off-chain intent verification, owner-key compromise out of scope).

## Reporting

This is a testnet-only hackathon project holding no real funds. If
you find a bug, open an issue on the GitHub repo.
