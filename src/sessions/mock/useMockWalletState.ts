import { useEffect, useRef, useState } from "react";
import { ReadContractParameters, toHex } from "viem";
import { JWTCredential } from "../../lib/Credential";
import { ILogger, IWallet, LoginCallback } from "../../lib/Types";
import { WalletCore } from "../../lib/WalletCore";

export const MOCK_WALLET_ADDRESS =
  "0x71C7656EC7ab88b098defB751B7401B5f6d8976F";
export const MOCK_WALLET_EMAIL = "mock.user@example.com";
export const MOCK_WALLET_UNIQUE_ID = "mock-unique-id-12345";

/**
 * Configures a mock wallet for end to end tests. The mock wallet is
 * signed in, never prompts and never sends transactions.
 */
export interface MockWalletConfig {
  uniqueID?: string;
  jwt?: string;
  /** Results returned by readContract, by contract function name. */
  readContractResults?: Record<string, unknown>;
}

export function useMockWalletState({
  core,
  mock,
  log,
}: {
  core: WalletCore;
  mock: MockWalletConfig;
  log?: ILogger;
}): IWallet {
  const mockUniqueID = mock.uniqueID || MOCK_WALLET_UNIQUE_ID;
  const [authenticated, setAuthenticated] = useState<boolean>(true);
  const [email, setEmail] = useState<string | undefined>(undefined);
  const [signature, setSignature] = useState<string | undefined>(
    undefined
  );
  const [uniqueID, setUniqueID] = useState<string | undefined>(
    mockUniqueID
  );
  const loginCallback = useRef<LoginCallback | undefined>(undefined);

  const runLoginCallback = async () => {
    const callback = loginCallback.current;
    if (callback) {
      loginCallback.current = undefined;
      await callback();
    }
  };

  useEffect(() => {
    if (authenticated) {
      setEmail(MOCK_WALLET_EMAIL);
      setUniqueID(mockUniqueID);
      runLoginCallback();
    } else {
      setEmail(undefined);
      setUniqueID(undefined);
      setSignature(undefined);
    }
  }, [authenticated]);

  const assertAuthenticated = () => {
    if (!authenticated) {
      throw new Error("Mock wallet not authenticated");
    }
  };

  return {
    ready: true,
    authenticated,
    email: email as string,
    signature: signature as string,
    uniqueID: uniqueID as string,
    walletAddress: (authenticated
      ? MOCK_WALLET_ADDRESS
      : undefined) as string,
    getCredential: async () => new JWTCredential(mock.jwt as string),
    signMessage: async (message: string) => {
      assertAuthenticated();
      const mockSignature = toHex(message);
      setSignature(mockSignature);
      log?.info("Mock signed message:", {
        message,
        signature: mockSignature,
      });
      return mockSignature;
    },
    sendTransaction: async (transaction: {}) => {
      assertAuthenticated();
      const mockTxHash = `0x${Math.random().toString(16).substring(2)}`;
      log?.info("Mock transaction sent:", {
        transaction,
        txHash: mockTxHash,
      });
      return mockTxHash;
    },
    addFunds: async (amount, chain, asset) => {
      assertAuthenticated();
      log?.info("Mock funds added:", {
        amount,
        chain: chain.name,
        asset,
      });
    },
    login: async () => {
      setAuthenticated(true);
      await runLoginCallback();
    },
    logout: async () => {
      await new Promise((resolve) => setTimeout(resolve, 300));
      setAuthenticated(false);
      log?.info("Mock logout successful");
    },
    readContract: async (parameters: {}, networkId: number) => {
      const publicClient = await core.getPublicClient(networkId);
      const functionName = (parameters as { functionName?: string })
        .functionName;
      if (
        functionName &&
        mock.readContractResults &&
        functionName in mock.readContractResults
      ) {
        return mock.readContractResults[functionName];
      }
      return publicClient.readContract(
        parameters as ReadContractParameters
      );
    },
    setLoginCallback: (callback) => {
      loginCallback.current = callback;
    },
    setAddFundsCallback: () => {},
  };
}
