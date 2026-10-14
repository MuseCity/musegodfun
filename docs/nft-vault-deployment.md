# NFT vault factory deployment (Robinhood 4663)

Status: not deployed. `contracts/artifacts/nft-vault-deployment.json` keeps `"4663"` as `not_deployed` until step 4. Base (8453) is out of scope.

`scripts/deploy-nft-vault.ts` prepares and verifies the single plain CREATE of `MusegodNftFeeVaultFactory`. It has no production broadcast mode and takes no private key or signer flag; the owner signs and sends with their own tool. The read-only modes use `--rpc <url>`, or Alchemy built from `ALCHEMY_API_KEY` in `.env.fork` (never `.env`). No output contains the key or any RPC URL; every file is written through a serializer that refuses both.

| Item | Value |
| --- | --- |
| Contract | `MusegodNftFeeVaultFactory`, Solidity `0.8.24+commit.e11b9ed9`, Cancun, optimizer 200 runs. No constructor arguments, owner, proxy or upgrade. |
| Creation code | `factoryBytecode` in `contracts/artifacts/nft-vault-build.json` (10,144 bytes) |
| Expected runtime | 5,727 bytes, hash `0x887bf689866d510c4d312b318320dd38088371c10372861ae429b668daf54abe`: the compiler template `0x0593f2fb…e02a` with both `VAULT_INIT_CODE_HASH` slots (offsets 190 and 1115) set to `vaultInitCodeHash` `0x9bca6b10…6fa7` |
| Standard JSON input | `contracts/artifacts/MusegodNftFeeVaultFactory.compiler-input.json`; its SHA-256 is `factoryCompilerInputSha256` in the build file |
| Dependencies with code | ERC-6551 registry, Tokenbound V3 proxy and implementation, Rehype, the Robinhood initializer, Muses |

`npm run build:nft-vault` regenerates the build file and the compiler input; CI rebuilds both and fails on any difference.

## 0. Rehearse (local only)

`npm run rehearse:nft-vault-deploy` starts one loopback Anvil fork that keeps chain id 4663. Only reads reach Alchemy, through a proxy that refuses everything else. The rehearsal then:

1. runs the preflight for a fresh random deployer address that only the fork funds and unlocks (Anvil's default accounts carry code on Robinhood);
2. deploys with the owner's exact `cast send` command, using `--unlocked` in place of the owner's signer flags;
3. mines one more block;
4. runs the full verify.

Outputs stay in `.cache/nft-vault-rehearsal-4663/`, including the manifest the verify would write. The committed manifest and evidence are never written from a local node. `--deploy-local --rpc http://127.0.0.1:<port>` does the same against an existing loopback Anvil fork. It refuses any other URL.

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

The preflight writes `.cache/nft-vault-preflight-4663.json`, containing the unsigned transaction, the predicted factory address and the expected runtime hash. It also writes `.cache/nft-vault-factory-4663.create.hex`, the creation calldata. If any check fails, it exits 1 and omits the transaction.

## 2. The owner signs and sends

The report's `ownerCommand` has this form:

```sh
cast send --rpc-url <their RPC> --chain 4663 --from <deployer> --nonce <n> --gas-limit <g> \
  --priority-gas-price <p> --gas-price <maxFee> <their signer flags> \
  --create "$(cat .cache/nft-vault-factory-4663.create.hex)"
```

- The owner picks the signer: `--keystore`/`--account`, `--ledger`, or a wallet with the same fields.
- In cast 1.x, `--create` is a subcommand. Every option must come before it, or cast rejects the command.
- The nonce must be exactly `n`, because the factory address is derived from it. Send nothing else from the deployer between the preflight and this transaction.
- Send it once. A stuck transaction may only be replaced with the same nonce, the same data and zero value.

## 3. Verify

```sh
npm run verify:nft-vault -- --tx <transaction hash>
```

This step is read-only. By default it reads the deployer and nonce from the preflight report. `--deployer <a> --nonce <n>` overrides both. Every check must pass:

- the receipt has status success;
- the receipt is canonical: its block hash equals the chain's block at that height, re-checked after all other reads;
- the transaction has at least 2 confirmations;
- the sender and nonce match the preflight report;
- the transaction is a contract creation with zero value, and its input equals the committed creation code exactly;
- `contractAddress` equals the predicted address;
- `keccak256(code)` equals the expected runtime hash;
- `VAULT_INIT_CODE_HASH()` equals the manifest's `vaultInitCodeHash`;
- `vaultFor(4663, Muses, 1)` and `treasuryFor(4663, Muses, 1)` equal `src/lib/nft-mode.ts`;
- the registry and Tokenbound proxy constants are correct.

When every check passes, it writes two files:

- `contracts/artifacts/nft-vault-deployment.json`, changing `"4663"` only to `{ status: "deployed_verified", factory, factoryRuntimeHash, transactionHash, blockNumber }`. `vaultInitCodeHash` and `"8453"` are never changed.
- `docs/evidence/nft-vault-factory-4663.json`, holding addresses, hashes, the block, gas used, the cost and every check.

It refuses an already recorded, different factory. Rerunning it for the same deployment changes nothing.

## 4. Commit the manifest

Commit the manifest and the evidence together. `npm test` requires a verified 4663 entry to match its evidence. Recording the factory does not enable NFT mode: `NFT_MODE_ENABLED` stays `false` until Task 13 Step 4. Even then, the runtime exposes the factory only while its on-chain runtime hash equals `factoryRuntimeHash`. Pushing to `master` publishes a release (Task 13 Step 3).

## 5. Sourcify

This step runs after the deployment, with the owner's approval. `npx tsx scripts/deploy-nft-vault.ts --sourcify-input` re-derives the standard JSON input. It refuses a stale build. It prints the file, its SHA-256, the compiler version and the contract identifier `src/MusegodNftFeeVaultFactory.sol:MusegodNftFeeVaultFactory`.

Submit these to Sourcify for chain 4663, together with the factory address and its creation transaction. Expect an exact creation and runtime match. This tool never submits anything.

## Stop conditions

- A failed preflight, a pending transaction or a changed nonce: do not send; rerun the preflight.
- A reverted or replaced transaction: record nothing. The nonce has moved, so a new preflight gives a new address.
- A failed verify: do not commit the manifest. The factory has no owner and cannot be changed; an unrecorded factory is never used.
