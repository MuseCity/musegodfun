import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { CHART_INTERVALS } from "../src/lib/market";
import { deploymentChain, sameAddress, type TokenRecord } from "../src/lib/config";

// Direct, read-only entrypoint. Does not load dotenv, start an app or reserve quota itself.
const args = process.argv.slice(2);
function option(name: string) {
  const index = args.indexOf(`--${name}`), value = args[index + 1];
  assert(index >= 0 && value && !value.startsWith("--"), `--${name} is required`);
  return value;
}
const origin = new URL(option("origin"));
assert(["http:", "https:"].includes(origin.protocol) && !origin.username && !origin.password && origin.pathname === "/" && !origin.search && !origin.hash, "Use a plain HTTP(S) origin without credentials");
const chain = Number(option("chain"));
assert(chain === 8453 || chain === 4663, "--chain must be 8453 or 4663");
const address = option("token"), pool = option("pool"), output = option("output"), evidenceKind = option("evidence");
assert(/^0x[0-9a-f]{40}$/i.test(address) && /^0x[0-9a-f]{64}$/i.test(pool), "Complete token and bytes32 pool identities are required");
assert(evidenceKind === "fixture" || evidenceKind === "real-api", "--evidence must be fixture or real-api");
const read = async (path: string) => {
  try {
    const response = await fetch(`${origin.origin}/api/chains/${chain}${path}`, { redirect: "manual", signal: AbortSignal.timeout(35_000) });
    return { http: response.status, body: await response.json() as any };
  } catch { return { http: null, body: { error: "Request or JSON decoding failed" } }; }
};
const sections: Record<string, unknown> = {};
const failures: string[] = [];
const catalog = await read("/tokens");
const token = Array.isArray(catalog.body) ? catalog.body.find((t: TokenRecord) => sameAddress(t.address, address)) as TokenRecord | undefined : undefined;
if (catalog.http !== 200 || !token || !sameAddress(token.poolId, pool) || deploymentChain(token) !== chain || token.mode !== (chain === 8453 ? "base" : "robinhood")) failures.push("registered_identity");
let summary: any;
if (!failures.length) {
  for (const section of ["summary", ...CHART_INTERVALS.map(interval => `candles?interval=${interval}`), "trades", "holders"]) {
    const { http, body } = await read(`/tokens/${address}/market/${section}`);
    const list = section.startsWith("candles") ? body.candles : section === "trades" ? body.trades : section === "holders" ? body.holders : undefined;
    const valid = http === 200 && ["fresh", "stale"].includes(body.status) && typeof body.source === "string" && Number.isFinite(Date.parse(body.fetchedAt))
      && (section === "summary" ? [body.priceUsd, body.marketCapUsd, body.fdvUsd, body.liquidityUsd].every(value => value === null || typeof value === "number" && Number.isFinite(value)) : Array.isArray(list));
    if (!valid) failures.push(section);
    sections[section] = { http, valid, source: body.source, fetchedAt: body.fetchedAt, status: body.status, reason: body.reason, upstreamStatus: body.upstreamStatus,
      ...(list ? { count: list.length, indexedEmpty: valid && list.length === 0 } : {}) };
    if (section === "summary") summary = body;
  }
  const batch = await read(`/market/summaries?addresses=${address}`), repeated = await read(`/tokens/${address}/market/summary`);
  const row = Array.isArray(batch.body) ? batch.body.find((r: any) => sameAddress(r.address, address)) : null;
  const shared = batch.http === 200 && repeated.http === 200 && row?.summary && summary?.fetchedAt && row.summary.fetchedAt === summary.fetchedAt && repeated.body.fetchedAt === summary.fetchedAt;
  sections.batch = { http: batch.http, sharedSnapshotVerified: Boolean(shared), reason: row?.reason };
  if (!shared) failures.push("batch_snapshot");
}
const report = { observedAt: new Date().toISOString(), status: failures.length ? "incomplete" : "passed_contract", evidenceKind,
  scope: "Explicit registered identity through HTTP only. Empty indexed results validate the response contract, not positive data coverage or absence of onchain trades.",
  chain, token: address, pool, sections, failures, chainEvidenceVerified: false, productionReleaseVerified: false };
await writeFile(output, JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify({ status: report.status, evidenceKind, chain, failures, output }));
if (failures.length) process.exitCode = 2;
