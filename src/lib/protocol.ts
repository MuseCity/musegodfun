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
  openingCapInQuote,
  type OpeningValuation,
} from "./opening-valuation";

export const routerAbi = parseAbi([
  "function execute(bytes commands, bytes[] inputs, uint256 deadline) payable",
]);
export const permit2Abi = parseAbi([
  "function approve(address token, address spender, uint160 amount, uint48 expiration)",
  "function allowance(address user, address token, address spender) view returns (uint160 amount, uint48 expiration, uint48 nonce)",
]);
// Only the selectors used for signing belong in the browser bundle.
export const claimFeesAbi = parseAbi(["function collectFees(bytes32 poolId)"]);
// multiplier() is supported by the deployed Beryl precompile. The newer
// uiMultiplier() selector is not active on the verified mainnet snapshot.
export const b20Abi = parseAbi([
  "function multiplier() view returns (uint256)",
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
export function tokenMetadata(input: LaunchInput, openingValuation: OpeningValuation, chainId: 8453 | 4663 = 8453, feeEngine?: Address) {
  assertOpeningValuation(openingValuation, input.quoteAddress, chainId);
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
) {
  const contracts = contractsFor({ mode: chainId === 4663 ? "robinhood" : "base" });
  const draft = launchSchema.parse(input),
    stock = stockByAddress(draft.quoteAddress);
  if (stock.chainId !== chainId) throw new Error("The paired asset is on a different deployment network");
  assertOpeningValuation(openingValuation, stock.address, chainId);
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
      tokenURI: `data:application/json,${encodeURIComponent(JSON.stringify(tokenMetadata(draft, openingValuation, chainId, feeEngine)))}`,
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
      fee: 500,
      tickSpacing: LAUNCH_CURVE_TICK_SPACING,
      beneficiaries: lpBeneficiaries,
      curves: buildLaunchCurves(),
    })
    .withRehypeDopplerHookInitializer({
      hookAddress: contracts.rehype,
      startFee: 10_000,
      endFee: 10_000,
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

// Bind the engine field in a preview to both immutable beneficiary arrays in
// the exact CreateParams that will be signed, including guarded first buys.
export function assertEngineFeeCalldata(input: { feePolicy?: string; feeEngine?: Address; creator: Address; feeTreasury?: Address }, poolInitializerData: Hex) {
  if (input.feePolicy !== ENGINE_FEE_POLICY) {
    if (input.feeEngine) throw new Error("The fee engine does not match the launch fee policy");
    return;
  }
  if (!input.feeEngine || !input.feeTreasury || [input.creator, input.feeTreasury, DEAD, "0x0000000000000000000000000000000000000000"].some((address) => sameAddress(address, input.feeEngine!)))
    throw new Error("The fee engine is missing or overlaps another beneficiary");
  const [pool] = decodeAbiParameters(parseAbiParameters("(uint24 fee, int24 tickSpacing, int24 farTick, (int24 tickLower, int24 tickUpper, uint16 numPositions, uint256 shares)[] curves, (address beneficiary, uint96 shares)[] beneficiaries, address dopplerHook, bytes onInitializationDopplerHookCalldata, bytes graduationDopplerHookCalldata)"), poolInitializerData);
  const [hook] = decodeAbiParameters(parseAbiParameters("(address numeraire,address buybackDst,uint24 startFee,uint24 endFee,uint32 durationSeconds,uint32 startingTime,uint8 feeRoutingMode,(uint64 assetFeesToAssetBuybackWad,uint64 assetFeesToNumeraireBuybackWad,uint64 assetFeesToBeneficiaryWad,uint64 assetFeesToLpWad,uint64 numeraireFeesToAssetBuybackWad,uint64 numeraireFeesToNumeraireBuybackWad,uint64 numeraireFeesToBeneficiaryWad,uint64 numeraireFeesToLpWad) feeDistributionInfo,(address beneficiary,uint96 shares)[] feeBeneficiaries,(address integrator,uint24 feeShare,uint32 assetFeesToNumeraireRatio,uint32 numeraireFeesToAssetRatio,bool automaticPayout) integratorConfig)"), pool.onInitializationDopplerHookCalldata);
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
export async function assertStock(
  client: Pick<PublicClient<Transport, typeof base>, "readContract">,
  address: Address,
  blockNumber?: bigint,
) {
  const stock = stockByAddress(address);
  // Official address + successful native calls identify the asset. B20s have
  // a precompile marker (currently 0xef), not ordinary ERC-20 bytecode.
  const [symbol, decimals, name, totalSupply, multiplierWad] =
    await Promise.all([
      client.readContract({
        address,
        abi: erc20Abi,
        functionName: "symbol",
        blockNumber,
      }),
      client.readContract({
        address,
        abi: erc20Abi,
        functionName: "decimals",
        blockNumber,
      }),
      client.readContract({
        address,
        abi: erc20Abi,
        functionName: "name",
        blockNumber,
      }),
      client.readContract({
        address,
        abi: erc20Abi,
        functionName: "totalSupply",
        blockNumber,
      }),
      stock.standard === "B20" ? client.readContract({
        address, abi: b20Abi, functionName: "multiplier", blockNumber,
      }) : Promise.resolve(null),
    ]);
  if (
    symbol !== stock.symbol ||
    decimals !== stock.decimals ||
    (stock.standard === "B20" && (multiplierWad === null || multiplierWad <= 0n))
  )
    throw new Error(`${stock.ticker} contract identity verification failed`);
  return { stock, name, totalSupply, multiplierWad };
}
