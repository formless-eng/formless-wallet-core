import { ReactElement, ReactNode } from "react";
import { Chain, FundingAsset, Hex } from "./Types";

/**
 * A user of the wallet implementation, in wallet implementation
 * agnostic terms.
 */
export interface WalletUser {
  /** The ID of the user in the wallet implementation. */
  id: string;
  email?: string;
  /** The Formless unique ID recorded on the user, if provisioned. */
  formlessUniqueID?: string;
  /** The key pair held for the user, used to sign for smart wallets. */
  embeddedSigner?: { address: string; delegated: boolean };
  /** The smart wallet managed by the wallet implementation, if any. */
  smartWalletAddress?: string;
  /** Changes whenever accounts are linked to or unlinked from the user. */
  linkedAccountsCount: number;
}

/**
 * A smart wallet managed by the wallet implementation.
 */
export interface ManagedSmartWallet {
  address: string;
  signMessage: (message: string) => Promise<string>;
  sendTransaction: (transaction: {}) => Promise<string>;
}

export interface WalletSessionCallbacks {
  onLoginComplete: (
    user: WalletUser,
    wasAlreadyAuthenticated: boolean
  ) => Promise<void>;
  onLoginError: (error: unknown) => void;
  onFundingExited: () => void;
}

/**
 * The contract between the Formless wallet core and a wallet
 * implementation (e.g. a wallet as a service vendor). Everything
 * implementation specific lives behind this interface.
 */
export interface WalletSession {
  ready: boolean;
  authenticated: boolean;
  user?: WalletUser;
  managedSmartWallet?: ManagedSmartWallet;
  /** The address of the embedded signer connected in this session. */
  connectedSignerAddress?: string;
  login: () => Promise<void>;
  logout: () => Promise<void>;
  /** Returns a fresh identity token JWT verifiable by Formless. */
  getIdentityToken: () => Promise<string | undefined>;
  /** Allows Formless to sign with the embedded signer server side. */
  delegateSigner: (address: string) => Promise<void>;
  /** Signs a raw hash (no EIP-191 prefix) with the connected signer. */
  signHashWithSigner: (hash: Hex) => Promise<Hex>;
  fundWallet: (
    address: string,
    options: {
      chain: Chain;
      amount: string;
      asset: FundingAsset;
      title: string;
    }
  ) => Promise<void>;
  /** Whether an error is the user dismissing a prompt. */
  isUserCancellation: (error: unknown) => boolean;
}

export interface WalletSessionProviderProps {
  config: WalletImplementationConfig;
  /** RPC endpoint overrides by network ID. */
  rpcEndpoints: Record<number, string>;
  children: ReactNode;
}

/**
 * A wallet implementation: a provider component which must wrap the
 * application, and a hook which returns the session.
 */
export interface WalletImplementation {
  Provider: (props: WalletSessionProviderProps) => ReactElement;
  useSession: (callbacks: WalletSessionCallbacks) => WalletSession;
}

export interface WalletImplementationConfig {
  appID: string;
  appearance?: {
    theme?: "light" | "dark";
    accentColor?: `#${string}`;
    logo?: string;
    loginMessage?: ReactNode;
  };
}
