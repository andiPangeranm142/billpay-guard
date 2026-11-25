# Verify BillPay Guard — a judge's guide

Everything below is read-only except the local test run. No wallet, no
funds, no account needed. Times are for a normal laptop; the test suite
is the slowest step (~2 minutes).

## 1. Run the tests (2 minutes)

```bash
git clone https://github.com/andiPangeranm142/billpay-guard
cd billpay-guard
npm install
npm test          # 61 tests: 19 contract + 15 intent + 13 leash-rule + 14 attack battery
npm run typecheck # tsc --noEmit, clean
npm run build     # the demo frontend builds
```

The attack battery (`test/attack-battery.test.ts`) is the interesting
part: a reentrant payee and a reentrant withdrawer that both fail to
take a second wei, plus three seeded model-based fuzz runs (150 random
operations each) where every outcome is predicted from an off-chain
model before it is sent.

## 2. Re-read the live state (30 seconds, read-only)

```bash
npx tsx scripts/verify-live.ts
```

This reads the deployed contract on the Diana testnet and prints the
owner balance, total payments and volume, both schedules, and whether
each schedule is due — the same numbers the README and the demo show.
No wallet is involved; it only calls the public RPC.

## 3. Check the contract on the explorer

Contract: [`0xac31fb4f4b85f29f6dc72e8485fa9188b37f3b6e`](https://explore.qore.network/address/0xac31fb4f4b85f29f6dc72e8485fa9188b37f3b6e)
(switch the explorer to Testnet). Deployed 15 Nov 2026, block
10151549, deploy tx
`0x600dfc9301c97d178a3bc2676b1aa520dd4b2c7a15285f2f778f1198f1287c10`.

Live state (re-verified 25 Nov 2026): the guard holds 0.30 QOR
(0.80 QOR deposited, 0.50 QOR paid); schedule 0 "rent" paid 0.20/0.25
QOR (2 payments, cap-reached); schedule 1 "subscription" paid
0.30/0.50 QOR (6/10 payments, due). Both schedules expire 15 Dec 2026.

## 4. Check the payments and refusals

Every hash is in [`deployments/demo.json`](deployments/demo.json)
(paste any hash into explore.qore.network):

- 8 real payments, 0.50 QOR total: 4 via the agent's own key, 1 as
  the Q-Day Drill proof (18 Nov 2026, tx `0x96d84888…16f502`), 3
  through the abstract-account leash (the last two gated by verified
  ML-DSA-87 payment intents).
- 2 contract reverts on-chain: too-soon (`0x43fc142e…62ed4`, block
  10151718) and cap-reached (`0x35ebc083…7f56b`, block 10151739).
- 1 leash refusal: a forbidden `withdraw` call refused by the
  chain's spending-rule check (Cosmos tx `FEF47E6B…43F801`, block
  10335955, `abstractaccount_execution_failed`). Full record:
  [`deployments/leash-rejection.json`](deployments/leash-rejection.json).

The demo renders the same 8 payments and re-verifies each EVM payment
against the chain when the page loads.

## 5. Check the leash and the intents

- Abstract account
  [`qor1xfnf0vdpatfwpl9qy365l42np4l9e00wkzdg9y`](https://api-testnet.qore.host/qorechain/abstractaccount/v1/accounts/qor1xfnf0vdpatfwpl9qy365l42np4l9e00wkzdg9y)
  (`session_based`): the agent key is linked with the `evm`
  permission only, bound by spending rule `billpay-agent` (50,000
  uqor per execution, 500,000 uqor per day, only `executePayment` on
  the guard contract).
- Signed ML-DSA-87 payment intents:
  [`deployments/intents/`](deployments/intents/). Verify one with
  `npx tsx scripts/intent.ts verify deployments/intents/intent-1-6.json`
  (a used intent correctly fails the payment-number check — that is
  the anti-replay working). Full write-up:
  [`docs/AUTHENTICATED_MESSAGING.md`](docs/AUTHENTICATED_MESSAGING.md).

## 6. The demo and the video

- Live demo: https://andipangeranm142.github.io/billpay-guard/
  (payment history, leash panel, authenticated-messaging panel).
- Demo video: [`docs/demo.mp4`](docs/demo.mp4) (2:51, 1080p, real
  screen recording — includes a leashed payment executed live during
  the recording).

## 7. What the project does not claim

- The contract has no in-contract `pqcVerify`: payment intents are
  verified off-chain by the runner. The README and
  [`docs/THREAT_MODEL.md`](docs/THREAT_MODEL.md) say so plainly.
- Nothing here has been formally audited. Static analysis: Slither
  0.11.6, 0 high / 0 medium findings (triage in
  [`docs/SECURITY.md`](docs/SECURITY.md)).
- Testnet only; nothing here should hold real funds.
