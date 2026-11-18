/**
 * intent.test.ts - unit tests for the authenticated-messaging layer
 * (scripts/intent.ts). Fully offline: the ML-DSA-87 keypairs here are
 * freshly generated throwaway keys, never funded anywhere, and no test
 * touches the network or a real wallet.
 *
 * What is covered: signing and verifying a payment intent, tamper
 * detection (intent fields, signature, public key), the anti-replay
 * paymentNumber rule, the schedule-match checks, and the signed-intent
 * JSON file round-trip. The on-chain binding (the owner's registered
 * PQC key, fetched from REST) is exercised by `scripts/intent.ts
 * verify` against the testnet, not here.
 *
 * Run: npm test
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { generatePqcKeypair } from "@qorechain/sdk";
import type { Address } from "viem";

import {
  canonicalIntentBytes,
  checkIntentAgainstSchedule,
  intentFileName,
  loadSignedIntent,
  signIntent,
  verifyIntentSignature,
  type PaymentIntent,
  type ScheduleView,
  type SignedIntent,
} from "../scripts/intent.js";

const CONTRACT = "0xac31fb4f4b85f29f6dc72e8485fa9188b37f3b6e" as Address;
const PAYEE = "0x5dA52428DE0b9928105175CF00C6435B21AB4779" as Address;
const SIGNER = {
  evm: "0x326697b1a1EAd2E0FCa024754Fd5530D7e5cBDee",
  cosmos: "qor1xfnf0vdpatfwpl9qy365l42np4l9e00wkzdg9y",
};

/** An intent for schedule 1's 5th payment, as on the Diana testnet. */
function testIntent(): PaymentIntent {
  return {
    version: 1,
    kind: "billpay-payment",
    chainId: "qorechain-diana",
    contract: CONTRACT.toLowerCase(),
    scheduleId: 1,
    paymentNumber: 5,
    payee: PAYEE.toLowerCase(),
    amountWei: "50000000000000000",
    expiryUnix: 1797362871,
  };
}

/** Schedule 1's live state before its 5th payment. */
function testSchedule(): ScheduleView {
  return {
    payee: PAYEE,
    amountPerPayment: 50000000000000000n,
    payments: 4n,
    expiry: 1797362871n,
  };
}

describe("payment intents", () => {
  it("signs and verifies an intent under the signer's ML-DSA-87 key", () => {
    const keypair = generatePqcKeypair();
    const signed = signIntent(keypair, testIntent(), SIGNER);
    assert.equal(signed.signer.evm, SIGNER.evm);
    assert.equal(signed.signer.cosmos, SIGNER.cosmos);
    // 2592-byte public key and 4627-byte signature, base64-encoded.
    assert.equal(Buffer.from(signed.publicKeyBase64, "base64").length, 2592);
    assert.equal(Buffer.from(signed.signatureBase64, "base64").length, 4627);
    assert.equal(verifyIntentSignature(signed), true);
    assert.equal(verifyIntentSignature(signed, keypair.publicKey), true);
  });

  it("signing is deterministic: the same intent yields the same signature", () => {
    const keypair = generatePqcKeypair();
    const a = signIntent(keypair, testIntent(), SIGNER);
    const b = signIntent(keypair, testIntent(), SIGNER);
    assert.equal(a.signatureBase64, b.signatureBase64);
    assert.deepEqual(canonicalIntentBytes(testIntent()), canonicalIntentBytes(testIntent()));
  });

  it("rejects a tampered intent", () => {
    const keypair = generatePqcKeypair();
    const signed = signIntent(keypair, testIntent(), SIGNER);
    const tampered: SignedIntent = {
      ...signed,
      intent: { ...signed.intent, amountWei: "100000000000000000" },
    };
    assert.equal(verifyIntentSignature(tampered), false);
    const retargeted: SignedIntent = {
      ...signed,
      intent: { ...signed.intent, payee: "0x0000000000000000000000000000000000000001" },
    };
    assert.equal(verifyIntentSignature(retargeted), false);
    const replayed: SignedIntent = {
      ...signed,
      intent: { ...signed.intent, paymentNumber: 6 },
    };
    assert.equal(verifyIntentSignature(replayed), false);
  });

  it("rejects a tampered signature and a wrong public key", () => {
    const keypair = generatePqcKeypair();
    const other = generatePqcKeypair();
    const signed = signIntent(keypair, testIntent(), SIGNER);
    const sigBytes = Buffer.from(signed.signatureBase64, "base64");
    sigBytes[0] ^= 0xff;
    const badSig: SignedIntent = { ...signed, signatureBase64: sigBytes.toString("base64") };
    assert.equal(verifyIntentSignature(badSig), false);
    assert.equal(verifyIntentSignature(signed, other.publicKey), false);
    const badKey: SignedIntent = { ...signed, publicKeyBase64: Buffer.from(other.publicKey).toString("base64") };
    assert.equal(verifyIntentSignature(badKey), false);
  });

  it("rejects malformed base64 and short signatures instead of throwing", () => {
    const keypair = generatePqcKeypair();
    const signed = signIntent(keypair, testIntent(), SIGNER);
    assert.equal(verifyIntentSignature({ ...signed, signatureBase64: "!!!not-base64!!!" }), false);
    assert.equal(
      verifyIntentSignature({ ...signed, signatureBase64: Buffer.alloc(100).toString("base64") }),
      false,
    );
    assert.equal(
      verifyIntentSignature({ ...signed, publicKeyBase64: Buffer.alloc(100).toString("base64") }),
      false,
    );
  });

  it("matches an intent against the live schedule, and flags every mismatch", () => {
    assert.deepEqual(checkIntentAgainstSchedule(testIntent(), CONTRACT, testSchedule()), []);

    const wrongPayee = checkIntentAgainstSchedule(
      { ...testIntent(), payee: "0x0000000000000000000000000000000000000001" },
      CONTRACT,
      testSchedule(),
    );
    assert.equal(wrongPayee.length, 1);
    assert.match(wrongPayee[0], /payee/);

    const wrongAmount = checkIntentAgainstSchedule(
      { ...testIntent(), amountWei: "1" },
      CONTRACT,
      testSchedule(),
    );
    assert.equal(wrongAmount.length, 1);
    assert.match(wrongAmount[0], /amount/);

    // The anti-replay rule: an intent for payment #5 does not authorise
    // payment #6, and a stale intent (already-paid #5) matches nothing.
    const replay = checkIntentAgainstSchedule(
      testIntent(),
      CONTRACT,
      { ...testSchedule(), payments: 5n },
    );
    assert.equal(replay.length, 1);
    assert.match(replay[0], /paymentNumber/);

    const wrongContract = checkIntentAgainstSchedule(
      testIntent(),
      "0x0000000000000000000000000000000000000001" as Address,
      testSchedule(),
    );
    assert.equal(wrongContract.length, 1);
    assert.match(wrongContract[0], /contract/);

    const wrongExpiry = checkIntentAgainstSchedule(
      { ...testIntent(), expiryUnix: 1 },
      CONTRACT,
      testSchedule(),
    );
    assert.equal(wrongExpiry.length, 1);
    assert.match(wrongExpiry[0], /expiry/);
  });

  it("round-trips a signed intent through a JSON file", () => {
    const keypair = generatePqcKeypair();
    const signed = signIntent(keypair, testIntent(), SIGNER);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "billpay-intent-"));
    try {
      const file = path.join(dir, intentFileName(1, 5));
      fs.writeFileSync(file, `${JSON.stringify(signed, null, 2)}\n`);
      const loaded = loadSignedIntent(file);
      assert.deepEqual(loaded, signed);
      assert.equal(verifyIntentSignature(loaded, keypair.publicKey), true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("names intent files deterministically", () => {
    assert.equal(intentFileName(1, 5), "intent-1-5.json");
    assert.equal(intentFileName(0, 1), "intent-0-1.json");
  });
});
