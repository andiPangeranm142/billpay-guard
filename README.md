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

> Deployment details are filled in by `npm run deploy` (see
> [`deployments/testnet.json`](deployments/testnet.json)).

- Contract: _to be deployed_
- Live demo: https://andipangeranm142.github.io/billpay-guard/
- Demo video: [`docs/demo.mp4`](docs/demo.mp4) (≤ 3 min, real screen recording)
- Project page: https://build.qorechain.io/p/billpay-guard

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

## Category requirements

| Requirement | How BillPay Guard meets it |
|---|---|
| Scoped EVM window | Every EVM transaction (owner and agent alike) is admitted only inside a post-quantum authorisation window opened by a hybrid-signed message. See `scripts/window.ts`. |
| Transaction limits | `maxPayments` per schedule + minimum `intervalSeconds` between payments. |
| Value limits | `amountPerPayment` per payment + `totalCap` per schedule. |
| Duration limits | `intervalSeconds` + `expiry` per schedule. |
| Target limits | One allowlisted payee per schedule; the contract pays nobody else. |
| Smart-account spending rules | The guard contract is the spending-rules engine: caps are enforced on-chain, not in the agent. |
| Authenticated messaging | Only the owner-authorised agent address may execute payments; the agent authenticates with its own key inside its own PQ window. |

## Repository layout

```
contracts/BillPayGuard.sol      the guard contract
contracts/BillPayGuard.artifact.ts   generated ABI + bytecode (npm run compile)
scripts/window.ts               PQC key registration + EVM window (owner & agent)
scripts/deploy.ts               deploy to the Diana testnet
scripts/setup-demo.ts           deposit + demo schedules + agent authorisation
scripts/agent.ts                the off-chain agent runner
scripts/demo-rejection.ts       demonstrate an on-chain limit rejection
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

The demo setup (`scripts/setup-demo.ts`) creates two real schedules on the
Diana testnet and the agent runner pays them; the rejection demo
(`scripts/demo-rejection.ts`) then attempts a payment that would breach
schedule 0's total cap, and the guard refuses it. All hashes are recorded
in [`deployments/demo.json`](deployments/demo.json) — nothing here claims
an on-chain result that has not happened.

## Limitations — read this

- **Testnet only.** All funds are testnet QOR with no value. Nothing here
  has been audited; nothing here should hold real funds.
- **The agent is a script, not a service.** It pays only while someone
  runs it. There is no always-on infrastructure in this repo.
- **The contract cannot verify who a payee is.** It enforces that funds go
  only to the registered address — but if the owner registers the wrong
  address, the funds go to the wrong address. Check payees before creating
  schedules.
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
