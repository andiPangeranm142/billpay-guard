# QCAI audit — stage 1 triage (25 Nov 2026)

- Audit: QoreChain dashboard QCAI, Blockchain = QoreChain, source
  `flattened/BillPayGuard.flattened.sol` (290 lines, no test code), run 25 Nov 2026.
- Result: **score 72/100, risk MEDIUM, quantum readiness HYBRID,
  5 findings.** Report: `docs/QCAI-audit-stage1.pdf`.
- Cost: 150 QOR (testnet, dashboard-internal charge — the on-chain wallet
  balance was verified unchanged before and after the run).
- Context: lower than Quantum Vault's 85/100 (x2) and Fenestella's 85/100
  (x2). The gap is finding 1 (HIGH): unlike Quantum Vault, this contract
  does not verify ML-DSA signatures on-chain — a documented design choice,
  not an oversight (see finding 1).

## Finding 1 — HIGH — ML-DSA-87 Key Management Not Enforced in Contract (executePayment)

**Verdict: ACCEPTED BY DESIGN — documented limitation, no code change.**

The contract deliberately does not verify ML-DSA signatures on-chain.
Quantum safety is enforced at two other layers, both documented: (1) the
chain-level post-quantum authorisation window — every EVM transaction is
admitted only inside a window opened by a hybrid-signed (secp256k1 +
ML-DSA-87) native message, so a leaked ECDSA key alone cannot move funds;
(2) off-chain intent verification — before a leashed payment is relayed,
the owner signs a payment intent with their ML-DSA-87 key and the runner
verifies it against the owner's on-chain registered PQC key. This is stated
in the contract NatSpec ("The window is a chain-level admission rule, not
contract logic, so this contract does not check it"), the README's "Honest
limitations", and the project page ("payment intents are verified off-chain
by the runner"). The finding's own recommendation offers two branches —
"implement explicit checks ... or clarify in documentation that quantum
safety is entirely handled at the chain level" — and the second branch is
already satisfied. Adding on-chain pqcVerify would require a redeploy that
orphans the live payment history (8 payments) and the Q-Day Drill proof —
not justified for a layer the chain already enforces. This finding is the
reason the readiness is HYBRID rather than QUANTUM-SAFE.

## Finding 2 — MEDIUM — Reentrancy Protection May Be Bypassed Due to External Calls (withdraw, executePayment)

**Verdict: FALSE POSITIVE — no code change.**

Both fund-moving functions are guarded by the `nonReentrant` modifier (a
`locked` flag that reverts on re-entry) AND follow checks-effects-
interactions: balances and schedule state are updated and totals
incremented before the external `call`. The finding's own recommendation
says "or ensure proper reentrancy guards around external calls" — guards
are in place. The "use transfer() instead of call()" suggestion is outdated
guidance: transfer's 2300-gas stipend breaks legitimate payees (smart-
contract wallets, multisigs); call() with a reentrancy guard is the
current best practice. Proven empirically: the attack battery includes a
reentrant payee and a reentrant withdrawer (contracts/test/
ReentrantAttacker.sol) that both fail to take a second wei — 14 attack-
battery tests, all passing (61/61 total).

## Finding 3 — MEDIUM — No Explicit Handling of PQC Algorithm Fallbacks (contract level)

**Verdict: NOT APPLICABLE — no code change.**

The contract contains no PQC algorithm implementation at all: no ML-DSA
code, no algorithm selection, nothing to version or fall back from.
Algorithm choice lives at the chain level (window gating, key
registration) and in the off-chain runner (intent verification). A fallback
mechanism inside the contract would be dead code guarding nothing.

## Finding 4 — LOW — Insufficient Validation of Payee Address (createSchedule)

**Verdict: ACCEPTED RISK — no code change.**

`createSchedule` already rejects the zero address (`InvalidPayee`). The
suggested extra check (payee must not be a contract without payable
functions) would only catch a misconfiguration at creation time — and a
payment to a non-payable payee already fails safe: the `call` returns
false, the transaction reverts with `TransferFailed`, and the funds stay
in the contract. No funds can be lost this way; the owner can cancel the
schedule and create a correct one. The check would add gas and complexity
for a failure mode that already fails safe. Candidate for a future v2 if
the contract is ever redeployed for other reasons.

## Finding 5 — INFO — Missing Event Emission for Critical Operations (updateSchedule)

**Verdict: FALSE POSITIVE — no code change.**

`updateSchedule` DOES emit an event: `ScheduleUpdated(scheduleId,
amountPerPayment, totalCap, maxPayments, intervalSeconds, expiry)` —
every parameter change is logged. Every other state-changing function
emits its event too (Deposited, Withdrawn, ScheduleCreated,
ScheduleCancelled, AgentSet, AgentRevoked, PaymentExecuted). The auditor
missed the existing emission.

## Summary

| # | Severity | Verdict |
|---|----------|---------|
| 1 | HIGH | Accepted by design (documented limitation; PQ enforced at chain + runner layers) |
| 2 | MEDIUM | False positive (nonReentrant + checks-effects-interactions; proven by attack battery) |
| 3 | MEDIUM | Not applicable (no PQC code in the contract to fall back from) |
| 4 | LOW | Accepted risk (failure mode fails safe; funds never leave the contract) |
| 5 | INFO | False positive (ScheduleUpdated is emitted) |

No finding requires a code change. No redeploy. Stage 2 pending: the
dashboard failed twice on the second run (25 Nov, "No wallet found" toast
on the retry) — retry scheduled 26 Nov 2026 in a fresh session.
