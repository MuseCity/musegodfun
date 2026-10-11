import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { decodeFunctionData, type Address, type Hex } from "viem";
import { approvalProxyAbi, relayRequestMetadata } from "../server/buyback";
import { STOCKS } from "../src/lib/config";
import { BASE_NATIVE_DESTINATION_POLICY } from "../src/lib/base-buyback";
import { inspectNoTraceAutomationEnvelope, inspectNoTraceDirectNativePair, inspectNoTraceSourceCalldata,
  inspectNoTraceSource, inspectNoTraceDestination, type RawNoTraceSnapshot } from "./base-native-no-trace";

// Offline only. The checked-in captures were obtained with ordinary read-only
// RPC. This script has no client, signer, transaction broadcaster or journal.
const sha = (data: string) => createHash("sha256").update(data).digest("hex");
const attempt = (read: () => unknown) => { try { return { supported: true, result: read() }; }
  catch (error) { return { supported: false, reason: error instanceof Error ? error.message : "Unsupported structure" }; } };
const fixturePath = "tests/fixtures/native-relay-no-trace-mainnet.json";
const raw = await readFile(fixturePath, "utf8");
const fixture = JSON.parse(raw) as { automation: RawNoTraceSnapshot; source: RawNoTraceSnapshot; destination: RawNoTraceSnapshot;
  destinationRecipientCode: Hex; observedAt: unknown; historicalRuntimeHashes: unknown };
const automation = "0xAdA3348D6fC8EcF7cc2DbCA931D038b4B2913E3a" as Address;
const envelope = attempt(() => { const read = inspectNoTraceAutomationEnvelope(fixture.automation, automation);
  return { userOpHash: read.userOpHash, executionLogs: read.executionLogs.length, calls: read.calls.map(call => ({ target: call.target,
    selector: call.data.slice(0, 10), value: String(call.value) })), implementationContinuity: read.implementationContinuity }; });
const direct = attempt(() => inspectNoTraceDirectNativePair(fixture.source, fixture.destination, fixture.destinationRecipientCode));
const qualificationPath = "docs/evidence/base-native-route-qualification.json", qualificationRaw = await readFile(qualificationPath, "utf8");
const qualification = JSON.parse(qualificationRaw);
const quoteRecords: { symbol: string; file: string; sha256?: string; sourceAsset?: Address; cleanupNativeAmount?: string;
  status: string; reason?: string }[] = [];
for (const stock of STOCKS) {
  const retained = qualification.records.find((row: { symbol: string; address: string }) => row.symbol === stock.symbol && row.address.toLowerCase() === stock.address.toLowerCase());
  const file = retained?.outbound?.rawCachePath ?? `.cache/base-native-route-audit/${stock.symbol}-outbound.json`;
  let body: string; try { body = await readFile(file, "utf8"); } catch { quoteRecords.push({ symbol: stock.symbol, file, status: "not_run_missing_capture" }); continue; }
  try {
    const quote = JSON.parse(body), steps = quote.steps?.filter((step: { id: string }) => step.id === "deposit");
    if (steps?.length !== 1 || steps[0].items?.length !== 1) throw new Error("No unique retained native source quote");
    const tx = steps[0].items[0].data, decoded = decodeFunctionData({ abi: approvalProxyAbi, data: tx.data });
    const calls = decoded.args[2], cleanup = calls.find(call => call.callData.slice(0, 10) === "0x5d1fe6a2");
    const cleanupAmount = cleanup ? BigInt(`0x${cleanup.callData.slice(10, 74)}`).toString() : undefined;
    const result = attempt(() => inspectNoTraceSourceCalldata(tx.data, tx.from));
    quoteRecords.push({ symbol: stock.symbol, file, sha256: sha(body), sourceAsset: decoded.args[0][0], cleanupNativeAmount: cleanupAmount,
      status: result.supported ? "supported_structure" : "unsupported_structure", ...(!result.supported ? { reason: result.reason } : {}) });
  } catch (error) { quoteRecords.push({ symbol: stock.symbol, file, sha256: sha(body), status: "unavailable_or_unsupported_capture",
    reason: error instanceof Error ? error.message : "Unsupported quote capture" }); }
}
const report = { schemaVersion: 1, observedAt: new Date().toISOString(), purpose: "Historical narrow no-trace prototype comparison; not the current canonical-receipt destination policy",
  execution: { networkRequests: 0, traceRequests: 0, mainnetWrites: 0, signed: false, deployed: false, runtimePolicyChanged: false },
  sources: { fixture: { path: fixturePath, sha256: sha(raw), capturedAt: fixture.observedAt },
    prototype: { path: "scripts/base-native-no-trace.ts", sha256: sha(await readFile("scripts/base-native-no-trace.ts", "utf8")) },
    comparison: { path: "scripts/compare-base-native-no-trace.ts", sha256: sha(await readFile("scripts/compare-base-native-no-trace.ts", "utf8")) },
    qualification: { path: qualificationPath, sha256: sha(qualificationRaw) } },
  actualMainnetSamples: {
    robinhoodSameChain: { hash: fixture.automation.transaction.hash, chainId: 4663, automationEnvelope: envelope,
      projectBaseSource: attempt(() => inspectNoTraceSource(fixture.automation, automation)), scope: "Actual same-chain conversion; not Base bridging" },
    thirdPartyBaseRobinhood: { sourceHash: fixture.source.transaction.hash, destinationHash: fixture.destination.transaction.hash, directNativeReceiptCorrelation: direct,
      projectDestination: attempt(() => inspectNoTraceDestination(fixture.destination, relayRequestMetadata(`0x${"ab".repeat(32)}`), "0x")),
      scope: "External ETH-to-ETH receipts; no project fee provenance, fixed-solver authentication or WETH/Treasury acceptance" },
    historicalRuntimeHashes: fixture.historicalRuntimeHashes },
  retainedNativeQuotes: { scope: "Expired unsigned quote calldata only; no live route availability or execution claim", assets: STOCKS.length,
    supportedStructures: quoteRecords.filter(row => row.status === "supported_structure").length,
    rejectedStructures: quoteRecords.filter(row => row.status === "unsupported_structure").length,
    unavailableCaptures: quoteRecords.filter(row => !["supported_structure", "unsupported_structure"].includes(row.status)).length, records: quoteRecords },
  comparison: {
    historicalTrace: { source: "Authenticates the actual successful Automation/ApprovalProxy/Router/Depository call tree",
      destination: "Binds a successful fixed-provider Router cleanup to its WETH transfer; covers more nested route layouts",
      actualMainnetTraceComparison: "not_run; existing Alchemy Free-tier trace rejection remains the recorded provider limitation",
      syntheticComparison: "Current canonical-receipt tests compare exact root calldata and success events with the historical narrow prototype; neither asserts a real project settlement",
      historicalProofRefresh: "Historical trace-era behavior; current keeper caches immutable canonical source proofs and checks current anchors and new bounded candidates" },
    currentDestination: { policy: BASE_NATIVE_DESTINATION_POLICY, source: "Base source still requires local OP replay",
      destination: "Complete root calldata, exact compiled Router success witnesses, final cleanup payment window, historical EOA/code and canonical snapshots",
      prototypeIsProductionVerifier: false, actualProjectMainnetSettlement: "not_run" },
    historicalNoTracePrototype: { source: "Recomputed EntryPoint v0.7 UserOp hash, success event, exact SmartVault CALL list and bounded log window",
      destination: "Strict direct fixed EOA -> Router: positive canonical WETH wrap plus exact positive cleanup only",
      unsupported: ["B20 opaque DEX routes", "zero-value native cleanup after unknown route calls", "modules/aggregated or multiple UserOps/paymasters/account creation",
        "nested/arbitrary destination calls", "unproved execution-time upgradeable account implementation"],
      acceptedProvenance: false },
    routeRequirements: { b20Conversion: "Conversion is required, but arbitrary opaque DEX routes are not; a complete reviewed route whitelist could broaden the prototype",
      zeroCleanup: "A provider construction choice, not a protocol requirement. Positive cleanup means exact native amount, not a minimum-output floor",
      currentWhitelist: "Only narrow WETH unwrap/wrap plus positive exact cleanup was implemented; rejecting old B20 quotes does not prove no-trace is impossible",
      changingCalls: "Native Splits scheduler route constraints/custom calldata support has not been established; do not mutate retained signed orders or assume leftover refunds go to Automation" },
    rpcCost: { traceEndpointRequired: false, monthlySavings: "Not measured; ordinary RPC/code/upgrade-history reads remain necessary" },
    conclusion: "This historical whole-path prototype is not production. Its B20 rejection count is not an admission gate for the current Base-source-replay plus Robinhood-receipt policy" },
  activation: { baseMustRemainPaused: true, replacementReady: false,
    required: ["Complete route whitelist or a verifiable execution wrapper/event protocol", "Execution-time implementation and canonical code binding",
      "Actual B20 -> canonical Robinhood WETH -> fixed Treasury sample", "Independent acceptance of the new proof policy"] } };
const checks: Record<string, unknown> = {};
for (const [name, flag] of [["applicationTests", "--test-log="], ["typecheck", "--typecheck-log="]] as const) {
  const path = process.argv.find(arg => arg.startsWith(flag))?.slice(flag.length);
  if (!path) { checks[name] = { status: "not_run_by_this_offline_comparison" }; continue; }
  const log = await readFile(path, "utf8");
  if (name === "applicationTests") {
    const count = (label: string) => Number(log.match(new RegExp(`(?:ℹ|#) ${label} (\\d+)`))?.[1] ?? NaN);
    const tests = count("tests"), passed = count("pass"), failed = count("fail"), skipped = count("skipped");
    if (!Number.isSafeInteger(tests) || tests !== passed || failed !== 0 || skipped !== 0) throw new Error("Validation log does not establish zero-failure/zero-skip acceptance");
    checks[name] = { status: "passed", tests, passed, failed, skipped, path, sha256: sha(log) };
  } else {
    if (!log.includes("tsc --noEmit && tsc --noEmit -p tsconfig.worker.json") || /error TS\d+/.test(log)) throw new Error("Typecheck evidence incomplete/failed");
    checks[name] = { status: "recorded_successful_command_log", path, sha256: sha(log) };
  }
}
const output = JSON.stringify({ ...report, validation: checks }, (_, value) => typeof value === "bigint" ? String(value) : value, 2) + "\n";
const out = process.argv.find(arg => arg.startsWith("--out="))?.slice(6);
if (out) await writeFile(out, output);
console.log(output);
