import { useEffect, useRef, useState } from "react";
import { ReadContractParameters } from "viem";
import { JWTCredential } from "../lib/Credential";
import {
  isFormlessServerSideWallet,
  toLinkPrimaryFinancialAccount,
} from "../lib/FormlessSmartWallets";
import {
  WalletImplementation,
  WalletSession,
  WalletUser,
} from "../lib/IWalletSession";
import {
  ILogger,
  IWallet,
  LoginCallback,
  PrimaryWallet,
  UniqueIDProvisionResponse,
  WalletEvent,
  WalletTransaction,
} from "../lib/Types";
import { WalletCore } from "../lib/WalletCore";

function signatureStorageKey(walletAddress: string) {
  return `share_application_services_signature_v1_${walletAddress}`;
}

export interface WalletStateOptions {
  core: WalletCore;
  implementation: WalletImplementation;
  fundingTitle: string;
  onEvent?: (event: WalletEvent) => void;
  log?: ILogger;
}

export function useWalletState({
  core,
  implementation,
  fundingTitle,
  onEvent,
  log,
}: WalletStateOptions): IWallet {
  const [email, setEmail] = useState<string | undefined>(undefined);
  const [signature, setSignature] = useState<string | undefined>(
    undefined
  );
  const [uniqueID, setUniqueID] = useState<string | undefined>(
    undefined
  );
  const [primaryWallet, setPrimaryWallet] = useState<
    PrimaryWallet | undefined
  >(undefined);
  const [primaryWalletResolved, setPrimaryWalletResolved] =
    useState<boolean>(false);
  const provisioningComplete = useRef(false);
  const loginCallback = useRef<LoginCallback | undefined>(undefined);
  const addFundsCallback = useRef<(() => void) | undefined>(
    undefined
  );
  // The session is read through a ref by its own callbacks.
  const sessionRef = useRef<WalletSession | undefined>(undefined);

  const emit = (event: WalletEvent) => {
    try {
      onEvent?.(event);
    } catch (error) {
      log?.error("Error handling wallet event:", error);
    }
  };

  const emitSignInFailed = (error: unknown) => {
    if (!sessionRef.current?.isUserCancellation(error)) {
      emit({ type: "sign_in_failed", error });
    }
  };

  const onProvisioned = (
    user: WalletUser,
    result: UniqueIDProvisionResponse
  ) => {
    setUniqueID(result.unique_id);
    provisioningComplete.current = result.status === "success";
    if (result.new_user) {
      emit({
        type: "unique_id_created",
        email: user.email,
        uniqueID: result.unique_id,
      });
    }
  };

  const runLoginCallback = async (
    provisioningResult?: UniqueIDProvisionResponse
  ) => {
    const callback = loginCallback.current;
    if (callback) {
      loginCallback.current = undefined;
      await callback(provisioningResult);
    }
  };

  const session = implementation.useSession({
    onLoginComplete: async (user, wasAlreadyAuthenticated) => {
      let provisioningResult: UniqueIDProvisionResponse | undefined;
      try {
        setEmail(user.email);
        if (wasAlreadyAuthenticated && user.formlessUniqueID) {
          setUniqueID(user.formlessUniqueID);
          return;
        }
        try {
          if (
            !provisioningComplete.current &&
            core.hasProvisioningWallet(user)
          ) {
            provisioningResult = await core.provisionUniqueID(user);
            onProvisioned(user, provisioningResult);
          }
          const signer = user.embeddedSigner;
          if (signer && !signer.delegated) {
            try {
              await core.delegateSigner(signer.address, () =>
                (sessionRef.current as WalletSession).delegateSigner(
                  signer.address
                )
              );
            } catch (error) {
              emitSignInFailed(error);
              log?.error("Error delegating wallet:", error);
            }
          }
        } catch (error) {
          emitSignInFailed(error);
          log?.error("Error during login completion:", error);
        }
        emit({
          type: "sign_in_succeeded",
          email: user.email,
          uniqueID: provisioningResult?.unique_id ?? uniqueID,
        });
      } finally {
        await runLoginCallback(provisioningResult);
      }
    },
    onLoginError: (error) => {
      emitSignInFailed(error);
      log?.error("Login error:", error);
    },
    onFundingExited: () => {
      const callback = addFundsCallback.current;
      addFundsCallback.current = undefined;
      callback?.();
    },
  });
  sessionRef.current = session;
  const { user, managedSmartWallet } = session;

  useEffect(() => {
    // Sets the unique ID of the user if it is not already set,
    // provisioning one if necessary.
    const run = async () => {
      if (!user || uniqueID) {
        return;
      }
      setEmail(user.email);
      if (user.formlessUniqueID) {
        setUniqueID(user.formlessUniqueID);
      } else if (core.hasProvisioningWallet(user)) {
        const result = await core.provisionUniqueID(user);
        onProvisioned(user, result);
        if (result.new_user) {
          await runLoginCallback(result);
        }
      }
    };
    run().catch((error) =>
      log?.error("Error provisioning unique ID:", error)
    );
  }, [user?.id, user?.linkedAccountsCount]);

  useEffect(() => {
    // Resolves the primary wallet of the user, which determines
    // whether the wallet is managed by the wallet implementation or
    // is a Formless provisioned smart wallet. A value cached in
    // memory is used until the RPC completes.
    if (!uniqueID) {
      setPrimaryWallet(undefined);
      setPrimaryWalletResolved(false);
      return;
    }
    let cancelled = false;
    const cachedWallet =
      core.smartWallets.loadCachedPrimaryWallet(uniqueID);
    setPrimaryWallet(cachedWallet);
    setPrimaryWalletResolved(!!cachedWallet);
    core.smartWallets
      .fetchPrimaryWallet(uniqueID)
      .then((wallet) => {
        if (!cancelled) {
          setPrimaryWallet(wallet);
          setPrimaryWalletResolved(true);
        }
      })
      .catch((error) => {
        log?.error("Error fetching primary wallet:", error);
      });
    return () => {
      cancelled = true;
    };
  }, [uniqueID]);

  const isFormlessSmartWallet =
    isFormlessServerSideWallet(primaryWallet);
  const linkPrimaryFinancialAccount =
    toLinkPrimaryFinancialAccount(primaryWallet);

  // For managed smart wallets the address is that of the managed
  // wallet. For Formless smart wallets the managed wallet (if any) is
  // not the user's primary wallet, so the address resolved by RPC is
  // used instead. The address is withheld until the primary wallet
  // is resolved so that a non-primary address is never surfaced.
  const walletAddress = !primaryWalletResolved
    ? undefined
    : isFormlessSmartWallet
      ? primaryWallet?.address
      : managedSmartWallet?.address;

  useEffect(() => {
    if (walletAddress) {
      core.approveWalletCodehash(walletAddress);
    }
  }, [walletAddress]);

  useEffect(() => {
    // Ensures that once a wallet is resolved, it is recorded as the
    // primary wallet of the unique ID.
    if (!walletAddress || !uniqueID || !email) {
      return;
    }
    core
      .syncPrimaryWallet({
        email,
        walletAddress,
        linkPrimaryFinancialAccount,
      })
      .then((result) => {
        if (result.new_user) {
          emit({
            type: "unique_id_created",
            email,
            uniqueID: result.unique_id,
          });
        }
      })
      .catch((error) =>
        log?.error("Error syncing primary wallet:", error)
      );
  }, [walletAddress, uniqueID, email]);

  return {
    ready: session.ready,
    authenticated: session.authenticated,
    email: email as string,
    signature: signature as string,
    uniqueID: uniqueID as string,
    walletAddress: walletAddress as string,
    linkPrimaryFinancialAccount,

    getCredential: async () =>
      new JWTCredential((await session.getIdentityToken()) as string),

    signMessage: async (message: string) => {
      const savedSignature = localStorage.getItem(
        signatureStorageKey(managedSmartWallet?.address as string)
      );
      if (savedSignature) {
        setSignature(savedSignature);
        return savedSignature;
      }
      if (!managedSmartWallet) {
        throw new Error("Wallet client not initialized");
      }
      try {
        const signature =
          await managedSmartWallet.signMessage(message);
        setSignature(signature);
        localStorage.setItem(
          signatureStorageKey(managedSmartWallet.address),
          signature
        );
        return signature;
      } catch (error) {
        log?.error("Error signing message:", error);
        return undefined as unknown as string;
      }
    },

    sendTransaction: async (transaction: {}) => {
      if (isFormlessSmartWallet) {
        try {
          const signerAddress = session.connectedSignerAddress;
          if (!signerAddress) {
            throw new Error("Smart wallet signer not initialized");
          }
          return await core.smartWallets.sendTransaction({
            wallet: primaryWallet as PrimaryWallet,
            signerAddress,
            transaction: transaction as WalletTransaction,
            signHash: session.signHashWithSigner,
          });
        } catch (error) {
          // Rethrown so callers never treat a failed user operation
          // as a successful transaction.
          log?.error("Error sending transaction:", error);
          throw error;
        }
      }
      if (!managedSmartWallet) {
        throw new Error("Wallet client not initialized");
      }
      try {
        return await managedSmartWallet.sendTransaction(transaction);
      } catch (error) {
        log?.error("Error sending transaction:", error);
        return undefined;
      }
    },

    addFunds: async (amount, chain, asset) => {
      if (!walletAddress) {
        throw new Error("Wallet address not available");
      }
      try {
        return await session.fundWallet(walletAddress, {
          chain,
          amount,
          asset,
          title: fundingTitle,
        });
      } catch (error) {
        log?.error("Error adding funds:", error);
        throw error;
      }
    },

    login: async () => {
      try {
        return await session.login();
      } catch (error) {
        log?.error("Error during login:", error);
        throw error;
      }
    },

    logout: async () => {
      try {
        setUniqueID(undefined);
        setEmail(undefined);
        provisioningComplete.current = false;
        return await session.logout();
      } catch (error) {
        log?.error("Error during logout:", error);
        throw error;
      }
    },

    readContract: async (parameters: {}, networkId: number) =>
      (await core.getPublicClient(networkId)).readContract(
        parameters as ReadContractParameters
      ),

    setLoginCallback: (callback) => {
      loginCallback.current = callback;
    },

    setAddFundsCallback: (callback) => {
      addFundsCallback.current = callback;
    },
  };
}
