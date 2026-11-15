import { isAddress } from "viem";

/** EVM chain id of the QoreChain testnet (`qorechain-diana`). */
export const TESTNET_CHAIN_ID = 9800;

/** QoreChain block explorer (covers the testnet). */
export const EXPLORER_URL = "https://explore.qore.network";

/**
 * The deployed BillPayGuard contract address, read from the build-time
 * environment. Empty string means the contract has not been deployed yet —
 * the UI must not show schedule controls in that case.
 *
 * A malformed value is treated the same as unset: never trust a bad address.
 */
const raw = (import.meta.env.VITE_BILLPAY_GUARD_ADDRESS ?? "").trim();

export const BILLPAY_GUARD_ADDRESS: `0x${string}` | "" = isAddress(raw)
  ? (raw as `0x${string}`)
  : "";

export const CONTRACT_DEPLOYED = BILLPAY_GUARD_ADDRESS !== "";

/**
 * The block the contract was deployed in (build-time env). The payment
 * history reads events from this block; when unset it falls back to a
 * recent window instead.
 */
const blockRaw = (import.meta.env.VITE_DEPLOY_BLOCK ?? "").trim();
const blockNum = blockRaw === "" ? NaN : Number(blockRaw);
export const DEPLOY_BLOCK: bigint | null =
  Number.isSafeInteger(blockNum) && blockNum > 0 ? BigInt(blockNum) : null;
