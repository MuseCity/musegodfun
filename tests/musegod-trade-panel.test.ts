import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { parseEther, type Hash } from "viem";
import { MUSEGOD, MUSEGOD_ROUTER_VERIFICATION, type MusegodInfo, type MusegodQuote } from "../src/lib/musegod";
import type { RuntimeConfig } from "../src/lib/config";
import { resetQuoteClock } from "../src/lib/quote-clock";
import { hookRuntime, importFresh, settle } from "./hook-runtime";

const src = (path: string) => new URL(`../src/${path}`, import.meta.url).href;
const account = "0x9999999999999999999999999999999999999999", hash = `0x${"1".repeat(64)}` as Hash;
const config: RuntimeConfig = { mode: "robinhood", chainId: 4663, deploymentChainId: 4663, writesEnabled: true, treasury: account, blockReason: null };
const info: MusegodInfo = { name: MUSEGOD.name, symbol: MUSEGOD.symbol, address: MUSEGOD.token, image: "", description: "",
  quoteAddress: MUSEGOD.weth, poolAddress: MUSEGOD.pool, decimals: 18, totalSupply: "100000000000000000000", tradeEnabled: true, tradeBlockReason: null };
type Deferred<T> = { resolve: (value: T) => void; reject: (error: Error) => void };
const deferred = <T>() => { let resolve!: Deferred<T>["resolve"], reject!: Deferred<T>["reject"];
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const text = (node: any): string => node == null || typeof node === "boolean" ? "" : typeof node !== "object" ? String(node)
  : (Array.isArray(node) ? node : [node.props?.children]).map(text).join("");

// Real panel, hook, scheduler, API and quote verification; only browser visibility, wallet, fees and HTTP are injected.
async function session(t: TestContext, options: { connected?: boolean; native?: bigint; held?: bigint; deferQuotes?: boolean } = {}) {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: 1_800_000_000_000 });
  resetQuoteClock();
  const prior = Object.getOwnPropertyDescriptor(globalThis, "document"), listeners = new Set<() => void>();
  const document = { visibilityState: "visible", addEventListener: (_: string, fn: () => void) => listeners.add(fn),
    removeEventListener: (_: string, fn: () => void) => listeners.delete(fn) };
  Object.defineProperty(globalThis, "document", { configurable: true, value: document });
  let props = { config: { ...config } as RuntimeConfig | null, musegod: { info: { ...info } as MusegodInfo | null, infoError: "", revision: 0, refresh() {} } };
  const fees: ReturnType<typeof deferred<{ maxFeePerGas?: bigint; gasPrice?: bigint }>>[] = [];
  const sends: (ReturnType<typeof deferred<Hash>> & { submitted: (hash: Hash) => void })[] = [];
  const balanceReads: string[] = [], requests: { body: { side: "buy" | "sell"; amount: string; slippageBps: number }; reply: ReturnType<typeof deferred<Response>> }[] = [];
  const wallet = { account: options.connected ? account : null, chainId: 4663, revision: 0, connecting: false, connect() {},
    connection: () => ({ account: wallet.account, chainId: wallet.chainId }),
    balanceNative: async () => { balanceReads.push("ETH"); return options.native ?? parseEther("1"); },
    balance: async (asset: string) => { balanceReads.push(asset); return options.held ?? parseEther("12.345"); },
    tradeMusegod: (_q: unknown, _config: unknown, progress: (value: string) => void, submitted: (hash: Hash) => void) => {
      progress("Confirm in your wallet"); const send = { ...deferred<Hash>(), submitted }; sends.push(send); return send.promise;
    } };
  const client = { estimateFeesPerGas: () => { const fee = deferred<{ maxFeePerGas?: bigint; gasPrice?: bigint }>(); fees.push(fee); return fee.promise; },
    getGasPrice: async () => 2_000_000_000n };
  const quote = (index: number, changes: Partial<MusegodQuote> = {}): MusegodQuote => {
    const body = requests[index].body;
    return { protocol: "sushi-v3", chainId: 4663, deploymentChainId: 4663, token: MUSEGOD.token, poolAddress: MUSEGOD.pool,
      side: body.side, amountIn: parseEther(body.amount).toString(), amountOut: parseEther("10").toString(),
      minAmountOut: (parseEther("10") * BigInt(10_000 - body.slippageBps) / 10_000n).toString(), slippageBps: body.slippageBps,
      quotedAt: Date.now(), expiresAt: Date.now() + 10_000, blockNumber: "123", blockHash: hash, ...changes };
  };
  t.mock.method(globalThis, "fetch", async (path: unknown, init: RequestInit) => {
    assert.equal(path, "/api/musegod/quote"); assert.equal(init.method, "POST");
    const reply = deferred<Response>(); requests.push({ body: JSON.parse(init.body as string), reply });
    return options.deferQuotes ? reply.promise : Response.json(quote(requests.length - 1));
  });
  let Panel: any;
  const runtime = hookRuntime(() => Panel(props));
  const { useAutoQuote } = await importFresh("src/lib/use-auto-quote.ts", { react: { file: import.meta.resolve("react"), bindings: runtime.hooks } });
  ({ default: Panel } = await importFresh("src/components/MusegodTradePanel.tsx", {
    react: { file: import.meta.resolve("react"), bindings: runtime.hooks },
    "../lib/use-auto-quote": { file: src("lib/use-auto-quote.ts"), bindings: { useAutoQuote } },
    "../lib/wallet": { file: src("lib/wallet.tsx"), bindings: { useWallet: () => wallet, transactionClient: () => client } },
  }));
  t.after(() => { runtime.unmount(); resetQuoteClock();
    if (prior) Object.defineProperty(globalThis, "document", prior); else Reflect.deleteProperty(globalThis, "document"); });
  runtime.render(); await settle();
  const all = (match: (node: any) => boolean, node: any, found: any[] = []): any[] => {
    if (!node || typeof node !== "object") return found;
    if (!Array.isArray(node) && match(node)) found.push(node);
    for (const child of Array.isArray(node) ? node : [node.props?.children]) all(match, child, found);
    return found;
  };
  const findAll = (match: (node: any) => boolean) => all(match, runtime.output());
  const byClass = (name: string) => findAll(node => node.props?.className === name)[0];
  const button = (name: string) => findAll(node => node.type === "button" && text(node).trim() === name)[0];
  const s = { requests, fees, sends, wallet, client, balanceReads, quote, button, byClass, all: findAll,
    input: () => findAll(node => node.type === "input" && node.props["aria-label"] === "Trade input amount")[0],
    confirm: () => byClass("primary large full"), max: () => byClass("trade-max"),
    errors: () => findAll(node => node.props?.role === "alert").map(text),
    async tick(ms: number) { t.mock.timers.tick(ms); await settle(); },
    async type(value: string) { s.input().props.onChange({ target: { value } }); await settle(); },
    async click(node: any) { assert.ok(node, "expected a rendered control"); node.props.onClick(); await settle(); },
    async visible(value: boolean) { document.visibilityState = value ? "visible" : "hidden"; listeners.forEach(fn => fn()); await settle(); },
    async set(next: Partial<typeof props>) { props = { ...props, ...next }; runtime.render(); await settle(); },
    async info(value: MusegodInfo | null) { await s.set({ musegod: { ...props.musegod, info: value } }); },
    async answer(index: number, changes: Partial<MusegodQuote> = {}) { requests[index].reply.resolve(Response.json(quote(index, changes))); await settle(); },
    async fail(index: number, message: string) { requests[index].reply.resolve(Response.json({ error: message }, { status: 503 })); await settle(); },
  };
  return s;
}

test("MUSEGOD guest typing debounces to one verified automatic quote and updates receive/minimum/expiry", async t => {
  const s = await session(t, { deferQuotes: true });
  await s.tick(5_000); assert.equal(s.requests.length, 0); assert.equal(s.button("Get on-chain quote"), undefined); assert.equal(s.max(), undefined);
  await s.type("0.0"); await s.tick(300); await s.type("0.01"); await s.tick(599); assert.equal(s.requests.length, 0);
  await s.tick(1); assert.equal(s.requests.length, 1); assert.match(text(s.byClass("trade-box receive")), /Updating/);
  assert.deepEqual(s.requests[0].body, { side: "buy", amount: "0.01", slippageBps: 100 });
  await s.answer(0); assert.match(text(s.byClass("trade-box receive")), /10/); assert.match(text(s.byClass("rows boxed quote-summary")), /9.9 MUSEGOD.*10 seconds/);
  assert.equal(s.button("Refresh quote"), undefined);
});

test("MUSEGOD automatic dispatch gates invalid amounts, network, info and hidden pages", async t => {
  const s = await session(t);
  for (const amount of ["", "0", "-1", "no", "0.0000000000000000001"]) { await s.type(amount); await s.tick(2_000); }
  assert.equal(s.requests.length, 0);
  await s.visible(false); await s.type("0.01"); await s.tick(2_000); assert.equal(s.requests.length, 0);
  await s.visible(true); await s.set({ config: null }); await s.tick(2_000); assert.equal(s.requests.length, 0);
  await s.set({ config: { ...config, mode: "base", chainId: 8453, deploymentChainId: 8453 } }); await s.tick(2_000); assert.equal(s.requests.length, 0);
  await s.info(null); await s.set({ config }); await s.tick(2_000); assert.equal(s.requests.length, 0);
  await s.info(info); await s.tick(600); assert.equal(s.requests.length, 1);
});

for (const [name, writesEnabled, reason] of [
  ["writes are paused", false, "Transactions are currently disabled."],
  ["router verification is pending", true, MUSEGOD_ROUTER_VERIFICATION.reason],
] as const) test(`MUSEGOD previews and Refresh work while ${name}, but confirmation stays blocked`, async t => {
  const s = await session(t, { connected: true });
  await s.set({ config: { ...config, writesEnabled, blockReason: writesEnabled ? null : reason } });
  await s.info(null); await s.type("0.01"); await s.tick(2_000); assert.equal(s.requests.length, 0);
  await s.info({ ...info, tradeEnabled: false, tradeBlockReason: reason });
  await s.tick(599); assert.equal(s.requests.length, 0);
  await s.tick(1); assert.equal(s.requests.length, 1);
  assert.match(text(s.byClass("trade-box receive")), /10/);
  assert.match(text(s.byClass("rows boxed quote-summary")), /9.9 MUSEGOD/);
  assert.equal(s.confirm().props.disabled, true);
  await s.click(s.confirm()); assert.equal(s.sends.length, 0);
  for (let n = 0; n < 3; n++) { await s.tick(10_000); assert.equal(s.requests.length, n + 2); }
  await s.tick(10_000); assert.equal(s.requests.length, 4);
  const refresh = s.button("Refresh quote"); assert.ok(refresh); assert.equal(refresh.props.disabled, false);
  await s.click(refresh); assert.equal(s.requests.length, 5);
  assert.match(text(s.byClass("trade-box receive")), /10/);
  assert.equal(s.confirm().props.disabled, true);
  await s.click(s.confirm()); assert.equal(s.sends.length, 0);
});

test("MUSEGOD input, side and slippage supersede quotes, and hidden responses are discarded", async t => {
  const s = await session(t, { deferQuotes: true });
  await s.type("0.01"); await s.tick(600); await s.type("0.02"); await s.tick(600);
  await s.answer(0); assert.equal(s.byClass("rows boxed quote-summary"), undefined);
  await s.visible(false); await s.answer(1); assert.equal(s.byClass("rows boxed quote-summary"), undefined);
  await s.visible(true); await s.tick(600); await s.answer(2); assert.ok(s.byClass("rows boxed quote-summary"));
  await s.click(s.button("Sell")); assert.equal(s.input().props.value, ""); await s.tick(600); assert.equal(s.requests.length, 3);
  await s.type("1"); await s.tick(600); assert.equal(s.requests[3].body.side, "sell");
  const slippage = s.all(node => node.props?.value === 100 && typeof node.props?.onChange === "function")[0];
  slippage.props.onChange(200); await settle(); await s.tick(600); assert.equal(s.requests[4].body.slippageBps, 200);
  await s.answer(3); assert.equal(s.byClass("rows boxed quote-summary"), undefined);
  await s.answer(4); assert.ok(s.byClass("rows boxed quote-summary"));
});

test("MUSEGOD stops at three automatic expiry refreshes; explicit Refresh and input changes work", async t => {
  const s = await session(t, { connected: true }); await s.type("0.01"); await s.tick(600);
  for (let n = 0; n < 3; n++) { await s.tick(10_000); assert.equal(s.requests.length, n + 2); }
  await s.tick(10_000); assert.equal(s.requests.length, 4); assert.ok(s.button("Refresh quote")); assert.equal(s.confirm().props.disabled, true);
  await s.tick(60_000); assert.equal(s.requests.length, 4);
  await s.click(s.button("Refresh quote")); assert.equal(s.requests.length, 5); assert.equal(s.confirm().props.disabled, false);
  await s.type("0.02"); assert.equal(s.button("Refresh quote"), undefined); await s.tick(599); assert.equal(s.requests.length, 5);
  await s.tick(1); assert.equal(s.requests.length, 6);
});

test("MUSEGOD automatic failures make one POST without retries and preserve a separate newest quote error", async t => {
  const s = await session(t, { connected: true, deferQuotes: true });
  await s.type("0.01"); await s.click(s.max()); s.fees[0].reject(new Error("Fee unavailable"));
  s.client.getGasPrice = async () => { throw new Error("Fee unavailable"); }; await settle();
  assert.deepEqual(s.errors(), ["Fee unavailable"]);
  await s.tick(600); await s.fail(0, "Quote unavailable"); await s.tick(3_000); assert.equal(s.requests.length, 1);
  assert.deepEqual(s.errors(), ["Fee unavailable", "Quote unavailable"]);
  await s.click(s.button("Refresh quote")); assert.deepEqual(s.errors(), []); await s.fail(1, "Newest quote failure");
  assert.deepEqual(s.errors(), ["Newest quote failure"]);
  await s.type("0.02"); assert.deepEqual(s.errors(), []); await s.tick(600); await s.answer(2);
});

test("MUSEGOD quote verification still rejects mismatched inputs, pool and block identity", async t => {
  const s = await session(t, { connected: true, deferQuotes: true }); await s.type("0.01"); await s.tick(600);
  for (const change of [{ amountIn: "1" }, { poolAddress: account }, { blockHash: "0x0" }, { slippageBps: 200 }]) {
    const index = s.requests.length - 1; await s.answer(index, change as Partial<MusegodQuote>);
    assert.equal(s.confirm().props.disabled, true); assert.ok(s.errors().length); await s.click(s.button("Refresh quote"));
  }
  await s.answer(s.requests.length - 1); assert.equal(s.confirm().props.disabled, false);
});

test("MUSEGOD in-field Max reserves ETH gas, handles insufficient balance and uses gasPrice fallback", async t => {
  const s = await session(t, { connected: true }); assert.ok(s.all(node => node.props?.className === "trade-amount-field")[0]);
  await s.type("0.01"); await s.tick(600); assert.equal(s.confirm().props.disabled, false);
  await s.click(s.max()); assert.equal(s.confirm().props.disabled, true);
  s.fees[0].resolve({ maxFeePerGas: 1n }); await settle(); assert.equal(s.input().props.value, "0.9998");
  await s.click(s.max()); s.fees[1].reject(new Error("EIP1559 unavailable")); await settle(); assert.equal(s.input().props.value, "0.998");
  await s.click(s.max()); s.fees[2].resolve({ maxFeePerGas: 2_000_000_000_000n }); await settle();
  assert.equal(s.input().props.value, "0.998"); assert.match(s.errors().join(), /Not enough ETH for network fees/);
});

test("MUSEGOD sell keeps 25/50/75 presets and takes the full token balance through in-field Max", async t => {
  const s = await session(t, { connected: true }); await s.type("0.01"); await s.click(s.button("Sell"));
  assert.equal(s.input().props.value, ""); assert.equal(text(s.byClass("quick-amounts")), "25%50%75%");
  assert.ok(s.balanceReads.includes(MUSEGOD.token)); await s.click(s.button("25%")); assert.equal(s.input().props.value, "3.08625");
  await s.click(s.max()); assert.equal(s.input().props.value, "12.345"); assert.equal(s.fees.length, 0);
  await s.click(s.button("Buy")); assert.equal(s.input().props.value, "");
});

test("MUSEGOD late Max cannot rewrite an active trade, and confirmed trades re-quote only via Refresh", async t => {
  const s = await session(t, { connected: true }); await s.type("0.01"); await s.tick(600); const staleConfirm = s.confirm();
  await s.click(s.max()); await s.click(staleConfirm); assert.equal(s.sends.length, 1);
  s.fees[0].resolve({ maxFeePerGas: 1n }); await settle();
  assert.equal(s.input().props.value, "0.01"); assert.equal(s.input().props.disabled, true); assert.equal(s.max().props.disabled, true);
  assert.match(text(s.byClass("notice")), /Confirm in your wallet/); await s.tick(60_000); assert.equal(s.requests.length, 1);
  s.sends[0].submitted(hash); s.wallet.revision++; await s.set({});
  assert.equal(s.input().props.disabled, true); assert.match(text(s.byClass("musegod-transaction")), /Submitted/);
  s.sends[0].resolve(hash); await settle(); assert.equal(s.input().props.disabled, false); assert.match(text(s.byClass("musegod-transaction")), /Confirmed/);
  await s.tick(60_000); assert.equal(s.requests.length, 1); await s.click(s.button("Refresh quote")); assert.equal(s.requests.length, 2);
  assert.equal(s.input().props.value, "0.01"); assert.equal(s.confirm().props.disabled, false);
  await s.tick(10_000); assert.equal(s.requests.length, 3);
});

test("MUSEGOD discards Max after a unit/input/account change and hides it while balance is unknown", async t => {
  const s = await session(t, { connected: true }); await s.type("0.01"); await s.click(s.max()); await s.type("0.02");
  s.fees[0].resolve({ maxFeePerGas: 1n }); await settle(); assert.equal(s.input().props.value, "0.02");
  await s.click(s.max()); await s.click(s.button("Sell")); s.fees[1].resolve({ maxFeePerGas: 1n }); await settle(); assert.equal(s.input().props.value, "");
  s.wallet.account = null; await s.set({}); assert.equal(s.max(), undefined);
});

test("MUSEGOD confirmed trade edits keep Refresh hidden during the next debounce", async t => {
  const s = await session(t, { connected: true }); await s.type("0.01"); await s.tick(600); await s.click(s.confirm());
  s.sends[0].resolve(hash); await settle(); assert.ok(s.button("Refresh quote"));
  await s.type("0.02"); assert.equal(s.button("Refresh quote"), undefined); await s.tick(599); assert.equal(s.button("Refresh quote"), undefined);
  assert.equal(s.requests.length, 1); await s.tick(1); assert.equal(s.requests.length, 2);
});
