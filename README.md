# formless-wallet-core

Vendor agnostic wallet SDK shared by Formless products
(share.stream, formless-wallet, formless-dashboard).

It owns everything between a product's UI and the user's wallet:

- `useWallet()`: sign in and out, the user's Formless unique ID,
  wallet address, credential, message signing, transactions, funding
  and contract reads.
- Unique ID provisioning: deduplicated per user, and keeping a
  Formless provisioned smart wallet as the primary wallet when one
  exists.
- Formless provisioned ERC4337 smart wallets: provisioning, primary
  wallet resolution, and preparing, verifying, signing and submitting
  user operations.
- Syncing the resolved wallet as the unique ID's primary wallet, and
  lazily approving smart wallet codehashes.
- `FormlessRPCClient`: the Formless RPCs used by wallets.

The wallet as a service vendor is an implementation detail behind
`WalletImplementation` (`src/lib/IWalletSession.ts`). Products never
import the vendor's SDK. The default implementation is
`src/sessions/privy`.

## Usage

Add this repository as a submodule under the app's `src`:

```bash
git submodule add https://github.com/formless-eng/formless-wallet-core.git frontend/src/formless-wallet-core
```

The code is compiled from source by the app, so `react`, `react-dom`,
`viem` and `@privy-io/react-auth` come from the app's `node_modules`.
Do not run `npm install` inside the submodule checkout of an app, a
second copy of React breaks hooks.

Wrap the app in `FormlessWalletProvider`, injecting the app's RPC
transport, logger and analytics:

```tsx
import { FormlessWalletProvider } from "formless-wallet-core/src";

<FormlessWalletProvider
  rpcRequest={(method, params, numAttempts) =>
    jsonRpcClientWithUnidentifiedJwt.request(method, params, numAttempts)
  }
  config={{ appID: WALLET_APP_ID, appearance: { logo: WALLET_APP_LOGO } }}
  mock={testMockWallet ? { uniqueID, jwt } : undefined}
  onEvent={(event) => {
    if (event.type === "unique_id_created") {
      mixpanel.track("Create FORMLESS ID", { ... });
    }
  }}
  log={log}
>
  <App />
</FormlessWalletProvider>
```

Products without their own transport can use
`makeFormlessRPCRequest({ endpoint })`.

Each app re-exports the hook from `hooks/useWallet.ts`, so that call
sites and test mocks of `hooks/useWallet` are unchanged:

```ts
export { useWallet } from "formless-wallet-core/src";
export type { IWallet } from "formless-wallet-core/src";
```

## Wallet implementations

A wallet implementation provides a `Provider` component and a
`useSession` hook returning a `WalletSession`: the user, a managed
smart wallet (if any), the embedded signer, login, logout, identity
tokens, signer delegation, raw hash signing and funding. Pass a
different implementation as `FormlessWalletProvider`'s
`implementation` to change vendors, without changing products.

## Development

```bash
npm install
npm test
npm run typecheck
```
