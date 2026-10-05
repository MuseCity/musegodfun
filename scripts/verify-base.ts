import { runtimeFromEnv, redact } from "../server/config";
import { mkdir, writeFile } from "node:fs/promises";
import { createPublicClient, http } from "viem";
import { base } from "viem/chains";
import { airlockAbi, DopplerSDK } from "@whetstone-research/doppler-sdk/evm";
import { CONTRACTS, STOCKS } from "../src/lib/config";
import { assertStock, buildLaunch } from "../src/lib/protocol";
// The public endpoint rate-limits bursts of code and archive reads. Serialize
// transport requests for this offline verifier and retry only explicit limits.
let rpcQueue = Promise.resolve();
const pacedFetch: typeof fetch = async (input, init) => {
  const previous = rpcQueue;
  let release!: () => void;
  rpcQueue = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous;
  try {
    for (let attempt = 0; ; attempt++) {
      const response = await fetch(input, init);
      const body = await response
        .clone()
        .json()
        .catch(() => null);
      const limited = response.status === 429 || body?.error?.code === -32016;
      if (!limited || attempt >= 3) return response;
      await new Promise((resolve) => setTimeout(resolve, 1000 * (attempt + 1)));
    }
  } finally {
    await new Promise((resolve) => setTimeout(resolve, 400));
    release();
  }
};
const client = createPublicClient({
  chain: base,
  transport: http(runtimeFromEnv().rpcUrl, {
    timeout: 60_000,
    retryCount: 1,
    fetchFn: pacedFetch,
  }),
  batch: { multicall: true },
});
if ((await client.getChainId()) !== 8453)
  throw new Error("Expected Base mainnet for read-only verification");
const blockNumber = await client.getBlockNumber();
const block = await client.getBlock({ blockNumber });
const modules = await Promise.all(
  Object.entries(CONTRACTS).map(async ([name, address]) => ({
    name,
    address,
    hasCode: !!(await client.getCode({ address, blockNumber })),
    ...([
      "tokenFactory",
      "initializer",
      "noOpGovernance",
      "noOpMigrator",
    ].includes(name)
      ? {
          state: await client.readContract({
            address: CONTRACTS.airlock,
            abi: airlockAbi,
            functionName: "getModuleState",
            args: [address],
            blockNumber,
          }),
        }
      : {}),
  })),
);
const stocks = [];
for (let i = 0; i < STOCKS.length; i += 6) {
  stocks.push(
    ...(await Promise.all(
      STOCKS.slice(i, i + 6).map(async (stock) => {
        try {
          const { name, totalSupply, multiplierWad } = await assertStock(
            client,
            stock.address,
            blockNumber,
          );
          return {
            ticker: stock.ticker,
            address: stock.address,
            symbol: stock.symbol,
            decimals: stock.decimals,
            name,
            issuer: stock.issuer,
            standard: stock.standard,
            sourceUrl: stock.sourceUrl,
            totalSupply,
            multiplierWad,
            verified: true,
          };
        } catch (error) {
          return {
            ticker: stock.ticker,
            address: stock.address,
            verified: false,
            error: redact(error),
          };
        }
      }),
    )),
  );
}
// eth_call only: creator is a test address; fee destination is the configured treasury.
const sdk = new DopplerSDK<8453>({ publicClient: client, chainId: 8453 });
const owner = await client.readContract({
  address: CONTRACTS.airlock,
  abi: airlockAbi,
  functionName: "owner",
  blockNumber,
});
const creator = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const treasury = runtimeFromEnv().config.treasury;
if (!treasury) throw new Error("主网模拟需要正式 PLATFORM_TREASURY");
const simulations = [];
for (const ticker of ["NVDA", "GOOGL"]) {
  const stock = STOCKS.find((s) => s.ticker === ticker)!;
  const params = buildLaunch(
    sdk,
    {
      name: "B20 read-only simulation",
      symbol: "B20SIM",
      description: "eth_call only",
      image: "",
      quoteAddress: stock.address,
      openingCap: "100",
    },
    creator,
    treasury,
    owner,
  );
  const result = await client.simulateContract({
    address: CONTRACTS.airlock,
    abi: airlockAbi,
    functionName: "create",
    args: [sdk.factory.encodeCreateMulticurveParams(params)],
    account: creator,
    blockNumber,
  });
  simulations.push({
    ticker,
    quoteAddress: stock.address,
    method: "eth_call",
    success: true,
    predictedToken: result.result[0],
  });
}
const result = {
  scope:
    "Base mainnet read-only; not transfer, solvency, or issuance-rights verification",
  observedAt: new Date().toISOString(),
  blockNumber,
  blockHash: block.hash,
  blockTimestamp: block.timestamp,
  modules,
  stocks,
  simulations,
};
await mkdir("docs/evidence", { recursive: true });
await writeFile(
  "docs/evidence/base-verification.json",
  JSON.stringify(
    result,
    (_, v) => (typeof v === "bigint" ? v.toString() : v),
    2,
  ) + "\n",
);
console.log(
  JSON.stringify(
    {
      blockNumber: String(blockNumber),
      modules,
      stocksVerified: stocks.filter((s) => s.verified).length,
      stockTotal: stocks.length,
      failed: stocks.filter((s) => !s.verified),
      simulations,
    },
    (_, v) => (typeof v === "bigint" ? v.toString() : v),
    2,
  ),
);
if (modules.some((m) => !m.hasCode) || stocks.some((s) => !s.verified))
  process.exitCode = 1;
