import { describe, expect, it, jest } from "@jest/globals";
import {
  FormlessRPCClient,
  FormlessRPCRequest,
} from "../lib/FormlessRPCClient";
import { WalletUser } from "../lib/IWalletSession";
import { makeKeyedLock, WalletCore } from "../lib/WalletCore";

const SIGNER = "0x1111111111111111111111111111111111111111";
const MANAGED_SMART_WALLET =
  "0x2222222222222222222222222222222222222222";
const FORMLESS_SMART_WALLET =
  "0x3333333333333333333333333333333333333333";

function makeUser(overrides: Partial<WalletUser> = {}): WalletUser {
  return {
    id: "did:user",
    email: "a@b.c",
    embeddedSigner: { address: SIGNER, delegated: false },
    smartWalletAddress: MANAGED_SMART_WALLET,
    linkedAccountsCount: 2,
    ...overrides,
  };
}

function makeCore(
  responses: Record<string, unknown>,
  options: { provisionFormlessSmartWalletsForNewUsers?: boolean } = {}
) {
  const request = jest.fn<FormlessRPCRequest>(
    async (method) => responses[method]
  );
  return {
    request,
    core: new WalletCore(new FormlessRPCClient(request), options),
  };
}

function provisionParams(
  request: ReturnType<typeof makeCore>["request"]
) {
  return request.mock.calls
    .filter(([method]) => method === "unique_id_provision")
    .map(([, params]) => params);
}

describe("makeKeyedLock", () => {
  it("shares a request between concurrent callers", async () => {
    const lock = makeKeyedLock<number>();
    let resolve: (value: number) => void = () => {};
    const run = jest.fn(
      () => new Promise<number>((r) => (resolve = r))
    );

    const first = lock("key", run);
    const second = lock("key", run);
    resolve(1);

    await expect(Promise.all([first, second])).resolves.toEqual([
      1, 1,
    ]);
    expect(run).toHaveBeenCalledTimes(1);

    const third = lock("key", run);
    resolve(2);
    await expect(third).resolves.toBe(2);
    expect(run).toHaveBeenCalledTimes(2);
  });
});

describe("WalletCore", () => {
  it("provisions with the managed smart wallet by default", async () => {
    const { core, request } = makeCore({
      unique_id_provision: { unique_id: "u1" },
    });

    await core.provisionUniqueID(makeUser());
    expect(provisionParams(request)).toEqual([
      {
        email_address: "a@b.c",
        privy_did: "did:user",
        primary_wallet_address: MANAGED_SMART_WALLET,
      },
    ]);
  });

  it("keeps an existing Formless smart wallet as the primary wallet", async () => {
    const { core, request } = makeCore({
      unique_id_fetch_data: {
        financial_accounts: [
          { evm_blockchain_address: MANAGED_SMART_WALLET },
          {
            evm_blockchain_address: FORMLESS_SMART_WALLET,
            metadata: {
              primary: true,
              wallet_type: "ERC4337",
              waas_implementation: "formless_server_side",
              signers: [SIGNER],
            },
          },
        ],
      },
      unique_id_provision: { unique_id: "u1" },
    });

    await core.provisionUniqueID(
      makeUser({ formlessUniqueID: "u1" })
    );
    expect(provisionParams(request)).toEqual([
      {
        email_address: "a@b.c",
        privy_did: "did:user",
        primary_wallet_address: FORMLESS_SMART_WALLET,
        link_primary_financial_account: {
          address: FORMLESS_SMART_WALLET,
          type: "ERC4337",
          waas_implementation: "formless_server_side",
        },
      },
    ]);
  });

  it("provisions new users with a Formless smart wallet when enabled", async () => {
    const { core, request } = makeCore(
      {
        provision_smart_wallet: {
          status: "success",
          address: FORMLESS_SMART_WALLET,
          type: "ERC4337",
          waas_implementation: "formless_server_side",
          signer_address: SIGNER,
        },
        unique_id_provision: { unique_id: "u1", new_user: true },
      },
      { provisionFormlessSmartWalletsForNewUsers: true }
    );
    const user = makeUser({ smartWalletAddress: undefined });

    expect(core.hasProvisioningWallet(user)).toBe(true);
    await core.provisionUniqueID(user);
    expect(request).toHaveBeenCalledWith(
      "provision_smart_wallet",
      { signer_address: SIGNER },
      10
    );
    expect(provisionParams(request)[0].primary_wallet_address).toBe(
      FORMLESS_SMART_WALLET
    );
  });

  it("requires a managed smart wallet unless Formless smart wallets are enabled", () => {
    const { core } = makeCore({});
    expect(
      core.hasProvisioningWallet(
        makeUser({ smartWalletAddress: undefined })
      )
    ).toBe(false);
  });

  it("provisions a user once for concurrent calls", async () => {
    const { core, request } = makeCore({
      unique_id_provision: { unique_id: "u1" },
    });

    await Promise.all([
      core.provisionUniqueID(makeUser()),
      core.provisionUniqueID(makeUser()),
    ]);
    expect(provisionParams(request)).toHaveLength(1);
  });

  it("logs, rather than throws, codehash approval failures", async () => {
    const log = {
      debug: jest.fn(),
      info: jest.fn(),
      error: jest.fn(),
    };
    const request = jest.fn(async () => {
      throw new Error("unavailable");
    });
    const core = new WalletCore(new FormlessRPCClient(request), {
      log,
    });

    await expect(
      core.approveWalletCodehash(MANAGED_SMART_WALLET)
    ).resolves.toBeUndefined();
    expect(log.error).toHaveBeenCalled();
  });

  it("rejects unsupported networks for public clients", async () => {
    const { core } = makeCore({});
    await expect(core.getPublicClient(1)).rejects.toThrow(
      "Unsupported network ID: 1"
    );
  });

  it("uses RPC endpoint overrides", async () => {
    const request = jest.fn(async () => ({}));
    const core = new WalletCore(new FormlessRPCClient(request), {
      rpcEndpointOverrides: { 137: "https://polygon.test" },
    });
    await expect(core.getRPCEndpoint(137)).resolves.toBe(
      "https://polygon.test"
    );
    expect(request).not.toHaveBeenCalled();
  });
});
