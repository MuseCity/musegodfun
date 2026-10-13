import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import {
  createPublicClient, decodeErrorResult, decodeEventLog, encodeAbiParameters, encodeFunctionData, erc20Abi, getAddress,
  http, keccak256, maxUint256, parseEther, toHex, zeroHash, type Abi, type Address, type Hex, type TransactionReceipt,
} from "viem";
import { generatePrivateKey, privateKeyToAddress } from "viem/accounts";
import { robinhood } from "viem/chains";
import { DopplerSDK, type V4PoolKey } from "@whetstone-research/doppler-sdk/evm";
import build from "../contracts/artifacts/nft-vault-build.json";
import { ROBINHOOD_CONTRACTS, WAD, sameAddress } from "../src/lib/config";
import {
  ERC6551_REGISTRY, MUSES, NFT_VAULT_MANIFEST, TOKENBOUND_V3_IMPLEMENTATION, TOKENBOUND_V3_PROXY, treasuryFor, vaultFor,
  type NftRef,
} from "../src/lib/nft-mode";
import { permit2Abi, swapTransaction } from "../src/lib/protocol";
import {
  accountProxyAbi, accountV3Abi, bindSourcifyRuntime, factoryAbi, feeSourceAbi, guardianAbi, guardianExecutorSource,
  guardianFromSourcify, immutableAddress, isRateLimited, musesAbi, patchImmutableRuntime, registryAbi,
  robinhoodUpstreamUrl, runtimeTemplateFromInitCode, safeForkError, solidityFunction, vaultAbi, wethAbi,
} from "./nft-vault-fork-helpers";
import { startChainFork } from "./robinhood-fork";

// Robinhood Chain fork gates for the per-NFT fee vault (plan Task 2 Steps 3-5, brief 2b). Everything runs on an
// isolated loopback Anvil fork that keeps chain id 4663. The upstream proxy forwards reads only; every write comes from
// a fresh random address or a mainnet account impersonated on the fork. No mainnet transaction is sent.

const args = process.argv.slice(2);
assert(args.length === 0 || (args.length === 2 && args[0] === "--chain" && ["robinhood", "4663"].includes(args[1])),
  "Usage: npm run test:nft-vault-fork -- --chain robinhood");
const key = process.env.ALCHEMY_API_KEY ?? "";
const upstreamUrl = robinhoodUpstreamUrl(key);
const redact = (error: unknown) => safeForkError(error, [key]);
if (!process.env.ANVIL_BIN?.trim() && !existsSync(".cache/bin/base-anvil-v1.1.1/anvil"))
  process.env.ANVIL_BIN = execFileSync("which", ["anvil"], { encoding: "utf8" }).trim();

const CHAIN_ID = 4663;
const CLAWGOD = getAddress("0x7ea969d8c90C92c056949D561960Af2ACCd6E113");
const CLAWGOD_CREATOR = getAddress("0x44Ce9B285C929873c041b5f85cF5eead629c08Ef");
const POOL_ID = "0xc8ea0526765dcad4bfc3ab3d6e9fd804fde7dfbf6d9173d9e0da236e1d4068f2" as Hex;
const WETH = getAddress("0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73");
const SOURCES = { initializer: getAddress("0x4e3468951D49f2EEa976eD0D6e75fFCb44a9a544"), rehype: getAddress("0x5F9eB5f6726Fe88D5e39867967F5b833d2fA3215") };
const SOURCIFY = "https://sourcify.dev/server/v2/contract";
const VALID_SIGNER_MAGIC = "0x523e3260";
const ERC1967_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc" as Hex;
const MUSE_ID = 2n;
const museRef = (tokenId: bigint): NftRef => ({ chainId: CHAIN_ID, contract: MUSES.contract, tokenId: tokenId.toString() });
assert(sameAddress(ROBINHOOD_CONTRACTS.initializer, SOURCES.initializer) && sameAddress(ROBINHOOD_CONTRACTS.rehype, SOURCES.rehype));

type GateName = "1_treasuryFormula" | "2_factory" | "3_counterfactualBeneficiary" | "4_zeroSharePush" | "5_tokenboundControl" | "6_guardian"
  | "7_preActivationResidualRisk";
// "observed" marks a documented residual risk: the gate records behaviour and never passes or fails on its outcome.
type Gate = Record<string, unknown> & { status: "not_run" | "running" | "passed" | "observed" | "failed" | "blocked" };
const gateNames: GateName[] = ["1_treasuryFormula", "2_factory", "3_counterfactualBeneficiary", "4_zeroSharePush", "5_tokenboundControl", "6_guardian",
  "7_preActivationResidualRisk"];
const FAILED_EVIDENCE = ".cache/nft-vault-fork-robinhood-failed.json";
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
const serialize = (_key: string, value: unknown) => typeof value === "bigint" ? value.toString() : value;
const evidence = {
  version: 1,
  scope: "Isolated Anvil fork of Robinhood Chain mainnet state, execution chain id 4663. Every write is a local fork transaction from a fresh random address or from a mainnet account (CLAWGOD creator, Muse holder, guardian owner) impersonated on the fork only; the upstream proxy forwards reads only. No mainnet signing, broadcast, deployment or manifest change.",
  status: "running" as string, stage: "initializing", observedAt: new Date().toISOString(), completedAt: null as string | null,
  upstreamChainId: CHAIN_ID, executionChainId: CHAIN_ID,
  runnerSha256: sha256(await readFile(new URL(import.meta.url), "utf8")),
  helpersSha256: sha256(await readFile(new URL("./nft-vault-fork-helpers.ts", import.meta.url), "utf8")),
  anvil: execFileSync(process.env.ANVIL_BIN?.trim() || ".cache/bin/base-anvil-v1.1.1/anvil", ["--version"], { encoding: "utf8" }).split("\n")[0],
  build: { vaultInitCodeHash: build.vaultInitCodeHash, factoryRuntimeTemplateHash: build.factoryRuntimeTemplateHash, immutableReferences: build.immutableReferences },
  manifest: { vaultInitCodeHash: NFT_VAULT_MANIFEST.vaultInitCodeHash, robinhoodStatus: NFT_VAULT_MANIFEST.chains["4663"].status,
    sha256: sha256(await readFile("contracts/artifacts/nft-vault-deployment.json", "utf8")) },
  forkBlockNumber: null as bigint | null, forkBlockHash: null as Hex | null, forkBlockTimestamp: null as bigint | null,
  mainnetTransactionsSubmitted: false, blockedUpstreamWrites: null as number | null, snapshotRestored: false,
  gates: Object.fromEntries(gateNames.map((name) => [name, { status: "not_run" }])) as Record<GateName, Gate>,
  error: null as string | null,
};
assert.equal(build.vaultInitCodeHash, NFT_VAULT_MANIFEST.vaultInitCodeHash, "The build and the manifest disagree");

let fork: Awaited<ReturnType<typeof startChainFork>>;
try { fork = await startChainFork(upstreamUrl, CHAIN_ID, CHAIN_ID); }
catch (error) {
  const message = redact(error);
  console.error(`BLOCKED: the Robinhood fork did not start: ${message}`);
  evidence.status = isRateLimited(message) ? "blocked_rate_limited" : "failed"; evidence.error = message;
  await mkdir(".cache", { recursive: true });
  await writeFile(FAILED_EVIDENCE, JSON.stringify(evidence, serialize, 2) + "\n");
  process.exit(1);
}
const client = createPublicClient({ chain: robinhood, pollingInterval: 100, transport: http(fork.rpc, { timeout: 120_000, retryCount: 0 }) });

// ---------- local transaction helpers ----------
async function rawRpc(method: string, params: unknown[]) {
  assert.equal(new URL(fork.rpc).hostname, "127.0.0.1");
  const response = await fetch(fork.rpc, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: AbortSignal.timeout(120_000) });
  return await response.json() as { result?: unknown; error?: { code: number; message: string; data?: Hex } };
}
const errorAbi = [...accountV3Abi, ...accountProxyAbi, ...feeSourceAbi, ...factoryAbi, ...vaultAbi].filter((item) => item.type === "error") as Abi;
function decodeRevert(data: Hex | undefined, message: string) {
  if (!data || data === "0x") return message;
  try { const { errorName, args } = decodeErrorResult({ abi: errorAbi, data }); return `${errorName}(${(args ?? []).join(",")})`; }
  catch { return `${message} [${data.slice(0, 74)}]`; }
}
async function sendTx(from: Address, to: Address | null, data: Hex, value = 0n, gas?: bigint) {
  const request: Record<string, string> = { from, data, value: toHex(value) };
  if (to) request.to = to;
  if (gas === undefined) {
    const estimate = await rawRpc("eth_estimateGas", [request]);
    if (estimate.error) throw new Error(`Estimate failed from ${from} to ${to}: ${decodeRevert(estimate.error.data, estimate.error.message)}`);
    gas = BigInt(estimate.result as Hex) * 150n / 100n + 100_000n;
  }
  const hash = await fork.rpcCall("eth_sendTransaction", [{ ...request, gas: toHex(gas) }]) as Hex;
  return client.waitForTransactionReceipt({ hash });
}
async function send(from: Address, to: Address | null, data: Hex, value = 0n) {
  const receipt = await sendTx(from, to, data, value);
  assert.equal(receipt.status, "success", `Fork transaction ${receipt.transactionHash} reverted`);
  return receipt;
}
const tx = (receipt: TransactionReceipt) => ({ hash: receipt.transactionHash, blockNumber: receipt.blockNumber, status: receipt.status, gasUsed: receipt.gasUsed });
/** Calls first; when the call reverts, also mines the same transaction to record an on-chain reverted receipt. */
async function attempt(from: Address, to: Address, data: Hex) {
  const call = await rawRpc("eth_call", [{ from, to, data }, "latest"]);
  if (!call.error) return { accepted: true as const, receipt: tx(await send(from, to, data)) };
  const reason = decodeRevert(call.error.data, call.error.message);
  const receipt = await sendTx(from, to, data, 0n, 1_000_000n);
  assert.equal(receipt.status, "reverted", "The call reverted but the mined transaction did not");
  return { accepted: false as const, reason, receipt: tx(receipt) };
}
// Fresh random actors only. Anvil's well-known default accounts are live on Robinhood mainnet, and at least one
// (account #3) carries an EIP-7702 delegation whose onERC721Received re-enters the NFT, so they are never used.
async function freshActor() {
  const address = privateKeyToAddress(generatePrivateKey());
  assert.equal(await code(address), "0x", "A fresh actor must have no code");
  await fork.rpcCall("anvil_setBalance", [address, toHex(parseEther("100"))]);
  await fork.rpcCall("anvil_impersonateAccount", [address]);
  return address;
}
async function impersonate<T>(account: Address, run: () => Promise<T>) {
  const balance = await client.getBalance({ address: account });
  if (balance < parseEther("1")) await fork.rpcCall("anvil_setBalance", [account, toHex(parseEther("10"))]);
  await fork.rpcCall("anvil_impersonateAccount", [account]);
  try { return await run(); } finally { await fork.rpcCall("anvil_stopImpersonatingAccount", [account]); }
}
const implementationOf = async (account: Address) =>
  getAddress(`0x${((await client.getStorageAt({ address: account, slot: ERC1967_SLOT })) ?? "0x").slice(2).padStart(64, "0").slice(-40)}`);
const balanceOf = (token: Address, account: Address) => client.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [account] });
const balances = async (account: Address) => ({ WETH: await balanceOf(WETH, account), CLAWGOD: await balanceOf(CLAWGOD, account) });
const shares = (source: Address, account: Address) => client.readContract({ address: source, abi: feeSourceAbi, functionName: "getShares", args: [POOL_ID, account] });
const code = async (address: Address) => (await client.getCode({ address })) ?? "0x";
const codeHash = async (address: Address) => { const runtime = await code(address); assert.notEqual(runtime, "0x", `${address} has no code`); return keccak256(runtime); };
async function sourcify(chainId: number, address: Address, fields: string) {
  const response = await fetch(`${SOURCIFY}/${chainId}/${address}?fields=${fields}`, { signal: AbortSignal.timeout(30_000) });
  assert(response.ok, `Sourcify ${chainId}/${address} returned HTTP ${response.status}`);
  return await response.json() as Record<string, unknown> & { match: string; runtimeMatch: string; matchId: string; verifiedAt: string;
    sources: Record<string, { content: string }>; runtimeBytecode: { onchainBytecode: Hex; immutableReferences: Record<string, { start: number; length: number }[]>;
      transformationValues: { immutables?: Record<string, Hex> } }; compilation: { name: string; compilerVersion: string } };
}

// Fee accounting: Release events from the two fee sources to `beneficiary`, and the source's own share arithmetic.
type Accrual = { WETH: bigint; CLAWGOD: bigint };
async function releaseState(beneficiary: Address) {
  const state: Record<string, { shares: bigint; last0: bigint; last1: bigint }> = {};
  for (const [name, source] of Object.entries(SOURCES)) state[name] = {
    shares: await shares(source, beneficiary),
    last0: await client.readContract({ address: source, abi: feeSourceAbi, functionName: "getLastCumulatedFees0", args: [POOL_ID, beneficiary] }),
    last1: await client.readContract({ address: source, abi: feeSourceAbi, functionName: "getLastCumulatedFees1", args: [POOL_ID, beneficiary] }),
  };
  return state;
}
async function verifyReleases(receipt: TransactionReceipt, beneficiary: Address, before: Awaited<ReturnType<typeof releaseState>>, poolKey: V4PoolKey) {
  const released: Record<string, Accrual & { expected: Accrual; shares: bigint }> = {};
  const asTokens = (fees0: bigint, fees1: bigint): Accrual => sameAddress(poolKey.currency0, WETH)
    ? { WETH: fees0, CLAWGOD: fees1 } : { WETH: fees1, CLAWGOD: fees0 };
  for (const [name, source] of Object.entries(SOURCES)) {
    let fees0 = 0n, fees1 = 0n;
    for (const log of receipt.logs.filter((item) => sameAddress(item.address, source))) {
      try {
        const event = decodeEventLog({ abi: feeSourceAbi, data: log.data, topics: log.topics });
        if (event.eventName === "Release" && event.args.poolId === POOL_ID && sameAddress(event.args.beneficiary, beneficiary)) {
          fees0 += event.args.fees0; fees1 += event.args.fees1;
        }
      } catch { /* other events */ }
    }
    const cum0 = await client.readContract({ address: source, abi: feeSourceAbi, functionName: "getCumulatedFees0", args: [POOL_ID] });
    const cum1 = await client.readContract({ address: source, abi: feeSourceAbi, functionName: "getCumulatedFees1", args: [POOL_ID] });
    const { shares: owned, last0, last1 } = before[name];
    const expected = asTokens((cum0 - last0) * owned / WAD, (cum1 - last1) * owned / WAD);
    released[name] = { ...asTokens(fees0, fees1), expected, shares: owned };
    assert.deepEqual(asTokens(fees0, fees1), expected, `${name}: released fees must equal the vault's share of cumulated fees`);
  }
  return released;
}
function vaultOutflows(receipt: TransactionReceipt, vault: Address) {
  const outflows: { token: Address; to: Address; amount: bigint }[] = [];
  for (const log of receipt.logs) {
    try {
      const event = decodeEventLog({ abi: erc20Abi, data: log.data, topics: log.topics });
      if (event.eventName === "Transfer" && sameAddress(event.args.from, vault)) outflows.push({ token: getAddress(log.address), to: event.args.to, amount: event.args.value });
    } catch { /* not an ERC-20 Transfer */ }
  }
  return outflows;
}
function vaultEvents(receipt: TransactionReceipt, vault: Address) {
  const events: { name: string; args: unknown }[] = [];
  for (const log of receipt.logs.filter((item) => sameAddress(item.address, vault))) {
    const event = decodeEventLog({ abi: vaultAbi, data: log.data, topics: log.topics });
    events.push({ name: event.eventName, args: event.args });
  }
  return events;
}

let snapshot: Hex | undefined;
let current: GateName | undefined;
async function gate(name: GateName, run: (record: Gate) => Promise<void>) {
  current = name; evidence.stage = name;
  const record = evidence.gates[name]; record.status = "running";
  console.log(`Gate ${name}: running`);
  await run(record);
  if (record.status === "running") record.status = "passed";
  else assert(record.status === "observed", `Gate ${name} ended as ${record.status}`);
  console.log(`Gate ${name}: ${record.status}`);
}

try {
  assert.equal(await client.getChainId(), CHAIN_ID);
  assert.match(await fork.rpcCall("web3_clientVersion") as string, /anvil/i);
  const pinned = await client.getBlock({ blockNumber: fork.blockNumber });
  Object.assign(evidence, { forkBlockNumber: fork.blockNumber, forkBlockHash: pinned.hash, forkBlockTimestamp: pinned.timestamp });
  const [deployer, trader, zeroShare, newHolder, outsider] = [await freshActor(), await freshActor(), await freshActor(), await freshActor(), await freshActor()];
  Object.assign(evidence, { actors: { deployer, trader, zeroShare, newHolder, trustedExecutorCandidate: outsider,
    note: "Fresh random addresses with no code, funded and impersonated on the fork only" } });
  snapshot = await fork.rpcCall("evm_snapshot") as Hex;
  const sdk = new DopplerSDK<4663>({ chainId: 4663, publicClient: client as never });
  let factory!: Address, vault!: Address, treasury!: Address, poolKey!: V4PoolKey, museHolder!: Address, treasuryAsset!: Address;

  await gate("1_treasuryFormula", async (g) => {
    const muse1 = museRef(1n);
    const onchain = await client.readContract({ address: ERC6551_REGISTRY, abi: registryAbi, functionName: "account",
      args: [TOKENBOUND_V3_PROXY, zeroHash, BigInt(CHAIN_ID), MUSES.contract, 1n] });
    const library = treasuryFor(muse1);
    Object.assign(g, { nft: muse1, registry: ERC6551_REGISTRY, implementation: TOKENBOUND_V3_PROXY, salt: zeroHash,
      onchainRegistryAccount: onchain, libraryTreasuryFor: library,
      runtimeHashes: { registry: await codeHash(ERC6551_REGISTRY), accountProxy: await codeHash(TOKENBOUND_V3_PROXY), accountV3Implementation: await codeHash(TOKENBOUND_V3_IMPLEMENTATION) } });
    assert.equal(onchain, library, "On-chain ERC-6551 account differs from treasuryFor");
  });

  await gate("2_factory", async (g) => {
    const deployment = await send(deployer, null, build.factoryBytecode as Hex);
    assert(deployment.contractAddress);
    factory = getAddress(deployment.contractAddress);
    const runtime = await code(factory);
    const length = (runtime.length - 2) / 2;
    const template = runtimeTemplateFromInitCode(build.factoryBytecode as Hex, build.factoryRuntimeTemplateHash as Hex, length);
    const filled = patchImmutableRuntime(template, build.immutableReferences, build.vaultInitCodeHash as Hex);
    const onchainInitCodeHash = await client.readContract({ address: factory, abi: factoryAbi, functionName: "VAULT_INIT_CODE_HASH" });
    const muse1 = museRef(1n);
    const libraryVault = vaultFor(muse1, factory);
    const factoryVault = await client.readContract({ address: factory, abi: factoryAbi, functionName: "vaultFor", args: [BigInt(CHAIN_ID), MUSES.contract, 1n] });
    const factoryTreasury = await client.readContract({ address: factory, abi: factoryAbi, functionName: "treasuryFor", args: [BigInt(CHAIN_ID), MUSES.contract, 1n] });
    Object.assign(g, { deployer, factory, deployment: tx(deployment), factoryAddressScope: "fork-local; the mainnet address is fixed only at Task 13",
      runtimeLength: length, templateOffsetInInitCode: (build.factoryBytecode.toLowerCase().indexOf(template.slice(2)) - 2) / 2,
      templateHash: keccak256(template), filledTemplateHash: keccak256(filled), onchainRuntimeHash: keccak256(runtime),
      onchainVaultInitCodeHash: onchainInitCodeHash, libraryVaultForMuse1: libraryVault, factoryVaultForMuse1: factoryVault,
      factoryTreasuryForMuse1: factoryTreasury,
      factoryConstants: { ERC6551_REGISTRY: await client.readContract({ address: factory, abi: factoryAbi, functionName: "ERC6551_REGISTRY" }),
        TOKENBOUND_V3_PROXY: await client.readContract({ address: factory, abi: factoryAbi, functionName: "TOKENBOUND_V3_PROXY" }) } });
    assert.equal(keccak256(template), build.factoryRuntimeTemplateHash);
    assert.equal(keccak256(filled), keccak256(runtime), "Filled template differs from the deployed runtime");
    assert.equal(filled, runtime.toLowerCase());
    assert.equal(onchainInitCodeHash, build.vaultInitCodeHash);
    assert.equal(factoryVault, libraryVault, "TS vaultFor differs from factory.vaultFor");
    assert.equal(factoryTreasury, treasuryFor(muse1));
    assert.deepEqual(g.factoryConstants, { ERC6551_REGISTRY, TOKENBOUND_V3_PROXY });
  });

  async function trade(currencyIn: Address, amountIn: bigint) {
    const zeroForOne = sameAddress(currencyIn, poolKey.currency0);
    const quote = await sdk.quoter.quoteExactInputV4({ poolKey, zeroForOne, exactAmount: amountIn, hookData: "0x" });
    assert(quote.amountOut > 0n, "The pool quote is empty");
    if (await client.readContract({ address: currencyIn, abi: erc20Abi, functionName: "allowance", args: [trader, ROBINHOOD_CONTRACTS.permit2] }) < amountIn)
      await send(trader, currencyIn, encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [ROBINHOOD_CONTRACTS.permit2, maxUint256] }));
    const deadline = (await client.getBlock()).timestamp + 600n;
    await send(trader, ROBINHOOD_CONTRACTS.permit2, encodeFunctionData({ abi: permit2Abi, functionName: "approve",
      args: [currencyIn, ROBINHOOD_CONTRACTS.router, amountIn, Number(deadline)] }));
    const swap = swapTransaction(poolKey, currencyIn, amountIn, quote.amountOut, 100, deadline, ROBINHOOD_CONTRACTS);
    const before = await balanceOf(swap.currencyOut, trader);
    const receipt = await send(trader, swap.to, swap.data);
    const amountOut = await balanceOf(swap.currencyOut, trader) - before;
    assert(amountOut >= swap.minOut);
    return { ...tx(receipt), currencyIn, amountIn, quotedOut: quote.amountOut, amountOut };
  }
  async function roundTrip(wethIn: bigint) {
    const buy = await trade(WETH, wethIn);
    const sell = await trade(CLAWGOD, buy.amountOut);
    return { buy, sell };
  }
  async function sweep(caller: Address) {
    const before = { treasury: await balances(treasury), vault: await balances(vault) };
    const accounting = await releaseState(vault);
    const receipt = await send(caller, vault, encodeFunctionData({ abi: vaultAbi, functionName: "sweep", args: [[POOL_ID], [WETH, CLAWGOD]] }));
    const after = { treasury: await balances(treasury), vault: await balances(vault) };
    const released = await verifyReleases(receipt, vault, accounting, poolKey);
    const events = vaultEvents(receipt, vault), outflows = vaultOutflows(receipt, vault);
    const totalReleased = { WETH: released.initializer.WETH + released.rehype.WETH, CLAWGOD: released.initializer.CLAWGOD + released.rehype.CLAWGOD };
    const treasuryDelta = { WETH: after.treasury.WETH - before.treasury.WETH, CLAWGOD: after.treasury.CLAWGOD - before.treasury.CLAWGOD };
    // Funds may only leave the vault to the NFT's treasury; the treasury gains exactly the vault's held and released fees.
    assert(outflows.every((item) => sameAddress(item.to, treasury)), "The vault sent funds somewhere other than the treasury");
    assert.deepEqual(events.filter((event) => event.name === "FeeClaimFailed" || event.name === "SweepFailed"), [], "A claim or forward failed");
    assert.deepEqual(after.vault, { WETH: 0n, CLAWGOD: 0n }, "The vault must end empty");
    assert.deepEqual(treasuryDelta, { WETH: before.vault.WETH + totalReleased.WETH, CLAWGOD: before.vault.CLAWGOD + totalReleased.CLAWGOD });
    return { ...tx(receipt), caller, before, after, released, totalReleased, treasuryDelta, vaultEvents: events, vaultOutflows: outflows };
  }

  await gate("3_counterfactualBeneficiary", async (g) => {
    const state = await client.readContract({ address: SOURCES.initializer, abi: feeSourceAbi, functionName: "getState", args: [CLAWGOD] });
    poolKey = { ...state[5], currency0: getAddress(state[5].currency0), currency1: getAddress(state[5].currency1), hooks: getAddress(state[5].hooks) };
    const derivedPoolId = keccak256(encodeAbiParameters([{ type: "address" }, { type: "address" }, { type: "uint24" }, { type: "int24" }, { type: "address" }],
      [poolKey.currency0, poolKey.currency1, poolKey.fee, poolKey.tickSpacing, poolKey.hooks]));
    assert.equal(derivedPoolId, POOL_ID, "The CLAWGOD pool key does not hash to the given pool id");
    assert(new Set([poolKey.currency0, poolKey.currency1].map((a) => a.toLowerCase())).size === 2
      && [WETH, CLAWGOD].every((token) => sameAddress(token, poolKey.currency0) || sameAddress(token, poolKey.currency1)));
    assert.equal(state[4], 2, "The CLAWGOD pool must be Locked so initializer fees are collectable");
    const sourcePoolKeys = Object.fromEntries(await Promise.all(Object.entries(SOURCES).map(async ([name, source]) =>
      [name, await client.readContract({ address: source, abi: feeSourceAbi, functionName: "getPoolKey", args: [POOL_ID] })])));
    const creatorShares = { initializer: await shares(SOURCES.initializer, CLAWGOD_CREATOR), rehype: await shares(SOURCES.rehype, CLAWGOD_CREATOR) };
    const muse = museRef(MUSE_ID);
    museHolder = await client.readContract({ address: MUSES.contract, abi: musesAbi, functionName: "ownerOf", args: [MUSE_ID] });
    vault = vaultFor(muse, factory);
    treasury = treasuryFor(muse);
    assert.equal(await client.readContract({ address: factory, abi: factoryAbi, functionName: "vaultFor", args: [BigInt(CHAIN_ID), MUSES.contract, MUSE_ID] }), vault);
    assert.equal(await code(vault), "0x", "The vault must not exist before it is named as a beneficiary");
    Object.assign(g, { token: CLAWGOD, creator: CLAWGOD_CREATOR, poolId: POOL_ID, quote: WETH, poolKey, poolStatus: state[4], sourcePoolKeys,
      creatorSharesBefore: creatorShares, nft: muse, museHolder, museHolderCodeLength: (await code(museHolder)).length / 2 - 1,
      vault, vaultCodeBeforeDeploy: "0x", treasury, treasuryCodeBefore: await code(treasury) });
    assert(creatorShares.initializer > 0n || creatorShares.rehype > 0n, "The CLAWGOD creator holds no shares on either source");

    // Ruling 3: the creator moves its shares to the not-yet-deployed vault.
    const moves: Record<string, unknown> = {};
    await impersonate(CLAWGOD_CREATOR, async () => {
      for (const [name, source] of Object.entries(SOURCES)) {
        const result = await attempt(CLAWGOD_CREATOR, source, encodeFunctionData({ abi: feeSourceAbi, functionName: "updateBeneficiary", args: [POOL_ID, vault] }));
        moves[name] = { ...result, vaultShares: await shares(source, vault), creatorSharesAfter: await shares(source, CLAWGOD_CREATOR) };
      }
    });
    g.updateBeneficiary = moves;
    for (const [name, source] of Object.entries(SOURCES)) {
      const move = moves[name] as { accepted: boolean };
      if (!move.accepted) continue;
      assert.equal(await shares(source, vault), creatorShares[name as keyof typeof creatorShares], `${name}: the vault must hold the creator's former shares`);
      assert.equal(await shares(source, CLAWGOD_CREATOR), 0n);
    }
    assert(Object.values(moves).some((move) => (move as { accepted: boolean }).accepted), "No fee source accepted the vault as beneficiary");
    assert.equal(await code(vault), "0x");

    const funding = await send(trader, WETH, encodeFunctionData({ abi: wethAbi, functionName: "deposit" }), parseEther("1"));
    g.traderFunding = { trader, kind: "WETH deposit of local Anvil ETH", amount: parseEther("1"), ...tx(funding) };
    g.trades = await roundTrip(parseEther("0.05"));
    assert.equal(await code(vault), "0x", "Fees accrued while the vault was still counterfactual");

    const predicted = await client.simulateContract({ address: factory, abi: factoryAbi, functionName: "deploy", args: [BigInt(CHAIN_ID), MUSES.contract, MUSE_ID], account: deployer });
    assert.equal(predicted.result, vault);
    const deployment = await send(deployer, factory, encodeFunctionData({ abi: factoryAbi, functionName: "deploy", args: [BigInt(CHAIN_ID), MUSES.contract, MUSE_ID] }));
    const deployed = deployment.logs.filter((log) => sameAddress(log.address, factory)).map((log) => decodeEventLog({ abi: factoryAbi, data: log.data, topics: log.topics }));
    const read = <T>(functionName: string) => client.readContract({ address: vault, abi: vaultAbi, functionName: functionName as "treasury" }) as Promise<T>;
    const immutables = { factory: await read<Address>("factory"), homeChainId: await read<bigint>("homeChainId"), nft: await read<Address>("nft"),
      tokenId: await read<bigint>("tokenId"), treasury: await read<Address>("treasury"), initializer: await read<Address>("initializer"), REHYPE: await read<Address>("REHYPE") };
    g.deploy = { ...tx(deployment), returned: predicted.result, events: deployed.map((event) => ({ name: event.eventName, args: event.args })), runtimeHash: await codeHash(vault), immutables };
    assert.deepEqual(immutables, { factory, homeChainId: BigInt(CHAIN_ID), nft: MUSES.contract, tokenId: MUSE_ID, treasury, initializer: SOURCES.initializer, REHYPE: SOURCES.rehype });

    assert.equal(await code(treasury), "0x", "The treasury must still be counterfactual before the first sweep");
    const swept = await sweep(deployer);
    g.sweep = swept;
    const activation = swept.vaultEvents.filter((event) => event.name === "TreasuryActivation");
    g.treasuryActivation = { events: activation, codeHashAfter: await codeHash(treasury), implementationSlotAfter: await implementationOf(treasury),
      ownerAfter: await client.readContract({ address: treasury, abi: accountV3Abi, functionName: "owner" }) };
    assert.deepEqual(activation, [{ name: "TreasuryActivation", args: { treasury, created: true, initialized: true } }]);
    assert.equal(await implementationOf(treasury), TOKENBOUND_V3_IMPLEMENTATION, "The first sweep must initialize the treasury to V3");
    assert.equal(await client.readContract({ address: treasury, abi: accountV3Abi, functionName: "owner" }), museHolder);
    for (const [name, move] of Object.entries(moves) as [keyof typeof SOURCES, { accepted: boolean }][])
      if (move.accepted) assert(swept.released[name].WETH + swept.released[name].CLAWGOD > 0n, `${name}: no fee accrued to the vault`);
    assert(swept.treasuryDelta.WETH + swept.treasuryDelta.CLAWGOD > 0n, "The treasury received nothing");
  });

  await gate("4_zeroSharePush", async (g) => {
    for (const source of Object.values(SOURCES)) assert.equal(await shares(source, zeroShare), 0n);
    g.zeroShareAccount = zeroShare;
    g.trades = await roundTrip(parseEther("0.05"));
    const vaultSharesBefore = { initializer: await shares(SOURCES.initializer, vault), rehype: await shares(SOURCES.rehype, vault) };
    const pushes: Record<string, unknown> = {};
    // As in the Base proof (scripts/test-base-collector-fork.ts), the zero-share account first runs the permissionless
    // collectFees, which moves pool fees into the source's cumulated total and pays the caller nothing. It then calls
    // updateBeneficiary(poolId, vault). Neither call is the vault's own claim.
    for (const [name, source] of Object.entries(SOURCES)) {
      const callerBefore = await balances(zeroShare);
      const collect = await send(zeroShare, source, encodeFunctionData({ abi: feeSourceAbi, functionName: "collectFees", args: [POOL_ID] }));
      assert.deepEqual(await balances(zeroShare), callerBefore, `${name}: a zero-share caller must not be paid`);
      const vaultBefore = await balances(vault);
      const update = await attempt(zeroShare, source, encodeFunctionData({ abi: feeSourceAbi, functionName: "updateBeneficiary", args: [POOL_ID, vault] }));
      const vaultAfter = await balances(vault);
      const arrived = { WETH: vaultAfter.WETH - vaultBefore.WETH, CLAWGOD: vaultAfter.CLAWGOD - vaultBefore.CLAWGOD };
      pushes[name] = { collect: tx(collect), updateBeneficiary: update, arrivedWithoutVaultClaim: arrived,
        feesArrived: arrived.WETH + arrived.CLAWGOD > 0n, vaultShares: await shares(source, vault), zeroShareAccountShares: await shares(source, zeroShare) };
      assert.equal(await shares(source, vault), vaultSharesBefore[name as keyof typeof vaultSharesBefore], `${name}: a zero-share call changed the vault's shares`);
      assert.equal(await shares(source, zeroShare), 0n);
      if (!update.accepted) {
        assert.match(update.reason, /^\w+\(.*\)$/, `${name}: a rejection must decode as a custom error, not a raw RPC failure`);
        assert.deepEqual(arrived, { WETH: 0n, CLAWGOD: 0n });
      }
    }
    g.pushes = pushes;
    g.vaultSharesBefore = vaultSharesBefore;
    const pushed = await balances(vault);
    g.vaultHeldBeforeSweep = pushed;
    const swept = await sweep(deployer);
    g.sweep = swept;
    assert(swept.treasuryDelta.WETH >= pushed.WETH && swept.treasuryDelta.CLAWGOD >= pushed.CLAWGOD, "The sweep did not forward the pushed fees");
    g.summary = Object.fromEntries(Object.entries(pushes).map(([name, push]) => {
      const { updateBeneficiary, feesArrived } = push as { updateBeneficiary: { accepted: boolean; reason?: string }; feesArrived: boolean };
      return [name, updateBeneficiary.accepted ? `zero-share updateBeneficiary accepted; fees arrived without a vault claim: ${feesArrived}`
        : `zero-share updateBeneficiary rejected (${updateBeneficiary.reason}); fees stay claimable by sweep`];
    }));
  });

  await gate("5_tokenboundControl", async (g) => {
    const created = await client.simulateContract({ address: ERC6551_REGISTRY, abi: registryAbi, functionName: "createAccount",
      args: [TOKENBOUND_V3_PROXY, zeroHash, BigInt(CHAIN_ID), MUSES.contract, MUSE_ID], account: deployer });
    assert.equal(created.result, treasury);
    // The vault's first sweep already activated this account; both steps are idempotent for anyone else.
    const codeBefore = await codeHash(treasury);
    const creation = await send(deployer, ERC6551_REGISTRY, encodeFunctionData({ abi: registryAbi, functionName: "createAccount",
      args: [TOKENBOUND_V3_PROXY, zeroHash, BigInt(CHAIN_ID), MUSES.contract, MUSE_ID] }));
    assert.equal(await codeHash(treasury), codeBefore, "createAccount must not replace an existing account");
    const initialization = await attempt(deployer, treasury, encodeFunctionData({ abi: accountProxyAbi, functionName: "initialize", args: [TOKENBOUND_V3_IMPLEMENTATION] }));
    assert.equal(initialization.accepted, false, "A swept treasury must already be initialized");
    assert.equal(initialization.reason, "AlreadyInitialized()");
    const implementation = await implementationOf(treasury);
    const token = await client.readContract({ address: treasury, abi: accountV3Abi, functionName: "token" });
    const ownerBefore = await client.readContract({ address: treasury, abi: accountV3Abi, functionName: "owner" });
    assert.equal(implementation, TOKENBOUND_V3_IMPLEMENTATION);
    assert.deepEqual(token, [BigInt(CHAIN_ID), MUSES.contract, MUSE_ID]);
    assert.equal(ownerBefore, museHolder);
    const held = await balances(treasury);
    const asset = treasuryAsset = held.WETH >= 4n ? WETH : CLAWGOD;
    const amount = (asset === WETH ? held.WETH : held.CLAWGOD) / 4n;
    assert(amount > 0n, "The treasury holds no swept fees to move");
    const withdraw = (to: Address) => encodeFunctionData({ abi: accountV3Abi, functionName: "execute",
      args: [asset, 0n, encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [to, amount] }), 0] });
    Object.assign(g, { treasury, alreadyActivatedBy: "the vault's first sweep (gate 3)", createAccountAgain: tx(creation), initializeAgain: initialization, implementation, token, ownerBefore,
      treasuryBalances: held, asset, amountPerWithdrawal: amount, oldHolder: museHolder, newHolder });

    const validator = await client.readContract({ address: MUSES.contract, abi: musesAbi, functionName: "getTransferValidator" });
    await impersonate(museHolder, async () => {
      const before = await balanceOf(asset, museHolder);
      g.holderExecute = await attempt(museHolder, treasury, withdraw(museHolder));
      assert((g.holderExecute as { accepted: boolean }).accepted, "The holder could not execute");
      assert.equal(await balanceOf(asset, museHolder) - before, amount);
      const transfer = await attempt(museHolder, MUSES.contract, encodeFunctionData({ abi: musesAbi, functionName: "safeTransferFrom", args: [museHolder, newHolder, MUSE_ID] }));
      g.museTransfer = { transferValidator: validator, transferValidatorCodeLength: (await code(validator)).length / 2 - 1, call: "safeTransferFrom(holder, newHolder, 2) by the holder", ...transfer };
      assert(transfer.accepted, "The Muse transfer was rejected");
      assert.equal(await client.readContract({ address: MUSES.contract, abi: musesAbi, functionName: "ownerOf", args: [MUSE_ID] }), newHolder);
      assert.equal(await client.readContract({ address: treasury, abi: accountV3Abi, functionName: "owner" }), newHolder);
      const treasuryBefore = await balanceOf(asset, treasury);
      g.oldHolderExecute = await attempt(museHolder, treasury, withdraw(museHolder));
      assert.equal((g.oldHolderExecute as { accepted: boolean }).accepted, false, "The old holder still controls the treasury");
      assert.equal((g.oldHolderExecute as { reason: string }).reason, "NotAuthorized()");
      assert.equal(await balanceOf(asset, treasury), treasuryBefore);
    });
    const before = await balanceOf(asset, newHolder);
    g.newHolderExecute = await attempt(newHolder, treasury, withdraw(newHolder));
    assert((g.newHolderExecute as { accepted: boolean }).accepted, "The new holder could not execute");
    assert.equal(await balanceOf(asset, newHolder) - before, amount);
    g.ownerAfter = await client.readContract({ address: treasury, abi: accountV3Abi, functionName: "owner" });
  });

  await gate("6_guardian", async (g) => {
    const implementationRuntime = await code(TOKENBOUND_V3_IMPLEMENTATION);
    const verified = await sourcify(8453, TOKENBOUND_V3_IMPLEMENTATION, "abi,sources,runtimeBytecode,creationBytecode,compilation,deployment");
    const runtimeHash = bindSourcifyRuntime(verified, implementationRuntime);
    const located = guardianFromSourcify(verified as never);
    const guardian = immutableAddress(implementationRuntime, located.references);
    assert.equal(guardian, located.guardian);
    const accountSource = verified.sources["src/AccountV3.sol"].content;
    const upgradableSource = verified.sources["src/AccountV3Upgradable.sol"].content;
    const executor = guardianExecutorSource(accountSource);
    const tokenOwner = solidityFunction(accountSource, "_tokenOwner");
    const signer = solidityFunction(accountSource, "_isValidSigner");
    const upgrade = solidityFunction(upgradableSource, "_authorizeUpgrade");
    assert(executor.guardianTrustOnlyForForeignChain, "Source: guardian trust is not confined to foreign-chain accounts");
    assert.match(tokenOwner.code, /if\s*\(\s*chainId\s*!=\s*block\.chainid\s*\)\s*return\s+address\(0\)/);
    assert.doesNotMatch(signer.code, /guardian/, "Source: signature validation consults the guardian");
    const guardianVerified = await sourcify(8453, guardian, "sources,runtimeBytecode,compilation");
    const guardianRuntimeHash = bindSourcifyRuntime(guardianVerified, await code(guardian));
    const guardianSource = guardianVerified.sources["src/AccountGuardian.sol"].content;
    const proxyVerified = await sourcify(8453, TOKENBOUND_V3_PROXY, "sources,runtimeBytecode,compilation");
    const proxyRuntimeHash = bindSourcifyRuntime(proxyVerified, await code(TOKENBOUND_V3_PROXY));
    const proxySource = Object.entries(proxyVerified.sources).find(([path]) => path.endsWith("AccountProxy.sol"))![1].content;
    const guardianOwner = await client.readContract({ address: guardian, abi: guardianAbi, functionName: "owner" });
    Object.assign(g, {
      guardian, guardianSource: { implementationImmutableId: located.immutableId, implementationImmutableOffsets: located.references,
        from: "Sourcify 8453 constructor argument `guardian`, read back from the Robinhood implementation runtime at the same immutable offsets" },
      guardianOwner, guardianOwnerCode: await code(guardianOwner),
      sourcify: {
        accountV3: { chainId: 8453, address: TOKENBOUND_V3_IMPLEMENTATION, name: verified.compilation.name, compiler: verified.compilation.compilerVersion,
          match: verified.match, runtimeMatch: verified.runtimeMatch, matchId: verified.matchId, verifiedAt: verified.verifiedAt,
          robinhoodRuntimeHash: runtimeHash, robinhoodRuntimeEqualsSourcify: true, accountV3SourceKeccak: keccak256(new TextEncoder().encode(accountSource)),
          note: "Not verified on Sourcify 4663; the Robinhood runtime is byte-identical to the Base exact match, immutables included" },
        accountGuardian: { chainId: 8453, address: guardian, name: guardianVerified.compilation.name, match: guardianVerified.match, runtimeMatch: guardianVerified.runtimeMatch,
          robinhoodRuntimeHash: guardianRuntimeHash, robinhoodRuntimeEqualsSourcify: true },
        accountProxy: { chainId: 8453, address: TOKENBOUND_V3_PROXY, name: proxyVerified.compilation.name, match: proxyVerified.match, runtimeMatch: proxyVerified.runtimeMatch,
          robinhoodRuntimeHash: proxyRuntimeHash, robinhoodRuntimeEqualsSourcify: true },
      },
      governingSource: {
        "src/AccountV3.sol _isValidExecutor": executor.lines,
        "src/AccountV3.sol _tokenOwner": tokenOwner.lines,
        "src/AccountV3.sol _isValidSigner": signer.lines,
        "src/AccountV3Upgradable.sol _authorizeUpgrade": upgrade.lines,
        "src/AccountGuardian.sol setTrustedExecutor": solidityFunction(guardianSource, "setTrustedExecutor").lines,
        "src/AccountProxy.sol initialize": solidityFunction(proxySource, "initialize").lines,
      },
      sourceFindings: { guardianTrustOnlyForForeignChain: executor.guardianTrustOnlyForForeignChain,
        tokenOwnerIsZeroForForeignChain: true, signatureValidationIgnoresGuardian: true },
    });

    assert.equal(await client.readContract({ address: guardian, abi: guardianAbi, functionName: "isTrustedExecutor", args: [outsider] }), false);
    // Positive control: an account bound to a foreign-chain token (Muses id 2 on chain 8453), created on this fork.
    const foreign = await client.readContract({ address: ERC6551_REGISTRY, abi: registryAbi, functionName: "account", args: [TOKENBOUND_V3_PROXY, zeroHash, 8453n, MUSES.contract, MUSE_ID] });
    await send(deployer, ERC6551_REGISTRY, encodeFunctionData({ abi: registryAbi, functionName: "createAccount", args: [TOKENBOUND_V3_PROXY, zeroHash, 8453n, MUSES.contract, MUSE_ID] }));
    await send(deployer, foreign, encodeFunctionData({ abi: accountProxyAbi, functionName: "initialize", args: [TOKENBOUND_V3_IMPLEMENTATION] }));
    const noop = encodeFunctionData({ abi: accountV3Abi, functionName: "execute", args: [outsider, 0n, "0x", 0] });
    const asset = treasuryAsset;
    const held = await balanceOf(asset, treasury);
    const steal = encodeFunctionData({ abi: accountV3Abi, functionName: "execute",
      args: [asset, 0n, encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [outsider, held] }), 0] });
    // The stand-in "implementation" is any contract the guardian owner could mark as trusted (here the local factory).
    const standIn = factory;
    g.foreignChainAccount = foreign;
    g.foreignBeforeTrust = await attempt(outsider, foreign, noop);
    assert.equal((g.foreignBeforeTrust as { accepted: boolean }).accepted, false, "Control: an untrusted outsider executed on the foreign-chain account");
    await impersonate(guardianOwner, async () => {
      g.markTrustedExecutor = tx(await send(guardianOwner, guardian, encodeFunctionData({ abi: guardianAbi, functionName: "setTrustedExecutor", args: [outsider, true] })));
      g.markTrustedImplementation = { implementation: standIn, ...tx(await send(guardianOwner, guardian,
        encodeFunctionData({ abi: guardianAbi, functionName: "setTrustedImplementation", args: [standIn, true] }))) };
    });
    assert.equal(await client.readContract({ address: guardian, abi: guardianAbi, functionName: "isTrustedExecutor", args: [outsider] }), true);
    assert.equal(await client.readContract({ address: guardian, abi: guardianAbi, functionName: "isTrustedImplementation", args: [standIn] }), true);
    g.trustedExecutor = outsider;
    const treasuryBefore = await balanceOf(asset, treasury);
    g.sameChainExecute = { target: treasury, asset, attemptedAmount: held, ...(await attempt(outsider, treasury, steal)) };
    if ((g.sameChainExecute as { accepted: boolean }).accepted) {
      g.status = "blocked";
      throw new Error("STOP: a guardian-trusted executor executed on a same-chain treasury; D1 option (b) needs an owner decision");
    }
    assert.equal((g.sameChainExecute as { reason: string }).reason, "NotAuthorized()");
    assert.equal(await balanceOf(asset, treasury), treasuryBefore);
    // _authorizeUpgrade checks the implementation first; a guardian-trusted one reaches the executor check.
    const upgradeTo = await attempt(outsider, treasury, encodeFunctionData({ abi: accountV3Abi, functionName: "upgradeTo", args: [standIn] }));
    g.sameChainUpgradeTo = { implementation: standIn, implementationTrusted: true, ...upgradeTo };
    if (upgradeTo.accepted) {
      g.status = "blocked";
      throw new Error("STOP: a guardian-trusted executor upgraded a same-chain treasury; D1 option (b) needs an owner decision");
    }
    assert.equal(upgradeTo.reason, "NotAuthorized()");
    g.sameChainIsValidSigner = await client.readContract({ address: treasury, abi: accountV3Abi, functionName: "isValidSigner", args: [outsider, "0x"] });
    assert.notEqual(g.sameChainIsValidSigner, VALID_SIGNER_MAGIC);
    g.foreignAfterTrust = await attempt(outsider, foreign, noop);
    assert((g.foreignAfterTrust as { accepted: boolean }).accepted, "Control: the trusted executor could not act on the foreign-chain account, so the trust mark was not effective");

    g.standInImplementation = standIn;
    g.reinitializeSweptTreasury = await attempt(outsider, treasury, encodeFunctionData({ abi: accountProxyAbi, functionName: "initialize", args: [standIn] }));
    assert.equal((g.reinitializeSweptTreasury as { reason?: string }).reason, "AlreadyInitialized()", "An activated treasury must reject re-initialization");
  });

  await gate("7_preActivationResidualRisk", async (g) => {
    // Documented residual risk, recorded rather than judged: before any sweep, an outsider initializes a fresh
    // treasury to an implementation the guardian owner trusts (the stand-in from gate 6). The vault cannot tell
    // implementations apart on-chain, so its activation step is a no-op and it forwards anyway.
    const standIn = factory;
    assert.equal(await client.readContract({ address: evidence.gates["6_guardian"].guardian as Address,
      abi: guardianAbi, functionName: "isTrustedImplementation", args: [standIn] }), true);
    let tokenId = 3n;
    while (await code(treasuryFor(museRef(tokenId))) !== "0x") { tokenId++; assert(tokenId < 20n, "No fresh Muse treasury found"); }
    const nft = museRef(tokenId), freshTreasury = treasuryFor(nft), freshVault = vaultFor(nft, factory);
    g.nft = nft; g.treasury = freshTreasury; g.vault = freshVault; g.standInImplementation = standIn; g.outsider = outsider;
    g.createAccount = tx(await send(outsider, ERC6551_REGISTRY, encodeFunctionData({ abi: registryAbi, functionName: "createAccount",
      args: [TOKENBOUND_V3_PROXY, zeroHash, BigInt(CHAIN_ID), MUSES.contract, tokenId] })));
    g.outsiderInitialize = await attempt(outsider, freshTreasury, encodeFunctionData({ abi: accountProxyAbi, functionName: "initialize", args: [standIn] }));
    g.implementationBeforeSweep = await implementationOf(freshTreasury);
    g.deploy = tx(await send(deployer, factory, encodeFunctionData({ abi: factoryAbi, functionName: "deploy", args: [BigInt(CHAIN_ID), MUSES.contract, tokenId] })));
    const donation = parseEther("0.001");
    g.funding = { kind: "WETH transfer from the fork trader standing in for fees", amount: donation,
      ...tx(await send(trader, WETH, encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [freshVault, donation] }))) };
    const before = await balanceOf(WETH, freshTreasury);
    const receipt = await send(deployer, freshVault, encodeFunctionData({ abi: vaultAbi, functionName: "sweep", args: [[], [WETH]] }));
    g.sweep = { ...tx(receipt), vaultEvents: vaultEvents(receipt, freshVault), vaultOutflows: vaultOutflows(receipt, freshVault),
      treasuryDelta: await balanceOf(WETH, freshTreasury) - before, vaultAfter: await balanceOf(WETH, freshVault) };
    g.implementationAfterSweep = await implementationOf(freshTreasury);
    g.forwardedToNonCanonicalImplementation = g.implementationAfterSweep !== TOKENBOUND_V3_IMPLEMENTATION && (g.sweep as { treasuryDelta: bigint }).treasuryDelta > 0n;
    g.finding = g.forwardedToNonCanonicalImplementation
      ? "Residual risk confirmed: an account initialized to a guardian-trusted non-V3 implementation before the first sweep keeps it, and the vault still forwards to it. Requires the Tokenbound guardian owner to trust a hostile implementation and someone to front-run the first sweep."
      : "The vault did not forward to a non-canonical implementation in this run.";
    g.status = "observed";
  });

  evidence.status = "passed";
  evidence.stage = "completed";
} catch (error) {
  const message = redact(error);
  evidence.error = message;
  const record = current ? evidence.gates[current] : undefined;
  if (record) { if (record.status !== "blocked") record.status = "failed"; record.error = message; }
  evidence.status = isRateLimited(message) ? "blocked_rate_limited" : record?.status === "blocked" ? "blocked" : "failed";
  console.error(`${evidence.status.toUpperCase()} at ${evidence.stage}: ${message}`);
} finally {
  try { if (snapshot) evidence.snapshotRestored = await fork.rpcCall("evm_revert", [snapshot]) as boolean; }
  catch (error) { console.error(`Snapshot restore failed: ${redact(error)}`); }
  finally {
    evidence.blockedUpstreamWrites = fork.blockedUpstreamWrites();
    await fork.stop();
  }
  if (evidence.blockedUpstreamWrites !== 0 && evidence.status === "passed") { evidence.status = "failed"; evidence.error = "An upstream write was attempted"; }
  evidence.completedAt = new Date().toISOString();
  // A failed run never replaces the last passing evidence and stays out of git (.cache is ignored).
  const path = evidence.status === "passed" ? "docs/evidence/nft-vault-fork-robinhood.json" : FAILED_EVIDENCE;
  const text = JSON.stringify(evidence, serialize, 2) + "\n";
  assert(!key || !text.includes(key), "Evidence must not contain the API key");
  await mkdir(path.startsWith(".cache") ? ".cache" : "docs/evidence", { recursive: true });
  await writeFile(path, text);
  console.log(JSON.stringify({ status: evidence.status, forkBlockNumber: evidence.forkBlockNumber, evidence: path,
    gates: Object.fromEntries(gateNames.map((name) => [name, evidence.gates[name].status])) }, serialize));
}
if (evidence.status !== "passed") process.exitCode = 1;
