# Launch guard deployment

The guard was deployed on Robinhood Chain mainnet (4663) on 2026-10-05 after user authorization. Its entire runtime and immutable dependencies match the reviewed artifact, and Sourcify verified both creation and runtime as `exact_match`. Mainnet token launches, first buys and trades were not performed as part of this deployment.

- Guard: [`0xfD919E60eB32AE9d02A89D6D9bAB94E2634cDE29`](https://robinhoodchain.blockscout.com/address/0xfD919E60eB32AE9d02A89D6D9bAB94E2634cDE29).
- Deployment: [`0xf0f4556f507bdf7d322267d2398a5661b804320f14ec09fff5d1d8697f09890f`](https://robinhoodchain.blockscout.com/tx/0xf0f4556f507bdf7d322267d2398a5661b804320f14ec09fff5d1d8697f09890f), block `80859015`.
- Gas used: `888931`; actual gas cost: `0.000018139525986 ETH`.
- [Deployment and source verification evidence](evidence/launch-guard-mainnet.json). [Sourcify verification](https://sourcify.dev/server/v2/contract/4663/0xfD919E60eB32AE9d02A89D6D9bAB94E2634cDE29). The Blockscout verification mirror was blocked by its Cloudflare challenge and is not confirmed.
- `wrangler.jsonc` configures this verified address. The [production deployment record](https://github.com/MuseCity/musegodfun/deployments) identifies the active website release; CI requires both domains to expose the same verified guard before reporting success.

## Pinned deployment input

- Contract: `MusegodLaunchGuard`, Solidity 0.8.24, Cancun, optimizer 200 runs, no proxy.
- OpenZeppelin Contracts: 5.7.0, vendored source closure and tarball hash in `contracts/lib/openzeppelin-contracts/dependency-lock.json`.
- Constructor Bundler: `0xf45588E8e0B1df9dB9ae7E20eCE5726AE931357c`.
- Expected Bundler runtime hash: `0x8d7c135bd087b74d2f2d1362593f23b824d5752bebe6a3c8bc6db0a6fa75e066`.
- Expected Airlock: `0xeb7c034704ef8dcd2d32324c1545f62fb4ad0862`.
- Expected PoolManager: `0x8366a39cc670b4001a1121b8f6a443a643e40951`.
- ABI, creation/runtime bytecode and immutable references: `contracts/artifacts/MusegodLaunchGuard.json`.
- Full standard JSON verification input: `contracts/artifacts/MusegodLaunchGuard.compiler-input.json`.

The ABI mirrors the official [Doppler Bundler source](https://github.com/whetstoneresearch/doppler/blob/main/src/Bundler.sol) and pinned Doppler SDK 1.0.43. The dependency is the official [OpenZeppelin 5.7.0 release](https://github.com/OpenZeppelin/openzeppelin-contracts/releases/tag/v5.7.0).

## Review and validation

1. Run `forge test -vv` from `contracts`, then `node contracts/export-artifact.mjs` from the root. Compare the exported input hash and bytecode with the reviewed source.
2. Run `npx tsx scripts/deploy-launch-guard.ts --output contracts/artifacts/dependency-verification.json` for block-pinned, read-only Robinhood verification. This path performs no signing.
3. Run the application's isolated fork tests. To deploy only on an existing local fork, run `npx tsx scripts/deploy-launch-guard.ts --rpc http://127.0.0.1:8547 --deploy-local --output contracts/artifacts/local-deployment.json`. The script rejects non-loopback URLs and every chain except 31337 before its deployment call, requires Anvil node identity, and uses only the local node's unlocked account. It has no private-key or production broadcast mode.
4. Inspect independent review and fork receipts. Confirm exact ERC20 sender/guard deltas, minimum output, deadline equality, recipient, no vesting, residual allowance zero and preserved guard donations.
5. Any replacement production deployment requires its own authorization. Submit the reviewed creation bytecode with this one constructor argument, preserve the deployment transaction and compiler input, and verify the source before enabling first buys. A new address alone is insufficient. The completed deployment used a one-time local signer; no private key is part of the repository or Worker configuration.
6. Compare the entire deployed runtime with the exported template after substituting the official Bundler address at every immutable reference; read `bundler()` and verify its runtime, `airlock()` and `poolManager()` again at one block. Record chain, block hash, address, runtime hash and constructor argument. Only then set `LAUNCH_GUARD_ADDRESS` and enable the guarded path. `/api/config` exposes this address only after a fresh verification succeeds.

## Behavior and limits

The guard trusts the pinned Bundler's returned amount and recipient delivery. It enforces the minimum returned net output after the atomic bundle, deadline, exact ERC20 input and zero residual allowance, and forces recipient to its caller. A failed minimum or residual balance check reverts creation and ERC20 transfer together. Previously mined user approval remains because it is a separate transaction. No native payment is accepted.

The guard does not enforce Musegod's curve version, module allowlist, creator split or metadata; the application validates the frozen CreateParams. The fixed official Bundler remains an external immutable dependency. There is no withdrawal method, so unrelated accidental ERC20 donations cannot be recovered. Do not claim that this application wrapper makes the entire pool or future added liquidity immutable.

## Stop signing and rollback

The verified pre-enablement rollback baseline is commit `9966794190bdef2947924ee99cedd3e6d0a8805f`, Worker `ec948bde-ca0d-418a-949e-1b78a6c32ce3`; it supports guarded receipt recovery while leaving new first buys disabled. Set `ENABLE_MAINNET_TRANSACTIONS=false` to disable all new mainnet signing while preserving guarded transaction registration and pending recovery; removing `LAUNCH_GUARD_ADDRESS` disables new first-buy previews. Stop signing if guard runtime or dependency identity differs, quotes expire, or receipt verification fails. Retain already-broadcast transaction hashes and frozen plans; do not generate a replacement salt while the outcome is unknown.

Do not revert the backend to an Airlock-only release after any guarded transaction has been broadcast. A stopped-signing build must continue to understand the guard's outer transaction, official `Bundled` event, `GuardedLaunch` event and old direct-Airlock recovery. Application rollback cannot change deployed pools, existing metadata or this guard's immutable dependency.

## Reproduce local acceptance

Run `npm test`, `npm run build` and `npm run test:launch-guard`. Run `npm run test:launch-curve-fork` using the configured read-only upstream; its proxy permits reads only and all deployment and transactions target local chain 31337. With `LAUNCH_FORK_KEEP_RUNNING=true`, the fork script writes a non-secret `.cache/launch-browser-context.json` and waits for its finish signal. While it waits, run `npm run test:launch-fork-browser`, then write `done` to the context's `finishSignal` so the fork is restored and stopped.

The browser scripts use Playwright from the workspace runtime. If it is not importable as `playwright`, set `PLAYWRIGHT_MODULE` to the absolute path of that runtime's `playwright/index.mjs`. `npm run test:launch-browser` covers explicitly injected wallet/API/RPC failure fixtures against a local dev server (`BROWSER_ORIGIN`, default port 5191); it is UI evidence. `npm run test:launch-fork-browser` starts an isolated local service on an available loopback port, exercises the actual API and official fork contracts, and signs through a local unlocked Anvil test account. These layers are recorded separately and do not establish mainnet or real user-wallet acceptance.
