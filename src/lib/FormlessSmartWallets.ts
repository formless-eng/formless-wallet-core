import { Hex, isAddressEqual, recoverAddress } from "viem";
import {
  entryPoint06Address,
  formatUserOperation,
  getUserOperationHash,
  RpcUserOperation,
} from "viem/account-abstraction";
import { NETWORK_ID_BASE } from "./Chains";
import { FormlessRPCClient } from "./FormlessRPCClient";
import {
  Dictionary,
  ILogger,
  LinkPrimaryFinancialAccount,
  PrimaryWallet,
  WalletTransaction,
} from "./Types";

export const WAAS_IMPLEMENTATION_FORMLESS_SERVER_SIDE =
  "formless_server_side";
export const WALLET_TYPE_ERC4337 = "ERC4337";

export function isFormlessServerSideWallet(
  wallet: PrimaryWallet | undefined
) {
  return (
    wallet?.waasImplementation ===
    WAAS_IMPLEMENTATION_FORMLESS_SERVER_SIDE
  );
}

/**
 * Returns the link_primary_financial_account parameter for
 * unique_id_provision if the wallet is a Formless provisioned
 * smart wallet, since such wallets are not linked accounts of the
 * wallet implementation's user.
 */
export function toLinkPrimaryFinancialAccount(
  wallet: PrimaryWallet | undefined
): LinkPrimaryFinancialAccount | undefined {
  if (!wallet || !isFormlessServerSideWallet(wallet)) {
    return undefined;
  }
  return {
    address: wallet.address,
    type: wallet.walletType || WALLET_TYPE_ERC4337,
    waas_implementation: wallet.waasImplementation as string,
  };
}

/**
 * Returns the primary wallet from the financial_accounts of
 * unique_id_fetch_data, which are VDR formatted dictionaries.
 */
export function parsePrimaryWallet(
  financialAccounts: Dictionary[] | undefined
): PrimaryWallet | undefined {
  for (const account of financialAccounts || []) {
    const metadata =
      account.metadata &&
      typeof account.metadata === "object" &&
      !Array.isArray(account.metadata)
        ? (account.metadata as Dictionary)
        : undefined;
    const address = account.evm_blockchain_address as
      | string
      | undefined;
    if (metadata?.primary) {
      return address
        ? {
            address,
            walletType: metadata.wallet_type as string | undefined,
            waasImplementation: metadata.waas_implementation as
              | string
              | undefined,
            smartContractImplementation:
              metadata.smart_contract_implementation as
                | string
                | undefined,
            signers: (metadata.signers as string[] | undefined) || [],
          }
        : undefined;
    }
  }
  return undefined;
}

function assertSuccess<
  T extends { status?: string; message?: string },
>(response: T, method: string): T {
  if (response?.status !== "success") {
    throw new Error(
      `${method} failed: ${response?.message || "unknown error"}`
    );
  }
  return response;
}

/**
 * Client side interface to Formless provisioned ERC4337 smart
 * wallets (waas_implementation formless_server_side).
 */
export class FormlessSmartWallets {
  // In memory cache of primary wallets by unique ID.
  private readonly primaryWalletsByUniqueID = new Map<
    string,
    PrimaryWallet | undefined
  >();

  constructor(
    private readonly rpc: FormlessRPCClient,
    private readonly log?: ILogger
  ) {}

  loadCachedPrimaryWallet(
    uniqueID: string
  ): PrimaryWallet | undefined {
    return this.primaryWalletsByUniqueID.get(uniqueID);
  }

  /**
   * Fetches the primary financial account of a unique ID using
   * unique_id_fetch_data and caches it in memory.
   */
  async fetchPrimaryWallet(
    uniqueID: string
  ): Promise<PrimaryWallet | undefined> {
    const result = await this.rpc.uniqueIDFetchData(uniqueID);
    const wallet = parsePrimaryWallet(result?.financial_accounts);
    this.primaryWalletsByUniqueID.set(uniqueID, wallet);
    return wallet;
  }

  /**
   * Provisions (or resolves, since the address is deterministic) the
   * Formless server side smart wallet of a signer.
   */
  async provision(signerAddress: string): Promise<PrimaryWallet> {
    const response = assertSuccess(
      await this.rpc.provisionSmartWallet(signerAddress),
      "provision_smart_wallet"
    );
    return {
      address: response.address as string,
      walletType: response.type,
      waasImplementation: response.waas_implementation,
      smartContractImplementation:
        response.smart_contract_implementation,
      signers: response.signer_address
        ? [response.signer_address]
        : [],
    };
  }

  /**
   * Sends a transaction from a Formless provisioned smart wallet:
   *   1. prepares the user operation server side,
   *   2. signs the user operation hash client side using signHash,
   *   3. submits the signed user operation server side.
   *
   * @returns The transaction hash of the bundled user operation.
   */
  async sendTransaction({
    wallet,
    signerAddress,
    transaction,
    signHash,
  }: {
    wallet: PrimaryWallet;
    signerAddress: string;
    transaction: WalletTransaction;
    signHash: (hash: Hex) => Promise<Hex>;
  }): Promise<string> {
    const calls =
      transaction.calls ??
      (transaction.to
        ? [
            {
              to: transaction.to,
              value: transaction.value,
              data: transaction.data,
            },
          ]
        : []);
    if (calls.length === 0) {
      throw new Error("Smart wallet transaction has no calls");
    }
    const networkId = transaction.chain?.id ?? NETWORK_ID_BASE;
    if (networkId !== NETWORK_ID_BASE) {
      throw new Error(
        `Unsupported network ID for smart wallet: ${networkId}`
      );
    }
    if (
      wallet.signers.length > 0 &&
      !wallet.signers.some((signer) =>
        isAddressEqual(signer as Hex, signerAddress as Hex)
      )
    ) {
      throw new Error(
        `Signer ${signerAddress} is not a signer of ${wallet.address}`
      );
    }

    const prepared = assertSuccess(
      await this.rpc.prepareSmartWalletUserOperation(
        signerAddress,
        calls.map((call) => ({
          to: call.to,
          value: (call.value ?? BigInt(0)).toString(),
          data: call.data ?? "0x",
        }))
      ),
      "prepare_smart_wallet_user_operation"
    );

    // Never sign a hash on trust: recompute it from the returned user
    // operation and ensure it is sent from the expected smart wallet.
    const userOperation = formatUserOperation(
      prepared.user_operation as unknown as RpcUserOperation<"0.6">
    );
    if (
      !isAddressEqual(userOperation.sender, wallet.address as Hex) ||
      !isAddressEqual(
        prepared.smart_wallet_address as Hex,
        wallet.address as Hex
      )
    ) {
      throw new Error(
        `Prepared user operation sender does not match ${wallet.address}`
      );
    }
    const userOperationHash = getUserOperationHash({
      userOperation: { ...userOperation, signature: "0x" },
      chainId: networkId,
      entryPointAddress: entryPoint06Address,
      entryPointVersion: "0.6",
    });
    if (
      userOperationHash.toLowerCase() !==
      prepared.user_operation_hash?.toLowerCase()
    ) {
      throw new Error("Prepared user operation hash mismatch");
    }

    const signature = await signHash(userOperationHash);
    // The server and the smart wallet contract verify a raw signature
    // over the user operation hash; fail early if the signer differs.
    const recoveredSigner = await recoverAddress({
      hash: userOperationHash,
      signature,
    });
    if (!isAddressEqual(recoveredSigner, signerAddress as Hex)) {
      throw new Error(
        `User operation signed by ${recoveredSigner}, expected ${signerAddress}`
      );
    }
    const { transaction_hash: transactionHash } = assertSuccess(
      await this.rpc.submitSmartWalletUserOperation(
        prepared.user_operation as Dictionary,
        signature
      ),
      "submit_smart_wallet_user_operation"
    );

    // The smart wallet contract is deployed with its first user
    // operation, so its codehash can only be approved afterwards.
    if (userOperation.initCode && userOperation.initCode !== "0x") {
      try {
        await this.rpc.appApproveWalletCodehash(wallet.address);
      } catch (error) {
        this.log?.error("Error approving wallet codehash:", error);
      }
    }

    return transactionHash as string;
  }
}
