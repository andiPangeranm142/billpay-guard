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
   the Diana testnet, the agent runner executed real payments, and a limit
   rejection was demonstrated on-chain. Every transaction hash in this
   repo was read back from the chain. Nothing in this repo claims an
   on-chain result that has not happened.
4. **Secrets discipline.** Fresh testnet-only wallets were generated for
   this project (one owner, one agent); their mnemonics and private keys
   live only in local, git-ignored `.env` files and mode-`600` files
   outside the repo. The repo was checked for secrets before every commit
   (see below).

## What the AI generated

- `contracts/BillPayGuard.sol` — the spending-guard contract (original design).
- `scripts/agent.ts` — the off-chain agent runner (reads schedules, asks
  the contract what is due, executes payments, logs every skip).
- `scripts/deploy.ts` — deployment + deployment record (adapted from the
  sibling project's deploy-script pattern, with a testnet-only chain-id
  guard).
- `scripts/setup-demo.ts`, `scripts/demo-rejection.ts`,
  `scripts/prepare-env.ts` — demo setup, the on-chain rejection
  demonstration, and local environment setup.
- `scripts/build-artifact.mjs` — artifact regeneration from `solc` output.
- `test/billpay-guard.test.ts` — contract tests (artifact checks, deposits
  and withdrawals, schedule validation, agent authorisation, payment
  execution, interval / cap / count / expiry enforcement, `checkDue`
  reasons, revocation, insufficient balance).
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
- [x] `npm test` — all contract tests pass on a local EVM (14/14).
- [x] `npm run typecheck` — `tsc --noEmit` clean.
- [x] `npm run build` — frontend builds.
- [x] Contract deployed on qorechain-diana (address in
      `deployments/testnet.json`).
- [x] Agent executed real on-chain payments (hashes in
      `deployments/demo.json` — 4 payments, 0.30 QOR).
- [x] A limit rejection demonstrated on-chain (record in
      `deployments/demo.json` — 2 reverted transactions).
- [x] Live demo renders on GitHub Pages (Playwright check, no errors).
- [x] Demo video ≤ 3 minutes, real screen recording (`docs/demo.mp4` —
      2:37, 1080p, verified with ffprobe + frame checks).
- [x] No secrets in the repo (`git grep` for mnemonic / private-key
      material before every push — final scan 15 Nov 2026: only the
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
