# Authenticated messaging: ML-DSA-87 payment intents

BillPay Guard's agent does not pay on its own say-so. Before a leashed
payment is relayed, the owner signs a **payment intent** with their
ML-DSA-87 key (QoreSign), and the runner verifies that signature before
executing. This document describes what the layer is, what it proves,
and — honestly — what it does not do.

## The flow

```
Owner                                   Agent runner (leash.ts pay)
  │                                              │
  │  intent.ts sign 1                            │
  │  ┌─────────────────────────────────┐         │
  │  │ intent: schedule 1, payment #5, │         │
  │  │ 0.05 QOR to 0x5dA5…4779,        │         │
  │  │ expiry 15 Dec 2026              │         │
  │  │ signed with owner's ML-DSA-87   │         │
  │  │ key (derived from the mnemonic) │         │
  │  └──────────────┬──────────────────┘         │
  │                 │ deployments/intents/       │
  │                 │ intent-1-5.json            │
  │                 ▼                            │
  │                        verify before relay:  │
  │                        1. signature valid    │
  │                           under the owner's  │
  │                           ON-CHAIN registered│
  │                           PQC key (REST)     │
  │                        2. intent matches the │
  │                           live schedule      │
  │                           (payee, amount,    │
  │                           next payment #)    │
  │                        3. relay MsgExecuteEVM│
  │                           (leash rule checks │
  │                           it again on-chain) │
```

## What an intent is

A payment intent (`scripts/intent.ts`) is a small JSON message with a
fixed canonical encoding:

```json
{
  "version": 1,
  "kind": "billpay-payment",
  "chainId": "qorechain-diana",
  "contract": "0xac31fb4f4b85f29f6dc72e8485fa9188b37f3b6e",
  "scheduleId": 1,
  "paymentNumber": 5,
  "payee": "0x5da52428de0b9928105175cf00c6435b21ab4779",
  "amountWei": "50000000000000000",
  "expiryUnix": 1797362871
}
```

The owner signs the canonical bytes with ML-DSA-87 (Dilithium-5) via
`pqcSign` from `@qorechain/sdk`, using the ML-DSA-87 keypair derived
from the owner's mnemonic (`deriveUnifiedAccount`, the same derivation
`scripts/window.ts` uses for registration). The signed file
(`deployments/intents/intent-<schedule>-<payment>.json`) holds the
intent, the signer's addresses, the owner's ML-DSA-87 public key
(base64, 2592 bytes — already public, registered on-chain), and the
signature (base64, 4627 bytes). It contains no secret and is safe to
commit.

## What verification checks

`verifySignedIntent` (used by `intent.ts verify` and by `leash.ts pay`)
checks three things, and refuses on any failure:

1. **The key is the owner's.** The public key embedded in the file must
   byte-match the ML-DSA-87 key the chain has registered for the owner
   (fetched from REST via `fetchPqcStatus`). A forged file with a
   swapped key cannot pass: the signature is verified under the
   *registered* key, not the file's key.
2. **The signature is valid.** `pqcVerify` over the intent's canonical
   bytes. Any tampering with the intent — payee, amount, payment
   number, contract, chain — invalidates it.
3. **The intent matches the live schedule.** Payee, amount per payment,
   and expiry must equal the schedule's on-chain state, and
   `paymentNumber` must be the schedule's *next* payment
   (`payments + 1`). An intent therefore authorises exactly one payment
   and cannot be replayed for a later one, retargeted at another payee,
   or reused for a different amount.

`intent.ts sign` refuses to sign unless the schedule is due and the
derived ML-DSA key is the one registered on chain, and it self-verifies
the freshly signed file before writing it.

## How the runner uses it

`leash.ts pay` looks for the intent file for the schedule's next payment
(`deployments/intents/intent-1-<n>.json`):

- **Intent present:** it is verified as above; any mismatch refuses the
  relay and nothing is sent.
- **Intent absent, `--require-intent` given:** the relay is refused.
  This is the strict mode, and it is how the 19 Nov 2026 leashed
  payment ran (`leash.ts pay --require-intent`).
- **Intent absent, no flag:** the runner logs a warning and proceeds —
  the payment is still bounded by the contract's caps and the leash's
  spending rule, just without an intent authorisation for that payment.

The EOA path (`scripts/agent.ts`, `scripts/drill-pay.ts`) does not use
intents: it pays inside the agent's own post-quantum window, and the
contract still enforces every limit there. Intents currently gate the
leashed path only.

## Live evidence

- **Intent for schedule 1 payment #5:**
  `deployments/intents/intent-1-5.json`, signed 18 Nov 2026 20:35:55 UTC
  by the owner `0x326697b1a1EAd2E0FCa024754Fd5530D7e5cBDee`.
  Re-verify it any time with:
  `npx tsx scripts/intent.ts verify deployments/intents/intent-1-5.json`
  (note: the schedule-match check compares against the *live* schedule,
  so it passes only while payment #5 is still the next payment — after
  the payment lands, the same file correctly fails the paymentNumber
  check, which is the anti-replay rule working as designed).
- **The payment it authorised:** leashed payment #5 of schedule 1,
  Cosmos tx
  [`456F314D…9FDDD76`](https://explore.qore.network/tx/456F314DFC5A58E2052E592EA868E679CBD166C0981E80FB3AFE4842F9FDDD76)
  (block 10335976, 18 Nov 2026 20:36:12 UTC). Schedule 1 went from
  0.20/0.50 QOR (4/10) to 0.25/0.50 QOR (5/10).

## Honest scope — read this

- **Verification is off-chain.** The runner verifies the intent before
  relaying; the contract does NOT verify ML-DSA signatures — there is
  no in-contract `pqcVerify`, and the contract cannot tell whether an
  intent existed for a payment. A runner that skipped verification
  could still pay, bounded only by the contract's caps and the leash's
  spending rule. The intent layer adds a post-quantum-signed audit
  trail and a pre-execution gate in the honest runner; it is not a
  third on-chain enforcement layer.
- **The intent does not move funds by itself.** It authorises one
  payment of one schedule; the contract still enforces the caps, the
  interval, the expiry, and the payee, and the leash's spending rule
  still bounds the execution on-chain.
- **No QoreSeal encryption.** Payment reports are not sealed with
  ML-KEM: the intent file is public by design (it is an audit record,
  not a confidential message), and nothing in this project needs
  confidentiality for payment authorisations. We did not add
  encryption theatre to a flow that has no secret to protect.
- **Key compromise.** If the owner's ML-DSA secret key were stolen, the
  thief could sign intents — but intents alone move nothing: the thief
  would still need the agent key (or the owner key) to relay, and the
  contract caps would still bound every payment. Owner-key compromise
  remains out of scope, as documented in the README.

## Tests

`test/intent.test.ts` (8 tests, offline, throwaway keypairs): sign and
verify, deterministic signing, tampered intent / signature / key
rejection, malformed-input rejection, every schedule-mismatch case
including the anti-replay paymentNumber rule, and the JSON file
round-trip. Run with `npm test` (22 tests total: 14 contract + 8 intent).
