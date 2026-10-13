import {
  Dictionary,
  LinkPrimaryFinancialAccount,
  UniqueIDProvisionResponse,
} from "./Types";

export const DEFAULT_RPC_RETRIES = 10;

/**
 * Sends a Formless JSON-RPC request authorized with an unidentified
 * Formless JWT and resolves to its result. Products may inject their
 * own transport (e.g. to intercept RPCs in end to end tests).
 */
export type FormlessRPCRequest = (
  method: string,
  params: Dictionary,
  numAttempts: number
) => Promise<unknown>;

export interface SmartWalletCall {
  to: string;
  value: string;
  data: string;
}

interface SmartWalletRPCStatus {
  status: "success" | "failed";
  code?: number;
  message?: string;
  error?: string;
}

export interface ProvisionSmartWalletResponse
  extends SmartWalletRPCStatus {
  address?: string;
  type?: string;
  waas_implementation?: string;
  smart_contract_implementation?: string;
  signer_address?: string;
}

export interface PrepareSmartWalletUserOperationResponse
  extends SmartWalletRPCStatus {
  smart_wallet_address?: string;
  // ERC4337 v0.6 (Coinbase Smart Wallet) user operation in RPC (hex encoded) format.
  user_operation?: Dictionary;
  user_operation_hash?: string;
}

export interface SubmitSmartWalletUserOperationResponse
  extends SmartWalletRPCStatus {
  user_operation_hash?: string;
  transaction_hash?: string;
}

export interface UniqueIDFetchDataResponse {
  financial_accounts?: Dictionary[];
}

const sleep = (ms: number) =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Makes a fetch based FormlessRPCRequest for `endpoint`. Requests
 * are retried on network errors, 400 and 5xx responses, but never
 * on JSON-RPC errors.
 */
export function makeFormlessRPCRequest({
  endpoint,
  fetchFn = (...args) => fetch(...args),
  retryDelayMs = 1000,
}: {
  endpoint: string;
  fetchFn?: typeof fetch;
  retryDelayMs?: number;
}): FormlessRPCRequest {
  let requestID = 0;
  const send = async (
    method: string,
    params: Dictionary,
    numAttempts: number
  ) => {
    for (let attempt = 1; ; attempt++) {
      let response: Response | undefined;
      try {
        response = await fetchFn(endpoint, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: ++requestID,
            method,
            params,
          }),
        });
      } catch (error) {
        if (attempt >= numAttempts) {
          throw error;
        }
      }
      if (response) {
        const retryable =
          response.status === 400 || response.status >= 500;
        if (response.status === 200) {
          const body = await response.json();
          if (body.error) {
            throw new Error(
              `Service failure with message "${body.error.message}" for method ${method}`
            );
          }
          return body.result;
        }
        if (!retryable || attempt >= numAttempts) {
          throw new Error(response.statusText);
        }
      }
      await sleep(retryDelayMs);
    }
  };
  return async (method, params, numAttempts) => {
    const { token } = (await send(
      "create_unidentified_share_jwt",
      {},
      DEFAULT_RPC_RETRIES
    )) as { token: string };
    return send(
      method,
      { ...params, share_unidentified_jwt: token },
      numAttempts
    );
  };
}

/**
 * Formless RPCs used by wallets.
 */
export class FormlessRPCClient {
  private readonly request: FormlessRPCRequest;
  private readonly rpcEndpointsByNetworkID = new Map<
    number,
    Promise<string>
  >();

  constructor(request: FormlessRPCRequest) {
    this.request = request;
  }

  /**
   * Returns the JSON-RPC node endpoint of a chain. Successful
   * results are cached for the lifetime of the client.
   */
  getRPCEndpoint(networkID: number): Promise<string> {
    let endpoint = this.rpcEndpointsByNetworkID.get(networkID);
    if (!endpoint) {
      endpoint = (
        this.request(
          "get_endpoint_for_chain_id",
          { network_id: networkID },
          DEFAULT_RPC_RETRIES
        ) as Promise<{ rpc_endpoint: string }>
      ).then((result) => result.rpc_endpoint);
      endpoint.catch(() =>
        this.rpcEndpointsByNetworkID.delete(networkID)
      );
      this.rpcEndpointsByNetworkID.set(networkID, endpoint);
    }
    return endpoint;
  }

  /**
   * @param identityProviderUserID The ID of the user in the wallet
   * implementation (sent as privy_did).
   */
  uniqueIDProvision(
    emailAddress: string,
    identityProviderUserID?: string,
    primaryWalletAddress?: string,
    linkPrimaryFinancialAccount?: LinkPrimaryFinancialAccount
  ): Promise<UniqueIDProvisionResponse> {
    const params: Dictionary = { email_address: emailAddress };
    if (identityProviderUserID) {
      params.privy_did = identityProviderUserID;
    }
    if (primaryWalletAddress) {
      params.primary_wallet_address = primaryWalletAddress;
    }
    if (linkPrimaryFinancialAccount) {
      params.link_primary_financial_account =
        linkPrimaryFinancialAccount;
    }
    return this.request(
      "unique_id_provision",
      params,
      DEFAULT_RPC_RETRIES
    ) as Promise<UniqueIDProvisionResponse>;
  }

  uniqueIDFetchData(
    uniqueID: string
  ): Promise<UniqueIDFetchDataResponse> {
    return this.request(
      "unique_id_fetch_data",
      { unique_id: uniqueID },
      DEFAULT_RPC_RETRIES
    ) as Promise<UniqueIDFetchDataResponse>;
  }

  /**
   * Smart wallets may contain code which is not approved by the
   * Formless protocol. This checks whether the codehash of the
   * wallet is approved and, if not, approves it.
   */
  appApproveWalletCodehash(walletAddress: string) {
    return this.request(
      "app_approve_wallet_codehash",
      { wallet_address: walletAddress },
      DEFAULT_RPC_RETRIES
    );
  }

  provisionSmartWallet(
    signerAddress: string
  ): Promise<ProvisionSmartWalletResponse> {
    return this.request(
      "provision_smart_wallet",
      { signer_address: signerAddress },
      DEFAULT_RPC_RETRIES
    ) as Promise<ProvisionSmartWalletResponse>;
  }

  /**
   * Prepares a user operation which executes `calls` (batched into a
   * single user operation) from the signer's smart wallet.
   */
  prepareSmartWalletUserOperation(
    signerAddress: string,
    calls: SmartWalletCall[]
  ): Promise<PrepareSmartWalletUserOperationResponse> {
    return this.request(
      "prepare_smart_wallet_user_operation",
      { signer_address: signerAddress, calls },
      DEFAULT_RPC_RETRIES
    ) as Promise<PrepareSmartWalletUserOperationResponse>;
  }

  submitSmartWalletUserOperation(
    userOperation: Dictionary,
    signature: string
  ): Promise<SubmitSmartWalletUserOperationResponse> {
    // Not retried: resubmitting a signed user operation is not
    // idempotent from the caller's point of view.
    return this.request(
      "submit_smart_wallet_user_operation",
      { user_operation: userOperation, signature },
      1 /* numAttempts */
    ) as Promise<SubmitSmartWalletUserOperationResponse>;
  }
}
