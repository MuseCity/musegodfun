# NFT vault factory deployment (Robinhood 4663)

Status: **deployed and verified on Robinhood (4663) on 2026-10-14**, after the owner's explicit authorization. `contracts/artifacts/nft-vault-deployment.json` records `"4663"` as `deployed_verified`. `NFT_MODE_ENABLED` stays off until the owner enables it (Task 13 Step 4). Base (8453) is out of scope.

| Deployment | Value |
| --- | --- |
| Factory | [`0x2Fdf5E0096ba18a76d258bDfBC66E1ba2Bcf5EE4`](https://robinhoodchain.blockscout.com/address/0x2Fdf5E0096ba18a76d258bDfBC66E1ba2Bcf5EE4), the preflight-predicted address |
| Transaction | [`0x3711cd781a93a1f47d488f18fe7e8ac9cc66ba546063cd41a735fce68da0f8a6`](https://robinhoodchain.blockscout.com/tx/0x3711cd781a93a1f47d488f18fe7e8ac9cc66ba546063cd41a735fce68da0f8a6), block `88404863`, from `0xd5C256e6411a6835543F2bCd763341639e3Cf56f` at nonce 388 |
| Cost | 1,347,843 gas at 0.020262 gwei = 0.000027309994866 ETH |
| Verification | `--verify` passed all 17 checks once the block was finalized. Evidence: [`docs/evidence/nft-vault-factory-4663.json`](evidence/nft-vault-factory-4663.json) |
| Source | [Sourcify exact match](https://sourcify.dev/server/v2/contract/4663/0x2Fdf5E0096ba18a76d258bDfBC66E1ba2Bcf5EE4) for both the creation and the runtime code |

The sections below are the runbook that was followed. Keep them for future redeployments, such as Base.

`scripts/deploy-nft-vault.ts` prepares and verifies the single plain CREATE of `MusegodNftFeeVaultFactory`. It has no production broadcast mode and takes no private key or signer flag; the owner signs and sends with their own tool. The read-only modes use Alchemy built from `ALCHEMY_API_KEY` in `.env.fork` (never `.env`), or `--rpc <url>` when it is a proven mainnet endpoint or a local fork (see "Which RPC may be used"). No output contains the key or any RPC URL; every file is written through a serializer that refuses both.

| Item | Value |
| --- | --- |
| Contract | `MusegodNftFeeVaultFactory`, Solidity `0.8.24+commit.e11b9ed9`, Cancun, optimizer 200 runs. No constructor arguments, owner, proxy or upgrade. |
| Creation code | `factoryBytecode` in `contracts/artifacts/nft-vault-build.json` (10,144 bytes) |
| Expected runtime | 5,727 bytes, hash `0x887bf689866d510c4d312b318320dd38088371c10372861ae429b668daf54abe`: the compiler template `0x0593f2fb…e02a` with both `VAULT_INIT_CODE_HASH` slots (offsets 190 and 1115) set to `vaultInitCodeHash` `0x9bca6b10…6fa7` |
| Standard JSON input | `contracts/artifacts/MusegodNftFeeVaultFactory.compiler-input.json`; its SHA-256 is `factoryCompilerInputSha256` in the build file |
| Dependencies with code | ERC-6551 registry, Tokenbound V3 proxy and implementation, Rehype, the Robinhood initializer, Muses |

`npm run build:nft-vault` regenerates the build file and the compiler input; CI rebuilds both and fails on any difference.

Run every command below **from the repository root**. The tool's Forge rebuild runs in `contracts/` with `--root .` and refuses if `contracts/.env` exists. Each rehearsal cast child runs with a scrubbed environment in a fresh directory created by `fs.mkdtemp` under `os.tmpdir()`, outside every Git repository, with no `.env` or `foundry.toml`; the directory is removed after success or failure. The fork's Anvil child uses the same temporary-directory isolation until it stops. A Git ancestor is refused, so Foundry cannot fall back to the repository root and load its `.env`. Rehearsal outputs still stay in `.cache/nft-vault-rehearsal-4663/`.

## 0. Rehearse (local only)

`npm run rehearse:nft-vault-deploy` starts one loopback Anvil fork that keeps chain id 4663. Only reads reach Alchemy, through a proxy that refuses everything else. The rehearsal then:

1. runs the preflight for a fresh random deployer address that only the fork funds and unlocks (Anvil's default accounts carry code on Robinhood);
2. deploys with the owner's exact `cast send` command, using `--unlocked` in place of the owner's signer flags;
3. mines one more block;
4. runs the full verify.

Outputs stay in `.cache/nft-vault-rehearsal-4663/`, including the manifest the verify would write. The committed manifest and evidence are never written from a local node. `--deploy-local --rpc http://127.0.0.1:<port>` does the same against an existing loopback Anvil fork. It refuses any other URL.

The 2026-10-14 rehearsal passed at fork block 88,353,226:

- [summary](evidence/nft-vault-factory-rehearsal-4663.json) and [verify evidence](evidence/nft-vault-factory-rehearsal-4663-verify.json);
- `toolSha256` identifies the historical rehearsal script;
- all 15 verify checks passed;
- the fork factory runtime hash is `0x887b…4abe`;
- gas used was 1,347,843;
- zero upstream writes.

These are fork-local results, not a mainnet deployment. That rehearsal ran the tool at `02ba4df`. The later codex review 1 fixes and F1–F5 fixes below are covered by offline tests only; the revised tool has not been rehearsed again.

## Before the preflight: the deployer's nonce

The factory address is derived from the deployer and its nonce, so nothing else may send from the deployer between the preflight and the CREATE.

`0xd5C256e6411a6835543F2bCd763341639e3Cf56f` is the documented deployment wallet (`roles.deploymentWallet` in `docs/evidence/base-owner-proposal.json`). It is also the Base Collector, buyback and launch-guard deployer, and the canary budget wallet. It is not a repo keeper:

- `scripts/buyback-keeper.ts` and `scripts/base-buyback-keeper.ts` sign only with their own `MUSEGOD_KEEPER_PRIVATE_KEY`;
- the gas keeper is `0xd3f11a4DDcED57aC4E41F8CE7fD323959667e278`;
- its Splits module entries are `enabled: false`.

**Controller finding, 2026-10-14: the sender is identified as the owner's own MV2C canary trade/approve/claim loop, currently inactive as of that check.** The controller's read-only Alchemy check of `0xd5C256e6411a6835543F2bCd763341639e3Cf56f` found that its latest 100 outgoing transfers were all on **2026-10-08, 10:09–11:13 UTC**, to the Universal Router `0x8876789976decbfcbbbe364623c63652db8c0904`, Permit2, the MV2C quote stock `0x4ea005168d7f09a7a0ba9d1def21a479950e44c2`, Rehype `0x5f9eb5f6726fe88d5e39867967f5b833d2fa3215`, and PoolManager transfers of MV2C/COST. There was no activity since that interval. Nonces **7–10** are the documented buyback V2 deployment; on **2026-10-14**, **latest = pending = 388**. Its nonce was 6 at the launch-guard V2 deployment (2026-10-07). This records the controller's dated finding; the offline tooling repair did not repeat the Alchemy check. It does not replace a fresh preflight immediately before signing.

Keep this read-only investigation method for future runs, especially if the nonce changes or activity resumes:

1. Open the [Blockscout address page](https://robinhoodchain.blockscout.com/address/0xd5C256e6411a6835543F2bCd763341639e3Cf56f), select Transactions and sort outgoing transactions by nonce. Alternatively, read `/api/v2/addresses/0xd5C256e6411a6835543F2bCd763341639e3Cf56f/transactions` on that explorer, follow pagination through the interval, filter `from` to this address and sort the collected transactions numerically by nonce. Incoming transactions do not explain its nonce.
2. Subtract the documented nonces 7–10: the 2026-10-08 buyback V2 assetOracle, vault, forwarder and engine CREATEs in [buyback-v2-deployment.json](../contracts/artifacts/buyback-v2-deployment.json). Match the documented canary-budget sends in [SPEC.md](SPEC.md) and its [native execution evidence](evidence/buyback-v2-native-execution.json) by transaction hash. Also exclude the keeper-fuel transfer `0x301842eebf6bc2e5beb6be15c09e34e8782d497364978e211eaa867e9b43a7cd` at block 83,270,275 in [buyback-v2-review.json](evidence/buyback-v2-review.json).
3. When reviewing the historical interval (nonces 11–387) or any newer outgoing nonces, read `to`, method/input, value, token transfers and timestamps, and compare them with the identified owner canary loop above. Investigate any newly unexplained activity. Repeated calls to one contract/method at regular intervals suggest a bot or script; identify its process and operator before pausing it. Unknown destinations, unauthorized sends or unexplained funds leaving are possible key-compromise signals. A pattern alone does not establish either automation or compromise.

**If a future run finds a sender that cannot be identified, use a fresh dedicated deployment account.** The current sender is identified and inactive as of the controller's 2026-10-14 check. A fresh account must have no code and be funded with at least the preflight's `balance.requiredWei`. Run the preflight with `--deployer <that account>`; the predicted address changes, and verify follows the new report. Pause an existing sender only after identifying it, and keep it paused until this CREATE is finalized and verified.

Run the preflight **immediately before signing**, and send nothing else from the account between that preflight and the CREATE. Right before sending, `cast nonce --block pending --rpc-url <their RPC> <deployer>` must still print the report's `nonce`. If it does not, do not send; rerun the preflight.

## 1. Preflight

```sh
npm run preflight:nft-vault -- --deployer <deployment account>
```

This step is read-only. It refuses outright if any of these hold:

- the chain is not 4663;
- the 4663 manifest entry is not `not_deployed`;
- a fresh offline `forge build` does not reproduce the committed build file and compiler input.

It then checks the following and reports any failure:

- the deployer's `latest` nonce equals its `pending` nonce;
- the predicted address `CREATE(deployer, nonce)` has no code and no nonce;
- every dependency has code;
- `eth_estimateGas` succeeds for the creation;
- the balance covers gas limit × `maxFeePerGas`.

The gas limit is the estimate plus 20%. `maxFeePerGas` is 2 × (latest base fee + suggested priority fee).

The ready preflight writes `.cache/nft-vault-preflight-4663.json`, containing the unsigned transaction, the predicted factory address and the expected runtime hash. It also writes `.cache/nft-vault-factory-4663.create.hex`, the creation calldata. Failures exit 1 and go to `.cache/nft-vault-preflight-4663.failed.json`; they never overwrite the ready report or calldata. If the previous ready report's predicted factory already has the expected runtime, preflight refuses: `the factory is already deployed at X; run verify with --tx`.

## 2. The owner signs and sends

The report's `ownerCommand` has this form:

```sh
CODE="$(cat '/absolute/repository/path/.cache/nft-vault-factory-4663.create.hex')" && \
  [ "$(cast keccak "$CODE")" = <report data.keccak256> ] && \
  cast send --rpc-url <their RPC> --chain 4663 --from <deployer> --nonce <n> --value 0 --gas-limit <g> \
  --priority-gas-price <p> --gas-price <maxFee> <their signer flags> \
  --create "$CODE"
```

- The owner picks the signer: `--keystore`/`--account`, `--ledger`, or a wallet with the same fields.
- In cast 1.x, `--create` is a subcommand. Every option must come before it, or cast rejects the command.
- Keep the absolute path and the keccak guard exactly as printed; a missing or modified file stops before sending. The owner's own cast, run from the repository root, reads that root's `.env`. Every important transaction value is explicit: RPC, chain, sender, nonce, zero value, gas limit, both fee caps, signer selection and guarded creation code. Review the chosen signer flags before executing it.
- The nonce must be exactly `n`, because the factory address is derived from it. Send nothing else from the deployer between the preflight and this transaction (see "Before the preflight" above).
- Send it once. A stuck transaction may only be sped up: the same nonce, the same data and zero value, with only the fees raised. Keep every hash you submit; see "Speed-ups, cancels and reverts" below.
- **Do not rerun preflight after sending.** Verify with the saved report. If you did rerun it, pass `--deployer <original deployer> --nonce <original n>` to verify; for the historical 2026-10-14 report that is `--deployer 0xd5C256e6411a6835543F2bCd763341639e3Cf56f --nonce 388`. Use the values from the report you actually signed.

## 3. Verify

Wait until the receipt block is **finalized** (typically about 15–30 minutes), then verify. Elapsed time is only a guide: the tool requires the RPC's `finalized` block number to reach the receipt block. Local nodes retain the two-confirmation rule.

```sh
npm run verify:nft-vault -- --tx <transaction hash>
```

This step is read-only. Pass the hash that was mined; after a speed-up, that is the winning replacement's hash. By default it reads the deployer and nonce from the preflight report. `--deployer <a> --nonce <n>` overrides both. Every check must pass:

- the receipt has status success;
- the receipt is canonical: its block hash equals the chain's block at that height, re-checked after all other reads;
- the transaction has at least 2 confirmations, counted again from a fresh head after all other reads;
- on a proven mainnet node, `getBlock({ blockTag: "finalized" })` has a number at least as high as the receipt block, and the receipt block hash is still canonical after that finality read;
- the sender and nonce match the preflight report;
- the transaction is a contract creation with zero value, and its input equals the committed creation code exactly;
- `contractAddress` equals the predicted address;
- `keccak256(code)` equals the expected runtime hash;
- `VAULT_INIT_CODE_HASH()` equals the manifest's `vaultInitCodeHash`;
- `vaultFor(4663, Muses, 1)` and `treasuryFor(4663, Muses, 1)` equal `src/lib/nft-mode.ts`;
- the registry and Tokenbound proxy constants are correct.

When every check passes, it writes two files:

- `contracts/artifacts/nft-vault-deployment.json`, changing `"4663"` only to `{ status: "deployed_verified", factory, factoryRuntimeHash, transactionHash, blockNumber }`. `vaultInitCodeHash` and `"8453"` are never changed.
- `docs/evidence/nft-vault-factory-4663.json`, holding addresses, hashes, the block, `finalizedBlockNumber` (null for local nodes), gas used, the cost and every check.

It refuses an already recorded, different factory. Rerunning it for the same deployment changes nothing.

## 4. Commit the manifest

Commit the manifest and the evidence together. `npm test` requires a verified 4663 entry to match its evidence. Recording the factory does not enable NFT mode: `NFT_MODE_ENABLED` stays `false` until Task 13 Step 4. Even then, the runtime exposes the factory only while its on-chain runtime hash equals `factoryRuntimeHash`. Pushing to `master` publishes a release (Task 13 Step 3).

## 5. Sourcify

This step runs after the deployment, with the owner's approval. `npx tsx scripts/deploy-nft-vault.ts --sourcify-input` re-derives the standard JSON input. It refuses a stale build. It prints the file, its SHA-256, the compiler version and the contract identifier `src/MusegodNftFeeVaultFactory.sol:MusegodNftFeeVaultFactory`.

Submit these to Sourcify for chain 4663, together with the factory address and its creation transaction. Expect an exact creation and runtime match. This tool never submits anything.

## Which RPC may be used

Preflight and verify never assume mainnet. They run only against one of these:

- **A proven Robinhood mainnet endpoint.** This is the built-in Alchemy RPC (no `--rpc`; the key comes from `.env.fork`) or `--rpc https://rpc.mainnet.chain.robinhood.com`. The URL must be HTTPS with no user or port, and the host must be exactly one of those two names (a trailing dot is refused; case is normalized by the URL parser). The endpoint's block 82,283,004 must have the hash recorded for the launch-guard V2 deployment. Only this kind of endpoint writes the committed manifest and evidence.
- **A local node:** a loopback URL, or a node that reports itself as Anvil, Hardhat or Ganache. It writes only `.cache/nft-vault-rehearsal-4663/` copies.

Any other RPC is refused before anything is read or written, including a node that hides `web3_clientVersion`.

A historical block hash alone cannot prove mainnet: a fork taken later returns the same hash. That is why the endpoint's identity is required.

## Speed-ups, cancels and reverts

Check every hash you submitted with `cast receipt <hash> --rpc-url <their RPC>`. Only the mined attempt has a receipt.

- **A mined speed-up of this CREATE** (same nonce, same calldata, zero value, only the fees changed): the factory is at the predicted address. Verify the winning hash. Verify accepts it because it checks the sender, nonce, calldata, value, address and runtime, never the fees or the original hash.
- **The nonce consumed by anything else**, such as a reverted CREATE (for example out of gas), a cancel (a zero-value transfer to self) or any transaction that is not this exact CREATE: no factory can ever appear at that address, because the nonce is spent. Record nothing. Rerun the preflight, which gives the next nonce and a new predicted address, and only then prepare a new CREATE.

## Stop conditions

- Before sending, a failed preflight, an unrelated pending transaction or a changed nonce: do not send; identify the sender, let the transaction settle and rerun preflight.
- After sending this CREATE, do not rerun preflight. Wait for its receipt and finality, then verify the mined hash with the original deployer/nonce if necessary. Rerun preflight only after proving the nonce was consumed by a revert, cancel or other transaction rather than this exact successful CREATE.
- A failed verify: do not commit the manifest. The factory has no owner and cannot be changed; an unrecorded factory is never used.
- An RPC that is neither proven mainnet nor local: the tool refuses it. Use the built-in Alchemy RPC or the official public RPC.
