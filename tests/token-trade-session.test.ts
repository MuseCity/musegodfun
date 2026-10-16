import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { parseEther, type Address, type Hex } from "viem";
import { syntheticToken } from "./fixtures";
import { hookRuntime, importFresh, settle } from "./hook-runtime";
import { executeEthBuy } from "../src/lib/eth-buy";
import { ROBINHOOD_STOCKS } from "../src/lib/config";

// The real Robinhood token panel in a minimal hooks runtime with injected wallet, RPC and quote scheduler: the wallet calls,
// the fee RPC and the quote results are all deferred, so a test controls the order in which they finish.
type Pending<T> = { kind: string; resolve: (value: T) => void; reject: (error: Error) => void };
const src = (path: string) => new URL(`../src/${path}`, import.meta.url).href;
const account = "0x9999999999999999999999999999999999999999" as Address, txHash = `0x${"1".repeat(64)}` as Hex;
const config = { mode: "robinhood", chainId: 4663, deploymentChainId: 4663, writesEnabled: true };

async function session(t: TestContext, pair: "WETH" | "COST", runEth = false) {
  const stock = ROBINHOOD_STOCKS.find(s => s.symbol === pair)!;
  const token = syntheticToken({ mode: "robinhood", deploymentChainId: 4663, quoteAddress: stock.address });
  const poolKey = { currency0: stock.address, currency1: token.address, fee: 8388608, tickSpacing: 10, hooks: token.address };
  const tokenData = { token, state: { poolKey } };
  const fees: Pending<{ maxFeePerGas: bigint }>[] = [], sends: Pending<unknown>[] = [];
  const send = <T>(kind: string, progress?: (message: string) => void) => {
    progress?.("Confirm in your wallet");
    return new Promise<T>((resolve, reject) => sends.push({ kind, resolve: resolve as (value: unknown) => void, reject }));
  };
  const wallet = { account, chainId: 4663, revision: 0, connect() {}, connection: () => ({ account, chainId: 4663 }),
    lifiTrade: (_quote: unknown, _target: unknown, _config: unknown, progress: (message: string) => void) => send("lifi", progress),
    balance: async () => 5n * 10n ** 18n, balanceNative: async () => parseEther("1"),
    trade: (_quote: unknown, _config: unknown, progress: (message: string) => void) => send<Hex>("trade", progress),
    tradeNativeWeth: (_quote: unknown, _config: unknown, progress: (message: string) => void) => send<Hex>("native", progress) };
  const auto: { input: any; callbacks: any } = { input: null, callbacks: null };
  const client = { estimateFeesPerGas: () => new Promise<{ maxFeePerGas: bigint }>((resolve, reject) => fees.push({ kind: "fees", resolve, reject })),
    getTransactionReceipt: async () => ({ logs: [] }),
    getGasPrice: async () => { throw new Error("Fee RPC unavailable"); } };
  const runtime = hookRuntime(() => TokenPage({ address: token.address, config }));
  const mocks = {
    react: { file: import.meta.resolve("react"), bindings: runtime.hooks },
    "./lib/resource": { file: src("lib/resource.ts"), bindings: { useResource: (path: string) => ({ data: path === "/stocks" ? [] : tokenData, loading: false, error: "" }) } },
    "./lib/wallet": { file: src("lib/wallet.tsx"), bindings: { useWallet: () => wallet, transactionClient: () => client } },
    "./lib/use-eth-buy-record": { file: src("lib/use-eth-buy-record.ts"), bindings: { useEthBuyRecord: () => ethBuy } },
    "./lib/use-auto-quote": { file: src("lib/use-auto-quote.ts"), bindings: { useAutoQuote(input: unknown, callbacks: unknown) {
      auto.input = input; auto.callbacks = callbacks; return { pending: false, manual: false, refresh() {} }; } } },
    "./lib/eth-buy": { file: src("lib/eth-buy.ts"), bindings: { executeEthBuy: runEth ? executeEthBuy : (_plan: unknown, _context: unknown, deps: { progress: (message: string) => void }) => send<unknown>("eth", deps.progress) } },
    "./lib/api": { file: src("lib/api.ts"), bindings: { api: () => send("requote"), chainApi: () => send("requote") } },
  };
  const ethBuy = { record: null, adopted: null, sending: false, notice: null, unknown: false, checking: false, clearAdopted() {}, guard(_quote: unknown, _target: unknown, run: any) { return run({ onHash() {}, beforeSend() {} }); }, checkAgain() {}, discard() {} };
  const prior = Object.getOwnPropertyDescriptor(globalThis, "location");
  Object.defineProperty(globalThis, "location", { configurable: true, value: { origin: "http://fixture", pathname: "/", search: "" } });
  Reflect.set(globalThis, "__BUILD_IDENTITY__", { source: "local", commit: "fixture", dirty: true });
  const { TokenPage } = await importFresh("src/App.tsx", mocks, ["TokenPage"]);
  t.after(() => {
    runtime.unmount();
    if (prior) Object.defineProperty(globalThis, "location", prior); else Reflect.deleteProperty(globalThis, "location");
  });
  runtime.render(); await settle();
  const all = (match: (node: any) => boolean, node: any, found: any[] = []): any[] => {
    if (!node || typeof node !== "object") return found;
    if (!Array.isArray(node) && match(node)) found.push(node);
    for (const child of Array.isArray(node) ? node : [node.props?.children]) all(match, child, found);
    return found;
  };
  const find = (match: (node: any) => boolean) => all(match, runtime.output())[0];
  const byClass = (name: string) => find(node => node.props?.className === name);
  const s = {
    fees, sends, auto, stock, token, poolKey, byClass,
    async acknowledge() { find(node => node.type?.name === "PriceImpactAcknowledgment").props.onChange(true); await settle(); },
    input: () => find(node => node.type === "input" && node.props["aria-label"] === "Trade input amount"),
    confirm: () => byClass("primary large full"), max: () => byClass("trade-max"),
    progress: () => byClass("trade-progress")?.props.children as string | undefined,
    errors: () => all(node => node.props?.kind === "error", runtime.output()).map(node => node.props.children as string),
    pay: (label: string) => find(node => node.props?.["aria-pressed"] !== undefined && node.props.children === label),
    async click(node: any) { node.props.onClick(); await settle(); },
    async type(value: string) { s.input().props.onChange({ target: { value } }); await settle(); },
    async quote(result: unknown) { auto.callbacks.result(result); await settle(); },
    async fail(error: Error) { auto.callbacks.error(error); await settle(); },
  };
  return s;
}
const swap = () => ({ amountOut: "1000", expiresAt: Date.now() + 60_000 });
const lifi = () => ({ mode: "direct", quote: { expiresAt: Date.now() + 60_000, expectedOut: "1000", minimumOut: "900", feeAmount: "0" } });

for (const [name, pair, kind] of [["native WETH wrap-and-swap", "WETH", "native"], ["LI.FI", "COST", "eth"]] as const) {
  const ready = async (t: TestContext) => {
    const s = await session(t, pair);
    if (pair === "COST") await s.click(s.pay("ETH"));
    await s.type("0.001");
    await s.quote(pair === "COST" ? lifi() : swap());
    return s;
  };
  test(`${name}: confirmation is not offered while Max awaits fees`, async t => {
    const s = await ready(t);
    assert.equal(s.confirm().props.disabled, false);
    await s.click(s.max());
    assert.equal(s.fees.length, 1); assert.equal(s.confirm().props.disabled, true);
    s.fees[0].resolve({ maxFeePerGas: 1n }); await settle();
    assert.equal(s.input().props.value, "0.9998");
  });
  test(`${name}: a trade started while Max awaits fees keeps its amount, progress and busy state`, async t => {
    const s = await ready(t), staleConfirm = s.confirm();
    await s.click(s.max());
    // A click that landed before the disabled state rendered still starts the trade; the late Max result must not touch it.
    await s.click(staleConfirm);
    assert.deepEqual(s.sends.map(send => send.kind), [kind]);
    assert.equal(s.input().props.disabled, true); assert.equal(s.auto.input.busy, true);
    s.fees[0].resolve({ maxFeePerGas: 1n }); await settle();
    assert.equal(s.input().props.value, "0.001");
    assert.equal(s.input().props.disabled, true); assert.equal(s.auto.input.busy, true);
    assert.equal(s.progress(), "Confirm in your wallet");
    assert.equal(s.max().props.disabled, true);
    s.sends[0].resolve(pair === "COST" ? { hash: txHash, received: null, mode: "direct" } : txHash); await settle();
    assert.equal(s.input().props.value, "0.001"); assert.equal(s.input().props.disabled, false);
    assert.equal(s.auto.input.busy, false); assert.equal(s.auto.input.completed, true);
  });
}

test("native Max without a trade still fills the balance less the gas reserve", async t => {
  const s = await session(t, "WETH");
  await s.type("0.001"); await s.click(s.max());
  s.fees[0].resolve({ maxFeePerGas: 1n }); await settle();
  assert.equal(s.input().props.value, "0.9998"); assert.equal(s.max().props.disabled, false);
});

test("an explicit WETH pick on a WETH pair pays with WETH through Permit2, never with ETH value", async t => {
  const s = await session(t, "WETH");
  assert.equal(s.pay("ETH").props["aria-pressed"], true);
  await s.click(s.pay("WETH"));
  assert.equal(s.pay("WETH").props["aria-pressed"], true);
  await s.type("0.001");
  assert.equal(s.auto.input.lifi, false);
  await s.quote(swap());
  await s.click(s.confirm());
  assert.deepEqual(s.sends.map(send => send.kind), ["trade"]);
});

test("the newest quote failure shows beside, never instead of, an error the user has not acted on", async t => {
  const s = await session(t, "WETH");
  await s.type("0.001"); await s.quote(swap());
  // An unrelated error: Max cannot read the network fee.
  await s.click(s.max()); s.fees[0].reject(new Error("Fee RPC unavailable")); await settle();
  assert.deepEqual(s.errors(), ["Fee RPC unavailable"]);
  await s.fail(new Error("Security check required"));
  assert.deepEqual(s.errors(), ["Fee RPC unavailable", "Security check required"]);
  await s.fail(new Error("Quote unavailable"));
  assert.deepEqual(s.errors(), ["Fee RPC unavailable", "Quote unavailable"]);
  // A quote that arrives ends the quote failure only.
  await s.quote(swap());
  assert.deepEqual(s.errors(), ["Fee RPC unavailable"]);
  await s.fail(new Error("Quote unavailable"));
  // Changing the input starts over.
  await s.type("0.002");
  assert.deepEqual(s.errors(), []);
});

for (const route of ["native", "pair", "sell", "two-step"] as const) test(`${route}: high-impact acknowledgment gates confirmation and resets on every new quote`, async t => {
  const s = await session(t, route === "two-step" ? "COST" : "WETH");
  if (route === "two-step") await s.click(s.pay("ETH"));
  if (route === "pair") await s.click(s.pay("WETH"));
  if (route === "sell") await s.click(s.pay("Sell"));
  await s.type("1");
  const q = { ...swap(), amountIn: "10000", amountOut: "8000", poolPrice: { sqrtPriceX96: String(2n ** 96n), blockNumber: "123", zeroForOne: true, feeBps: 0 } };
  const response = () => route === "two-step" ? { mode: "two-step", conversion: { expiresAt: q.expiresAt, feeAmount: "0" }, swapPreview: { ...q } } : { ...q };
  await s.quote(response()); assert.equal(s.confirm().props.disabled, true);
  await s.acknowledge(); assert.equal(s.confirm().props.disabled, false);
  const replacement = response();
  await s.quote(replacement); assert.equal(s.confirm().props.disabled, true);
  await s.acknowledge(); await s.type("2"); await s.quote(replacement);
  assert.equal(s.confirm().props.disabled, true, "a changed amount cannot reuse an old acknowledgment");
  if (route === "two-step") {
    await s.acknowledge(); await s.quote({ ...replacement });
    assert.equal(s.confirm().props.disabled, true, "a different plan requires acknowledgment even if it reuses the preview object");
  }
});

for (const belowFloor of [false, true]) test(`acknowledge → convert → high-impact requote: ${belowFloor ? "minimum output still blocks" : "the accepted plan reaches the swap"}`, async t => {
  const s = await session(t, "COST", true);
  await s.click(s.pay("ETH")); await s.type("1");
  const preview = { amountIn: "10000", amountOut: "8000", quotedAt: Date.now(), expiresAt: Date.now() + 60_000,
    side: "buy", token: s.token.address, currencyIn: s.stock.address, poolKey: s.poolKey, slippageBps: 100,
    poolPrice: { sqrtPriceX96: String(2n ** 96n), blockNumber: "123", zeroForOne: true, feeBps: 0 } };
  await s.quote({ mode: "two-step", conversion: { expiresAt: preview.expiresAt, feeAmount: "0" }, swapPreview: preview });
  await s.click(s.confirm()); assert.equal(s.sends.length, 0);
  await s.acknowledge(); await s.click(s.confirm()); assert.equal(s.sends[0].kind, "lifi");
  s.sends[0].resolve({ hash: txHash, received: 11000n }); await settle();
  assert.equal(s.sends[1]?.kind, "requote", JSON.stringify(s.errors()));
  s.sends[1].resolve({ ...preview, amountIn: "11000", amountOut: belowFloor ? "7919" : "8200" }); await settle();
  assert.deepEqual(s.sends.map(row => row.kind), belowFloor ? ["lifi", "requote"] : ["lifi", "requote", "trade"]);
  if (!belowFloor) { s.sends[2].resolve(txHash); await settle(); }
});
