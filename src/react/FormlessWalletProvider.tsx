import {
  createContext,
  ReactNode,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { NETWORK_ID_BASE } from "../lib/Chains";
import {
  FormlessRPCClient,
  FormlessRPCRequest,
} from "../lib/FormlessRPCClient";
import {
  WalletImplementation,
  WalletImplementationConfig,
} from "../lib/IWalletSession";
import { ILogger, IWallet, WalletEvent } from "../lib/Types";
import { WalletCore } from "../lib/WalletCore";
import {
  MockWalletConfig,
  useMockWalletState,
} from "../sessions/mock/useMockWalletState";
import { PrivyWalletImplementation } from "../sessions/privy/PrivyWalletImplementation";
import { useWalletState, WalletStateOptions } from "./useWalletState";

const WalletContext = createContext<IWallet | undefined>(undefined);

export interface FormlessWalletProviderProps {
  /** Transport used for Formless RPCs. */
  rpcRequest: FormlessRPCRequest;
  config: WalletImplementationConfig;
  /** Defaults to the Formless default wallet implementation. */
  implementation?: WalletImplementation;
  /** RPC endpoints by network ID, used instead of Formless's. */
  rpcEndpointOverrides?: Record<number, string>;
  provisionFormlessSmartWalletsForNewUsers?: boolean;
  /** Title of the funding prompt shown by addFunds. */
  fundingTitle?: string;
  /** When set, a mock wallet is used (for end to end tests). */
  mock?: MockWalletConfig;
  onEvent?: (event: WalletEvent) => void;
  log?: ILogger;
  /** Rendered while the wallet implementation is configured. */
  fallback?: ReactNode;
  children: ReactNode;
}

function WalletStateProvider({
  children,
  ...options
}: WalletStateOptions & { children: ReactNode }) {
  const wallet = useWalletState(options);
  return (
    <WalletContext.Provider value={wallet}>
      {children}
    </WalletContext.Provider>
  );
}

function MockWalletStateProvider({
  children,
  ...options
}: Parameters<typeof useMockWalletState>[0] & {
  children: ReactNode;
}) {
  const wallet = useMockWalletState(options);
  return (
    <WalletContext.Provider value={wallet}>
      {children}
    </WalletContext.Provider>
  );
}

/**
 * Provides the wallet of the signed in user to useWallet. Must wrap
 * every component which uses useWallet.
 */
export function FormlessWalletProvider({
  rpcRequest,
  config,
  implementation = PrivyWalletImplementation,
  rpcEndpointOverrides,
  provisionFormlessSmartWalletsForNewUsers,
  fundingTitle = "Transfer USDC (crypto) to your wallet",
  mock,
  onEvent,
  log,
  fallback = null,
  children,
}: FormlessWalletProviderProps) {
  const core = useMemo(
    () =>
      new WalletCore(new FormlessRPCClient(rpcRequest), {
        provisionFormlessSmartWalletsForNewUsers,
        rpcEndpointOverrides,
        log,
      }),
    []
  );
  // undefined once resolved means the chain's default is used.
  const [baseRPCEndpoint, setBaseRPCEndpoint] = useState<
    string | undefined | null
  >(null);

  useEffect(() => {
    if (mock) {
      return;
    }
    core
      .getRPCEndpoint(NETWORK_ID_BASE)
      .then(setBaseRPCEndpoint)
      .catch((error) => {
        log?.error("Error fetching base RPC endpoint:", error);
        setBaseRPCEndpoint(undefined);
      });
  }, [core]);

  if (mock) {
    return (
      <MockWalletStateProvider core={core} mock={mock} log={log}>
        {children}
      </MockWalletStateProvider>
    );
  }
  if (baseRPCEndpoint === null) {
    return <>{fallback}</>;
  }
  const { Provider } = implementation;
  return (
    <Provider
      config={config}
      rpcEndpoints={
        baseRPCEndpoint ? { [NETWORK_ID_BASE]: baseRPCEndpoint } : {}
      }
    >
      <WalletStateProvider
        core={core}
        implementation={implementation}
        fundingTitle={fundingTitle}
        onEvent={onEvent}
        log={log}
      >
        {children}
      </WalletStateProvider>
    </Provider>
  );
}

/**
 * Returns the wallet of the signed in user.
 */
export function useWallet(): IWallet {
  const wallet = useContext(WalletContext);
  if (!wallet) {
    throw new Error(
      "useWallet must be used within FormlessWalletProvider"
    );
  }
  return wallet;
}
