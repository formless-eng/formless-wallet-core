import { Chain, Hex } from "viem";

export type Dictionary = Record<string, unknown>;

export type FundingAsset = "USDC" | "native-currency";

export interface ILogger {
  debug: (...args: unknown[]) => void;
  info: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
}

export interface LinkPrimaryFinancialAccount {
  address: string;
  type: string;
  waas_implementation: string;
}

export interface UniqueIDProvisionResponse {
  unique_id: string;
  status?: string;
  financial_account?: Dictionary;
  financial_accounts?: Dictionary[];
  new_user?: boolean;
}

/**
 * The primary financial account of a unique ID, as recorded by
 * Formless. Either a smart wallet managed by the wallet
 * implementation, or a Formless provisioned ERC4337 smart wallet.
 */
export interface PrimaryWallet {
  address: string;
  walletType?: string;
  waasImplementation?: string;
  smartContractImplementation?: string;
  signers: string[];
}

export interface WalletTransactionCall {
  to: string;
  value?: bigint;
  data?: string;
}

/**
 * Either a single call, or a batch of `calls` executed atomically.
 */
export interface WalletTransaction
  extends Partial<WalletTransactionCall> {
  calls?: WalletTransactionCall[];
  chain?: { id: number };
}

export interface IJWTCredential {
  credentialType: string;
  jwt: string;
  toDictionary: () => Dictionary;
}

/**
 * Wallet lifecycle events, emitted so that each product can forward
 * them to its own analytics.
 */
export type WalletEvent =
  | { type: "unique_id_created"; email?: string; uniqueID: string }
  | { type: "sign_in_succeeded"; email?: string; uniqueID?: string }
  | { type: "sign_in_failed"; error: unknown };

export type LoginCallback = (
  provisioningResult?: UniqueIDProvisionResponse
) => void | Promise<void>;

export interface IWallet {
  /** Whether the wallet implementation has finished initializing. */
  ready: boolean;
  authenticated: boolean;
  // These are undefined until resolved, but are typed as strings
  // for compatibility with existing consumers.
  email: string;
  signature: string;
  uniqueID: string;
  walletAddress: string;
  // Set when the primary wallet is a Formless provisioned smart
  // wallet, which must be explicitly linked in unique_id_provision.
  linkPrimaryFinancialAccount?: LinkPrimaryFinancialAccount;
  addFunds: (
    amount: string,
    chain: Chain,
    asset: FundingAsset
  ) => Promise<void>;
  getCredential: () => Promise<IJWTCredential>;
  login: () => Promise<void>;
  logout: () => Promise<void>;
  readContract: (
    parameters: {},
    networkId: number
  ) => Promise<unknown>;
  sendTransaction: (transaction: {}) => Promise<string | undefined>;
  setLoginCallback: (callback: LoginCallback) => void;
  setAddFundsCallback: (callback: () => void) => void;
  signMessage: (message: string) => Promise<string>;
}

export type { Chain, Hex };
