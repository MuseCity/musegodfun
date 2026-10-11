import { runtimeFromEnv, mainnetRpcUrl, redact } from "../server/config";
import { mkdir, writeFile } from "node:fs/promises";
import { createPublicClient, http, type PublicClient, type Transport } from "viem";
import { base, robinhood } from "viem/chains";
import { airlockAbi } from "@whetstone-research/doppler-sdk/evm";
import { CONTRACTS, STOCKS } from "../src/lib/config";
import { assertStock } from "../src/lib/protocol";
import { BASE_COLLECTOR_MANIFEST, verifyBaseCollector } from "../server/base-collector";
import { readOpeningValuation } from "../server/opening-price";
import { launchAssetsFor } from "../src/lib/config";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { boundedBaseOperatorAudit, baseOperatorAuditStore } from "./base-audit-store";
import type { BaseAuditStore } from "../server/base-audit";
import { createLocalReplayClient } from "./base-local-replay";
import { SupabaseStore } from "../server/supabase-store";

/** Both operator tools retain checked pages without ever signing a transaction. */
export async function verifyBaseCollectorForOperator(
  client: Parameters<typeof verifyBaseCollector>[0], address: Parameters<typeof verifyBaseCollector>[1],
  options: Parameters<typeof verifyBaseCollector>[2] = {},
  deps: { verifyGraph?: typeof verifyBaseCollector; auditStore?: BaseAuditStore; maxDurationMs?: number } = {},
) {
  const rpc = client as PublicClient<Transport, any>;
  const auditStore = deps.auditStore ?? baseOperatorAuditStore();
  const source = deps.verifyGraph ? client : createLocalReplayClient(rpc, { chainId: 8453, rpcUrl: rpc.transport?.url!, auditStore });
  return boundedBaseOperatorAudit(store => (deps.verifyGraph ?? verifyBaseCollector)(source, address, { ...options, auditStore: store }),
    auditStore, deps.maxDurationMs);
}

export async function runBaseVerification() {
const runtime = runtimeFromEnv(8453);
const recordActivation = process.argv.includes("--record-activation");
if (recordActivation && (runtime.dataScope !== "base" || !runtime.supabase))
  throw new Error("Explicit activation recording requires the canonical Base Supabase operator scope; no record was written");
if (recordActivation && (!runtime.config.feeEngine || BASE_COLLECTOR_MANIFEST.status !== "deployed_verified"))
  throw new Error("A verified deployed Base Collector is required before recording activation; no record was written");
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
  const activationStore = recordActivation ? new SupabaseStore(runtime.supabase!.url, runtime.supabase!.secretKey, "base", "base") : undefined;
  try {
    const destination = createPublicClient({ chain: robinhood, transport: http(mainnetRpcUrl(4663, runtime.environment), { timeout: 25_000, retryCount: 1 }) });
    collector = { status: "verified", graph: await verifyBaseCollectorForOperator(client, runtime.config.feeEngine,
      { robinhoodClient: destination, recordActivation }, { auditStore: activationStore }), activation: BASE_COLLECTOR_MANIFEST.activation.status,
      activationRecord: recordActivation ? "persisted_after_complete_finalized_verification" : "not_written" };
  }
  catch (error) { collector = { status: "unavailable", error: redact(error) }; process.exitCode = 1; }
  finally { await activationStore?.close(); }
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
  issuanceSimulation: "not_run: mainnet issuance requires the reviewed fee adapter, dedicated native Automation wiring and governor configuration acceptance; manufactured fee/canary execution is not a launch prerequisite in trusted Splits mode",
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
}
const direct = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
const runner = process.argv[2] && pathToFileURL(resolve(process.argv[2])).href === import.meta.url && process.argv[1]?.endsWith("run.ts");
if (direct || runner) await runBaseVerification().catch(error => { console.error(redact(error)); process.exitCode = 1; });
