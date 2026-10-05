import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DopplerSDK,
  feeClaimsInitializerAbi,
  feesManagerAbi,
  tickToMarketCap,
} from "@whetstone-research/doppler-sdk/evm";
import {
  createPublicClient,
  decodeAbiParameters,
  decodeFunctionData,
  encodeFunctionData,
  http,
  formatUnits,
  parseAbiParameters,
  zeroAddress,
  type Address,
  type Hex,
} from "viem";
import { base } from "viem/chains";
import {
  CONTRACTS,
  DEAD,
  STOCKS,
  ROBINHOOD_STOCKS,
  SUPPLY,
  WAD,
  poolCurrency,
  shareEquivalent,
  stockByAddress,
  listedTokens,
} from "../src/lib/config";
import { FEE_POLICY, FEE_SHARES, MUSEGOD_BUYBACK } from "../src/lib/fee-policy";
import { OPENING_CAP_USD, OPENING_POLICY, LAUNCH_PRICE_TTL, assertOpeningValuation, openingCapInQuote } from "../src/lib/opening-valuation";
import {
  beneficiaries,
  buildLaunch,
  routerAbi,
  swapTransaction,
  claimFeesAbi,
  assertStock,
  tokenMetadata,
} from "../src/lib/protocol";
import {
  launchSchema,
  minimumOutput,
  parseAmount,
  restoreDraft,
  safeImage,
  validTreasury,
  simulationError,
  safeSocialLink,
} from "../src/lib/validation";
import { Store, type LaunchPlan } from "../server/store";
import { runtimeFromEnv, LaunchpadService } from "../server/service";
import { syntheticToken, syntheticOpeningValuation } from "./fixtures";

const creator = "0x0000000000000000000000000000000000000001" as Address;
const treasury = "0x0000000000000000000000000000000000000002" as Address;
const owner = "0x0000000000000000000000000000000000000003" as Address;
const draft = {
  name: "Test Meme",
  symbol: "MEME",
  description: "",
  image: "",
  quoteAddress: STOCKS[0].address,
};
const sdk = new DopplerSDK<8453>({
  publicClient: createPublicClient({ chain: base, transport: http() }),
  chainId: 8453,
});

test("fixed USD valuation validates its exact asset, policy, evidence and five-minute price expiry", () => {
  const quotedAt = 1_800_000_000_000;
  const snapshot = syntheticOpeningValuation(STOCKS[0].address, "100", {
    quotedAt, expiresAt: quotedAt + LAUNCH_PRICE_TTL, sourceUpdatedAt: quotedAt,
  });
  assert.equal(snapshot.policy, OPENING_POLICY);
  assert.equal(snapshot.marketCapUsd, OPENING_CAP_USD);
  assert.doesNotThrow(() => assertOpeningValuation(snapshot, STOCKS[0].address, 8453, quotedAt));
  assert.doesNotThrow(() => assertOpeningValuation(snapshot, STOCKS[0].address, 8453, snapshot.expiresAt - 1));
  assert.throws(() => assertOpeningValuation(snapshot, STOCKS[0].address, 8453, snapshot.expiresAt), /expired/);
  assert.throws(() => assertOpeningValuation(snapshot, STOCKS[0].address, 8453, quotedAt - 1), /expired/);
  assert.throws(() => assertOpeningValuation(undefined, STOCKS[0].address, 8453, quotedAt), /policy has changed/);
  assert.throws(() => assertOpeningValuation({ ...snapshot, policy: "future-v2" }, STOCKS[0].address, 8453, quotedAt), /policy has changed/);
  assert.throws(() => assertOpeningValuation({ ...snapshot, marketCapUsd: 6000 }, STOCKS[0].address, 8453, quotedAt), /policy has changed/);
  assert.throws(() => assertOpeningValuation(snapshot, STOCKS[1].address, 8453, quotedAt), /does not match/);
  assert.throws(() => assertOpeningValuation(snapshot, STOCKS[0].address, 4663, quotedAt), /does not match/);
  for (const quotePriceUsd of ["0", "-1", "NaN", "Infinity", "1e3", "1.0000000000000000001"])
    assert.throws(() => assertOpeningValuation({ ...snapshot, quotePriceUsd }, STOCKS[0].address, 8453, quotedAt), /USD price/);
  for (const patch of [
    { expiresAt: snapshot.expiresAt + 1 }, { blockHash: "0xabcd" },
    { blockNumber: "1e3" }, { sourceUpdatedAt: 0 }, { source: "unverified" },
    { source: "Chainlink" }, { source: "SushiSwap V3 TWAP", pool: creator, twapSeconds: 60 },
  ]) assert.throws(() => assertOpeningValuation({ ...snapshot, ...patch }, STOCKS[0].address, 8453, quotedAt));
});

test("quote-unit opening valuation uses integer precision without the retired 1 to 1,000,000 range", () => {
  for (const [price, expected] of [
    ["3000", "1.666666666666666666"],
    ["100000", "0.05"],
    ["0.000005", "1000000000"],
    ["0.000000000000000001", "5000000000000000000000"],
  ]) assert.equal(openingCapInQuote(syntheticOpeningValuation(STOCKS[0].address, price)), expected);
  assert.equal(openingCapInQuote(syntheticOpeningValuation()), "50");
  assert.throws(() => openingCapInQuote(syntheticOpeningValuation(STOCKS[0].address, "0")), /USD price/);
});

test("6, 8 and 18 decimal pairs encode a $5,000 opening and $50,000 curve boundary", () => {
  const robinhoodSdk = new DopplerSDK<4663>({
    publicClient: createPublicClient({ chain: { ...base, id: 4663 }, transport: http() }),
    chainId: 4663,
  });
  // Controlled prices exercise each decimal/valuation branch, not live evidence.
  for (const [ticker, quotePriceUsd] of [
    ["USDG", "1"], ["WETH", "3000"], ["cbBTC", "100000"],
    ["NVDA", "150"], ["MUSEGOD", "0.000005"],
  ]) {
    const stock = ROBINHOOD_STOCKS.find((asset) => asset.ticker === ticker)!;
    const valuation = syntheticOpeningValuation(stock.address, quotePriceUsd, { chainId: 4663 });
    const params = buildLaunch(robinhoodSdk, { ...draft, quoteAddress: stock.address }, creator, treasury, owner, valuation, undefined, 4663);
    const openingTick = params.pool.curves[0].tickLower;
    const tenfoldTick = params.pool.curves[0].tickUpper;
    const capAt = (tick: number) => tickToMarketCap({
      tick, tokenIsToken0: true, tokenSupply: SUPPLY,
      numerairePriceUSD: Number(quotePriceUsd), tokenDecimals: 18, numeraireDecimals: stock.decimals,
    });
    assert(capAt(openingTick) >= OPENING_CAP_USD);
    assert(capAt(openingTick) < OPENING_CAP_USD * 1.0001 ** 10);
    assert(capAt(tenfoldTick) >= OPENING_CAP_USD * 10);
    assert(capAt(tenfoldTick) < OPENING_CAP_USD * 10 * 1.0001 ** 10);
    assert.equal(params.pool.curves[1].tickLower, tenfoldTick);
    assert(openingTick % 10 === 0);
    const encoded = robinhoodSdk.factory.encodeCreateMulticurveParams(params);
    const [pool] = decodeAbiParameters(parseAbiParameters("(uint24 fee, int24 tickSpacing, int24 farTick, (int24 tickLower, int24 tickUpper, uint16 numPositions, uint256 shares)[] curves, (address beneficiary, uint96 shares)[] beneficiaries, address dopplerHook, bytes onInitializationDopplerHookCalldata, bytes graduationDopplerHookCalldata)"), encoded.poolInitializerData);
    assert(pool.curves[0].tickLower === openingTick);
    assert(pool.curves[0].tickUpper === tenfoldTick);
    assert.throws(() => buildLaunch(robinhoodSdk, { ...draft, quoteAddress: stock.address }, creator, treasury, owner,
      { ...valuation, quoteAddress: STOCKS[0].address }, undefined, 4663), /does not match/);
  }
});

test("service preparation derives the cap and consumes price validity during simulation", async (context) => {
  let now = 1_800_000_000_000;
  let simulationTime = 0;
  context.mock.method(Date, "now", () => now);
  const stock = ROBINHOOD_STOCKS.find((asset) => asset.ticker === "WETH")!;
  const saved: LaunchPlan[] = [];
  const robinhoodSdk = new DopplerSDK<4663>({
    publicClient: createPublicClient({ chain: { ...base, id: 4663 }, transport: http() }),
    chainId: 4663,
  });
  context.mock.method(robinhoodSdk, "getAirlockOwner", async () => owner);
  const service = Object.assign(Object.create(LaunchpadService.prototype), {
    runtime: { config: { mode: "robinhood", chainId: 4663, treasury, writesEnabled: true } },
    assertNetwork: async () => {},
    sdk: robinhoodSdk,
    client: {
      getBlock: async () => ({ number: 10n, hash: `0x${"a".repeat(64)}`, timestamp: BigInt(now / 1000) }),
      readContract: async ({ address, functionName }: { address: string; functionName: string }) => {
        if (address.toLowerCase() === stock.address.toLowerCase())
          return { name: stock.name, symbol: stock.symbol, decimals: stock.decimals, totalSupply: 1n }[functionName];
        if (functionName === "decimals") return 8;
        if (functionName === "latestRoundData") return [1n, 3000_00000000n, 1n, BigInt(now / 1000), 1n];
        throw new Error(`Unexpected fixture read: ${functionName}`);
      },
      simulateContract: async () => {
        now += simulationTime;
        return { result: [creator] };
      },
      estimateGas: async () => 1000000n,
    },
    store: { savePlan: async (plan: LaunchPlan) => saved.push(plan) },
  }) as LaunchpadService;
  const input = { ...draft, quoteAddress: stock.address };
  const plan = await service.prepare(input, creator);
  assert.equal(plan.draft.openingCap, "1.666666666666666666");
  assert.equal(plan.openingValuation?.quotePriceUsd, "3000");
  assert.equal(plan.openingValuation?.marketCapUsd, OPENING_CAP_USD);
  assert.equal(plan.openingValuation?.expiresAt, now + LAUNCH_PRICE_TTL);
  await assert.rejects(() => service.prepare({ ...input, openingCap: "5000" }, creator));
  assert.equal(saved.length, 1);
  simulationTime = LAUNCH_PRICE_TTL;
  await assert.rejects(() => service.prepare(input, creator), /price expired/);
  assert.equal(saved.length, 1, "An expired quote must not become a saved signing preview");
});

test("launch accepts only whitelisted stocks and rejects arbitrary quote assets", () => {
  assert.equal(launchSchema.parse({ ...draft, symbol: "meme" }).symbol, "MEME");
  for (const quoteAddress of [syntheticToken().address, creator, zeroAddress])
    assert.throws(() => launchSchema.parse({ ...draft, quoteAddress }));
  for (const openingCap of ["5000", "0", "0.9", "1000001", "1e3", "-1", "NaN"])
    assert.throws(() => launchSchema.parse({ ...draft, openingCap }));
  for (const field of ["openingCapUsd", "openingValuation", "quotePriceUsd"])
    assert.throws(() => launchSchema.parse({ ...draft, [field]: "5000" }));
});

const removedRobinhoodAssets = [
  "0xce24439f2d9c6a2289f741120fe202248b666666",
  "0x6b1d42927b1a84ec28fa88d4fc6fa7af404966be",
] as const;

test("Robinhood issuance rejects removed U/PAIR and accepts the verified MUSEGOD identity", () => {
  for (const quoteAddress of removedRobinhoodAssets) {
    assert.throws(() => stockByAddress(quoteAddress));
    assert.throws(() => launchSchema.parse({ ...draft, quoteAddress }));
  }
  const musegod = stockByAddress(MUSEGOD_BUYBACK.tokenAddress);
  assert.equal(musegod.symbol, "MUSEGOD");
  assert.equal(musegod.name, "MUSEGOD");
  assert.equal(musegod.chainId, 4663);
  assert.equal(musegod.decimals, 18);
  assert.equal(musegod.sourceUrl, "https://musegod.org/docs");
  const input = launchSchema.parse({ ...draft, quoteAddress: musegod.address });
  assert.equal(input.quoteAddress, musegod.address);
  assert.equal(parseAmount("1.000000000000000001", musegod.decimals), 1000000000000000001n);
  assert.throws(() => parseAmount("1.0000000000000000001", musegod.decimals));
  assert.equal(ROBINHOOD_STOCKS.filter((asset) => asset.category !== "OTHERS").length, 194);
  assert.deepEqual(ROBINHOOD_STOCKS.filter((asset) => asset.category === "OTHERS").map((asset) => asset.symbol),
    ["WETH", "USDG", "cbBTC", "MUSEGOD"]);
});

test("removed Robinhood pairs cannot return through saved drafts or the active catalog", () => {
  const config = { mode: "robinhood" as const };
  for (const quoteAddress of removedRobinhoodAssets) {
    const restored = restoreDraft(JSON.stringify({ ...draft, quoteAddress, openingCap: "777" }), config);
    assert.equal(restored.quoteAddress, ROBINHOOD_STOCKS[0].address);
    assert.equal(restored.name, draft.name);
    assert.equal("openingCap" in restored, false);
  }
  const musegod = stockByAddress(MUSEGOD_BUYBACK.tokenAddress);
  assert.equal(restoreDraft(JSON.stringify({ ...draft, quoteAddress: musegod.address }), config).quoteAddress, musegod.address);
  const history = [...removedRobinhoodAssets, musegod.address].map((quoteAddress) =>
    syntheticToken({ mode: "robinhood", quoteAddress }));
  assert.deepEqual(listedTokens(history, "robinhood"), [history[2]]);
  assert.equal(history.length, 3);
});

test("launch social links validate before encoding and survive draft restore", () => {
  const input = launchSchema.parse({
    ...draft,
    website: "https://example.com/meme",
    twitter: "https://x.com/meme",
    telegram: "https://t.me/meme",
  });
  assert.equal(restoreDraft(JSON.stringify(input)).website, input.website);
  assert.equal(restoreDraft(JSON.stringify(input)).twitter, input.twitter);
  assert.equal(restoreDraft(JSON.stringify(input)).telegram, input.telegram);
  const valuation = syntheticOpeningValuation(input.quoteAddress);
  const encoded = tokenMetadata(input, valuation);
  assert.equal(encoded.external_url, input.website);
  assert.deepEqual(encoded.socials, {
    twitter: input.twitter,
    telegram: input.telegram,
  });
  const built = buildLaunch(sdk, input, creator, treasury, owner, valuation);
  const params = sdk.factory.encodeCreateMulticurveParams(built);
  assert(
    params.tokenFactoryData.includes(
      Buffer.from(encodeURIComponent(input.website!)).toString("hex"),
    ),
  );
  for (const website of [
    "javascript:alert(1)",
    "http://example.com",
    "https://user:pass@example.com",
    "https://localhost/test",
  ])
    assert.throws(() => launchSchema.parse({ ...draft, website }));
  for (const twitter of [
    "https://x.com.evil.test/meme",
    "https://example.com/meme",
  ])
    assert.throws(() => launchSchema.parse({ ...draft, twitter }));
  assert.throws(() =>
    launchSchema.parse({ ...draft, telegram: "https://telegram.example/meme" }),
  );
  assert.equal(safeSocialLink("javascript:alert(1)"), "");
  assert.equal(safeSocialLink("https://x.com.evil.test/meme", "x"), "");
  assert.equal(
    safeSocialLink("https://t.me/meme", "telegram"),
    "https://t.me/meme",
  );
});

test("Coinbase registry excludes wrapped stocks and unlisted B20 assets", () => {
  assert.deepEqual(
    STOCKS.map((s) => s.symbol),
    [
      "NVDAc",
      "AAPLc",
      "GOOGLc",
      "METAc",
      "AMZNc",
      "MSFTc",
      "MSTRc",
      "SNDKc",
      "SPCXc",
      "TSLAc",
    ],
  );
  for (const stock of STOCKS) {
    assert.equal(stock.issuer, "Coinbase");
    assert.equal(stock.decimals, 8);
    assert.equal(stock.chainId, 8453);
  }
  for (const quoteAddress of [
    "0xFb5B41acdbA20a3230F84BE995173CFb98b8D6E7",
    "0xb200000000000000000000c85a31389D71F3ecfb",
    "0xB20000000000000000000019f6E7C675b73C2e4D",
    "0xB2000000000000000000004AFF16039bA04bdFBc",
  ])
    assert.throws(() => launchSchema.parse({ ...draft, quoteAddress }));
  assert.throws(() =>
    launchSchema.parse({ ...draft, openingCap: "100.000000001" }),
  );
});

test("8-decimal amounts and both fee currencies retain their native units", () => {
  assert.equal(parseAmount("0.00000001", 8), 1n);
  assert.equal(parseAmount("1.23456789", 8), 123456789n);
  assert.throws(() => parseAmount("0.000000001", 8));
  const token = {
    address: creator,
    symbol: "MEME",
    quoteAddress: STOCKS[0].address,
  };
  for (const currencies of [
    [creator, STOCKS[0].address],
    [STOCKS[0].address, creator],
  ]) {
    const amounts = currencies.map((address) => poolCurrency(address, token));
    for (const asset of amounts)
      assert.equal(
        formatUnits(parseAmount("1.23456789", asset.decimals), asset.decimals),
        "1.23456789",
      );
    assert.deepEqual(amounts.map((a) => a.decimals).sort(), [18, 8]);
  }
  assert.throws(() => poolCurrency(owner, token));
});

test("share equivalents floor fractions without altering transaction units", () => {
  const raw = parseAmount("12.34567891", 8);
  const multiplier = 1000377118676784179n;
  assert.equal(shareEquivalent(raw, WAD), raw);
  assert.equal(shareEquivalent(raw, 2n * WAD), raw * 2n);
  assert.equal(shareEquivalent(raw, WAD / 2n), raw / 2n);
  const scaled = shareEquivalent(raw, multiplier);
  assert(scaled * WAD <= raw * multiplier);
  assert((scaled + 1n) * WAD > raw * multiplier);
  assert.equal(raw, 1234567891n);
  assert.equal(shareEquivalent(1n, WAD / 2n), 0n);
  assert.throws(() => shareEquivalent(raw, 0n));
});

test("B20 identity uses native calls, preserves unknown data and retries failures", async () => {
  let fail = false;
  const client = {
    getChainId: async () => 8453,
    getBlockNumber: async () => 51603508n,
    getCode: async () => {
      throw new Error("bytecode is not a B20 identity check");
    },
    readContract: async ({
      address,
      functionName,
      blockNumber,
    }: {
      address: string;
      functionName: string;
      blockNumber?: bigint;
    }) => {
      assert.equal(blockNumber, 51603508n);
      const stock = STOCKS.find((s) => s.address === address)!;
      if (fail && functionName === "multiplier")
        throw new Error("RPC unavailable");
      return {
        name: stock.name,
        symbol: stock.symbol,
        decimals: 8,
        totalSupply: 0n,
        multiplier: WAD,
      }[functionName];
    },
  } as unknown as Parameters<typeof assertStock>[0];
  assert.equal(
    (await assertStock(client, STOCKS[0].address, 51603508n)).totalSupply,
    0n,
  );
  const directory = mkdtempSync(join(tmpdir(), "musegod-b20-test-"));
  const service = new LaunchpadService({
    config: {
      mode: "base",
      chainId: 8453,
      treasury: null,
      writesEnabled: false,
      blockReason: null,
    },
    rpcUrl: "http://127.0.0.1:1",
    dataDir: directory,
  });
  Object.defineProperty(service, "client", { value: client });
  try {
    fail = true;
    const failed = await service.stocks();
    assert(
      failed.every(
        (s) =>
          !s.verified &&
          s.totalSupply === null &&
          s.multiplierWad === null &&
          /RPC unavailable/.test(s.error!),
      ),
    );
    fail = false;
    const recovered = await service.stocks();
    assert(
      recovered.every(
        (s) =>
          s.verified &&
          s.totalSupply === "0" &&
          s.multiplierWad === String(WAD),
      ),
    );
  } finally {
    await service.store.close();
    rmSync(directory, { recursive: true });
  }
  assert.match(simulationError(new Error("ContractPaused(0)")).message, /paused/);
  assert.match(
    simulationError(new Error("RPC unavailable")).message,
    /transaction was not submitted/,
  );
});

test("amount parsing retains all 18 decimal places and never silently rounds", () => {
  assert.equal(
    parseAmount("9007199254740993.000000000000000001", 18),
    9007199254740993000000000000000001n,
  );
  assert.equal(parseAmount("0.000000000000000001", 18), 1n);
  for (const amount of [
    "0",
    "-1",
    "1e18",
    "1.0000000000000000001",
    "1,000",
    "Infinity",
    " 1",
  ])
    assert.throws(() => parseAmount(amount, 18));
  assert.throws(() => parseAmount("1.0000001", 6));
  assert.throws(() => parseAmount("999999999999999999999", 18));
});

test("an incomplete saved draft survives reload but cannot bypass launch validation", () => {
  const restored = restoreDraft(
    JSON.stringify({
      ...draft,
      name: "Half finished",
      symbol: "",
      quoteAddress: STOCKS[1].address,
    }),
  );
  assert.equal(restored.name, "Half finished");
  assert.equal(restored.symbol, "");
  assert.equal(restored.quoteAddress, STOCKS[1].address);
  assert.throws(() => launchSchema.parse(restored));
  assert.equal(restoreDraft("{broken").quoteAddress, STOCKS[0].address);
});

test("slippage floors integer output, rejects unsafe ranges and dust", () => {
  const output = 987654321098765432109876543n;
  for (const bps of [1, 50, 100, 200, 500]) {
    const min = minimumOutput(output, bps);
    assert(min * 10000n <= output * BigInt(10000 - bps));
    assert((min + 1n) * 10000n > output * BigInt(10000 - bps));
  }
  for (const bps of [0, 501, 10000, -1, 1.5, NaN])
    assert.throws(() => minimumOutput(output, bps));
  assert.throws(() => minimumOutput(1n, 500));
});

test("fees merge overlapping beneficiaries without losing shares", () => {
  assert.deepEqual(
    beneficiaries([
      { beneficiary: treasury, shares: WAD / 2n },
      { beneficiary: creator, shares: WAD / 4n },
      { beneficiary: creator, shares: WAD / 4n },
    ]),
    [
      { beneficiary: creator, shares: WAD / 2n },
      { beneficiary: treasury, shares: WAD / 2n },
    ],
  );
  assert.throws(() =>
    beneficiaries([{ beneficiary: creator, shares: WAD - 1n }]),
  );
  assert.throws(() =>
    beneficiaries([
      { beneficiary: creator, shares: -1n },
      { beneficiary: treasury, shares: WAD + 1n },
    ]),
  );
});

test("every stock builds the fixed supply, immutable fee policy and official modules", () => {
  for (const stock of STOCKS) {
    const params = buildLaunch(
      sdk,
      { ...draft, quoteAddress: stock.address },
      creator,
      treasury,
      owner,
      syntheticOpeningValuation(stock.address),
    );
    assert.equal(params.sale.initialSupply, SUPPLY);
    assert.equal(params.sale.numTokensToSell, SUPPLY);
    assert.equal(params.sale.numeraire, stock.address);
    assert.equal(params.modules?.dopplerERC20V1Factory, CONTRACTS.tokenFactory);
    assert.equal(params.modules?.dopplerHookInitializer, CONTRACTS.initializer);
    assert.equal(params.modules?.noOpMigrator, CONTRACTS.noOpMigrator);
    assert.equal(params.dopplerHook?.buybackDestination, DEAD);
    assert.equal(params.dopplerHook?.startFee, 10000);
    assert.equal(params.dopplerHook?.endFee, 10000);
    assert.equal(params.pool.fee, 500);
    assert.equal(
      params.pool.curves.reduce((n, c) => n + c.shares, 0n),
      WAD,
    );
    assert.equal(
      params.pool.beneficiaries?.reduce((n, b) => n + b.shares, 0n),
      WAD,
    );
    assert.equal(params.integrator, treasury);
    assert.deepEqual(params.pool.beneficiaries, [
      { beneficiary: creator, shares: (WAD * 665n) / 1000n },
      { beneficiary: treasury, shares: (WAD * 285n) / 1000n },
      { beneficiary: owner, shares: (WAD * 5n) / 100n },
    ]);
    assert.deepEqual(params.dopplerHook?.feeBeneficiaries, [
      { beneficiary: creator, shares: (WAD * 70n) / 100n },
      { beneficiary: treasury, shares: (WAD * 30n) / 100n },
    ]);
  }
  const same = buildLaunch(
    sdk,
    draft,
    creator,
    creator,
    creator,
    syntheticOpeningValuation(),
  );
  assert.deepEqual(same.pool.beneficiaries, [
    { beneficiary: creator, shares: WAD },
  ]);
  assert.deepEqual(same.dopplerHook?.feeBeneficiaries, [
    { beneficiary: creator, shares: WAD },
  ]);
  const creatorIsTreasury = buildLaunch(sdk, draft, creator, creator, owner, syntheticOpeningValuation());
  assert.deepEqual(creatorIsTreasury.pool.beneficiaries, [
    { beneficiary: creator, shares: (WAD * 95n) / 100n },
    { beneficiary: owner, shares: (WAD * 5n) / 100n },
  ]);
  assert.deepEqual(creatorIsTreasury.dopplerHook?.feeBeneficiaries, [
    { beneficiary: creator, shares: WAD },
  ]);
  const treasuryIsOwner = buildLaunch(sdk, draft, creator, owner, owner, syntheticOpeningValuation());
  assert.deepEqual(treasuryIsOwner.pool.beneficiaries, [
    { beneficiary: creator, shares: (WAD * 665n) / 1000n },
    { beneficiary: owner, shares: (WAD * 335n) / 1000n },
  ]);
  const creatorIsOwner = buildLaunch(sdk, draft, creator, treasury, creator, syntheticOpeningValuation());
  assert.deepEqual(creatorIsOwner.pool.beneficiaries, [
    { beneficiary: creator, shares: (WAD * 715n) / 1000n },
    { beneficiary: treasury, shares: (WAD * 285n) / 1000n },
  ]);
});

test("SDK calldata retains exact v2 shares after all recipient overlaps", () => {
  for (const [c, t, p] of [[creator, treasury, owner], [creator, creator, owner], [creator, treasury, creator], [creator, owner, owner], [creator, creator, creator]] as const) {
    const plan = buildLaunch(sdk, draft, c, t, p, syntheticOpeningValuation());
    const encoded = sdk.factory.encodeCreateMulticurveParams(plan);
    const [pool] = decodeAbiParameters(parseAbiParameters("(uint24 fee, int24 tickSpacing, int24 farTick, (int24 tickLower, int24 tickUpper, uint16 numPositions, uint256 shares)[] curves, (address beneficiary, uint96 shares)[] beneficiaries, address dopplerHook, bytes onInitializationDopplerHookCalldata, bytes graduationDopplerHookCalldata)"), encoded.poolInitializerData);
    assert.equal(pool.fee, 500);
    assert.equal(pool.dopplerHook.toLowerCase(), CONTRACTS.rehype.toLowerCase());
    assert.deepEqual(pool.beneficiaries, plan.pool.beneficiaries);
    assert.equal(pool.beneficiaries.reduce((sum, b) => sum + b.shares, 0n), WAD);
    const [hook] = decodeAbiParameters(parseAbiParameters("(address numeraire, address buybackDst, uint24 startFee, uint24 endFee, uint32 durationSeconds, uint32 startingTime, uint8 feeRoutingMode, (uint64 assetFeesToAssetBuybackWad, uint64 assetFeesToNumeraireBuybackWad, uint64 assetFeesToBeneficiaryWad, uint64 assetFeesToLpWad, uint64 numeraireFeesToAssetBuybackWad, uint64 numeraireFeesToNumeraireBuybackWad, uint64 numeraireFeesToBeneficiaryWad, uint64 numeraireFeesToLpWad) feeDistributionInfo, (address beneficiary, uint96 shares)[] feeBeneficiaries, (address integrator, uint24 feeShare, uint32 assetFeesToNumeraireRatio, uint32 numeraireFeesToAssetRatio, bool automaticPayout) integratorConfig)"), pool.onInitializationDopplerHookCalldata);
    assert.equal(hook.startFee, 10000);
    assert.equal(hook.endFee, 10000);
    assert.equal(hook.buybackDst, DEAD);
    assert.deepEqual(hook.feeBeneficiaries, plan.dopplerHook!.feeBeneficiaries);
    assert.equal(hook.feeBeneficiaries.reduce((sum, b) => sum + b.shares, 0n), WAD);
    assert.deepEqual(hook.feeDistributionInfo, plan.dopplerHook!.feeDistributionInfo);
    assert.equal(hook.feeRoutingMode, 1);
  }
});

test("new metadata identifies the MuseGod fee policy without rewriting older launches", () => {
  const valuation = syntheticOpeningValuation();
  const metadata = tokenMetadata(launchSchema.parse(draft), valuation);
  assert.equal(metadata.properties.platform, "musegod.fun");
  assert.equal(metadata.properties.openingCap, "50");
  assert.deepEqual(metadata.properties.openingValuation, valuation);
  assert.equal(metadata.properties.feePolicy, "creator-70-musegod-v2");
  assert.equal(metadata.properties.feePolicy, FEE_POLICY);
  assert.deepEqual(metadata.properties.buyback, {
    chainId: 4663,
    tokenAddress: "0x0379E228F6887c6F18bf394042ECAF81B308cb2e",
    burnAddress: DEAD,
  });
  assert.deepEqual(metadata.properties.buyback, MUSEGOD_BUYBACK);
  assert.deepEqual(metadata.properties.feeDistribution, { basis: "total_fees", protocolBps: 500, creatorBps: 6650, platformBps: 2850 });
  assert.deepEqual(metadata.properties.platformIncomeAllocation, { basis: "platform_income", buybackBps: 8000, operationsBps: 2000, execution: "treasury_manual_allocation" });
  assert.equal(FEE_SHARES.creator + FEE_SHARES.platform + FEE_SHARES.protocol, 10_000);
  assert.equal(FEE_SHARES.buyback + FEE_SHARES.operations, FEE_SHARES.platform);
  assert.equal(FEE_SHARES.creatorNet + FEE_SHARES.platformNet, 10_000);
  assert.equal(syntheticToken().feePolicy, undefined);
  assert.equal(syntheticToken().feeTreasury, undefined);
});

test("router calldata enforces exact input, min output, direction and deadline", () => {
  const poolKey = {
    currency0: creator,
    currency1: treasury,
    fee: 8388608,
    tickSpacing: 10,
    hooks: CONTRACTS.initializer,
  };
  for (const currencyIn of [creator, treasury]) {
    const tx = swapTransaction(
      poolKey,
      currencyIn,
      1234567890123456789n,
      987654321012345678n,
      100,
      999n,
    );
    assert.equal(tx.to, CONTRACTS.router);
    assert.equal(tx.value, 0n);
    const outer = decodeFunctionData({ abi: routerAbi, data: tx.data });
    assert.equal(outer.functionName, "execute");
    assert.equal(outer.args[0], "0x10");
    assert.equal(outer.args[2], 999n);
    const [actions, encoded] = decodeAbiParameters(
      [{ type: "bytes" }, { type: "bytes[]" }],
      outer.args[1][0],
    );
    assert.equal(actions, "0x060c0f");
    assert.equal(encoded.length, 3);
    const [swap] = decodeAbiParameters(
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
            { name: "hookData", type: "bytes" },
          ],
        },
      ],
      encoded[0],
    );
    assert.equal(swap.zeroForOne, currencyIn === creator);
    assert.equal(swap.amountIn, 1234567890123456789n);
    assert.equal(swap.amountOutMinimum, tx.minOut);
    assert.deepEqual(
      decodeAbiParameters(
        [{ type: "address" }, { type: "uint256" }],
        encoded[1],
      ),
      [currencyIn, swap.amountIn],
    );
    assert.deepEqual(
      decodeAbiParameters(
        [{ type: "address" }, { type: "uint256" }],
        encoded[2],
      ),
      [currencyIn === creator ? treasury : creator, tx.minOut],
    );
  }
  assert.throws(() => swapTransaction(poolKey, owner, 1n, 1000n, 100, 999n));
  assert.throws(() =>
    swapTransaction(poolKey, creator, 2n ** 128n, 1000n, 100, 999n),
  );
});

test("untrusted image URLs and unusable treasury addresses are rejected", () => {
  for (const url of [
    "javascript:alert(1)",
    "data:image/svg+xml,<svg/>",
    "http://example.com/a.png",
    "https://a:b@example.com/a.png",
    "https://127.0.0.1/a",
    "https://10.0.0.1/a",
  ])
    assert.equal(safeImage(url), "");
  assert.equal(
    safeImage("https://example.com/a.png"),
    "https://example.com/a.png",
  );
  for (const address of ["", undefined, DEAD, zeroAddress, "garbage"])
    assert.equal(validTreasury(address), null);
  assert.equal(validTreasury(treasury), treasury);
});

test("browser fee claim calldata matches official SDK ABIs", () => {
  const poolId = `0x${"a".repeat(64)}` as Hex;
  assert.equal(
    encodeFunctionData({
      abi: claimFeesAbi,
      functionName: "collectFees",
      args: [poolId],
    }),
    encodeFunctionData({
      abi: feesManagerAbi,
      functionName: "collectFees",
      args: [poolId],
    }),
  );
  assert.equal(
    encodeFunctionData({
      abi: claimFeesAbi,
      functionName: "collectFees",
      args: [poolId],
    }),
    encodeFunctionData({
      abi: feeClaimsInitializerAbi,
      functionName: "collectFees",
      args: [poolId],
    }),
  );
});

test("stored launch identity requires both exact creator and calldata; chains cannot share DB", () => {
  const directory = mkdtempSync(join(tmpdir(), "musegod-store-test-"));
  const store = new Store(directory, 8453);
  const plan: LaunchPlan = {
    id: `0x${"1".repeat(64)}` as Hex,
    creator,
    data: "0x1234",
    tokenAddress: treasury,
    poolId: `0x${"2".repeat(64)}`,
    draft,
    preparedAt: Date.now(),
    gas: null,
  };
  try {
    store.savePlan(plan);
    assert.deepEqual(store.findPlan(creator, "0x1234"), plan);
    assert.equal(store.findPlan(treasury, "0x1234"), null);
    assert.equal(store.findPlan(creator, "0x1235"), null);
    assert.throws(() => new Store(directory, 31337), /database network does not match/);
  } finally {
    store.db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("mainnet signing is opt-in, requires treasury and can return to read-only", () => {
  const names = [
    "CHAIN_MODE",
    "PLATFORM_TREASURY",
    "ENABLE_MAINNET_TRANSACTIONS",
    "FORK_RPC_URL",
  ];
  const saved = Object.fromEntries(names.map((n) => [n, process.env[n]]));
  try {
    for (const name of names) delete process.env[name];
    assert.equal(runtimeFromEnv().config.writesEnabled, false);
    process.env.ENABLE_MAINNET_TRANSACTIONS = "true";
    assert.throws(() => runtimeFromEnv(), /PLATFORM_TREASURY/);
    process.env.PLATFORM_TREASURY = treasury;
    assert.equal(runtimeFromEnv().config.writesEnabled, true);
    assert.equal(runtimeFromEnv().config.chainId, 4663);
    assert.equal(runtimeFromEnv().config.blockReason, null);
    process.env.ENABLE_MAINNET_TRANSACTIONS = "TRUE";
    assert.throws(() => runtimeFromEnv(), /true or false/);
    process.env.ENABLE_MAINNET_TRANSACTIONS = "false";
    assert.equal(runtimeFromEnv().config.writesEnabled, false);
    process.env.CHAIN_MODE = "fork";
    assert.equal(runtimeFromEnv().config.writesEnabled, true);
    process.env.FORK_RPC_URL = "https://mainnet.base.org";
    assert.throws(() => runtimeFromEnv(), /loopback/);
  } finally {
    for (const name of names) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
  }
});
