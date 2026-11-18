# BillPay Guard

An autonomous bill-payment agent with spending limits enforced on-chain —
built for the [QoreChain Developer Fest](https://build.qorechain.io)
("Build Before Q-Day"), **Post-Quantum AI Agents** category.

The owner deposits funds, registers bill schedules (one allowlisted payee
per schedule, with per-payment and total caps, a maximum payment count, a
minimum interval, and an expiry), and authorises one agent address. The
agent runner then pays the bills — and the guard contract refuses any
payment outside the limits. The limits live on-chain, not in the agent:
even a compromised agent cannot pay a different address, exceed a cap, pay
early, or pay after expiry.

Every payment is an EVM transaction admitted only inside a post-quantum
authorisation window opened by a hybrid-signed (secp256k1 + ML-DSA-87)
message, so the agent's key alone — without its ML-DSA-87 key — cannot move
funds.

**This is a bill payer, not a trading agent.** It pays fixed bills to fixed
payees. It does not swap, does not trade, and holds no price feeds.

## Live deployment (QoreChain testnet, qorechain-diana)

- Contract: [`0xac31fb4f4b85f29f6dc72e8485fa9188b37f3b6e`](https://explore.qore.network/address/0xac31fb4f4b85f29f6dc72e8485fa9188b37f3b6e) (deployed 15 Nov 2026, block 10151549, deploy tx `0x600dfc9301c97d178a3bc2676b1aa520dd4b2c7a15285f2f778f1198f1287c10`)
- Live demo: https://andipangeranm142.github.io/billpay-guard/
- Demo video: [`docs/demo.mp4`](docs/demo.mp4) (2:37, 1080p, real screen recording — includes a payment executed live during the recording)
- Project page: [billpay-guard on build.qorechain.io](https://build.qorechain.io/p/billpay-guard) (Post-Quantum AI Agents; AI-Native Verified)

Deployment record: [`deployments/testnet.json`](deployments/testnet.json).
Demo evidence: [`deployments/demo.json`](deployments/demo.json).

> Note: an earlier `setup-demo` run accidentally deployed a second, empty
> instance of the same contract
> (`0x3cfd510876608551be630cdb68e2b40205541fc7`) because the deploy script
> ran on import. That instance holds no funds, has no schedules, and is
> unused; the bug was fixed (see `scripts/cosmos-hash.ts` and the guarded
> `main()` in `scripts/deploy.ts`). The canonical deployment is the one
> above.

## How it works

```
Owner                          BillPayGuard contract              Agent runner
  │ deposit()                        │                              │
  │ ────────────────────────────────>│                              │
  │ createSchedule(payee, caps…)     │                              │
  │ ────────────────────────────────>│                              │
  │ setAgent(agent)                  │                              │
  │ ────────────────────────────────>│                              │
  │                                  │   checkDue(id) ──────────────│
  │                                  │   (due? why not?)            │
  │                                  │<──────── executePayment(id) ─│
  │                                  │   caps ✓ interval ✓ expiry ✓ │
  │                                  │   ── amount ──> payee         │
```

**The guard enforces, on-chain, for every payment:**

| Limit | What it means |
|---|---|
| Target | Only the schedule's registered payee can ever receive funds. |
| Per-payment value | Each payment is exactly `amountPerPayment` — no more. |
| Total value | `paid + amountPerPayment` must stay within `totalCap`. |
| Transaction count | At most `maxPayments` payments per schedule. |
| Duration | At least `intervalSeconds` between payments; nothing after `expiry`. |
| Authorisation | Only the owner or the owner's authorised agent may execute. |

The owner can change the limits (`updateSchedule`), cancel a schedule,
revoke the agent, or withdraw unspent funds at any time.

**The agent runner** (`scripts/agent.ts`) is deliberately dumb: it reads
every schedule, asks the contract itself whether each is due (`checkDue`),
executes the due ones, and logs every skip with its reason. It never
decides a limit, so it can never talk itself into breaking one. Run it
once (`npm run agent`), on a loop (`npm run agent -- --loop 60`), or as a
dry run (`npm run agent -- --dry-run`).

## The leash: abstract-account spending rules

On top of the contract's own limits, the agent wears a second leash
enforced by the chain's abstract-account module (`scripts/leash.ts`):

- The owner holds an abstract account
  ([REST](https://api-testnet.qore.host/qorechain/abstractaccount/v1/accounts/qor1xfnf0vdpatfwpl9qy365l42np4l9e00wkzdg9y),
  `session_based`, created 16 Nov 2026,
  [tx `43B2C4D4…09B9D`](https://explore.qore.network/tx/43B2C4D432AADF644DE81A39BACD718B625D7CAD7CD23F7E74B7CF5B84C09B9D)).
- The agent key is linked to that account as an authenticator with the
  `evm` permission only
  ([REST](https://api-testnet.qore.host/qorechain/abstractaccount/v1/accounts/qor1xfnf0vdpatfwpl9qy365l42np4l9e00wkzdg9y/authenticators),
  [tx `598647E1…08D4`](https://explore.qore.network/tx/598647E1D891A3BCBFC69883F301C380A5A0C657C5EFECEAE6193442F1BC08D4)),
  expiring 15 Dec 2026 19:27:51 UTC — the same expiry as schedule 1.
- The link carries a spending rule, `billpay-agent`
  ([REST](https://api-testnet.qore.host/qorechain/abstractaccount/v1/accounts/qor1xfnf0vdpatfwpl9qy365l42np4l9e00wkzdg9y/spending_rules)):
  at most 50,000 uqor (0.05 QOR) per execution, 500,000 uqor (0.50 QOR)
  per day, denoms `["uqor"]`, and only one EVM call —
  `0xac31fb4f4b85f29f6dc72e8485fa9188b37f3b6e/0x162a0cf8`
  (`executePayment(uint256)` on the guard contract). The rule mirrors
  schedule 1's caps; the per-schedule caps themselves are still the
  contract's job, since the rule allows the function on any schedule id.

A leashed payment works like this: the agent signs a meta-transaction
(`MsgExecuteEVM`, EIP-191 `personal_sign`) for `executePayment(1)` and the
owner relays it, paying the fee. The chain checks the spending rule before
the call runs, and the EVM call executes from the owner's address, so the
contract sees `msg.sender == owner`. No EVM window is needed on either
account for this path — the rule, not the window, is what bounds the agent
here. Two leashed payments have actually run: schedule 1 went from 0.10 to
0.15 QOR paid (3/10 payments) in
[tx `FA5A2A89…49D70`](https://explore.qore.network/tx/FA5A2A898B805B7FBD476F42538D8BA1D1F0212B8BB172A0DEB54468B4149D70)
(block 10159020, 16 Nov 2026), and from 0.20 to 0.25 QOR paid (5/10
payments) in
[tx `456F314D…9FDDD76`](https://explore.qore.network/tx/456F314DFC5A58E2052E592EA868E679CBD166C0981E80FB3AFE4842F9FDDD76)
(block 10335976, 19 Nov 2026) — the second one relayed only after the
runner verified the owner's ML-DSA-87-signed payment intent (see
"Authenticated messaging" below). The leashed payment has no separate EVM
transaction hash — the EVM call executes inside the Cosmos `MsgExecuteEVM`
transaction, so the Cosmos hash plus the schedule state change is the
proof.

**The rule bites — proven on-chain.** On 19 Nov 2026 the agent signed a
meta-transaction the rule forbids — `withdraw(uint256)` on the guard
contract, a function outside the allowlist (which permits only
`executePayment`) — and the owner relayed it
([tx `FEF47E6B…43F801`](https://explore.qore.network/tx/FEF47E6B1BD611AC80D53C59F3C760FC355A2F5907363AE3530F07604343F801),
block 10335955). The relay transaction landed with code 0, but the
execution was refused inside it: the chain emitted an
`abstractaccount_execution_failed` event with the reason *"a linked key
with a spending rule may call 0xAc31FB4F4b85F29F6DC72e8485Fa9188b37f3B6E
with data only if the rule lists the call in allowed_evm_calls …
authenticator not permitted for this action"*. Schedule 1 and the owner's
contract balance were verified unchanged afterwards (0.20/0.50 QOR, 4/10;
0.10 QOR). Full record:
[`deployments/leash-rejection.json`](deployments/leash-rejection.json)
(re-run with `npx tsx scripts/leash.ts reject`). One thing the run
taught us: the refused attempt still consumed authenticator nonce 1 — the
next leashed payment used nonce 2.

Two honest notes. First, the authenticator view reports
`has_spend_rule: false`: that field means a rule attached to the key
itself, and the module has no message to set a per-key rule — the key is
bound by the account-wide rule above, which is what the chain applies
(the first enabled rule bounds every linked key without its own). Second,
the leashed path needs a relayer: the agent cannot pay while the owner is
offline to relay. The agent's normal EOA path (`scripts/agent.ts`, and the
drill-day `scripts/drill-pay.ts`) keeps working independently of the leash.

```bash
npx tsx scripts/leash.ts status   # abstract account, rules, authenticators, schedule 1
npx tsx scripts/leash.ts setup    # create the account + link the agent (idempotent)
npx tsx scripts/leash.ts pay      # pay schedule 1 once through the leash
npx tsx scripts/leash.ts reject   # prove the rule bites: relay one forbidden
                                  # call and record the chain's refusal
```

## Authenticated messaging: ML-DSA-87 payment intents

Before a leashed payment is relayed, the owner signs a **payment
intent** — a small JSON message naming the contract, the schedule, the
payment number, the payee, and the exact amount — with their ML-DSA-87
key, and the runner verifies that signature before executing
(`scripts/intent.ts`, full write-up in
[`docs/AUTHENTICATED_MESSAGING.md`](docs/AUTHENTICATED_MESSAGING.md)):

- The signature is a real ML-DSA-87 (Dilithium-5) signature (`pqcSign`
  from `@qorechain/sdk`) made with the owner's ML-DSA-87 key, derived
  from the owner's mnemonic — the same key the chain already has
  registered for the account.
- Verification checks the signature against the owner's **on-chain
  registered** PQC key (fetched from REST, never trusted from the file),
  and checks the intent against the schedule's live state: payee,
  amount, expiry, and `paymentNumber == payments + 1`, so an intent
  authorises exactly one payment and cannot be replayed.
- `leash.ts pay` verifies a signed intent whenever one exists for the
  next payment and refuses to relay on any mismatch; with
  `--require-intent` it refuses to relay without one. The second
  leashed payment (19 Nov 2026, tx `456F314D…9FDDD76`) ran in strict
  mode against
  [`deployments/intents/intent-1-5.json`](deployments/intents/intent-1-5.json).

Honest scope: verification is **off-chain**, by the runner, before
relaying. The contract does not verify ML-DSA signatures (no
in-contract `pqcVerify`), so a runner that skipped verification could
still pay within the contract's caps and the leash's rule. The layer
adds a post-quantum-signed audit trail and a pre-execution gate in the
honest runner — it is not a third on-chain enforcement layer. Payment
intents are public audit records by design, so nothing here is
ML-KEM-sealed; there is no secret in a payment authorisation to protect.

```bash
npx tsx scripts/intent.ts sign 1                            # sign the next payment's intent
npx tsx scripts/intent.ts verify deployments/intents/intent-1-5.json   # verify a signed intent
npx tsx scripts/leash.ts pay --require-intent              # pay only with a verified intent
```

## Category requirements

| Requirement | How BillPay Guard meets it |
|---|---|
| Scoped EVM window | Every EVM transaction (owner and agent alike) is admitted only inside a post-quantum authorisation window opened by a hybrid-signed message. See `scripts/window.ts`. |
| Transaction limits | `maxPayments` per schedule + minimum `intervalSeconds` between payments. |
| Value limits | `amountPerPayment` per payment + `totalCap` per schedule. |
| Duration limits | `intervalSeconds` + `expiry` per schedule. |
| Target limits | One allowlisted payee per schedule; the contract pays nobody else. |
| Smart-account spending rules | A real abstract-account layer on top of the contract: the agent key is linked to the owner's abstract account with the `evm` permission and a chain-enforced spending rule — and the rule has been proven to bite: a forbidden `withdraw` call was refused on-chain with an `abstractaccount_execution_failed` event (see "The leash" below). |
| Authenticated messaging | Before a leashed payment is relayed, the owner signs a payment intent with their ML-DSA-87 key and the runner verifies the signature against the owner's on-chain registered PQC key plus the live schedule (see "Authenticated messaging" below). The agent also authenticates with its own key inside its own PQ window on the EOA path, and with an EIP-191-signed meta-transaction on the leashed path. |

## Repository layout

```
contracts/BillPayGuard.sol      the guard contract
contracts/BillPayGuard.artifact.ts   generated ABI + bytecode (npm run compile)
scripts/window.ts               PQC key registration + EVM window (owner & agent)
scripts/deploy.ts               deploy to the Diana testnet
scripts/setup-demo.ts           deposit + demo schedules + agent authorisation
scripts/agent.ts                the off-chain agent runner
scripts/leash.ts                abstract-account leash: link the agent key
                                with a chain-enforced spending rule, pay
                                schedule 1 through a relayed meta-transaction,
                                prove the rule bites (reject)
scripts/intent.ts               authenticated messaging: ML-DSA-87-signed
                                payment intents (sign / verify), checked by
                                the leash runner before relaying
scripts/demo-rejection.ts       demonstrate an on-chain limit rejection
scripts/render-check.mjs        Playwright render check of the live demo
scripts/prepare-env.ts          one-time local env setup (writes .env files)
test/billpay-guard.test.ts      contract tests (Ganache local chain)
test/intent.test.ts             authenticated-messaging tests (offline)
src/                            React dashboard (Vite + wagmi + RainbowKit)
docs/demo.mp4                   demo video (real screen recording, ≤ 3 min)
docs/featured.png               featured image for the project page
deployments/testnet.json        deployment record (address, hashes, explorer links)
deployments/demo.json           demo evidence (schedules, payments, rejections)
deployments/leash-rejection.json  the chain's refusal of a forbidden leashed call
deployments/intents/            signed ML-DSA-87 payment intents (public data)
```

## Run it yourself (testnet)

Prerequisites: Node 20+, a QoreChain testnet wallet funded with QOR
(faucet: https://dashboard.qorechain.io), and the wallet's mnemonic.

```bash
git clone https://github.com/andiPangeranm142/billpay-guard
cd billpay-guard
npm install
npm run compile
npm test
```

**Owner account** — put the mnemonic in `../deployer.json`
(`{mnemonic, evm, cosmos}`, mode 600, outside the repo) or write `.env`
from `.env.example`, then:

```bash
npm run window register   # ML-DSA-87 key — the account's FIRST transaction
npm run window open       # open a post-quantum EVM window
npm run deploy            # deploy BillPayGuard (writes deployments/testnet.json)
npm run setup-demo        # deposit + demo schedules + authorise + fund the agent
```

**Agent account** — a separate key, generated by `scripts/prepare-env.ts`
into `../agent.json` + `.env.agent`:

```bash
npm run window-agent register
npm run window-agent open
npm run agent             # one pass: pay what is due, log what is skipped
```

**Frontend:**

```bash
VITE_BILLPAY_GUARD_ADDRESS=0x… VITE_DEPLOY_BLOCK=… npm run build
npm run preview
```

## Demo evidence

The demo setup (`scripts/setup-demo.ts`) created two real schedules on the
Diana testnet (15 Nov 2026): schedule 0 "rent" (0.1 QOR/payment, 0.25 QOR
total cap, max 5, 30 s interval) and schedule 1 "subscription"
(0.05 QOR/payment, 0.5 QOR total cap, max 10, 60 s interval), funded with a
0.5 QOR deposit. The agent runner then paid them — **4 real on-chain
payments, 0.30 QOR total** (the fourth executed live during the demo-video
recording). A fifth payment (schedule 1, 0.05 QOR) ran 16 Nov 2026 through
the abstract-account leash (see "The leash" above), bringing the total to
**5 payments, 0.35 QOR**. A sixth payment (schedule 1, 0.05 QOR) ran
18 Nov 2026 as the Q-Day Drill proof (`scripts/drill-pay.ts`, tx
`0x96d84888…16f502`, block 10286574), bringing the total to **6 payments,
0.40 QOR**. A seventh payment (schedule 1, 0.05 QOR) ran 19 Nov 2026
through the leash, gated by the owner's verified ML-DSA-87 payment intent
(Cosmos tx `456F314D…9FDDD76`, block 10335976), bringing the total to **7
payments, 0.45 QOR**. Two further payment attempts were **rejected
on-chain** (transactions mined with status `reverted`): one too-soon
(interval not elapsed) and one cap-reaching (a third 0.1 QOR payment would
have exceeded schedule 0's 0.25 QOR cap). A third refusal happened at the
leash layer: a forbidden `withdraw` call was refused by the chain's
spending-rule check (see "The leash" above). All hashes are recorded in
[`deployments/demo.json`](deployments/demo.json) — nothing here claims an
on-chain result that has not happened.

Live state, re-verified 19 Nov 2026 after the intent-gated leashed
payment (read back from the contract): the guard holds **0.05 QOR** (0.5
QOR deposit − 0.45 QOR paid); schedule 0 has paid 0.2 / 0.25 QOR and is
`cap-reached`; schedule 1 has paid 0.25 / 0.5 QOR (5/10 payments) and is
`due` again once its 60 s interval elapses. Both schedules expire 15 Dec
2026.

## Limitations — read this

- **Testnet only.** All funds are testnet QOR with no value. Nothing here
  has been audited; nothing here should hold real funds.
- **The agent is a script, not a service.** It pays only while someone
  runs it. There is no always-on infrastructure in this repo.
- **The contract cannot verify who a payee is.** It enforces that funds go
  only to the registered address — but if the owner registers the wrong
  address, the funds go to the wrong address. Check payees before creating
  schedules.
- **The leash needs a relayer.** A leashed payment only lands while the
  owner is online to relay the agent's signed meta-transaction. The
  agent's normal EOA path does not have this dependency.
- **The spending rule allows the function, not the schedule.** The
  `billpay-agent` rule permits `executePayment` on any schedule id; the
  per-schedule caps (which schedule, how much, how often) are enforced by
  the contract, not by the rule.
- **Payment intents are verified off-chain, not by the contract.** The
  ML-DSA-87 intent layer (`scripts/intent.ts`) is a pre-execution gate
  in the runner plus a signed audit trail; the contract has no
  in-contract `pqcVerify` and cannot check intents. A runner that
  skipped verification could still pay within the contract's caps and
  the leash's rule. Intents currently gate the leashed path only, not
  the EOA path (`scripts/agent.ts`).
- **Owner-key compromise is out of scope.** The guard protects against a
  compromised *agent*; if the owner's own key is stolen, the thief is the
  owner as far as the contract is concerned.
- **The PQ window is a chain rule, not contract logic.** The contract
  trusts the chain to admit only windowed transactions. If the chain's
  admission rule changed, the contract would not notice.
- **No partial payments, no refunds.** Each payment is exactly
  `amountPerPayment`; overpaying a bill is the owner's configuration
  error, not something the contract can detect.

## Credits

- Built with the QoreChain SDK and EVM packages (`@qorechain/sdk`,
  `@qorechain/evm`), the QoreX RainbowKit wallet, viem, and wagmi.
- The window helper, deploy script, test setup, and frontend scaffold
  follow the patterns of the sibling project Quantum Flip (same author,
  same event), whose window helper came from the official QoreChain
  `hardhat` template and whose frontend came from the official
  `viem-wagmi` template.
- See [`AI_USAGE.md`](AI_USAGE.md) for how AI was used to build this
  project.

## License

Apache-2.0. See [`LICENSE`](LICENSE).
