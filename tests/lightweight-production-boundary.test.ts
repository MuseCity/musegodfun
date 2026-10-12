import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildSync, transformSync } from "esbuild";

const root = fileURLToPath(new URL("../", import.meta.url));
const deletedModules = [
  "server/base-audit.ts",
  "server/base-native-candidates.ts",
  "server/base-native-observer.ts",
  "server/base-native-provenance.ts",
  "server/base-native-trace.ts",
  "server/buyback-audit-snapshot.ts",
  "server/buyback-custody-ledger.ts",
  "server/buyback-vault-ledger.ts",
  "server/buyback-vault-runtime.ts",
  "scripts/base-keeper-audit.ts",
  "scripts/base-keeper-rpc.ts",
  "scripts/base-local-replay.ts",
  "scripts/base-native-no-trace.ts",
  "scripts/compare-base-native-no-trace.ts",
  "scripts/buyback-vault-ledger.ts",
  "src/lib/buyback-custody-ledger.ts",
  "src/lib/buyback-vault-ledger.ts",
];
const forbidden = new Set([...deletedModules,
  // Retained explicit one-time tools may exist, but must never enter a live
  // keeper/Worker request graph (type-only deployment types are erased).
  "scripts/verify-base-first-flow.ts", "scripts/verify-base.ts", "scripts/deploy-base-collector.ts", "scripts/test-buyback-vault-fork.ts",
].map(path => resolve(root, path)));

function runtimeGraph(entry: string): Set<string> {
  // The existing production compiler resolves TS imports, runtime re-exports,
  // literal require/import calls and JSON without executing any source module.
  // Type-only dependencies are erased; disabled tree shaking keeps runtime
  // dependencies visible even if an exported function is not called here.
  const result=buildSync({absWorkingDir:root,entryPoints:[entry],bundle:true,write:false,metafile:true,
    packages:"external",platform:"node",format:"esm",external:["cloudflare:*"],treeShaking:false,logLevel:"silent"});
  const graph=new Set(Object.keys(result.metafile!.inputs).map(file=>resolve(root,file)));
  for(const file of graph){
    assert(!forbidden.has(file),`${entry} reaches deleted financial scanner ${relative(root,file)}`);
    assert(!relative(root,file).startsWith(".."),`${entry} imports an operator/private checkout`);
    if (/\.[cm]?[jt]sx?$/.test(file)) assertNoHistoricalReads(readFileSync(file,"utf8"),file);
  }
  return graph;
}

function assertNoHistoricalReads(contents:string,label:string) {
  // Transpile first: BaseCollectorClient's type-only Pick includes these names
  // but cannot issue a runtime RPC. Comments and prose strings also disappear
  // from executable code. Lower templates so interpolated calls are visible.
  const output=transformSync(contents,{loader:label.endsWith(".tsx")?"tsx":"ts",format:"esm",target:"es2022",
    supported:{"template-literal":false},legalComments:"none"}).code;
  const actions="getLogs|getContractEvents|getFilterLogs|createEventFilter|watchContractEvent|getBlockReceipts";
  const actionRead=new RegExp(`\\.\\s*(?:${actions})\\b|\\[\\s*["'](?:${actions})["']\\s*\\]|\\b(?:${actions})\\s*[:(]|\\b(?:import|export)\\s*\\{[^}]*\\b(?:${actions})\\b|\\{\\s*(?:${actions})\\s*[,}]`);
  assert(!actionRead.test(output),
    `${label} retains runtime historical RPC calls`);
  // Even the shared transport may describe limits/CU, but it may not originate
  // a scan through a hard-coded request object. Elsewhere a raw method string
  // is forbidden too, catching constants, aliases and computed request fields.
  assert(!/(?:\bmethod\b|["']method["']|\[\s*["']method["']\s*\])\s*:\s*["'](?:eth_getLogs|alchemy_getAssetTransfers)["']/.test(output),
    `${label} retains runtime historical raw requests`);
  assert(!/\balchemy_getAssetTransfers\b/.test(output),`${label} retains runtime historical Alchemy transfers`);
  const permittedTransport=resolve(root,label)===resolve(root,"server/alchemy-rpc.ts");
  const withoutDescriptions=permittedTransport ? output
    .replace(/\beth_getLogs\s*:\s*\d+\b/g,"permittedCuEntry")
    .replace(/args\.method\s*===\s*["']eth_getLogs["']/g,"permittedRangeGuard") : output;
  assert(!/\beth_getLogs\b/.test(withoutDescriptions),`${label} retains runtime historical log method strings`);
}

test("the compiler graph erases full type-only imports and includes runtime re-exports, side effects, dynamic imports and require", () => {
  const contents=`import type { Ledger } from "./type-ledger";
import { type Report } from "./type-report";
export type { Proof } from "./type-proof";
export { type Event } from "./type-event";
import { value, type Asset } from "./live";
import "./side-effect";
export * from "./runtime-export";
export function run(){console.log(value);return import("./runtime-dynamic");}
export function load(){return require("./runtime-required");}
const ignored="import './string-decoy'";
// import './comment-decoy';
console.log(ignored);`;
  const result=buildSync({stdin:{contents,loader:"ts",sourcefile:"fixture.ts"},bundle:true,write:false,
    metafile:true,platform:"node",format:"esm",external:["./*"],treeShaking:false,logLevel:"silent"});
  const imports=result.metafile!.inputs["fixture.ts"].imports;
  // Inline-only type specifiers can emit empty imports/re-exports with module
  // side effects. Keep these runtime edges instead of hiding them as types.
  assert.deepEqual(imports.map(item=>item.path).sort(),["./live","./side-effect","./runtime-export","./runtime-dynamic","./runtime-required","./type-report","./type-event"].sort());
  assert.equal(imports.find(item=>item.path==="./runtime-dynamic")!.kind,"dynamic-import");
  assert.equal(imports.find(item=>item.path==="./runtime-required")!.kind,"require-call");
});
for (const entry of ["scripts/base-buyback-keeper.ts", "scripts/buyback-keeper.ts", "worker/index.ts", "server/app.ts", "server/service.ts", "server/index.ts"]) {
  test(`${entry} has no transitive runtime dependency on deleted custody, attribution or replay modules`, () => {
    const graph = runtimeGraph(entry);
    assert(graph.has(resolve(root,"server/contract-identity.ts")), "The production path retains its lightweight immutable startup identity");
    assert(graph.size > 1, "Inspect the recursive production graph, not only the entry point");
  });
}
test("history-call guard erases type-only BaseCollectorClient names but catches runtime method and computed reads",()=>{
  assert.doesNotThrow(()=>assertNoHistoricalReads('type BaseCollectorClient=Pick<PublicClient,"getLogs"|"getContractEvents">;export const live="getLogs is only prose";',"type-fixture.ts"));
  for(const code of ['client.getLogs({});','client["getContractEvents"]({});','const {getLogs:scan}=client;scan({});'])
    assert.throws(()=>assertNoHistoricalReads(code,"runtime-fixture.ts"),/runtime historical/);
});
test("R11-3 detects lower-level requests, filters, subscriptions, receipt scans and Alchemy asset transfers",async t=>{
  const mutations:Record<string,string>={
    request:'client.request({method:"eth_getLogs",params:[{}]});',
    requestAlias:'const args={method:"eth_getLogs",params:[{}]};client.request(args);',
    computedRequest:'client["request"]({["method"]:"eth_getLogs",params:[{}]});',
    methodConstant:'const method="eth_getLogs";client.request({method,params:[{}]});',
    filterLogs:'client.getFilterLogs({filter});',
    filterCreation:'client.createEventFilter({event});',
    eventSubscription:'client.watchContractEvent({onLogs});',
    blockReceipts:'client.getBlockReceipts({blockNumber});',
    computedReceipts:'client["getBlockReceipts"]({blockNumber});',
    importedFilter:'import {getFilterLogs as scan} from "viem/actions";scan(client,{filter});',
    destructuredFilter:'const {createEventFilter:create}=client;create({event});',
    optionalSubscription:'client.watchContractEvent?.({onLogs});',
    alchemyRequest:'client.request({method:"alchemy_getAssetTransfers",params:[{}]});',
    alchemySdk:'client.alchemy_getAssetTransfers({fromBlock});',
  };
  for(const[name,code]of Object.entries(mutations))await t.test(name,()=>
    assert.throws(()=>assertNoHistoricalReads(code,"server/production-fixture.ts"),/runtime historical/));
});
test("R11-3 exempts only Alchemy's CU table and range guard; executable scan requests remain forbidden",()=>{
  const explanation='// eth_getLogs is a CU-table entry, not a production scan.\nconst cu={eth_getLogs:60};function guard(args){if(args.method==="eth_getLogs")return 10;}';
  assert.doesNotThrow(()=>assertNoHistoricalReads(explanation,"server/alchemy-rpc.ts"));
  assert.throws(()=>assertNoHistoricalReads(explanation,"server/another-transport.ts"),/runtime historical/);
  assert.throws(()=>assertNoHistoricalReads('client.request({method:"eth_getLogs",params:[{}]});',"server/alchemy-rpc.ts"),/runtime historical/);
  assert.throws(()=>assertNoHistoricalReads('const method="eth_getLogs";client.request({method});',"server/alchemy-rpc.ts"),/runtime historical/);
  assert.throws(()=>assertNoHistoricalReads('client.request({method:"alchemy_getAssetTransfers",params:[{}]});',"server/alchemy-rpc.ts"),/runtime historical/);
  assert.doesNotThrow(()=>assertNoHistoricalReads('// client.request({method:"eth_getLogs"});\ntype LegacyRequest={method:"eth_getLogs"|"alchemy_getAssetTransfers"};\ntype BaseCollectorClient=Pick<PublicClient,"getLogs"|"getContractEvents"|"getFilterLogs"|"createEventFilter"|"watchContractEvent"|"getBlockReceipts">;\nexport const current=1;',"server/type-only.ts"));
});
test("removed financial scanners cannot be invoked through old files or package commands", () => {
  for (const file of deletedModules) assert.equal(existsSync(resolve(root,file)),false, `${file} must stay removed`);
  const { scripts } = JSON.parse(readFileSync(resolve(root,"package.json"),"utf8")) as {scripts:Record<string,string>};
  assert.equal(Object.hasOwn(scripts,"ledger:buyback"),false);
  for (const [name,command] of Object.entries(scripts)) {
    for (const file of deletedModules.filter(path => path.startsWith("scripts/"))) assert(!command.includes(file), `${name} invokes removed ${file}`);
  }
  assert.match(scripts["audit:base"], /scripts\/base-buyback-keeper\.ts --audit-only(?:\s|$)/);
});
