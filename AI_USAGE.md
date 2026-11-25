# AI Usage — BillPay Guard

This file documents how AI was used to build BillPay Guard, what the AI
generated, what the human contributed, and how the work was verified. It
exists for the QoreChain Developer Fest's **Best AI-Native Build** award,
and as an honest development record.

## Summary

BillPay Guard was built end-to-end by an AI coding agent (**Muse**, running
as the assistant "forza") from a human-approved concept, over build sessions
starting 16 November 2026. The human (Aeron) chose the event and the
category, approved the concept and the multi-project plan, and owns every
step that needs a human identity: accounts, funding, registration, and
submission. The concept and the contract are original — the concept
(bill payments with on-chain spending limits) was checked against the
projects already listed on build.qorechain.io before building began, and
is deliberately different from the rival DCA/trading agent in the same
category: this agent pays bills, it does not trade. Proven scaffolding
patterns (the window helper, deploy script, test setup, and frontend
scaffold) were reused and adapted from the sibling project Quantum Flip,
with credit in the README.

## Workflow

1. **Research first, code second.** The agent read the fest site, the
   QoreChain docs (SDK, EVM window, hybrid signing, QoreX), and the
   published npm packages before writing anything. The sibling project
   Quantum Flip (same author, same event) served as the reference for
   proven patterns: its window helper, deploy script, test setup, and
   frontend scaffold were reused and adapted, with credit in the README.
2. **Never guess an API.** Every SDK/EVM function used was checked against
   the type definitions in `node_modules` (or the docs) before use —
   including `deriveUnifiedAccount`, `evmWindowStatus`, `fetchPqcStatus`,
   and viem's `mnemonicToAccount` derivation path.
3. **Verify at every step.** Contract compiled with `solc` 0.8.24;
   artifact regenerated from compiler output by script (never
   hand-copied); `tsc --noEmit` typecheck; automated contract tests on a
   local EVM (including every limit rejection); `vite build` for the
   frontend; Playwright render check of the live demo after deployment.
   On-chain verification was done the same week: the contract deployed on
   the Diana testnet, the agent runner executed real payments (8
   payments, 0.50 QOR total, three of them through the
   abstract-account leash), a limit rejection was demonstrated
   on-chain, and a leash rejection was proven on-chain (19 Nov 2026: a
   `withdraw()` call outside the leash rule's allowlist was blocked by
   the abstract account — see `deployments/leash-rejection.json`).
   Authenticated messaging was added 19 Nov 2026: the agent's payment
   intents are ML-DSA-87 signed (`scripts/intent.ts`), verified
   off-chain with anti-replay. Every transaction hash in this repo was
   read back from the chain. Nothing in this repo claims an on-chain
   result that has not happened.
4. **Secrets discipline.** Fresh testnet-only wallets were generated for
   this project (one owner, one agent); their mnemonics and private keys
   live only in local, git-ignored `.env` files and mode-`600` files
   outside the repo. The repo was checked for secrets before every commit
   (see below).

## What the AI generated

- `contracts/BillPayGuard.sol` — the spending-guard contract (original design).
- `scripts/agent.ts` — the off-chain agent runner (reads schedules, asks
  the contract what is due, executes payments, logs every skip).
- `scripts/leash.ts` — the abstract-account leash (creates the owner's
  abstract account, links the agent key with a chain-enforced spending
  rule, and pays schedule 1 once through a relayed meta-transaction;
  added 16 Nov 2026, verified on-chain the same day).
- `scripts/intent.ts` — ML-DSA-87 signed payment intents (added 19 Nov
  2026: intent creation + off-chain verification with anti-replay;
  signed intents recorded in `deployments/intents/`).
- `scripts/leash-rule.ts` — the leash rule evaluator (per-tx / daily
  limits, allowed calls) shared by the intent flow and the tests.
- `scripts/deploy.ts` — deployment + deployment record (adapted from the
  sibling project's deploy-script pattern, with a testnet-only chain-id
  guard).
- `scripts/setup-demo.ts`, `scripts/demo-rejection.ts`,
  `scripts/prepare-env.ts` — demo setup, the on-chain rejection
  demonstration, and local environment setup.
- `scripts/drill-pay.ts`, `scripts/topup.ts` — the Q-Day Drill payment
  and the contract top-up (0.3 QOR, 19 Nov 2026).
- `scripts/build-artifact.mjs` — artifact regeneration from `solc` output.
- `test/billpay-guard.test.ts` — contract tests (19 tests: artifact
  checks, deposits and withdrawals, schedule validation, agent
  authorisation, payment execution, interval / cap / count / expiry
  enforcement, `checkDue` reasons, revocation, insufficient balance).
- `test/attack-battery.test.ts` — adversarial tests (14 tests, added
  25 Nov 2026: a reentrant payee and a reentrant withdrawer that both
  fail to take a second wei, nonexistent-schedule and cross-owner
  attacks, invalid schedule changes, event correctness, shared-balance
  contention, the interval-0 boundary, and three seeded model-based
  fuzz runs of 150 random operations each).
- `contracts/test/ReentrantAttacker.sol` — the test-only malicious
  payee / withdrawer contracts the attack battery deploys (never
  deployed to a live chain).
- `scripts/verify-live.ts` — read-only live-state check (added
  25 Nov 2026: reads the deployed contract and prints balances,
  totals, schedules, and due states; no wallet).
- `docs/THREAT_MODEL.md`, `docs/JUDGES.md`, `docs/SECURITY.md`,
  `docs/slither-report.txt` — threat model, judge's verification
  guide, security notes with the Slither triage, and the raw Slither
  0.11.6 output (added 25 Nov 2026).
- `test/intent.test.ts` — signed-intent tests (15 tests: signature
  verification, wrong-signer / wrong-intent rejection, anti-replay).
- `test/leash-rule.test.ts` — leash-rule tests (13 tests: per-tx and
  daily limits, allowed-call enforcement, combined violations).
- `src/*` — the React dashboard (public schedule + payment history reads,
  wallet actions for deposit / schedule / agent), adapted from the
  `viem-wagmi` template via the sibling project.
- `README.md`, this file, `.gitignore`, `.env.example`,
  `.env.agent.example`, `LICENSE` (Apache-2.0).

## What the human contributed

- The event, the category (Post-Quantum AI Agents), and the decision to
  build a second fest project.
- The concept direction (bill payments, not trading) and the approval to
  build all four remaining solo categories.
- Accounts and funding: the GitHub account, the testnet deployer wallet
  (pre-funded with 5 QOR), and the project-page submission.
- Review of the demo video and the final submission.

## Verification checklist

- [x] `npm run compile` — contract compiles with solc 0.8.24.
- [x] `npm test` — all tests pass on a local EVM (61/61: 19 contract +
      15 intent + 13 leash-rule + 14 attack battery).
- [x] `npm run typecheck` — `tsc --noEmit` clean.
- [x] `npm run build` — frontend builds.
- [x] Slither 0.11.6 on the contract: 6 findings, 0 high, 0 medium
      (triage in `docs/SECURITY.md`, raw output in
      `docs/slither-report.txt`).
- [x] Contract deployed on qorechain-diana (address in
      `deployments/testnet.json`).
- [x] Agent executed real on-chain payments (hashes in
      `deployments/demo.json` — 8 payments, 0.50 QOR total, three
      through the abstract-account leash).
- [x] Abstract-account leash live: owner abstract account, agent key
      linked with spending rule `billpay-agent`, three leashed
      payments executed and verified on-chain (16 Nov 2026 and
      19 Nov 2026, the last two gated by verified ML-DSA-87 payment
      intents; see the README's "The leash" section for the hashes
      and REST evidence).
- [x] A limit rejection demonstrated on-chain (record in
      `deployments/demo.json` — 2 reverted transactions).
- [x] A leash rejection proven on-chain (19 Nov 2026): a `withdraw()`
      call outside the rule's allowlist was blocked by the abstract
      account (record in `deployments/leash-rejection.json` — Cosmos
      tx `FEF47E6B…`, block 10335955).
- [x] ML-DSA-87 signed payment intents live (19 Nov 2026): intent
      creation + off-chain verification with anti-replay proven
      (`scripts/intent.ts`; signed intents in `deployments/intents/`).
- [x] Live demo renders on GitHub Pages (Playwright check, no errors).
- [x] Demo video ≤ 3 minutes, real screen recording (`docs/demo.mp4` —
      2:51 (171.3 s), 1080p, verified with ffprobe + frame checks).
- [x] No secrets in the repo (`git grep` for mnemonic / private-key
      material before every push — final scan 16 Nov 2026: only the
      public Hardhat test mnemonic, placeholder `0x000…` keys in
      `.env.example` files, and public on-chain tx hashes).

## Limitations the AI is aware of

- The agent runner is a script, not a hosted service: it pays only while
  someone runs it. There is no always-on infrastructure in this repo.
- The contract cannot verify that a payee address belongs to the intended
  biller; the owner must check addresses before creating schedules.
- The post-quantum window is a chain-level admission rule, not contract
  logic: the contract trusts the chain to admit only windowed
  transactions. If the chain's rule changed, the contract would not
  notice.
- Testnet only. Nothing here has been audited, and nothing here should
  hold real funds.
