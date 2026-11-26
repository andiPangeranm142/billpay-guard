# QCAI audit — stage 2 triage (26 Nov 2026)

- Audit: QoreChain dashboard QCAI, Blockchain = QoreChain, source
  `flattened/BillPayGuard.flattened.sol` (290 lines, no test code), run 26 Nov 2026
  (fresh browser session; the two 25 Nov attempts failed — dashboard silent
  failure, then "No wallet found" toast — and did not recur).
- Result: **score 72/100, risk MEDIUM, quantum readiness HYBRID,
  5 findings.** Report: `docs/QCAI-audit-stage2.pdf`. Score, risk and
  readiness are IDENTICAL to stage 1 (72/100, MEDIUM, HYBRID).
- Cost: 150 QOR (testnet, dashboard-internal charge).
- Context: lower than Quantum Vault's 85/100 (x2) and Fenestella's 85/100
  (x2). The gap is finding 1 (HIGH): unlike Quantum Vault, this contract
  does not verify ML-DSA signatures on-chain — a documented design choice,
  not an oversight (see finding 1). Finding 3 is the same design decision
  counted a second time under a different title.

## Stage 2 vs stage 1

| # | Stage 2 finding | Stage 1 equivalent | Change |
|---|---|---|---|
| 1 | HIGH — ML-DSA-87 Key Management Not Enforced in Contract | Finding 1 (same title) | Identical |
| 2 | MEDIUM — Potential Reentrancy via External Call | Finding 2 (same substance, "Reentrancy Protection May Be Bypassed…") | Same substance |
| 3 | MEDIUM — Assumption of Hybrid Signature Validity | Finding 3 ("No Explicit Handling of PQC Algorithm Fallbacks") | Retitled; same underlying theme (chain-level hybrid enforcement) |
| 4 | LOW — Insufficient Validation of Payee Address | Finding 4 (same title) | Identical |
| 5 | INFO — Missing Input Sanitization for Large Values | Finding 5 ("Missing Event Emission for Critical Operations") | NEW title; the stage-1 event flag is GONE — the stage-2 auditor no longer claims `updateSchedule` misses an event, corroborating the stage-1 false-positive verdict (`ScheduleUpdated` is emitted) |

Note: the auditor's line references ("executePayment line ~158",
"createSchedule line ~100") are approximate and do not match either the
flattened file (`executePayment` at line 243, `createSchedule` at line 147)
or `contracts/BillPayGuard.sol` (237 / 141). The functions named are the
right ones; the line numbers are not exact.

## Finding 1 — HIGH — ML-DSA-87 Key Management Not Enforced in Contract

**Verdict: ACCEPTED BY DESIGN — documented limitation, no code change.**

Identical to stage-1 finding 1; the stage-1 triage stands unchanged. The
contract deliberately does not verify ML-DSA signatures on-chain. Quantum
safety is enforced at two other layers, both documented: (1) the
chain-level post-quantum authorisation window — every EVM transaction is
admitted only inside a window opened by a hybrid-signed (secp256k1 +
ML-DSA-87) native message, so a leaked ECDSA key alone cannot move funds;
(2) off-chain intent verification — before a leashed payment is relayed,
the owner signs a payment intent with their ML-DSA-87 key and the runner
verifies it against the owner's on-chain registered PQC key. This is stated
in the contract NatSpec ("The window is a chain-level admission rule, not
contract logic, so this contract does not check it"), the README's "Honest
limitations", and the project page ("payment intents are verified off-chain
by the runner"). Adding on-chain pqcVerify would require a redeploy that
orphans the live payment history (8 payments) and the Q-Day Drill proof —
not justified for a layer the chain already enforces. This finding is the
reason the readiness is HYBRID rather than QUANTUM-SAFE.

## Finding 2 — MEDIUM — Potential Reentrancy via External Call (executePayment)

**Verdict: FALSE POSITIVE — no code change.**

Identical in substance to stage-1 finding 2; the stage-1 triage stands
unchanged. `executePayment` is guarded by the `nonReentrant` modifier (a
`locked` flag that reverts on re-entry) AND already follows the exact
pattern the finding recommends — "performing the external call after all
state modifications are complete": in `contracts/BillPayGuard.sol` the
balance and schedule state are updated and the totals incremented
(`balances[s.owner] -= …`, `s.paid += …`, `s.payments += 1`,
`s.lastPaidAt = …`, `totalPayments += 1`, `totalVolume += …`) BEFORE the
external `s.payee.call{value: …}("")`, whose return value is checked
(`TransferFailed` on failure). Proven empirically: the attack battery
includes a reentrant payee and a reentrant withdrawer
(contracts/test/ReentrantAttacker.sol) that both fail to take a second wei
— 14 attack-battery tests, all passing (61/61 total).

## Finding 3 — MEDIUM — Assumption of Hybrid Signature Validity (contract level)

**Verdict: ACCEPTED BY DESIGN — same design decision as finding 1, counted twice; no code change.**

This is finding 1 restated: the contract "assumes" hybrid signatures are
valid because validity is enforced at the chain level (the post-quantum
authorisation window), not inside the contract. There is no signature
validation code in the contract to add a check to, and no on-chain
ML-DSA-87 verification primitive for the contract to call — the window is
the enforcement point, documented in the contract NatSpec, the README's
"Honest limitations", and the project page. The finding's rationale
("robustness against potential chain-level failures") does not change the
calculus: a contract-level check would duplicate the chain's enforcement
and would still require a redeploy orphaning the live payment history (8
payments) and the Q-Day Drill proof. The two MEDIUM/HIGH findings on this
theme (1 and 3) describe one documented limitation, not two independent
defects — which is also why the score is unchanged from stage 1 despite
the retitle.

## Finding 4 — LOW — Insufficient Validation of Payee Address (createSchedule)

**Verdict: ACCEPTED RISK — no code change.**

Identical to stage-1 finding 4; the stage-1 triage stands unchanged.
`createSchedule` already rejects the zero address (`InvalidPayee`). The
suggested extra check (payee must not be a contract without payable
functions) would only catch a misconfiguration at creation time — and a
payment to a non-payable payee already fails safe: the `call` returns
false, the transaction reverts with `TransferFailed`, and the funds stay
in the contract. No funds can be lost this way; the owner can cancel the
schedule and create a correct one. The check would add gas and complexity
for a failure mode that already fails safe. Candidate for a future v2 if
the contract is ever redeployed for other reasons.

## Finding 5 — INFO — Missing Input Sanitization for Large Values (createSchedule and updateSchedule)

**Verdict: FALSE POSITIVE — no code change.**

The recommendation ("add bounds checking for large parameter values to
prevent potential overflow or excessive gas consumption") rests on two
premises, and neither holds for this contract:

- **Overflow is impossible.** The contract is `pragma solidity ^0.8.24`
  (flattened file line 8): all arithmetic is checked by default, so an
  overflow reverts instead of wrapping silently. Every addition the
  finding could concern (`s.paid + s.amountPerPayment` in the cap check,
  `s.lastPaidAt + s.intervalSeconds` in the interval check,
  `balances[msg.sender] += msg.value`) reverts on overflow. There is no
  unchecked block anywhere in the contract.
- **Excessive gas is impossible from parameter size.** The contract
  contains no loops and no unbounded iteration; gas per call is bounded
  regardless of how large `amountPerPayment`, `totalCap`, `maxPayments`,
  `intervalSeconds` or `expiry` are. A schedule with absurdly large caps
  simply fails safe at payment time: a payment larger than the owner's
  deposited balance reverts with `InsufficientBalance`, and the owner can
  cancel the schedule and create a correct one.
- **The existing validation is the meaningful kind.** `createSchedule`
  and `updateSchedule` already reject zero amounts, caps below the
  per-payment amount (or below what is already paid), zero max-payments,
  and past expiries. An arbitrary upper bound would be a policy choice,
  not a security fix — values are denominated in wei, so any fixed cap
  risks breaking legitimate large-value schedules.

## Summary

| # | Severity | Verdict |
|---|----------|---------|
| 1 | HIGH | Accepted by design (documented limitation; PQ enforced at chain + runner layers) |
| 2 | MEDIUM | False positive (nonReentrant + checks-effects-interactions already in place; proven by attack battery) |
| 3 | MEDIUM | Accepted by design (same limitation as #1, counted twice; no on-chain ML-DSA check to add) |
| 4 | LOW | Accepted risk (failure mode fails safe; funds never leave the contract) |
| 5 | INFO | False positive (checked arithmetic in 0.8.24 — no overflow; no loops — no unbounded gas; absurd values fail safe) |

No finding requires a code change. No redeploy. Two independent QCAI runs
now agree exactly: **72/100, MEDIUM, HYBRID, 5 findings** — the score is
stable and reproducible, and every finding is either a documented design
decision or a false positive. The stage-2 run also confirms the stage-1
false-positive verdict on the event-emission flag: the stage-2 auditor
dropped it entirely.
