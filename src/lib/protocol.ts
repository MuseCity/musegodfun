import type {
  DopplerSDK,
  BeneficiaryData,
  V4PoolKey,
} from "@whetstone-research/doppler-sdk/evm";
import {
  encodeAbiParameters,
  decodeAbiParameters,
  encodeFunctionData,
  erc20Abi,
  getAddress,
  parseAbi,
  parseAbiParameters,
  type Address,
  type Hex,
  type PublicClient,
  type Transport,
} from "viem";
import { base } from "viem/chains";
import {
  CONTRACTS,
  ROBINHOOD_CONTRACTS,
  contractsFor,
  type ContractRegistry,
  DEAD,
  SUPPLY,
  WAD,
  sameAddress,
  stockByAddress,
} from "./config";
import { launchSchema, minimumOutput, type LaunchInput } from "./validation";
import { ENGINE_FEE_POLICY, FEE_POLICY, FEE_SHARES, MUSEGOD_BUYBACK } from "./fee-policy";
import { CURVE_POLICY, buildLaunchCurves, LAUNCH_CURVE_TICK_SPACING } from "./launch-curve";
import {
  assertOpeningValuation,
  assertHistoricalOpeningValuation,
  openingCapInQuote,
  type OpeningValuation,
  type LaunchWarning,
} from "./opening-valuation";
import { LP_FEE_PPM, tradingFeeBpsFor } from "./trading-fee";

export const routerAbi = parseAbi([
  "function execute(bytes commands, bytes[] inputs, uint256 deadline) payable",
]);
export const permit2Abi = parseAbi([
  "function approve(address token, address spender, uint160 amount, uint48 expiration)",
  "function allowance(address user, address token, address spender) view returns (uint160 amount, uint48 expiration, uint48 nonce)",
]);
// Only the selectors used for signing belong in the browser bundle.
export const claimFeesAbi = parseAbi(["function collectFees(bytes32 poolId)"]);
// Coinbase B20 and Robinhood ERC-8056 expose different multiplier selectors.
export const b20Abi = parseAbi([
  "function multiplier() view returns (uint256)",
  "function uiMultiplier() view returns (uint256)",
  "function newUIMultiplier() view returns (uint256)",
  "function effectiveAt() view returns (uint256)",
  "function paused() view returns (bool)",
  "function oraclePaused() view returns (bool)",
]);
export function beneficiaries(entries: BeneficiaryData[]): BeneficiaryData[] {
  const merged = new Map<Address, bigint>();
  for (const e of entries) {
    const a = getAddress(e.beneficiary);
    merged.set(a, (merged.get(a) ?? 0n) + e.shares);
  }
  const result = [...merged]
    .map(([beneficiary, shares]) => ({ beneficiary, shares }))
    .sort((a, b) =>
      a.beneficiary.toLowerCase().localeCompare(b.beneficiary.toLowerCase()),
    );
  if (
    result.some((e) => e.shares <= 0n) ||
    result.reduce((n, e) => n + e.shares, 0n) !== WAD
  )
    throw new Error("Fee shares must total 100%");
  return result;
}
export function tokenMetadata(input: LaunchInput, openingValuation: OpeningValuation, chainId: 8453 | 4663 = 8453, feeEngine?: Address, recovery = false) {
  if (recovery) assertHistoricalOpeningValuation(openingValuation, input.quoteAddress, chainId);
  else assertOpeningValuation(openingValuation, input.quoteAddress, chainId);
  return {
    name: input.name,
    symbol: input.symbol,
    description: input.description,
    image: input.image,
    external_url: input.website || undefined,
    socials: {
      twitter: input.twitter || undefined,
      telegram: input.telegram || undefined,
    },
    properties: {
      platform: "musegod.fun",
      chainId,
      quote: input.quoteAddress,
      openingCap: openingCapInQuote(openingValuation),
      openingValuation,
      curvePolicy: CURVE_POLICY,
      tradingFeeBps: tradingFeeBpsFor(input.tradingFeeBps),
      feePolicy: feeEngine ? ENGINE_FEE_POLICY : FEE_POLICY,
      ...(feeEngine ? { feeEngine } : {}),
      feeDistribution: {
        basis: "total_fees",
        protocolBps: FEE_SHARES.protocol,
        creatorBps: FEE_SHARES.creator,
        platformBps: FEE_SHARES.platform,
      },
      platformIncomeAllocation: {
        basis: "platform_income",
        buybackBps: FEE_SHARES.platformBuyback,
        operationsBps: FEE_SHARES.platformOperations,
        execution: feeEngine ? "permissionless_weth_swapper" : "treasury_manual_allocation",
      },
      buyback: MUSEGOD_BUYBACK,
    },
  };
}
export function buildLaunch(
  sdk: DopplerSDK<8453 | 4663>,
  input: LaunchInput,
  creator: Address,
  treasury: Address,
  protocolOwner: Address,
  openingValuation: OpeningValuation,
  salt?: Hex,
  chainId: 8453 | 4663 = 8453,
  feeEngine?: Address,
  recovery = false,
) {
  const contracts = contractsFor({ mode: chainId === 4663 ? "robinhood" : "base" });
  const draft = launchSchema.parse(input),
    stock = stockByAddress(draft.quoteAddress);
  if (stock.chainId !== chainId) throw new Error("The paired asset is on a different deployment network");
  if (recovery) assertHistoricalOpeningValuation(openingValuation, stock.address, chainId);
  else assertOpeningValuation(openingValuation, stock.address, chainId);
  if (feeEngine && (chainId !== 4663 || [creator, treasury, protocolOwner, DEAD, "0x0000000000000000000000000000000000000000"].some((address) => sameAddress(feeEngine, address))))
    throw new Error("The fee engine must be a distinct Robinhood Chain beneficiary");
  const lpBeneficiaries = beneficiaries([
    {
      beneficiary: protocolOwner,
      shares: (WAD * BigInt(FEE_SHARES.protocol)) / 10_000n,
    },
    {
      beneficiary: creator,
      shares: (WAD * BigInt(FEE_SHARES.creator)) / 10_000n,
    },
    {
      beneficiary: treasury,
      shares: (WAD * BigInt(feeEngine ? FEE_SHARES.operations : FEE_SHARES.platform)) / 10_000n,
    },
    ...(feeEngine ? [{ beneficiary: feeEngine, shares: WAD * BigInt(FEE_SHARES.buyback) / 10_000n }] : []),
  ]);
  const hookBeneficiaries = beneficiaries([
    {
      beneficiary: creator,
      shares: (WAD * BigInt(FEE_SHARES.creatorNet)) / 10_000n,
    },
    {
      beneficiary: treasury,
      shares: (WAD * BigInt(feeEngine ? FEE_SHARES.platformNet * FEE_SHARES.platformOperations / 10_000 : FEE_SHARES.platformNet)) / 10_000n,
    },
    ...(feeEngine ? [{ beneficiary: feeEngine, shares: WAD * BigInt(FEE_SHARES.platformNet * FEE_SHARES.platformBuyback / 10_000) / 10_000n }] : []),
  ]);
  const builder = sdk
    .buildMulticurveAuction()
    .tokenConfig({
      type: "dopplerERC20V1",
      name: draft.name,
      symbol: draft.symbol,
      tokenURI: `data:application/json,${encodeURIComponent(JSON.stringify(tokenMetadata(draft, openingValuation, chainId, feeEngine, recovery)))}`,
    })
    .saleConfig({
      initialSupply: SUPPLY,
      numTokensToSell: SUPPLY,
      numeraire: stock.address,
    })
    .withCurves({
      numerairePrice: Number(openingValuation.quotePriceUsd),
      numeraireDecimals: stock.decimals,
      tokenDecimals: 18,
      fee: LP_FEE_PPM,
      tickSpacing: LAUNCH_CURVE_TICK_SPACING,
      beneficiaries: lpBeneficiaries,
      curves: buildLaunchCurves(),
    })
    .withRehypeDopplerHookInitializer({
      hookAddress: contracts.rehype,
      startFee: draft.tradingFeeBps * 100,
      endFee: draft.tradingFeeBps * 100,
      durationSeconds: 0,
      feeRoutingMode: "routeToBeneficiaryFees",
      feeBeneficiaries: hookBeneficiaries as [
        BeneficiaryData,
        ...BeneficiaryData[],
      ],
      feeDistributionInfo: {
        assetFeesToAssetBuybackWad: 0n,
        assetFeesToNumeraireBuybackWad: WAD,
        assetFeesToBeneficiaryWad: 0n,
        assetFeesToLpWad: 0n,
        numeraireFeesToAssetBuybackWad: 0n,
        numeraireFeesToNumeraireBuybackWad: 0n,
        numeraireFeesToBeneficiaryWad: WAD,
        numeraireFeesToLpWad: 0n,
      },
    })
    .withFeeDistributionController(DEAD)
    .withGovernance({ type: "noOp" })
    .withMigration({ type: "noOp" })
    .withTokenFactory(contracts.tokenFactory)
    .withDopplerHookInitializer(contracts.initializer)
    .withGovernanceFactory(contracts.noOpGovernance)
    .withNoOpMigrator(contracts.noOpMigrator)
    .withUserAddress(creator)
    .withIntegrator(treasury);
  if (salt) builder.withSalt(salt);
  const params = builder.build();
  // dopplerERC20V1 selects its dedicated module address in SDK 1.0.43.
  params.modules = {
    ...params.modules,
    dopplerERC20V1Factory: contracts.tokenFactory,
  };
  return params;
}

const launchPoolDataAbi = parseAbiParameters("(uint24 fee, int24 tickSpacing, int24 farTick, (int24 tickLower, int24 tickUpper, uint16 numPositions, uint256 shares)[] curves, (address beneficiary, uint96 shares)[] beneficiaries, address dopplerHook, bytes onInitializationDopplerHookCalldata, bytes graduationDopplerHookCalldata)");
const rehypeInitializationDataAbi = parseAbiParameters("(address numeraire,address buybackDst,uint24 startFee,uint24 endFee,uint32 durationSeconds,uint32 startingTime,uint8 feeRoutingMode,(uint64 assetFeesToAssetBuybackWad,uint64 assetFeesToNumeraireBuybackWad,uint64 assetFeesToBeneficiaryWad,uint64 assetFeesToLpWad,uint64 numeraireFeesToAssetBuybackWad,uint64 numeraireFeesToNumeraireBuybackWad,uint64 numeraireFeesToBeneficiaryWad,uint64 numeraireFeesToLpWad) feeDistributionInfo,(address beneficiary,uint96 shares)[] feeBeneficiaries,(address integrator,uint24 feeShare,uint32 assetFeesToNumeraireRatio,uint32 numeraireFeesToAssetRatio,bool automaticPayout) integratorConfig)");
export function launchFeeData(poolInitializerData: Hex) {
  const [pool] = decodeAbiParameters(launchPoolDataAbi, poolInitializerData);
  const [hook] = decodeAbiParameters(rehypeInitializationDataAbi, pool.onInitializationDopplerHookCalldata);
  return { pool, hook };
}

export function assertTradingFeeCalldata(tradingFeeBps: number | undefined, poolInitializerData: Hex, rehype: Address) {
  const expected = tradingFeeBpsFor(tradingFeeBps) * 100;
  const { pool, hook } = launchFeeData(poolInitializerData);
  if (pool.fee !== LP_FEE_PPM || !sameAddress(pool.dopplerHook, rehype) ||
    hook.startFee !== expected || hook.endFee !== expected || hook.durationSeconds !== 0)
    throw new Error("The launch calldata does not match the selected fixed trading fee");
}

// Bind the engine field in a preview to both immutable beneficiary arrays in
// the exact CreateParams that will be signed, including guarded first buys.
export function assertEngineFeeCalldata(input: { feePolicy?: string; feeEngine?: Address; creator: Address; feeTreasury?: Address }, poolInitializerData: Hex) {
  if (input.feePolicy !== ENGINE_FEE_POLICY) {
    if (input.feeEngine) throw new Error("The fee engine does not match the launch fee policy");
    return;
  }
  if (!input.feeEngine || !input.feeTreasury || [input.creator, input.feeTreasury, DEAD, "0x0000000000000000000000000000000000000000"].some((address) => sameAddress(address, input.feeEngine!)))
    throw new Error("The fee engine is missing or overlaps another beneficiary");
  const { pool, hook } = launchFeeData(poolInitializerData);
  const lp = pool.beneficiaries.filter((entry) => sameAddress(entry.beneficiary, input.feeEngine!));
  const trade = hook.feeBeneficiaries.filter((entry) => sameAddress(entry.beneficiary, input.feeEngine!));
  if (lp.length !== 1 || trade.length !== 1 || lp[0].shares !== WAD * 2280n / 10_000n || trade[0].shares !== WAD * 2400n / 10_000n ||
    !sameAddress(pool.dopplerHook, ROBINHOOD_CONTRACTS.rehype) || hook.feeRoutingMode !== 1)
    throw new Error("The launch calldata does not contain the fixed fee engine shares");
}
export function swapTransaction(
  poolKey: V4PoolKey,
  currencyIn: Address,
  amountIn: bigint,
  amountOut: bigint,
  slippageBps: number,
  deadline: bigint,
  contracts: ContractRegistry = CONTRACTS,
) {
  if (
    !sameAddress(currencyIn, poolKey.currency0) &&
    !sameAddress(currencyIn, poolKey.currency1)
  )
    throw new Error("The input asset does not belong to this pool");
  if (amountIn <= 0n || amountIn >= 2n ** 128n)
    throw new Error("The amount exceeds the uint128 range");
  const zeroForOne = sameAddress(currencyIn, poolKey.currency0);
  const currencyOut = zeroForOne ? poolKey.currency1 : poolKey.currency0;
  const minOut = minimumOutput(amountOut, slippageBps);
  // Robinhood's deployed router decodes the newer exact-input struct, including
  // minHopPriceX36. Base's existing router keeps the original five-field ABI.
  // Both enforce amountOutMinimum and TAKE_ALL's minimum output.
  const robinhoodRouter = sameAddress(contracts.router, ROBINHOOD_CONTRACTS.router);
  const swap = encodeAbiParameters(
    [
      {
        type: "tuple",
        components: [
          {
            name: "poolKey",
            type: "tuple",
            components: [
              { name: "currency0", type: "address" },
              { name: "currency1", type: "address" },
              { name: "fee", type: "uint24" },
              { name: "tickSpacing", type: "int24" },
              { name: "hooks", type: "address" },
            ],
          },
          { name: "zeroForOne", type: "bool" },
          { name: "amountIn", type: "uint128" },
          { name: "amountOutMinimum", type: "uint128" },
          ...(robinhoodRouter ? [{ name: "minHopPriceX36", type: "uint256" }] : []),
          { name: "hookData", type: "bytes" },
        ],
      },
    ],
    [
      {
        poolKey,
        zeroForOne,
        amountIn,
        amountOutMinimum: minOut,
        ...(robinhoodRouter ? { minHopPriceX36: 0n } : {}),
        hookData: "0x",
      },
    ],
  );
  const settle = encodeAbiParameters(
    [{ type: "address" }, { type: "uint256" }],
    [currencyIn, amountIn],
  );
  const take = encodeAbiParameters(
    [{ type: "address" }, { type: "uint256" }],
    [currencyOut, minOut],
  );
  const actions = encodeAbiParameters(
    [{ type: "bytes" }, { type: "bytes[]" }],
    ["0x060c0f", [swap, settle, take]],
  );
  return {
    to: contracts.router,
    data: encodeFunctionData({
      abi: routerAbi,
      functionName: "execute",
      args: ["0x10", [actions], deadline],
    }),
    value: 0n,
    minOut,
    currencyOut,
  };
}
/** Auxiliary stock metadata is advisory. Only known transfer pauses and observed
 * identity mismatches stop a preview; strict execution callers require identity. */
export async function readStockStatus(
  client: Pick<PublicClient<Transport, typeof base>, "readContract">,
  address: Address, blockNumber?: bigint, requireIdentity = false,
) {
  const stock = stockByAddress(address), rhStock = stock.chainId === 4663 && stock.issuer === "Robinhood";
  const [symbol, decimals, name, totalSupply, multiplier, scheduled, effectiveAt, paused, oraclePaused] = await Promise.allSettled([
    client.readContract({ address, abi: erc20Abi, functionName: "symbol", blockNumber }),
    client.readContract({ address, abi: erc20Abi, functionName: "decimals", blockNumber }),
    client.readContract({ address, abi: erc20Abi, functionName: "name", blockNumber }),
    client.readContract({ address, abi: erc20Abi, functionName: "totalSupply", blockNumber }),
    stock.standard === "B20" ? client.readContract({ address, abi: b20Abi, functionName: "multiplier", blockNumber }) :
      rhStock ? client.readContract({ address, abi: b20Abi, functionName: "uiMultiplier", blockNumber }) : Promise.resolve(null),
    rhStock ? client.readContract({ address, abi: b20Abi, functionName: "newUIMultiplier", blockNumber }) : Promise.resolve(null),
    rhStock ? client.readContract({ address, abi: b20Abi, functionName: "effectiveAt", blockNumber }) : Promise.resolve(null),
    client.readContract({ address, abi: b20Abi, functionName: "paused", blockNumber }),
    rhStock ? client.readContract({ address, abi: b20Abi, functionName: "oraclePaused", blockNumber }) : Promise.resolve(null),
  ]);
  const identityVerified = symbol.status === "fulfilled" && decimals.status === "fulfilled";
  if ((symbol.status === "fulfilled" && symbol.value !== stock.symbol) ||
    (decimals.status === "fulfilled" && decimals.value !== stock.decimals) || (requireIdentity && !identityVerified))
    throw new Error(`${stock.ticker} contract identity verification failed`);
  if (paused.status === "fulfilled" && paused.value === true)
    throw new Error(`${stock.ticker} transfers are paused on chain.`);
  const positive = (result: PromiseSettledResult<bigint | null>) => result.status === "fulfilled" && typeof result.value === "bigint" && result.value > 0n ? result.value : null;
  const multiplierWad = positive(multiplier), newMultiplierWad = positive(scheduled);
  const warnings: LaunchWarning[] = [];
  if ([symbol, decimals, name, totalSupply, multiplier, scheduled, effectiveAt].some((result) => result.status === "rejected") ||
    ((stock.standard === "B20" || rhStock) && multiplierWad === null))
    warnings.push({ code: "asset_status_unavailable", message: `${stock.ticker} has incomplete live metadata. Its pinned address and transaction simulation remain authoritative; share-equivalent estimates may be unavailable.` });
  if (oraclePaused.status === "fulfilled" && oraclePaused.value === true)
    warnings.push({ code: "asset_oracle_paused", message: `${stock.ticker}'s issuer price oracle is paused. Review the live executable quote; the reference feed is unavailable.` });
  return { stock, name: name.status === "fulfilled" ? name.value : stock.name,
    totalSupply: totalSupply.status === "fulfilled" ? totalSupply.value : null, multiplierWad, newMultiplierWad,
    multiplierEffectiveAt: effectiveAt.status === "fulfilled" && typeof effectiveAt.value === "bigint" && effectiveAt.value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(effectiveAt.value) : null,
    paused: paused.status === "fulfilled" && typeof paused.value === "boolean" ? paused.value : null,
    oraclePaused: oraclePaused.status === "fulfilled" && typeof oraclePaused.value === "boolean" ? oraclePaused.value : null,
    identityVerified, warnings };
}
export async function assertStock(client: Pick<PublicClient<Transport, typeof base>, "readContract">, address: Address, blockNumber?: bigint) {
  return readStockStatus(client, address, blockNumber, true);
}
