import { createPublicClient, http, PublicClient } from "viem";
import { SUPPORTED_CHAINS } from "./Chains";
import { FormlessRPCClient } from "./FormlessRPCClient";
import {
  FormlessSmartWallets,
  isFormlessServerSideWallet,
  toLinkPrimaryFinancialAccount,
} from "./FormlessSmartWallets";
import { WalletUser } from "./IWalletSession";
import {
  ILogger,
  LinkPrimaryFinancialAccount,
  UniqueIDProvisionResponse,
} from "./Types";

/**
 * Deduplicates concurrent calls of `run` with the same key.
 */
export function makeKeyedLock<T>() {
  const requestsByKey = new Map<string, Promise<T>>();
  return async (key: string, run: () => Promise<T>): Promise<T> => {
    const existingRequest = requestsByKey.get(key);
    if (existingRequest) {
      return existingRequest;
    }
    const request = run();
    requestsByKey.set(key, request);
    try {
      return await request;
    } finally {
      requestsByKey.delete(key);
    }
  };
}

/**
 * Wallet logic independent of React and of the wallet
 * implementation.
 */
export class WalletCore {
  readonly smartWallets: FormlessSmartWallets;
  private readonly provisionWithUserLock =
    makeKeyedLock<UniqueIDProvisionResponse>();
  private readonly delegateWithAddressLock = makeKeyedLock<void>();
  private readonly publicClientsByNetworkID = new Map<
    number,
    Promise<PublicClient>
  >();

  constructor(
    readonly rpc: FormlessRPCClient,
    private readonly options: {
      // When enabled, new sign ups are provisioned with a Formless
      // server side smart wallet as their primary wallet instead of
      // a smart wallet managed by the wallet implementation.
      provisionFormlessSmartWalletsForNewUsers?: boolean;
      // RPC endpoints by network ID, used instead of the endpoints
      // provided by Formless.
      rpcEndpointOverrides?: Record<number, string>;
      log?: ILogger;
    } = {}
  ) {
    this.smartWallets = new FormlessSmartWallets(rpc, options.log);
  }

  getRPCEndpoint(networkID: number): Promise<string> {
    const override = this.options.rpcEndpointOverrides?.[networkID];
    return override
      ? Promise.resolve(override)
      : this.rpc.getRPCEndpoint(networkID);
  }

  getPublicClient(networkID: number): Promise<PublicClient> {
    const chain = SUPPORTED_CHAINS[networkID];
    if (!chain) {
      return Promise.reject(
        new Error(`Unsupported network ID: ${networkID}`)
      );
    }
    let client = this.publicClientsByNetworkID.get(networkID);
    if (!client) {
      client = this.getRPCEndpoint(networkID).then(
        (endpoint) =>
          createPublicClient({
            chain,
            transport: http(endpoint),
          }) as PublicClient
      );
      client.catch(() =>
        this.publicClientsByNetworkID.delete(networkID)
      );
      this.publicClientsByNetworkID.set(networkID, client);
    }
    return client;
  }

  /**
   * Returns whether the wallet needed to provision a unique ID for the
   * user is available: a managed smart wallet, or an embedded signer
   * when Formless smart wallets are provisioned for new users.
   */
  hasProvisioningWallet(user: WalletUser) {
    return (
      !!user.smartWalletAddress ||
      (!!this.options.provisionFormlessSmartWalletsForNewUsers &&
        !!user.embeddedSigner)
    );
  }

  /**
   * Provisions the unique ID of a user. Concurrent calls for the same
   * user share a single request.
   */
  provisionUniqueID(user: WalletUser) {
    return this.provisionWithUserLock(user.id, () =>
      this.provisionUniqueIDUnlocked(user)
    );
  }

  private async provisionUniqueIDUnlocked(user: WalletUser) {
    const emailAddress = user.email as string;
    // A user provisioned with a Formless smart wallet (e.g. on native)
    // must keep it as their primary wallet, rather than any smart
    // wallet managed by the wallet implementation.
    const primaryWallet = user.formlessUniqueID
      ? await this.smartWallets.fetchPrimaryWallet(
          user.formlessUniqueID
        )
      : undefined;
    if (isFormlessServerSideWallet(primaryWallet)) {
      return this.rpc.uniqueIDProvision(
        emailAddress,
        user.id,
        primaryWallet?.address,
        toLinkPrimaryFinancialAccount(primaryWallet)
      );
    }
    if (
      !user.formlessUniqueID &&
      this.options.provisionFormlessSmartWalletsForNewUsers &&
      user.embeddedSigner
    ) {
      const formlessWallet = await this.smartWallets.provision(
        user.embeddedSigner.address
      );
      return this.rpc.uniqueIDProvision(
        emailAddress,
        user.id,
        formlessWallet.address,
        toLinkPrimaryFinancialAccount(formlessWallet)
      );
    }
    return this.rpc.uniqueIDProvision(
      emailAddress,
      user.id,
      user.smartWalletAddress
    );
  }

  /**
   * Delegates the embedded signer of a user. Concurrent calls for the
   * same signer share a single request.
   */
  delegateSigner(address: string, delegate: () => Promise<void>) {
    return this.delegateWithAddressLock(address, delegate);
  }

  /**
   * Records the wallet as the primary wallet of the unique ID once it
   * is resolved.
   */
  syncPrimaryWallet({
    email,
    walletAddress,
    linkPrimaryFinancialAccount,
  }: {
    email: string;
    walletAddress: string;
    linkPrimaryFinancialAccount?: LinkPrimaryFinancialAccount;
  }) {
    return this.rpc.uniqueIDProvision(
      email,
      undefined,
      walletAddress,
      linkPrimaryFinancialAccount
    );
  }

  /**
   * Smart wallets are ERC4337 smart contracts which may contain code
   * not approved by the Formless protocol. Contract code changes
   * rarely, but to ensure wallets are always approved, the codehash
   * is lazily approved when new addresses are detected.
   */
  async approveWalletCodehash(walletAddress: string) {
    try {
      await this.rpc.appApproveWalletCodehash(walletAddress);
    } catch (error) {
      this.options.log?.error(
        "Error approving wallet codehash:",
        error
      );
    }
  }
}
