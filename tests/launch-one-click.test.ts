import assert from "node:assert/strict";
import test from "node:test";
import { parseUnits } from "viem";
import { ROBINHOOD_STOCKS } from "../src/lib/config";
import { FEE_POLICY } from "../src/lib/fee-policy";
import { CURVE_POLICY } from "../src/lib/launch-curve";
import { find, installGlobals, launchForm, nodes, store, textOf, wallet } from "./launch-form";

// Owner, 2026-10-19: a launch without a first buy or a payment conversion has no separate preview. One click on Confirm prepares the
// plan, checks it and opens the wallet; opening the review prepares nothing, and nothing prepares in the background. First buys and
// conversions keep their preview (tests/launch-review.test.ts).

const weth = ROBINHOOD_STOCKS.find((asset) => asset.symbol === "WETH")!;
const treasury = "0x1111111111111111111111111111111111111111", token = "0x2222222222222222222222222222222222222222";
const preview = { treasury, launchGuard: "0x3333333333333333333333333333333333333333", curvePolicy: CURVE_POLICY } as const;
let plans = 0;
/** The server's preview with a fresh id each time; only the fields the launch reads are real. */
function prepare(body: any) {
  const now = Date.now(), id = `0x${String(++plans).padStart(64, "0")}`;
  return { id, creator: body.creator, data: "0x", tokenAddress: token, poolId: `0x${"cd".repeat(32)}`,
    draft: { ...body.draft, tradingFeeBps: body.draft.tradingFeeBps ?? 100 }, preparedAt: now, finalizedAt: now, signingExpiresAt: now + 300_000,
    serverTime: now, validityVersion: 2, intentId: body.options.intentId, gas: null, feePolicy: FEE_POLICY, feeTreasury: treasury,
    curvePolicy: CURVE_POLICY, openingValuation: {}, transaction: { to: token, data: "0x", value: "0" },
    ...(Number(body.firstBuy.amount) > 0 ? { firstBuy: { amount: body.firstBuy.amount, amountIn: parseUnits(body.firstBuy.amount, 18).toString(),
      expectedAmountOut: "20000000000000000000000000", minAmountOut: "19800000000000000000000000", slippageBps: body.firstBuy.slippageBps,
      deadline: Math.floor(now / 1000) + 300, recipient: body.creator, quoteAddress: weth.address, guard: preview.launchGuard,
      bundler: preview.launchGuard, lockDays: body.firstBuy.lockDays } } : {}) };
}
const confirm = (dialog: any) => find(dialog, (element) => element.type === "button" && /^Confirm launch/.test(textOf(element)) || /Preparing your launch|Waiting for confirmation/.test(textOf(element)) && element.type === "button");
const errors = (dialog: any) => nodes(dialog).filter((element) => element.props?.kind === "error").map(textOf);

test.before(() => {
  installGlobals();
  // The intent lock: Web Locks grant the lock at once in one tab.
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { locks: { request: async (_key: string, _options: unknown, run: (lock: unknown) => unknown) => run({}) } } });
});
test.beforeEach(() => { store.clear(); plans = 0; });

test("one Confirm prepares once and opens the wallet with that plan; a cancelled wallet reuses it; an expired plan prepares again on the next click only", async (t) => {
  let now = Date.now(); t.mock.method(Date, "now", () => now);
  const launches: string[] = [];
  wallet.launch = async (plan: { id: string }) => { launches.push(plan.id); throw new Error("User rejected the request"); };
  t.after(() => { delete wallet.launch; });
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const form = await launchForm(t, { config: preview, api: { "/launch/prepare": async (body) => { if (plans === 0) await held; return prepare(body); } } });
  await form.type("name", "Preview Cat"); await form.type("symbol", "PCAT");
  await form.submit(); await form.submit();
  assert.deepEqual(form.calls, [], "opening the review prepares nothing");
  let button = confirm(form.dialog());
  assert.equal(textOf(button), "Confirm launch · Sign in wallet"); assert.equal(button.props.disabled, false);

  button.props.onClick(); await form.flush();
  button = confirm(form.dialog());
  assert.deepEqual([textOf(button), button.props.disabled], ["Preparing your launch…", true], "the click prepares first");
  release(); await form.flush();
  assert.deepEqual(form.calls, ["/launch/prepare"]);
  assert.deepEqual(launches, [`0x${"1".padStart(64, "0")}`], "then opens the wallet with the plan it prepared, in the same click");
  assert.deepEqual(errors(form.dialog()), ["User rejected the request"]);
  assert.equal(nodes(form.dialog()).some((element) => String(element.props?.className ?? "").includes("plan-result")), false, "no preview to report");

  confirm(form.dialog()).props.onClick(); await form.flush();
  assert.deepEqual(form.calls, ["/launch/prepare"], "a current plan is reused: no second prepare");
  assert.deepEqual(launches, [`0x${"1".padStart(64, "0")}`, `0x${"1".padStart(64, "0")}`]);

  now += 301_000; t.mock.timers.tick(301_000); await form.flush();
  assert.deepEqual(form.calls, ["/launch/prepare"], "an expired plan is not refreshed in the background");
  const text = textOf(form.dialog());
  assert.equal(text.includes("This preview has expired"), false, "no preview, so no preview expiry notice");
  assert.equal(textOf(confirm(form.dialog())), "Confirm launch · Sign in wallet");
  confirm(form.dialog()).props.onClick(); await form.flush();
  assert.deepEqual(form.calls, ["/launch/prepare", "/launch/prepare"], "the next click prepares a fresh plan");
  assert.equal(launches.at(-1), `0x${"2".padStart(64, "0")}`);
});

test("a failed prepare shows its error and opens no wallet; Confirm is the retry, without the first buy's retry buttons", async (t) => {
  const launches: string[] = [];
  wallet.launch = async (plan: { id: string }) => { launches.push(plan.id); return `0x${"ee".repeat(32)}`; };
  t.after(() => { delete wallet.launch; });
  const form = await launchForm(t, { config: preview, api: { "/launch/prepare": async () => { throw new Error("LI.FI pricing or routing is unavailable for this asset."); } } });
  await form.type("name", "Preview Cat"); await form.type("symbol", "PCAT");
  await form.submit(); await form.submit();
  confirm(form.dialog()).props.onClick(); await form.flush();
  assert.deepEqual(form.calls, ["/launch/prepare"]); assert.deepEqual(launches, []);
  const dialog = form.dialog();
  assert.deepEqual(errors(dialog), ["LI.FI pricing or routing is unavailable for this asset."]);
  for (const label of ["Retry preview", "Choose another payment asset", "Launch without a first buy"])
    assert.equal(find(dialog, (element) => element.type === "button" && textOf(element).startsWith(label)), null, label);
  assert.equal(confirm(dialog).props.disabled, false, "Confirm tries again");
});

test("Confirm stays disabled while writes are off or the platform treasury is missing", async (t) => {
  for (const [name, config] of [["writes off", { ...preview, writesEnabled: false }], ["no treasury", { ...preview, treasury: null }]] as const)
    await t.test(name, async (st) => {
      store.clear();
      const form = await launchForm(st, { config, api: { "/launch/prepare": prepare } });
      await form.type("name", "Preview Cat"); await form.type("symbol", "PCAT");
      await form.submit(); await form.submit();
      assert.equal(confirm(form.dialog()).props.disabled, true);
      assert.deepEqual(form.calls, []);
    });
});
