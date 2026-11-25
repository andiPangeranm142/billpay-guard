# Flattened contract for the QCAI audit

`BillPayGuard.flattened.sol` is the deployed contract's source, flattened
with `npx hardhat flatten contracts/BillPayGuard.sol` — the real contract
only, plus its (zero) dependencies. The contract has no imports, so the
flattened file is the single source file with a Hardhat header.

**No test code is included.** `contracts/test/ReentrantAttacker.sol`
exists only for the attack-battery test suite and is deliberately excluded:
the audit must assess exactly what is deployed at
`0xac31fb4f4b85f29f6dc72e8485fa9188b37f3b6e` on Diana testnet (chain id 9800).

Regenerate after any contract change (and redeploy + re-verify first — the
flattened file must always match the deployed bytecode):

```bash
npx hardhat flatten contracts/BillPayGuard.sol > flattened/BillPayGuard.flattened.sol
```

## Running the QCAI audit (two runs, the AI Agents evidence push)

The audit is run from the QoreChain dashboard — **not** from this repo, and
not by an automated script. Steps:

1. Open https://dashboard.qorechain.io/audit and sign in with the project
   account.
2. Start a new audit for the BillPay Guard project and upload
   `flattened/BillPayGuard.flattened.sol` as the contract source.
3. Set **Blockchain = QoreChain** so the quantum-readiness assessment runs
   against QoreChain's post-quantum surface.
4. Run the audit (150 QOR testnet per run, paid from the connected wallet)
   and wait for it to complete.
5. **Export the audit PDF** and keep it with the project records
   (`docs/QCAI-audit-stage1.pdf`).
6. Run a **second audit as a new audit with the identical source** — the
   dashboard offers no stage-2 option on an existing result and keeps no
   audit history. Export its PDF as `docs/QCAI-audit-stage2.pdf`.
7. **Triage every finding:**
   - Confirm whether each finding applies to the deployed contract or is a
     false positive.
   - Fix real findings in `contracts/BillPayGuard.sol`, re-run the full
     test suite (`npm test`, 61 tests), redeploy, re-flatten, and re-run
     the audit on the new source. (A redeploy orphans the live payment
     history + drill proof — only justified for a real, exploitable
     finding.)
   - Record the triage outcome (fixed / false positive with reason /
     accepted risk with reason) alongside the PDF.

## Known context for the auditor

- The owner deposits funds, registers bill schedules (one allowlisted payee
  per schedule, per-payment and total caps, max payment count, minimum
  interval, expiry) and authorises one agent address. The guard contract
  enforces every limit on-chain; the agent cannot pay a different address,
  exceed a cap, pay early, or pay after expiry.
- A second leash is enforced by the chain's abstract-account module: a
  spending rule (at most 0.05 QOR per execution, 0.50 QOR per day, only
  executePayment on the guard contract). The leash has been proven to bite
  (a forbidden withdraw call was refused on-chain, 19 Nov 2026).
- Before a leashed payment is relayed, the owner signs a payment intent
  with their ML-DSA-87 key, verified by the runner against the owner's
  on-chain registered PQC key. **Intent verification is off-chain by
  design — the contract has no in-contract pqcVerify.** This is an honest,
  documented limitation, not a hidden gap.
- `executePayment` follows checks-effects-interactions and is guarded by
  nonReentrant; a reentrant payee or withdrawer cannot take a second wei
  (proven by the attack-battery tests).
- The contract admin is the owner ECDSA address. Post-quantum protection
  for admin actions comes from the chain-level PQ window, not contract
  logic. Testnet only, nothing audited, nothing here should hold real
  funds.
