/**
 * leash-rule.test.ts - unit tests for the abstract-account spending rule
 * logic (scripts/leash-rule.ts). Fully offline: the rule checks are pure
 * functions over the rule's on-chain shape, and no test touches the
 * network or a real wallet.
 *
 * What is covered: the allowlist (executePayment on the guard contract
 * only, case-insensitive), the per-transaction and daily limits
 * (inclusive bounds), the disabled-rule case, and the exact forbidden
 * call the chain refused on 19 Nov 2026 (`withdraw` on the guard
 * contract — see deployments/leash-rejection.json). The on-chain
 * enforcement itself is proven by that rejection record, not here.
 *
 * Run: npm test
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  LEASH_AUTH_EXPIRY_UNIX,
  LEASH_RULE_DAILY_UQOR,
  LEASH_RULE_ID,
  LEASH_RULE_PER_TX_UQOR,
  allowedEvmCall,
  checkExecutionAgainstRule,
  checkSpendingLimits,
  expectedLeashRule,
  isEvmCallAllowed,
  type SpendingRuleView,
} from "../scripts/leash-rule.js";

const CONTRACT = "0xac31fb4f4b85f29f6dc72e8485fa9188b37f3b6e";
/** executePayment(uint256) selector, as stored in the on-chain rule. */
const EXECUTE_PAYMENT = "0x162a0cf8";
/** withdraw(uint256) selector — the call the chain refused on 19 Nov 2026. */
const WITHDRAW = "0x2e1a7d4d";
const OTHER_CONTRACT = "0x0000000000000000000000000000000000000001";

function rule(): SpendingRuleView {
  return expectedLeashRule(CONTRACT, EXECUTE_PAYMENT);
}

describe("leash rule constants", () => {
  it("matches the rule stored on-chain for the BillPay Guard agent", () => {
    assert.equal(LEASH_RULE_ID, "billpay-agent");
    assert.equal(LEASH_RULE_PER_TX_UQOR, "50000");
    assert.equal(LEASH_RULE_DAILY_UQOR, "500000");
    // 15 Dec 2026 19:27:51 UTC — the same expiry as schedule 1.
    assert.equal(LEASH_AUTH_EXPIRY_UNIX, 1797362871);
    const r = rule();
    assert.equal(r.enabled, true);
    assert.equal(r.perTxLimit, 50000n);
    assert.equal(r.dailyLimit, 500000n);
    assert.deepEqual(r.allowedDenoms, ["uqor"]);
    assert.deepEqual(r.allowedEvmCalls, [`${CONTRACT}/${EXECUTE_PAYMENT}`]);
  });

  it("formats allowlist entries as lowercase contract/selector", () => {
    assert.equal(
      allowedEvmCall("0xAC31FB4F4B85F29F6DC72E8485FA9188B37F3B6E", "0x162A0CF8"),
      `${CONTRACT}/${EXECUTE_PAYMENT}`,
    );
  });
});

describe("leash rule allowlist", () => {
  it("allows executePayment on the guard contract", () => {
    assert.equal(isEvmCallAllowed(rule(), CONTRACT, EXECUTE_PAYMENT), true);
  });

  it("allows the call regardless of address/selector casing", () => {
    assert.equal(
      isEvmCallAllowed(rule(), "0xAC31FB4F4B85F29F6DC72E8485FA9188B37F3B6E", "0x162A0CF8"),
      true,
    );
  });

  it("refuses withdraw on the guard contract — the call the chain refused on-chain", () => {
    assert.equal(isEvmCallAllowed(rule(), CONTRACT, WITHDRAW), false);
    const problems = checkExecutionAgainstRule(rule(), {
      contract: CONTRACT,
      selector: WITHDRAW,
      amountUqor: 1000n,
      spentTodayUqor: 0n,
    });
    assert.equal(problems.length, 1);
    assert.match(problems[0], /not in spending rule billpay-agent's allowlist/);
  });

  it("refuses executePayment on any other contract", () => {
    assert.equal(isEvmCallAllowed(rule(), OTHER_CONTRACT, EXECUTE_PAYMENT), false);
  });

  it("refuses every call when the rule is disabled", () => {
    const disabled = { ...rule(), enabled: false };
    assert.equal(isEvmCallAllowed(disabled, CONTRACT, EXECUTE_PAYMENT), false);
    const problems = checkExecutionAgainstRule(disabled, {
      contract: CONTRACT,
      selector: EXECUTE_PAYMENT,
      amountUqor: 1n,
      spentTodayUqor: 0n,
    });
    assert.ok(problems.some((p) => /disabled/.test(p)));
  });
});

describe("leash rule spending limits", () => {
  it("allows a payment at exactly the per-transaction limit", () => {
    assert.deepEqual(checkSpendingLimits(rule(), 50000n, 0n), []);
  });

  it("refuses a payment one uqor above the per-transaction limit", () => {
    const problems = checkSpendingLimits(rule(), 50001n, 0n);
    assert.equal(problems.length, 1);
    assert.match(problems[0], /per-transaction limit/);
  });

  it("allows the day's last payment exactly at the daily limit", () => {
    // Nine 50,000 uqor payments spent, one more fills the 500,000 daily cap.
    assert.deepEqual(checkSpendingLimits(rule(), 50000n, 450000n), []);
  });

  it("refuses a payment that would push the day over the daily limit", () => {
    const problems = checkSpendingLimits(rule(), 50000n, 450001n);
    assert.equal(problems.length, 1);
    assert.match(problems[0], /daily limit/);
  });

  it("reports both limit violations at once", () => {
    const problems = checkSpendingLimits(rule(), 600000n, 0n);
    assert.equal(problems.length, 2);
    assert.match(problems[0], /per-transaction limit/);
    assert.match(problems[1], /daily limit/);
  });

  it("admits a normal leashed payment: executePayment, 0.05 QOR, nothing spent today", () => {
    assert.deepEqual(
      checkExecutionAgainstRule(rule(), {
        contract: CONTRACT,
        selector: EXECUTE_PAYMENT,
        amountUqor: 50000n,
        spentTodayUqor: 0n,
      }),
      [],
    );
  });
});
