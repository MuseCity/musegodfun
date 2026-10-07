# Launch guard deployment

The guard was deployed on Robinhood Chain mainnet (4663) on 2026-10-05 after user authorization. Its entire runtime and immutable dependencies match the reviewed artifact, and Sourcify verified both creation and runtime as `exact_match`. Mainnet token launches, first buys and trades were not performed as part of this deployment.

- Guard: [`0xfD919E60eB32AE9d02A89D6D9bAB94E2634cDE29`](https://robinhoodchain.blockscout.com/address/0xfD919E60eB32AE9d02A89D6D9bAB94E2634cDE29).
- Deployment: [`0xf0f4556f507bdf7d322267d2398a5661b804320f14ec09fff5d1d8697f09890f`](https://robinhoodchain.blockscout.com/tx/0xf0f4556f507bdf7d322267d2398a5661b804320f14ec09fff5d1d8697f09890f), block `80859015`.
- Gas used: `888931`; actual gas cost: `0.000018139525986 ETH`.
- [Deployment and source verification evidence](evidence/launch-guard-mainnet.json). [Sourcify verification](https://sourcify.dev/server/v2/contract/4663/0xfD919E60eB32AE9d02A89D6D9bAB94E2634cDE29). The Blockscout verification mirror was blocked by its Cloudflare challenge and is not confirmed.
- `wrangler.jsonc` configures this verified address. The [production deployment record](https://github.com/MuseCity/musegodfun/deployments) identifies the active website release; CI requires both domains to expose the same verified guard before reporting success.

## V2 source preparation — not deployed

The current source adds optional 30/90/365-day first-buy locks and complete Base/Robinhood Create. The current `MusegodLaunchGuard.json` and compiler input describe the new vesting-capable candidate, not the historical address above. The previously deployed bytecode and verification closure are retained separately as `MusegodLaunchGuardLegacy.json` and `MusegodLaunchGuardLegacy.compiler-input.json`.

The candidate was deployed only on isolated local 31337 forks of both chains. Local issuance, lock-position/receipt checks, cliff expiry and recipient claims passed using synthetic local funding; the upstream proxies recorded zero writes. Ignored outputs are `.cache/first-buy-lock-fork-8453.json` and `.cache/first-buy-lock-fork-4663.json`. These are local acceptance files, not tracked audit or release records. V2 mainnet deployments and new guard activation remain `not_run`; code/Secret publication is separate and does not enable locked first buys. The latest [tracked LI.FI acceptance](evidence/lifi-opening-price/index.json) contains new-policy fork copies; these retain their local/synthetic-funding boundary. The old Robinhood address and its dated deployment evidence remain unchanged.

## Pinned historical deployment input

- Contract: `MusegodLaunchGuard`, Solidity 0.8.24, Cancun, optimizer 200 runs, no proxy.
- OpenZeppelin Contracts: 5.7.0, vendored source closure and tarball hash in `contracts/lib/openzeppelin-contracts/dependency-lock.json`.
- Constructor Bundler: `0xf45588E8e0B1df9dB9ae7E20eCE5726AE931357c`.
- Expected Bundler runtime hash: `0x8d7c135bd087b74d2f2d1362593f23b824d5752bebe6a3c8bc6db0a6fa75e066`.
- Expected Airlock: `0xeb7c034704ef8dcd2d32324c1545f62fb4ad0862`.
- Expected PoolManager: `0x8366a39cc670b4001a1121b8f6a443a643e40951`.
- Historical ABI, creation/runtime bytecode and immutable references: `contracts/artifacts/MusegodLaunchGuardLegacy.json`.
- Historical standard JSON verification input: `contracts/artifacts/MusegodLaunchGuardLegacy.compiler-input.json`.

The ABI mirrors the official [Doppler Bundler source](https://github.com/whetstoneresearch/doppler/blob/main/src/Bundler.sol) and pinned Doppler SDK 1.0.43. The dependency is the official [OpenZeppelin 5.7.0 release](https://github.com/OpenZeppelin/openzeppelin-contracts/releases/tag/v5.7.0).

## Candidate dependencies

The V2 artifact remains `contracts/artifacts/MusegodLaunchGuard.json`, with full standard JSON in `MusegodLaunchGuard.compiler-input.json`. Its constructor binds the official Bundler address `0xf45588E8e0B1df9dB9ae7E20eCE5726AE931357c`; the code and bindings must be verified separately on each deployment:

| Deployment | Bundler runtime hash | Airlock | PoolManager |
| --- | --- | --- | --- |
| Base 8453 | `0xead06e5d9d0349000bfc7408621d9ef28857743925dc3aa2351993f2d29a4beb` | `0x660eaaedebc968f8f3694354fa8ec0b4c5ba8d12` | `0x498581ff718922c3f8e6a244956af099b2652b2b` |
| Robinhood 4663 | `0x8d7c135bd087b74d2f2d1362593f23b824d5752bebe6a3c8bc6db0a6fa75e066` | `0xeb7c034704ef8dcd2d32324c1545f62fb4ad0862` | `0x8366a39cc670b4001a1121b8f6a443a643e40951` |

## Review and validation

1. Run `forge test -vv` from `contracts`, then `node contracts/export-artifact.mjs` from the root. Compare the exported input hash and bytecode with the reviewed source.
2. Run `npx tsx scripts/deploy-launch-guard.ts --chain 4663 --output .cache/guard-dependencies-4663.json` and the corresponding `--chain 8453` command for block-pinned, read-only dependency verification. This path performs no signing.
3. Run the application's isolated fork tests. To deploy only on an existing local fork, run `npx tsx scripts/deploy-launch-guard.ts --chain 4663 --rpc http://127.0.0.1:8547 --deploy-local --output .cache/guard-local-deployment.json`. The script rejects non-loopback URLs and every chain except 31337 before its deployment call, requires Anvil node identity, and uses only the local node's unlocked account. It has no private-key or production broadcast mode.
4. Inspect independent review and fork receipts. Confirm exact ERC20 sender/guard deltas, minimum output, deadline equality, recipient, zero residual allowance and preserved guard donations. Check unlocked buys separately from 30/90/365-day cliff locks: exactly matching VestingCreated event/position, no claim before unlock and recipient-only claim with the expected token transfer.
5. Any replacement production deployment requires its own authorization. Submit the reviewed creation bytecode with this one constructor argument, preserve the deployment transaction and compiler input, and verify the source before enabling first buys. A new address alone is insufficient. The completed deployment used a one-time local signer; no private key is part of the repository or Worker configuration.
6. Compare the entire deployed runtime with the exported template after substituting the official Bundler address at every immutable reference; read `bundler()` and verify its runtime, `airlock()` and `poolManager()` again at one block. Record chain, block hash, address, runtime hash and constructor argument. Only then configure the corresponding `BASE_FIRST_BUY_GUARD_ADDRESS` or `ROBINHOOD_FIRST_BUY_GUARD_ADDRESS`. `/api/chains/:chainId/config` exposes a verified selected guard and `launchLockAvailable` capability. Base writing is separately opt-in; a new address does not enable it. The legacy `LAUNCH_GUARD_ADDRESS` remains a Robinhood-only fallback.

## Behavior and limits

The guard trusts the pinned Bundler's returned amount and recipient delivery. It enforces the minimum returned net output after the atomic bundle, deadline, exact ERC20 input and zero residual allowance, and forces recipient to its caller. A failed minimum or residual balance check reverts creation and ERC20 transfer together. Previously mined user approval remains because it is a separate transaction. The guard itself remains nonpayable; native ETH or stablecoin payment is converted in a preceding separately signed, same-chain LI.FI transaction. An unsuccessful launch does not roll that conversion back.

The guard does not enforce Musegod's curve version, module allowlist, creator split or metadata; the application validates the frozen CreateParams. The fixed official Bundler remains an external immutable dependency. There is no withdrawal method, so unrelated accidental ERC20 donations cannot be recovered. Do not claim that this application wrapper makes the entire pool or future added liquidity immutable.

The historical deployed guard uses unlocked first buys only. V2 preserves that entry point and adds `createAndBuyLocked`; allowed locks are 0/30/90/365 days with official Bundler `permissionlessClaim=false`, recipient equal to caller and cliff equal to the full vesting duration. All purchased tokens unlock together. The application records the verified position and exposes recipient-only claims; pending/cancelled/replaced claim hashes require canonical account/nonce proof before another attempt.

## Stop signing and rollback

The verified pre-enablement rollback baseline is commit `9966794190bdef2947924ee99cedd3e6d0a8805f`, Worker `ec948bde-ca0d-418a-949e-1b78a6c32ce3`; it supports guarded receipt recovery while leaving new first buys disabled. For the current legacy Robinhood deployment, `ENABLE_MAINNET_TRANSACTIONS=false` disables new signing while preserving receipt recovery. In the dual-chain source, also clear any explicit Robinhood override and set `ENABLE_BASE_TRANSACTIONS=false`. Remove the corresponding new/legacy guard candidates to disable fresh first-buy previews; retain recovery for already broadcast calls. Stop signing if guard runtime or dependency identity differs, quotes expire, or receipt verification fails. Retain already-broadcast transaction hashes and frozen plans; do not generate a replacement salt while the outcome is unknown.

Do not revert the backend to an Airlock-only release after any guarded transaction has been broadcast. A stopped-signing build must continue to understand the guard's outer transaction, official `Bundled` / `VestingCreated` events, `GuardedLaunch` event, stored lock positions and old direct-Airlock recovery. After a V2 transaction exists, a stopped-signing build must still understand its chain-scoped APIs and locked receipt; the historical pre-enablement version is not a recovery-capable rollback for that new format. Application rollback cannot change deployed pools, existing metadata or this guard's immutable dependency.

## Reproduce local acceptance

Run `npm test`, `npm run build` and `npm run test:launch-guard`. Run `npm run test:launch-curve-fork` using the configured read-only upstream; its proxy permits reads only and all deployment and transactions target local chain 31337. With `LAUNCH_FORK_KEEP_RUNNING=true`, the fork script writes a non-secret `.cache/launch-browser-context.json` and waits for its finish signal. While it waits, run `npm run test:launch-fork-browser`, then write `done` to the context's `finishSignal` so the fork is restored and stopped.

The browser scripts use Playwright from the workspace runtime. If it is not importable as `playwright`, set `PLAYWRIGHT_MODULE` to the absolute path of that runtime's `playwright/index.mjs`. `npm run test:launch-browser` covers explicitly injected wallet/API/RPC failure fixtures against a local dev server (`BROWSER_ORIGIN`, default port 5191); it is UI evidence. `npm run test:launch-fork-browser` starts an isolated local service on an available loopback port, exercises the actual API and official fork contracts, and signs through a local unlocked Anvil test account. These layers are recorded separately and do not establish mainnet or real user-wallet acceptance.

Run `npm run test:first-buy-payment-fork` separately for actual local LI.FI conversion/min-output acceptance on Base and Robinhood. Quotes and upstream RPC remain read-only; every funded swap targets an isolated localhost Anvil fork. The output `.cache/first-buy-payment-fork-evidence.json` is ignored local evidence. Payment conversion source/route proof is distinct from launch/lock receipts and from mainnet execution.
