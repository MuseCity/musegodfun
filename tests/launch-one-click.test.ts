import assert from "node:assert/strict";
import test from "node:test";
import { parseUnits } from "viem";
import { ROBINHOOD_STOCKS } from "../src/lib/config";
import { FEE_POLICY } from "../src/lib/fee-policy";
import { CURVE_POLICY } from "../src/lib/launch-curve";
import { find, installGlobals, launchForm, nodes, store, textOf, wallet } from "./launch-form";

// Owner, 2026-10-19: a launch without a first buy or a payment conversion has no separate preview. One click on Confirm prepares the
// plan, checks it and opens the wallet; opening the review prepares nothing, nothing prepares in the background, and a click asks at
// most once (no automatic retries). First buys and conversions keep their preview (tests/launch-review.test.ts).

const weth = ROBINHOOD_STOCKS.find((asset) => asset.symbol === "WETH")!;
const treasury = "0x1111111111111111111111111111111111111111", token = "0x2222222222222222222222222222222222222222";
const preview = { treasury, launchGuard: "0x3333333333333333333333333333333333333333", curvePolicy: CURVE_POLICY } as const;
const declined = "You cancelled the wallet request. You can make changes and try again.";
let plans = 0;
const planId = (n: number) => `0x${String(n).padStart(64, "0")}`;
/** The server's preview with a fresh id each time; only the fields the launch reads are real. */
function prepare(body: any, extra: Record<string, unknown> = {}) {
  const now = Date.now();
  return { id: planId(++plans), creator: body.creator, data: "0x", tokenAddress: token, poolId: `0x${"cd".repeat(32)}`,
    draft: { ...body.draft, tradingFeeBps: body.draft.tradingFeeBps ?? 100 }, preparedAt: now, finalizedAt: now, signingExpiresAt: now + 300_000,
    serverTime: now, validityVersion: 2, intentId: body.options.intentId, gas: null, feePolicy: FEE_POLICY, feeTreasury: treasury,
    curvePolicy: CURVE_POLICY, openingValuation: {}, transaction: { to: token, data: "0x", value: "0" },
    ...(Number(body.firstBuy.amount) > 0 ? { firstBuy: { amount: body.firstBuy.amount, amountIn: parseUnits(body.firstBuy.amount, 18).toString(),
      expectedAmountOut: "20000000000000000000000000", minAmountOut: "19800000000000000000000000", slippageBps: body.firstBuy.slippageBps,
      deadline: Math.floor(now / 1000) + 300, recipient: body.creator, quoteAddress: weth.address, guard: preview.launchGuard,
      bundler: preview.launchGuard, lockDays: body.firstBuy.lockDays } } : {}), ...extra };
}
const confirm = (dialog: any) => find(dialog, (element) => element.type === "button" && element.props.className === "primary large full");
const errors = (dialog: any) => nodes(dialog).filter((element) => element.props?.kind === "error").map(textOf);
const warnings = (dialog: any) => nodes(dialog).filter((element) => element.props?.kind === "warning").map(textOf);
/** The wallet declines (EIP-1193 4001), as a person cancelling the prompt. */
const decline = () => Object.assign(new Error("User rejected the request"), { code: 4001 });

async function openPlainReview(t: any, api: Record<string, (body: any) => unknown>, config: Record<string, unknown> = preview) {
  const form = await launchForm(t, { config, api });
  await form.type("name", "Preview Cat"); await form.type("symbol", "PCAT");
  await form.submit(); await form.submit();
  return form;
}
async function click(form: Awaited<ReturnType<typeof launchForm>>) { confirm(form.dialog()).props.onClick(); await form.flush(); }

test.before(() => {
  installGlobals();
  // The intent lock: Web Locks grant the lock at once in one tab.
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { locks: { request: async (_key: string, _options: unknown, run: (lock: unknown) => unknown) => run({}) } } });
});
test.beforeEach(() => { store.clear(); plans = 0; });

test("one Confirm prepares once, without automatic retries, and opens the wallet with that plan; a declined plan is reused while it has time to spare", async (t) => {
  let now = Date.now(); t.mock.method(Date, "now", () => now);
  const launches: string[] = [];
  wallet.launch = async (plan: { id: string }) => { launches.push(plan.id); throw decline(); };
  t.after(() => { delete wallet.launch; });
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const form = await openPlainReview(t, { "/launch/prepare": async (body) => { if (plans === 0) await held; return prepare(body); } });
  assert.deepEqual(form.calls, [], "opening the review prepares nothing");
  assert.deepEqual([textOf(confirm(form.dialog())), confirm(form.dialog()).props.disabled], ["Confirm launch · Sign in wallet", false]);

  confirm(form.dialog()).props.onClick(); confirm(form.dialog()).props.onClick(); await form.flush();
  assert.deepEqual([textOf(confirm(form.dialog())), confirm(form.dialog()).props.disabled], ["Preparing your launch…", true], "the click prepares first");
  assert.deepEqual(form.calls, ["/launch/prepare"], "a second click in the same moment adds nothing");
  release(); await form.flush();
  assert.deepEqual(form.callOptions, [{ retry: false }], "the prepare asks once: no automatic retries");
  assert.deepEqual(launches, [planId(1)], "then opens the wallet with the plan it prepared, in the same click");
  assert.deepEqual(errors(form.dialog()), [declined]);
  assert.equal(nodes(form.dialog()).some((element) => String(element.props?.className ?? "").includes("plan-result")), false, "no preview to report");

  await click(form);
  assert.deepEqual(form.calls, ["/launch/prepare"], "a declined plan is reused: no second prepare");
  assert.deepEqual(launches, [planId(1), planId(1)]);

  // With 89 seconds left the wallet layer would refresh it with its own prepare, so the click prepares a fresh one instead.
  now += 211_000; await form.flush();
  await click(form);
  assert.deepEqual(form.calls, ["/launch/prepare", "/launch/prepare"]);
  assert.equal(launches.at(-1), planId(2));

  now += 301_000; t.mock.timers.tick(301_000); await form.flush();
  assert.equal(form.calls.length, 2, "an expired plan is not refreshed in the background");
  assert.equal(textOf(form.dialog()).includes("This preview has expired"), false, "no preview, so no preview expiry notice");
  await click(form);
  assert.equal(form.calls.length, 3, "the next click prepares a fresh plan");
  assert.equal(launches.at(-1), planId(3));
});

test("a fresh plan with warnings stops before the wallet so they can be read; the next click launches that plan", async (t) => {
  for (const [name, extra, shown] of [
    ["an opening price warning", { openingValuation: { warnings: [{ code: "reference_price_divergence", message: "The opening price differs from its independent reference by 7.00%. Review this difference before continuing." }] } },
      "The opening price differs from its independent reference by 7.00%. Review this difference before continuing."],
    ["an asset warning", { warnings: [{ code: "asset_oracle_paused", message: "The NVDA issuer oracle is paused. Review the price before continuing." }] },
      "The NVDA issuer oracle is paused. Review the price before continuing."],
  ] as const)
    await t.test(name, async (st) => {
      store.clear(); plans = 0;
      const launches: string[] = [];
      wallet.launch = async (plan: { id: string }) => { launches.push(plan.id); throw decline(); };
      st.after(() => { delete wallet.launch; });
      const form = await openPlainReview(st, { "/launch/prepare": (body) => prepare(body, extra) });
      await click(form);
      assert.deepEqual(form.calls, ["/launch/prepare"]); assert.deepEqual(launches, [], "the wallet waits");
      assert.deepEqual(warnings(form.dialog()), [shown]);
      await click(form);
      assert.deepEqual(form.calls, ["/launch/prepare"], "the warned plan is reused");
      assert.deepEqual(launches, [planId(1)]);
    });
});

test("a failed launch that sent nothing prepares afresh next time, and its message points to Confirm", async (t) => {
  const launches: string[] = [];
  wallet.launch = async (plan: { id: string }) => { launches.push(plan.id); throw new Error("The launch preview has changed. Run a new preview."); };
  t.after(() => { delete wallet.launch; });
  const form = await openPlainReview(t, { "/launch/prepare": prepare });
  await click(form);
  assert.deepEqual(errors(form.dialog()), ["The launch preview has changed. Confirm again."]);
  await click(form);
  assert.deepEqual(form.calls, ["/launch/prepare", "/launch/prepare"], "the failed plan is not reused");
  assert.deepEqual(launches, [planId(1), planId(2)]);
});

test("while a sent launch is unresolved, Confirm is off and nothing prepares over its saved plan", async (t) => {
  let now = Date.now(); t.mock.method(Date, "now", () => now);
  // The wallet's answer never arrives: the submission marker stays, as after a mobile wallet reload.
  wallet.launch = async (plan: { id: string; intentId: string }) => {
    const key = [...store.keys()].find((name) => name.startsWith("musegod.launch.plan.") && name.endsWith(plan.intentId))!.replace(".plan.", ".submission.");
    store.set(key, JSON.stringify({ planId: plan.id })); throw new Error("Wallet disconnected before returning the transaction hash");
  };
  t.after(() => { delete wallet.launch; });
  const form = await openPlainReview(t, { "/launch/prepare": prepare });
  await click(form);
  const saved = [...store.entries()].filter(([key]) => key.startsWith("musegod.launch.plan."));
  assert.equal(saved.length, 1);
  assert.equal(confirm(form.dialog()).props.disabled, true, "Confirm waits for recovery");
  now += 301_000; t.mock.timers.tick(301_000); await form.flush();
  confirm(form.dialog()).props.onClick(); await form.flush();
  assert.deepEqual(form.calls, ["/launch/prepare"], "no prepare while the launch is unresolved");
  assert.deepEqual([...store.entries()].filter(([key]) => key.startsWith("musegod.launch.plan.")), saved, "the saved plan recovery compares with is kept");
  assert.match(errors(form.dialog()).join(" "), /Recover the submitted launch before preparing another launch\./);
});

test("a failed prepare opens no wallet and shows no first-buy retry buttons; Confirm is the retry", async (t) => {
  const launches: string[] = [];
  wallet.launch = async (plan: { id: string }) => { launches.push(plan.id); return `0x${"ee".repeat(32)}`; };
  t.after(() => { delete wallet.launch; });
  const form = await openPlainReview(t, { "/launch/prepare": async () => { throw new Error("LI.FI pricing or routing is unavailable for this asset."); } });
  await click(form);
  assert.deepEqual(form.calls, ["/launch/prepare"]); assert.deepEqual(launches, []);
  const dialog = form.dialog();
  assert.deepEqual(errors(dialog), ["LI.FI pricing or routing is unavailable for this asset."]);
  for (const label of ["Retry preview", "Choose another payment asset", "Launch without a first buy"])
    assert.equal(find(dialog, (element) => element.type === "button" && textOf(element).startsWith(label)), null, label);
  assert.equal(confirm(dialog).props.disabled, false, "Confirm tries again");
});

test("Confirm stays off with writes off, without the platform treasury, or on the wrong chain", async (t) => {
  for (const [name, config, chainId] of [["writes off", { ...preview, writesEnabled: false }, 4663], ["no treasury", { ...preview, treasury: null }, 4663],
    ["wrong chain", preview, 1]] as const)
    await t.test(name, async (st) => {
      store.clear(); wallet.chainId = chainId; st.after(() => { wallet.chainId = 4663; });
      const form = await openPlainReview(st, { "/launch/prepare": prepare }, config);
      assert.equal(confirm(form.dialog()).props.disabled, true);
      assert.deepEqual(form.calls, []);
    });
});

test("a first buy keeps its preview: prepared on opening, with automatic retries, and confirmed by a second button", async (t) => {
  const form = await launchForm(t, { config: preview, api: { "/launch/prepare": prepare } });
  await form.type("name", "Preview Cat"); await form.type("symbol", "PCAT");
  await form.submit();
  await form.firstBuy({ amount: "0.01", payAddress: weth.address });
  await form.submit();
  assert.deepEqual(form.calls, ["/launch/prepare"]); assert.deepEqual(form.callOptions, [undefined]);
  assert.equal(textOf(confirm(form.dialog())), "Confirm launch and first buy");
});
