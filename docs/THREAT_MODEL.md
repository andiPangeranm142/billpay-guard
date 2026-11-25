# Threat model — BillPay Guard

What this guard is built to stop, what stops each attack, and what it
honestly does not cover. Every claim below points at a test or an
on-chain record; nothing here is aspirational.

## What is protected

The owner's deposited funds in the `BillPayGuard` contract, on the
QoreChain Diana testnet. The guard's job is narrow on purpose: the
money may only leave as scheduled bill payments to allowlisted payees,
inside the limits the owner set. It is not a vault, not a wallet, and
not a trading agent.

## Attackers

### 1. A compromised agent key

**The core threat.** The agent runner holds a key that may execute
payments. If that key leaks, the attacker has exactly the agent's
powers — and the contract, not the agent, decides what those are.

| Attack | What stops it | Evidence |
|---|---|---|
| Pay a different address | The contract pays only the schedule's registered payee; there is no parameter for the destination | `test/billpay-guard.test.ts` ("pays only the allowlisted payee"); `test/attack-battery.test.ts` (fuzz battery) |
| Pay more than the cap | `paid + amount > totalCap` reverts | Contract test (cap-reached); on-chain revert `0x35ebc083…7f56b` (block 10151739) |
| Pay too often | `maxPayments` and `intervalSeconds` enforced per payment | Contract tests; on-chain revert `0x43fc142e…62ed4` (block 10151718, too-soon) |
| Pay after expiry | `block.timestamp > expiry` reverts | Contract tests ("enforces expiry") |
| Pay from a schedule the owner cancelled | `active` flag checked on every payment | Attack battery ("cancelSchedule twice") |
| Use the agent key on another owner's schedule | Authorization is per-owner: `agents[s.owner]` | Attack battery ("one owner's agent cannot pay another owner's schedule") |
| Drain via withdraw | `withdraw` pays `msg.sender` only their own balance; the agent has no balance in the contract | Fuzz battery (withdraw model) |
| Raise the limits | `updateSchedule` is owner-only | Contract + attack-battery tests |

On top of the contract, the chain-level leash bounds the agent key
itself: the abstract-account spending rule allows only
`executePayment` on the guard contract, at most 0.05 QOR per
execution and 0.50 QOR per day. A forbidden call was proven refused
on-chain (Cosmos tx `FEF47E6B…43F801`, block 10335955,
`abstractaccount_execution_failed`).

### 2. A malicious payee

The payee is a contract the owner registered. It could try to
re-enter the guard when it is paid.

| Attack | What stops it | Evidence |
|---|---|---|
| Re-enter `executePayment` from `receive()` to double-pay | The `nonReentrant` lock: the inner call reverts before any check runs | Attack battery ("a reentrant payee cannot double-pay": payment lands exactly once, re-entry attempts 1, successes 0) |
| Re-enter `withdraw()` to drain | Same lock on `withdraw`, plus checks-effects-interactions (balance reduced before the call) | Attack battery ("a reentrant withdrawer cannot drain") |

Residual: a hostile payee whose `receive()` always reverts makes its
own schedule unpayable — the payment reverts atomically, so no funds
move, but that schedule cannot pay until the owner cancels it and
registers a correct payee. The payee is owner-chosen, so this is an
owner-configuration risk, not a theft vector.

### 3. A leaked ECDSA key (Q-Day Drill scenario)

On QoreChain, an EVM transaction is admitted only inside a
post-quantum authorisation window opened by a hybrid-signed
(secp256k1 + ML-DSA-87) message. A leaked ECDSA key alone cannot open
a window and cannot move funds.

Evidence: the Q-Day Drill proof payment (schedule 1, 0.05 QOR,
18 Nov 2026, tx `0x96d84888…16f502`, block 10286574) ran while the
agent's ECDSA key was leaked to the drill attacker — the payment
still needed the agent's live post-quantum window.

### 4. A malicious or buggy runner

The agent runner (`scripts/agent.ts`) is deliberately dumb: it asks
the contract whether each schedule is due (`checkDue`) and executes
the due ones. It never decides a limit, so a bug or a prompt
injection in the runner cannot talk the contract into breaking one —
every limit is re-checked on-chain at execution time.

The leashed path adds a second gate: the owner signs a payment intent
with their ML-DSA-87 key and the runner verifies it against the
owner's on-chain registered PQC key and the live schedule before
relaying. An intent authorises exactly one payment
(`paymentNumber == payments + 1`) and cannot be replayed
(`test/intent.test.ts`, 15 tests).

**Honest scope:** intent verification is off-chain, by the runner.
The contract does not verify ML-DSA signatures (no in-contract
`pqcVerify`), so a runner that skipped verification could still pay
within the contract's caps and the leash's rule. The intent layer is
a pre-execution gate plus a signed audit trail — it is not a third
on-chain enforcement layer. See `docs/AUTHENTICATED_MESSAGING.md`.

### 5. A malicious schedule configuration

The owner is the trust root for configuration: the contract enforces
that funds go only to the registered address, but it cannot verify
that the address belongs to the intended biller. If the owner
registers the wrong address, the funds go to the wrong address.
Mitigations: the demo UI shows the payee before creation, and the
owner can cancel a schedule at any time (paid funds stay paid).

### 6. Chain-level assumptions

- The PQ window is a chain admission rule, not contract logic. The
  contract trusts the chain to admit only windowed transactions. If
  the chain's rule changed, the contract would not notice.
- `block.timestamp` is used for interval and expiry checks (seconds
  granularity). A miner shifting timestamps by a few seconds could
  move a payment by seconds — irrelevant at the 30–60 s intervals and
  day-scale expiries this guard uses. (Slither flags the timestamp
  comparisons; triaged as accepted in `docs/SECURITY.md`.)
- The leash needs a relayer: a leashed payment only lands while the
  owner is online to relay the agent's signed meta-transaction. The
  agent's normal EOA path does not have this dependency.

## Out of scope (stated, not hidden)

- **Owner-key compromise.** The guard protects against a compromised
  *agent*; if the owner's own key is stolen, the thief is the owner
  as far as the contract is concerned.
- **Payee identity.** See attacker 5.
- **Real funds.** Testnet only. Nothing here has been formally
  audited, and nothing here should hold real funds.

## Verification summary

- `npm test`: 61 tests (19 contract + 15 intent + 13 leash-rule +
  14 attack battery, incl. 3 seeded fuzz runs of 150 operations
  each) — all passing.
- Slither 0.11.6 on `contracts/BillPayGuard.sol`: 6 findings, 0 high,
  0 medium (triage in `docs/SECURITY.md`, raw output in
  `docs/slither-report.txt`).
- On-chain: 8 payments (0.50 QOR), 2 contract reverts, 1 leash
  refusal — every hash in `deployments/demo.json`.
