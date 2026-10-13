import {
  addRpcUrlOverrideToChain,
  getAccessToken,
  PrivyProvider as PrivyProviderComponent,
  useFundWallet,
  useHeadlessDelegatedActions,
  useIdentityToken,
  useLogin,
  usePrivy,
  User,
  useWallets,
} from "@privy-io/react-auth";
import {
  SmartWalletsProvider as SmartWalletsProviderComponent,
  useSmartWallets,
} from "@privy-io/react-auth/smart-wallets";
import {
  ComponentProps,
  ReactElement,
  ReactNode,
  useMemo,
} from "react";
import { base } from "viem/chains";
import {
  ManagedSmartWallet,
  WalletImplementation,
  WalletSession,
  WalletSessionCallbacks,
  WalletSessionProviderProps,
  WalletUser,
} from "../../lib/IWalletSession";
import { Hex } from "../../lib/Types";

type LinkedWallet = {
  address: string;
  connectorType: string;
  delegated: boolean;
  type: string;
};

// Privy is typed against its own copy of @types/react, which may
// differ from the app's.
const PrivyProvider = PrivyProviderComponent as unknown as (
  props: Omit<
    ComponentProps<typeof PrivyProviderComponent>,
    "children"
  > & {
    children: ReactNode;
  }
) => ReactElement;
const SmartWalletsProvider =
  SmartWalletsProviderComponent as unknown as (props: {
    children: ReactNode;
  }) => ReactElement;

const _USER_EXITED_AUTH_FLOW_ERRORS = new Set(["exited_auth_flow"]);

function getEmail(user: User) {
  if (user.email) {
    return user.email.address;
  }
  const linkedAccount = user.linkedAccounts?.find(
    (account) => (account as { email?: string }).email
  ) as { email?: string } | undefined;
  return linkedAccount?.email;
}

function findLinkedWallet(
  user: User,
  predicate: (wallet: LinkedWallet) => boolean
) {
  return user.linkedAccounts?.find((account) =>
    predicate(account as unknown as LinkedWallet)
  ) as unknown as LinkedWallet | undefined;
}

export function toWalletUser(user: User): WalletUser {
  const embeddedSigner = findLinkedWallet(
    user,
    (wallet) => wallet.connectorType === "embedded"
  );
  return {
    id: user.id,
    email: getEmail(user),
    formlessUniqueID: user.customMetadata?.formless_unique_id as
      | string
      | undefined,
    embeddedSigner: embeddedSigner && {
      address: embeddedSigner.address,
      delegated: embeddedSigner.delegated,
    },
    smartWalletAddress: findLinkedWallet(
      user,
      (wallet) => wallet.type === "smart_wallet"
    )?.address,
    linkedAccountsCount: user.linkedAccounts?.length ?? 0,
  };
}

function Provider({
  config,
  rpcEndpoints,
  children,
}: WalletSessionProviderProps) {
  const baseRPCEndpoint = rpcEndpoints[base.id];
  return (
    <PrivyProvider
      appId={config.appID}
      config={{
        appearance: {
          theme: config.appearance?.theme ?? "light",
          accentColor: config.appearance?.accentColor ?? "#000000",
          logo: config.appearance?.logo,
          // Typed as a string, but React nodes are rendered.
          loginMessage: config.appearance?.loginMessage as string,
        },
        embeddedWallets: {
          createOnLogin: "users-without-wallets",
        },
        supportedChains: [
          baseRPCEndpoint
            ? addRpcUrlOverrideToChain(base, baseRPCEndpoint)
            : base,
        ],
      }}
    >
      <SmartWalletsProvider>{children}</SmartWalletsProvider>
    </PrivyProvider>
  );
}

function useSession({
  onLoginComplete,
  onLoginError,
  onFundingExited,
}: WalletSessionCallbacks): WalletSession {
  const { user, logout, authenticated, ready } = usePrivy();
  const { client } = useSmartWallets();
  const { wallets } = useWallets();
  const { identityToken } = useIdentityToken();
  const { delegateWallet } = useHeadlessDelegatedActions();
  const { fundWallet } = useFundWallet({
    onUserExited: onFundingExited,
  });
  const { login } = useLogin({
    onComplete: ({ user, wasAlreadyAuthenticated }) =>
      onLoginComplete(toWalletUser(user), wasAlreadyAuthenticated),
    onError: onLoginError,
  });
  const walletUser = useMemo(
    () => (user ? toWalletUser(user) : undefined),
    [user]
  );
  const embeddedWallet = wallets.find(
    (wallet) => wallet.walletClientType === "privy"
  );

  const managedSmartWallet: ManagedSmartWallet | undefined = client
    ? {
        address: client.account.address,
        signMessage: (message) =>
          client.signMessage(
            { message },
            { uiOptions: { showWalletUIs: false } }
          ),
        sendTransaction: (transaction) =>
          client.sendTransaction(
            transaction as Parameters<
              typeof client.sendTransaction
            >[0],
            { uiOptions: { showWalletUIs: false } }
          ),
      }
    : undefined;

  return {
    ready,
    authenticated,
    user: walletUser,
    managedSmartWallet,
    connectedSignerAddress: embeddedWallet?.address,
    login: async () => login(),
    logout,
    getIdentityToken: async () => {
      // getAccessToken refreshes the identity token if it expired.
      await getAccessToken();
      return identityToken ?? undefined;
    },
    delegateSigner: (address) =>
      delegateWallet({ address, chainType: "ethereum" }),
    signHashWithSigner: async (hash) => {
      if (!embeddedWallet) {
        throw new Error("Smart wallet signer not initialized");
      }
      // Coinbase Smart Wallets verify a raw secp256k1 signature over
      // the user operation hash.
      const provider = await embeddedWallet.getEthereumProvider();
      return (await provider.request({
        method: "secp256k1_sign",
        params: [hash],
      })) as Hex;
    },
    fundWallet: (address, { chain, amount, asset, title }) =>
      fundWallet(address, {
        chain,
        amount,
        asset,
        uiConfig: { receiveFundsTitle: title },
      }),
    isUserCancellation: (error) =>
      typeof error === "string" &&
      _USER_EXITED_AUTH_FLOW_ERRORS.has(error),
  };
}

export const PrivyWalletImplementation: WalletImplementation = {
  Provider,
  useSession,
};
