import { describe, expect, it, jest } from "@jest/globals";
import { Hex } from "viem";
import {
  entryPoint06Address,
  formatUserOperation,
  getUserOperationHash,
  RpcUserOperation,
} from "viem/account-abstraction";
import { privateKeyToAccount } from "viem/accounts";
import {
  FormlessRPCClient,
  FormlessRPCRequest,
} from "../lib/FormlessRPCClient";
import {
  FormlessSmartWallets,
  parsePrimaryWallet,
} from "../lib/FormlessSmartWallets";
import { PrimaryWallet } from "../lib/Types";

const signer = privateKeyToAccount(
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d"
);
const OTHER_SIGNER = privateKeyToAccount(
  "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a"
);
const SMART_WALLET = "0x3333333333333333333333333333333333333333";
const RECIPIENT = "0x4444444444444444444444444444444444444444";

const wallet: PrimaryWallet = {
  address: SMART_WALLET,
  walletType: "ERC4337",
  waasImplementation: "formless_server_side",
  signers: [signer.address],
};

function makeUserOperation(
  overrides: Partial<RpcUserOperation<"0.6">> = {}
): RpcUserOperation<"0.6"> {
  return {
    sender: SMART_WALLET,
    nonce: "0x0",
    initCode: "0x",
    callData: "0xdeadbeef",
    callGasLimit: "0x5208",
    verificationGasLimit: "0x5208",
    preVerificationGas: "0x5208",
    maxFeePerGas: "0x1",
    maxPriorityFeePerGas: "0x1",
    paymasterAndData: "0x",
    signature: "0x",
    ...overrides,
  };
}

function hashOf(userOperation: RpcUserOperation<"0.6">) {
  return getUserOperationHash({
    userOperation: {
      ...formatUserOperation(userOperation),
      signature: "0x",
    },
    chainId: 8453,
    entryPointAddress: entryPoint06Address,
    entryPointVersion: "0.6",
  });
}

function makeSmartWallets({
  userOperation = makeUserOperation(),
  userOperationHash = hashOf(userOperation),
}: {
  userOperation?: RpcUserOperation<"0.6">;
  userOperationHash?: string;
} = {}) {
  const request = jest.fn<FormlessRPCRequest>(async (method) => {
    switch (method) {
      case "prepare_smart_wallet_user_operation":
        return {
          status: "success",
          smart_wallet_address: SMART_WALLET,
          user_operation: userOperation,
          user_operation_hash: userOperationHash,
        };
      case "submit_smart_wallet_user_operation":
        return { status: "success", transaction_hash: "0xtx" };
      case "app_approve_wallet_codehash":
        return {};
    }
    throw new Error(`Unexpected method ${method}`);
  });
  return {
    request,
    smartWallets: new FormlessSmartWallets(
      new FormlessRPCClient(request)
    ),
  };
}

const signHash = (hash: Hex) => signer.sign({ hash });

describe("parsePrimaryWallet", () => {
  it("returns the primary financial account", () => {
    expect(
      parsePrimaryWallet([
        {
          evm_blockchain_address: "0xa",
          metadata: { primary: false },
        },
        {
          evm_blockchain_address: "0xb",
          metadata: {
            primary: true,
            wallet_type: "ERC4337",
            waas_implementation: "privy",
          },
        },
      ])
    ).toEqual({
      address: "0xb",
      walletType: "ERC4337",
      waasImplementation: "privy",
      smartContractImplementation: undefined,
      signers: [],
    });
    expect(parsePrimaryWallet(undefined)).toBeUndefined();
  });
});

describe("FormlessSmartWallets.sendTransaction", () => {
  it("signs, verifies and submits a user operation", async () => {
    const { smartWallets, request } = makeSmartWallets();

    await expect(
      smartWallets.sendTransaction({
        wallet,
        signerAddress: signer.address,
        transaction: { to: RECIPIENT, value: BigInt(5) },
        signHash,
      })
    ).resolves.toBe("0xtx");
    expect(request.mock.calls[0][1]).toEqual({
      signer_address: signer.address,
      calls: [{ to: RECIPIENT, value: "5", data: "0x" }],
    });
    expect(request.mock.calls.map(([method]) => method)).toEqual([
      "prepare_smart_wallet_user_operation",
      "submit_smart_wallet_user_operation",
    ]);
  });

  it("approves the wallet codehash after deployment", async () => {
    const { smartWallets, request } = makeSmartWallets({
      userOperation: makeUserOperation({ initCode: "0x1234" }),
    });

    await smartWallets.sendTransaction({
      wallet,
      signerAddress: signer.address,
      transaction: { calls: [{ to: RECIPIENT }] },
      signHash,
    });
    expect(request).toHaveBeenLastCalledWith(
      "app_approve_wallet_codehash",
      { wallet_address: SMART_WALLET },
      10
    );
  });

  it("never signs a hash which does not match the user operation", async () => {
    const { smartWallets, request } = makeSmartWallets({
      userOperationHash: `0x${"00".repeat(32)}`,
    });
    const sign = jest.fn(signHash);

    await expect(
      smartWallets.sendTransaction({
        wallet,
        signerAddress: signer.address,
        transaction: { to: RECIPIENT },
        signHash: sign,
      })
    ).rejects.toThrow("Prepared user operation hash mismatch");
    expect(sign).not.toHaveBeenCalled();
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("rejects user operations from another sender", async () => {
    const { smartWallets } = makeSmartWallets({
      userOperation: makeUserOperation({ sender: RECIPIENT }),
    });

    await expect(
      smartWallets.sendTransaction({
        wallet,
        signerAddress: signer.address,
        transaction: { to: RECIPIENT },
        signHash,
      })
    ).rejects.toThrow("sender does not match");
  });

  it("rejects signatures from another signer", async () => {
    const { smartWallets, request } = makeSmartWallets();

    await expect(
      smartWallets.sendTransaction({
        wallet: { ...wallet, signers: [] },
        signerAddress: signer.address,
        transaction: { to: RECIPIENT },
        signHash: (hash) => OTHER_SIGNER.sign({ hash }),
      })
    ).rejects.toThrow(`expected ${signer.address}`);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("rejects signers not recorded on the wallet", async () => {
    const { smartWallets, request } = makeSmartWallets();

    await expect(
      smartWallets.sendTransaction({
        wallet,
        signerAddress: OTHER_SIGNER.address,
        transaction: { to: RECIPIENT },
        signHash,
      })
    ).rejects.toThrow("is not a signer of");
    expect(request).not.toHaveBeenCalled();
  });

  it("rejects transactions on other networks", async () => {
    const { smartWallets } = makeSmartWallets();

    await expect(
      smartWallets.sendTransaction({
        wallet,
        signerAddress: signer.address,
        transaction: { to: RECIPIENT, chain: { id: 10 } },
        signHash,
      })
    ).rejects.toThrow("Unsupported network ID for smart wallet: 10");
  });
});
