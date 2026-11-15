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
here. One leashed payment has actually run: schedule 1 went from 0.10 to
0.15 QOR paid (3/10 payments) in
[tx `FA5A2A89…49D70`](https://explore.qore.network/tx/FA5A2A898B805B7FBD476F42538D8BA1D1F0212B8BB172A0DEB54468B4149D70)
(block 10159020, 16 Nov 2026; the agent's authenticator nonce is now 1).
The leashed payment has no separate EVM transaction hash — the EVM call
executes inside the Cosmos `MsgExecuteEVM` transaction, so the Cosmos hash
plus the schedule state change is the proof.

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
```

## Category requirements

| Requirement | How BillPay Guard meets it |
|---|---|
| Scoped EVM window | Every EVM transaction (owner and agent alike) is admitted only inside a post-quantum authorisation window opened by a hybrid-signed message. See `scripts/window.ts`. |
| Transaction limits | `maxPayments` per schedule + minimum `intervalSeconds` between payments. |
| Value limits | `amountPerPayment` per payment + `totalCap` per schedule. |
| Duration limits | `intervalSeconds` + `expiry` per schedule. |
| Target limits | One allowlisted payee per schedule; the contract pays nobody else. |
| Smart-account spending rules | A real abstract-account layer on top of the contract: the agent key is linked to the owner's abstract account with the `evm` permission and a chain-enforced spending rule (see "The leash" below). |
| Authenticated messaging | Only the owner-authorised agent address may execute payments; the agent authenticates with its own key inside its own PQ window — or, on the leashed path, with an EIP-191-signed meta-transaction the chain checks against its spending rule. |

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
                                schedule 1 through a relayed meta-transaction
scripts/demo-rejection.ts       demonstrate an on-chain limit rejection
scripts/render-check.mjs        Playwright render check of the live demo
scripts/prepare-env.ts          one-time local env setup (writes .env files)
test/billpay-guard.test.ts      contract tests (Ganache local chain)
src/                            React dashboard (Vite + wagmi + RainbowKit)
docs/demo.mp4                   demo video (real screen recording, ≤ 3 min)
docs/featured.png               featured image for the project page
deployments/testnet.json        deployment record (address, hashes, explorer links)
deployments/demo.json           demo evidence (schedules, payments, rejection)
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
**5 payments, 0.35 QOR**. Two further payment attempts were **rejected
on-chain** (transactions mined with status `reverted`): one too-soon
(interval not elapsed) and one cap-reaching (a third 0.1 QOR payment would
have exceeded schedule 0's 0.25 QOR cap). All hashes are recorded in
[`deployments/demo.json`](deployments/demo.json) — nothing here claims an
on-chain result that has not happened.

Live state, re-verified 16 Nov 2026 (read back from the contract): the
guard holds **0.15 QOR** (0.5 QOR deposit − 0.35 QOR paid); schedule 0 has
paid 0.2 / 0.25 QOR and is `cap-reached`; schedule 1 has paid 0.15 / 0.5
QOR (3/10 payments) and is `due`. Both schedules expire 15 Dec 2026.

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
