import { runtimeFromEnv, mainnetRpcUrl, redact } from "../server/config";
import { mkdir, writeFile } from "node:fs/promises";
import { createPublicClient, http } from "viem";
import { base, robinhood } from "viem/chains";
import { airlockAbi } from "@whetstone-research/doppler-sdk/evm";
import { CONTRACTS, STOCKS } from "../src/lib/config";
import { assertStock } from "../src/lib/protocol";
import { BASE_COLLECTOR_MANIFEST, verifyBaseCollector } from "../server/base-collector";
import { readOpeningValuation } from "../server/opening-price";
import { launchAssetsFor } from "../src/lib/config";
const runtime = runtimeFromEnv(8453);
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
  transport: http(runtime.rpcUrl, {
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
if (launchAssetsFor(runtime.config).length !== 36 || STOCKS.length !== 36)
  throw new Error("Expected the exact 36 admitted Base B20 addresses");
let collector: unknown = { status: "not_deployed", activation: "not_run" };
if (runtime.config.feeEngine) {
  try {
    const destination = createPublicClient({ chain: robinhood, transport: http(mainnetRpcUrl(4663, runtime.environment), { timeout: 25_000, retryCount: 1 }) });
    collector = { status: "verified", graph: await verifyBaseCollector(client, runtime.config.feeEngine, { robinhoodClient: destination }), activation: BASE_COLLECTOR_MANIFEST.activation.status };
  }
  catch (error) { collector = { status: "unavailable", error: redact(error) }; process.exitCode = 1; }
}
// Opt-in pricing consumes the same bounded LI.FI budget as launches. It never
// substitutes directory prices or submits a transaction.
const valuations = [];
if (process.argv.includes("--pricing")) for (const asset of launchAssetsFor(runtime.config))
  valuations.push(await readOpeningValuation(client, asset, 8453, runtime.lifi));
const simulations: never[] = [];
const result = {
  scope:
    "Base mainnet read-only; not transfer, solvency, or issuance-rights verification",
  observedAt: new Date().toISOString(),
  blockNumber,
  blockHash: block.hash,
  blockTimestamp: block.timestamp,
  modules,
  stocks,
  collector,
  valuations,
  simulations,
  issuanceSimulation: "not_run: mainnet issuance requires the reviewed fee adapter and dedicated native Automation graph, plus wallet/canary acceptance; use the Base fork verifier for local execution",
  realCrossChainExecution: "not_run: native Automation / Relay requires canonical source and destination receipts",
  nativeAutomation: { provider: "Splits", bridge: "Relay", receiver: BASE_COLLECTOR_MANIFEST.constants.automationReceiver ?? null, sourceGuardedConversion: false },
};
await mkdir("docs/evidence", { recursive: true });
await writeFile(
  "docs/evidence/base-go-live-verification.json",
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
