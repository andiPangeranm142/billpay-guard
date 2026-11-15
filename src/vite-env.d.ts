/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_WALLETCONNECT_PROJECT_ID?: string;
  /** Deployed BillPayGuard contract address on the QoreChain testnet. Empty when not yet deployed. */
  readonly VITE_BILLPAY_GUARD_ADDRESS?: string;
  /** Block the contract was deployed in. Used as the event-history start. */
  readonly VITE_DEPLOY_BLOCK?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
