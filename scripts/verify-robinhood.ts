import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { createPublicClient, erc20Abi, http, keccak256, parseAbi, type Address } from "viem";
import { robinhood } from "viem/chains";
import { airlockAbi, DopplerSDK } from "@whetstone-research/doppler-sdk/evm";
import { assetsFor, contractsFor, sameAddress } from "../src/lib/config";
import { buildLaunch } from "../src/lib/protocol";
import { runtimeFromEnv } from "../server/config";
import { readOpeningValuation } from "../server/opening-price";

const runtime = runtimeFromEnv();
assert.equal(runtime.config.mode, "robinhood", "Use CHAIN_MODE=robinhood");
assert.equal(runtime.config.chainId, 4663);
assert(runtime.config.treasury, "A configured platform treasury is required for read-only issuance simulation");
const contracts = contractsFor(runtime.config), assets = assetsFor(runtime.config);
const musegodAddress: Address = "0x0379E228F6887c6F18bf394042ECAF81B308cb2e";
const excludedReferenceAssets = [
  { symbol: "U", address: "0xce24439f2d9c6a2289f741120fe202248b666666" },
  { symbol: "PAIR", address: "0x6b1d42927b1a84ec28fa88d4fc6fa7af404966be" },
];
const musegod = assets.find((asset) => sameAddress(asset.address, musegodAddress));
assert(musegod, "The curated Robinhood whitelist must contain MUSEGOD");
assert.equal(musegod.symbol, "MUSEGOD");
assert.equal(musegod.ticker, "MUSEGOD");
assert.equal(musegod.category, "OTHERS");
assert.equal(musegod.decimals, 18);
for (const excluded of excludedReferenceAssets)
  assert(!assets.some((asset) => sameAddress(asset.address, excluded.address) || asset.symbol === excluded.symbol),
    `${excluded.symbol} must be excluded from the curated whitelist`);
const client = createPublicClient({ chain: robinhood,
  transport: http(runtime.rpcUrl, { timeout: 40_000, retryCount: 0 }) });
assert.equal(await client.getChainId(), 4663);
const blockNumber = await client.getBlockNumber({ cacheTime: 0 });
const block = await client.getBlock({ blockNumber });
const bindingsAbi = parseAbi([
  "function airlock() view returns(address)", "function poolManager() view returns(address)",
  "function isDopplerHookEnabled(address) view returns(uint256)",
]);
const expectedModuleStates = { tokenFactory: 1, noOpGovernance: 2, initializer: 3, noOpMigrator: 4 };
const modules = [];
for (const [name, address] of Object.entries(contracts)) {
  const code = await client.getCode({ address, blockNumber });
  assert(code && code !== "0x", `${name} canonical deployment must have bytecode`);
  const expectedState = expectedModuleStates[name as keyof typeof expectedModuleStates];
  const state = expectedState === undefined ? undefined : Number(await client.readContract({
    address: contracts.airlock, abi: airlockAbi, functionName: "getModuleState", args: [address], blockNumber,
  }));
  if (expectedState !== undefined) assert.equal(state, expectedState);
  modules.push({ name, address, codeBytes: (code.length - 2) / 2, codeHash: keccak256(code), state });
}
for (const name of ["tokenFactory", "initializer"] as const)
  assert(sameAddress(await client.readContract({ address: contracts[name], abi: bindingsAbi,
    functionName: "airlock", blockNumber }), contracts.airlock));
for (const name of ["initializer", "rehype", "quoter"] as const)
  assert(sameAddress(await client.readContract({ address: contracts[name], abi: bindingsAbi,
    functionName: "poolManager", blockNumber }), contracts.poolManager));
assert((await client.readContract({ address: contracts.initializer, abi: bindingsAbi,
  functionName: "isDopplerHookEnabled", args: [contracts.rehype], blockNumber })) > 0n);

const referenceUrl = "https://pair.fund/api/official-paired-markets?chainId=4663";
const referenceResponse = await fetch(referenceUrl, { signal: AbortSignal.timeout(25_000) });
assert(referenceResponse.ok, "PAIR's public Robinhood launch catalog must be available");
const reference = await referenceResponse.json() as { chainId: number; markets: {
  chainId: number; address: string; symbol: string; name: string; category: string;
}[] };
assert.equal(reference.chainId, 4663);
for (const excluded of excludedReferenceAssets) {
  const matched = reference.markets.find((asset) => asset.symbol === excluded.symbol);
  assert(matched, `${excluded.symbol} must be identified in the source catalog`);
  assert(sameAddress(matched.address, excluded.address));
}
const retainedReference = reference.markets.filter((asset) =>
  !excludedReferenceAssets.some((excluded) => sameAddress(excluded.address, asset.address)) &&
  !sameAddress(asset.address, musegodAddress));
const retainedAssets = assets.filter((asset) => !sameAddress(asset.address, musegodAddress));
assert.equal(retainedReference.length, retainedAssets.length,
  "Review changed PAIR catalog before updating the curated launch whitelist");
const referenceByAddress = new Map(retainedReference.map((asset) => [asset.address.toLowerCase(), asset]));
assert.equal(referenceByAddress.size, retainedAssets.length, "Retained reference assets must have unique addresses");
for (const asset of retainedAssets) {
  const matched = referenceByAddress.get(asset.address.toLowerCase());
  assert(matched, `${asset.symbol} must match the live PAIR catalog by address`);
  assert.equal(matched.chainId, 4663);
  assert.equal(matched.symbol, asset.symbol);
  assert.equal(matched.name, asset.name);
  assert.equal(matched.category, asset.category);
}
const catalogResponse = await fetch("https://api.robinhood.com/rhj/assets", { signal: AbortSignal.timeout(25_000) });
assert(catalogResponse.ok, "Official Robinhood catalog must be available for issuer provenance verification");
const catalog = await catalogResponse.json();
const official = new Map<string, { symbol: string; status: string }>();
for (const asset of catalog.assets ?? []) for (const deployment of asset.deployments ?? [])
  if (deployment.chainId === 4663) official.set(deployment.contractAddress.toLowerCase(), {
    symbol: asset.tokenSymbol, status: asset.status,
  });
const readings = [];
for (let offset = 0; offset < assets.length; offset += 20) {
  const chunk = assets.slice(offset, offset + 20);
  const results = await client.multicall({ blockNumber, allowFailure: true,
    contracts: chunk.flatMap((asset) => ["name", "symbol", "decimals", "totalSupply"].map((functionName) => ({
      address: asset.address, abi: erc20Abi, functionName,
    }))),
  });
  for (let index = 0; index < chunk.length; index++) {
    const asset = chunk[index], result = results.slice(index * 4, index * 4 + 4);
    assert(result.every((row) => row.status === "success"), `${asset.symbol} ERC20 metadata unavailable`);
    const [name, symbol, decimals, totalSupply] = result.map((row) => row.status === "success" ? row.result : null);
    assert.equal(String(symbol).toUpperCase(), asset.symbol.toUpperCase());
    assert.equal(Number(decimals), asset.decimals);
    const provenance = official.get(asset.address.toLowerCase());
    const other = asset.category === "OTHERS";
    if (!other) {
      assert(provenance, `${asset.symbol} must match an official Robinhood deployment by address`);
      assert.equal(provenance.symbol.toUpperCase(), asset.symbol.toUpperCase());
      assert.equal(provenance.status, "ASSET_STATUS_ACTIVE");
    }
    if (sameAddress(asset.address, musegodAddress)) {
      assert.equal(name, "MUSEGOD");
      assert(BigInt(totalSupply as bigint) > 0n, "MUSEGOD must be a deployed token with positive supply");
    }
    readings.push({ address: asset.address, symbol, name, decimals, totalSupply,
      officialStockAddressMatched: !other, sourceStatus: provenance?.status ?? null });
  }
  console.log(`Robinhood read verification ${readings.length}/${assets.length}`);
}
const sdk = new DopplerSDK<4663>({ publicClient: client, chainId: 4663 });
const owner = await client.readContract({ address: contracts.airlock, abi: airlockAbi,
  functionName: "owner", blockNumber });
const creator: Address = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const simulations = [];
for (const ticker of ["WETH", "NVDA", "USDG", "cbBTC", "MUSEGOD"]) {
  const asset = assets.find((row) => row.ticker === ticker);
  assert(asset);
  const openingValuation = await readOpeningValuation(client, asset, 4663, runtime.lifi);
  const params = buildLaunch(sdk, {
    name: "Robinhood Read-only Simulation", symbol: "RHSIM",
    description: "Read-only eth_call. No signature or broadcast.", image: "",
    quoteAddress: asset.address,
  }, creator, runtime.config.treasury, owner, openingValuation, undefined, 4663);
  const simulation = await client.simulateContract({ address: contracts.airlock,
    abi: airlockAbi, functionName: "create",
    args: [sdk.factory.encodeCreateMulticurveParams(params)], account: creator, blockNumber: BigInt(openingValuation.blockNumber) });
  simulations.push({ ticker, quoteAddress: asset.address, decimals: asset.decimals,
    method: "eth_call", success: true, predictedToken: simulation.result[0], openingValuation });
}
assert.equal((await client.getBlock({ blockNumber })).hash, block.hash, "Evidence block must stay canonical");
await mkdir(".cache", { recursive: true });
await writeFile(".cache/robinhood-read-proof.json", JSON.stringify({
  scope: "Robinhood mainnet identity reads and issuance eth_call only; no signing or transactions.",
  observedAt: new Date().toISOString(), chainId: 4663, blockNumber, blockHash: block.hash,
  modules, bindingsVerified: true, assets: readings, simulations,
  stockProvenanceSource: "https://api.robinhood.com/rhj/assets",
  catalogReference: referenceUrl, curatedReferenceCatalogMatched: true,
  assetPolicy: { excludedReferenceAssets, customAssets: [{ symbol: musegod.symbol,
    address: musegod.address, category: musegod.category, decimals: musegod.decimals }],
    retainedReferenceAssetCount: retainedAssets.length, totalCuratedAssetCount: assets.length },
  mainnetTransactionsSubmitted: false,
}, (_, value) => typeof value === "bigint" ? String(value) : value, 2) + "\n");
console.log(JSON.stringify({ chainId: 4663, blockNumber: String(blockNumber), assetsVerified: readings.length,
  stockAddressesMatched: readings.filter((row) => row.officialStockAddressMatched).length,
  canonicalModulesVerified: modules.length, simulations }, null, 2));
