/**
 * leash-rule.ts - the abstract-account spending rule for the BillPay Guard
 * agent, as pure, dependency-free logic.
 *
 * The rule itself lives on-chain (the owner's abstract account, rule id
 * `billpay-agent`, fetched by scripts/leash.ts). This module holds the
 * constants the runner and the tests agree on, plus the exact checks the
 * chain applies to a leashed execution:
 *
 *   1. the rule must be enabled;
 *   2. the EVM call must be listed in `allowedEvmCalls` (contract address
 *      + function selector, lowercased, joined by "/");
 *   3. the execution's value must not exceed the per-transaction limit;
 *   4. the execution's value plus what the key already spent today must
 *      not exceed the daily limit.
 *
 * Limits are inclusive: spending exactly the per-tx or daily limit is
 * allowed. The rule mirrors schedule 1's caps (0.05 QOR per payment,
 * 0.50 QOR total cap as the daily bound), but it bounds the CALL, not the
 * schedule: it allows `executePayment` on ANY schedule id — the
 * per-schedule caps are still the contract's job.
 *
 * This module has no side effects and no imports, so the test suite can
 * exercise the rule logic fully offline (test/leash-rule.test.ts). The
 * on-chain proof that the chain really enforces it is
 * deployments/leash-rejection.json (a forbidden `withdraw` call refused
 * with `abstractaccount_execution_failed`).
 */

/** The spending rule id, as stored on-chain. */
export const LEASH_RULE_ID = "billpay-agent";

/** At most 50,000 uqor (0.05 QOR) per leashed execution. */
export const LEASH_RULE_PER_TX_UQOR = "50000";

/** At most 500,000 uqor (0.50 QOR) per day. */
export const LEASH_RULE_DAILY_UQOR = "500000";

/** The agent authenticator's expiry (15 Dec 2026 19:27:51 UTC), matching schedule 1's on-chain expiry. */
export const LEASH_AUTH_EXPIRY_UNIX = 1797362871;

/** The agent authenticator's label, as stored on-chain. */
export const LEASH_AUTH_LABEL = "BillPay Guard agent";

/**
 * The on-chain shape of a spending rule, as returned by the SDK's
 * fetchSpendingRules (amounts are bigints).
 */
export interface SpendingRuleView {
  id: string;
  enabled: boolean;
  perTxLimit: bigint;
  dailyLimit: bigint;
  allowedDenoms: string[];
  allowedEvmCalls: string[];
}

/** A leashed EVM execution the rule is checked against. */
export interface LeashedCall {
  /** The contract the call targets. */
  contract: string;
  /** The 4-byte function selector, e.g. "0x162a0cf8". */
  selector: string;
  /** The value the execution moves, in uqor. */
  amountUqor: bigint;
  /** What the key already spent today, in uqor. */
  spentTodayUqor: bigint;
}

/** The rule the runner expects: the exact rule stored on-chain. */
export function expectedLeashRule(contract: string, executePaymentSelector: string): SpendingRuleView {
  return {
    id: LEASH_RULE_ID,
    enabled: true,
    perTxLimit: BigInt(LEASH_RULE_PER_TX_UQOR),
    dailyLimit: BigInt(LEASH_RULE_DAILY_UQOR),
    allowedDenoms: ["uqor"],
    allowedEvmCalls: [allowedEvmCall(contract, executePaymentSelector)],
  };
}

/**
 * One allowlist entry: the contract address and the function selector,
 * lowercased, joined by "/". The chain stores entries in this form.
 */
export function allowedEvmCall(contract: string, selector: string): string {
  return `${contract.toLowerCase()}/${selector.toLowerCase()}`;
}

/** Whether the rule's allowlist contains this contract + selector. A disabled rule allows nothing. */
export function isEvmCallAllowed(rule: SpendingRuleView, contract: string, selector: string): boolean {
  if (!rule.enabled) return false;
  const wanted = allowedEvmCall(contract, selector);
  return rule.allowedEvmCalls.some((entry) => entry.toLowerCase() === wanted);
}

/**
 * Check an execution's value against the rule's per-tx and daily limits.
 * Returns a list of violations (empty = within limits). Limits are
 * inclusive: spending exactly the limit is allowed.
 */
export function checkSpendingLimits(
  rule: SpendingRuleView,
  amountUqor: bigint,
  spentTodayUqor: bigint,
): string[] {
  const problems: string[] = [];
  if (!rule.enabled) problems.push(`spending rule ${rule.id} is disabled`);
  if (amountUqor > rule.perTxLimit) {
    problems.push(
      `amount ${amountUqor} uqor exceeds the per-transaction limit of ${rule.perTxLimit} uqor`,
    );
  }
  if (spentTodayUqor + amountUqor > rule.dailyLimit) {
    problems.push(
      `spent today ${spentTodayUqor} uqor plus ${amountUqor} uqor exceeds the daily limit of ${rule.dailyLimit} uqor`,
    );
  }
  return problems;
}

/**
 * The full rule check for one leashed execution: the allowlist AND the
 * spending limits. Returns a list of violations (empty = the chain
 * would admit the execution, as far as the rule is concerned).
 */
export function checkExecutionAgainstRule(rule: SpendingRuleView, call: LeashedCall): string[] {
  const problems: string[] = [];
  if (!isEvmCallAllowed(rule, call.contract, call.selector)) {
    problems.push(
      `call ${allowedEvmCall(call.contract, call.selector)} is not in spending rule ${rule.id}'s allowlist`,
    );
  }
  problems.push(...checkSpendingLimits(rule, call.amountUqor, call.spentTodayUqor));
  return problems;
}
