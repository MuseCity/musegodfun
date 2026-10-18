import assert from "node:assert/strict";
import test from "node:test";
import { formatUnits, parseUnits } from "viem";
import { ROBINHOOD_STOCKS } from "../src/lib/config";
import { FEE_POLICY } from "../src/lib/fee-policy";
import { firstBuyPaymentAssets } from "../src/lib/first-buy-payment";
import { CURVE_POLICY } from "../src/lib/launch-curve";
import { NFT_DISCLAIMER } from "../src/components/NftLaunchStep";
import { find, holder, installGlobals, launchForm, muse, nodes, store, textOf } from "./launch-form";

// Owner, 2026-10-18: the launch review dialog repeated itself. Each fact a person needs before signing is stated once; nothing the
// wallet signs, no amount, fee, lock, irreversible effect or NFT rule is lost (tasks/launch-review-trim-plan.md).

const weth = ROBINHOOD_STOCKS.find((asset) => asset.symbol === "WETH")!;
const usdg = firstBuyPaymentAssets(4663, weth.address).find((asset) => asset.symbol === "USDG")!;
const treasury = "0x1111111111111111111111111111111111111111", token = "0x2222222222222222222222222222222222222222";
const preview = { treasury, launchGuard: "0x3333333333333333333333333333333333333333", curvePolicy: CURVE_POLICY } as const;
const minimumOut = 3_267_000_000_000_000n;

/** The server's preview, echoing the request; only the fields the review shows and checks are real. */
function prepare(body: any) {
  const now = Date.now(), buy = Number(body.firstBuy.amount) > 0;
  return { id: `0x${"ab".repeat(32)}`, creator: body.creator, data: "0x", tokenAddress: token, poolId: `0x${"cd".repeat(32)}`,
    draft: { ...body.draft, tradingFeeBps: body.draft.tradingFeeBps ?? 100 }, preparedAt: now, finalizedAt: now, signingExpiresAt: now + 300_000,
    serverTime: now, validityVersion: 2, intentId: body.options.intentId, gas: null, feePolicy: FEE_POLICY, feeTreasury: treasury,
    curvePolicy: CURVE_POLICY, openingValuation: {}, transaction: { to: token, data: "0x", value: "0" },
    ...(buy ? { firstBuy: { amount: body.firstBuy.amount, amountIn: parseUnits(body.firstBuy.amount, 18).toString(),
      expectedAmountOut: "20000000000000000000000000", minAmountOut: "19800000000000000000000000", slippageBps: body.firstBuy.slippageBps,
      deadline: Math.floor(now / 1000) + 300, recipient: body.creator, quoteAddress: weth.address, guard: preview.launchGuard,
      bundler: preview.launchGuard, lockDays: body.firstBuy.lockDays } } : {}) };
}
/** A LI.FI quote converting 10 USDG into at least 0.003267 WETH, for `account`. */
const quote = (account: string) => (body: any) => {
  const now = Date.now();
  return { protocol: "lifi", id: "quote-1", transactionId: `0x${"ef".repeat(32)}`, integrator: "musegodfun", tool: "test", chainId: 4663, account,
    fromToken: usdg, toToken: { chainId: 4663, address: weth.address, symbol: "WETH", decimals: 18 }, amountIn: parseUnits(body.amount, 6).toString(),
    expectedOut: "3300000000000000", minimumOut: minimumOut.toString(), slippageBps: body.slippageBps, quotedAt: now, expiresAt: now + 60_000,
    router: token, facet: token, facetRuntimeHash: `0x${"00".repeat(32)}`, blockNumber: "1", blockHash: `0x${"00".repeat(32)}`,
    transaction: { to: token, data: "0x", value: "0" }, approval: null, feeAmount: "25000", feeUsd: "0.03", gasFeeUsd: "0.01", amountInUsd: "10" };
};
const count = (text: string, pattern: RegExp) => text.match(new RegExp(pattern.source, `${pattern.flags.replace("g", "")}g`))?.length ?? 0;
const byClass = (node: any, name: string) => find(node, (element) => String(element.props?.className ?? "").split(" ").includes(name));
const byLabel = (node: any, label: string) => find(node, (element) => element.props?.["aria-label"] === label);
/** A definition list's rows as [term, description] text pairs. */
const rows = (list: any) => nodes(list).filter((element) => element.type === "div" && find(element.props.children, (child) => child.type === "dt"))
  .map((row) => [textOf(find(row.props.children, (child) => child.type === "dt")), textOf(find(row.props.children, (child) => child.type === "dd"))]);
const terms = (list: any) => rows(list).map(([term]) => term);
const success = (dialog: any) => nodes(dialog).filter((element) => element.props?.kind === "success" || String(element.props?.className ?? "").includes("plan-result")).map(textOf);

test.before(installGlobals);
test.beforeEach(() => store.clear());

test("a plain coin's review states each fact once and keeps what is fixed, the fee, the share and the window", async (t) => {
  const form = await launchForm(t, { config: preview, api: { "/launch/prepare": prepare } });
  await form.type("name", "Preview Cat"); await form.type("symbol", "PCAT");
  await form.submit(); await form.submit();
  assert.deepEqual(form.calls, ["/launch/prepare"], "opening review with a wallet previews the launch");
  const dialog = form.dialog(), text = textOf(dialog);
  assert.match(text, /One wallet transaction launches the pool\. You pay network gas\. The name, symbol, pair, trading fee, and fee distribution are fixed after launch\./);
  assert.match(textOf(byClass(dialog, "review-identity")), /\$PCAT · WETH pair · Robinhood Chain/);
  assert.deepEqual(rows(byClass(dialog, "review-tiles")), [["Trading fee", "1% + 0.05% LP"], ["Opens at", "$5,000"], ["First buy", "None"]]);
  assert.equal(textOf(byClass(dialog, "review-earn")), "You earn 0.665% of every trade");
  assert.deepEqual(terms(byClass(dialog, "review-facts")), ["Trading fee split", "Buyback target / recipient", "Robinhood Chain platform treasury",
    "Platform income allocation (platform income = 100%)", "Network / protocol", "Asset issuer", "Supply", "Opening price reference"]);
  assert.equal(rows(byClass(dialog, "review-facts"))[0][1], "Creator 66.5% · Buyback 22.8% · Operations 5.7% · Doppler 5%");
  assert.equal(count(text, /five minutes|5-minute/), 1, "the signing window is stated once");
  assert.match(text, /You have five minutes to confirm in your wallet once the preview is ready\./);
  for (const gone of ["READY TO LAUNCH", "Permanent after launch", "Quote asset", "Parameter check", "Wallet confirmation", "Set using LI.FI",
    "Initial valuation target", "Nominal total fee", "Net fee distribution", "Total fee allocation", "Launch cost", "Buyback 0.228%"])
    assert.equal(text.includes(gone), false, `${gone} is gone`);
  assert.deepEqual(success(dialog), [`Simulation passed · Predicted token address${token}`], "one success notice");
  assert(find(dialog, (element) => element.type === "button" && textOf(element) === "Confirm launch · Sign in wallet"));
});

test("a first buy paid by conversion shows each amount, fee, lock and the recipient once", async (t) => {
  const form = await launchForm(t, { config: preview, api: { "/first-buy/quote": quote(holder), "/launch/prepare": prepare } });
  await form.type("name", "Preview Cat"); await form.type("symbol", "PCAT");
  await form.submit();
  await form.firstBuy({ amount: "10", payAddress: usdg.address });
  await form.submit();
  assert.deepEqual(form.calls, ["/first-buy/quote", "/launch/prepare"]);
  const dialog = form.dialog(), text = textOf(dialog), spend = formatUnits(minimumOut, 18);
  assert.match(text, /Your payment converts first; one wallet transaction then launches the pool and makes your first buy\. You pay network gas\./);
  assert.deepEqual(rows(byClass(dialog, "review-tiles"))[2], ["First buy", "10 USDG · no lock"]);
  assert.deepEqual(rows(byLabel(dialog, "Payment conversion review")), [["You pay", `10 USDG → at least ${spend} WETH`],
    ["Fees", "0.025 USDG (≈ $0.03) route fee · gas ≈ $0.01"]]);
  const buy = byLabel(dialog, "First buy preview");
  assert.deepEqual(terms(buy), ["You spend", "Estimated tokens received", "Minimum tokens received", "Share of total supply", "First buy lock", "Recipient"]);
  assert.deepEqual(rows(buy)[0], ["You spend", `${spend} WETH · approval for this amount only`]);
  assert.deepEqual(rows(buy)[4], ["First buy lock", "No lock"]);
  assert.deepEqual(rows(buy)[5], ["Recipient", holder]);
  assert.match(textOf(buy), /Any required approval comes first; if the buy fails, the launch reverts too, and a confirmed approval stays in place\./);
  assert.equal(count(text, new RegExp(holder, "i")), 1, "the recipient is shown once");
  assert.equal(count(text, /slippage/i), 1, "slippage appears only as its control");
  assert.equal(count(text, /five minutes|5-minute|expires/i), 1, "the signing window is stated once");
  assert.equal(count(text, /A completed conversion stays in your wallet if you cancel or the launch fails\./), 1);
  for (const gone of ["Estimated paired asset", "Quote expires", "Preview expires", "Approval amount", "Slippage tolerance", "Payment and first buy quoted together"])
    assert.equal(text.includes(gone), false, `${gone} is gone`);
  assert.deepEqual(success(dialog), [`Payment and first buy quoted · Predicted token address${token}`]);
  assert(find(dialog, (element) => element.type === "button" && textOf(element) === "Convert payment and launch"));
});

test("a locked first buy in the pair asset needs no conversion card and shows its lock in the tile and the card", async (t) => {
  const form = await launchForm(t, { config: { ...preview, launchLockAvailable: true }, api: { "/launch/prepare": prepare } });
  await form.type("name", "Preview Cat"); await form.type("symbol", "PCAT");
  await form.submit();
  await form.firstBuy({ amount: "0.01", payAddress: weth.address, lockDays: 30 });
  await form.submit();
  assert.deepEqual(form.calls, ["/launch/prepare"]);
  const dialog = form.dialog(), text = textOf(dialog);
  assert.match(text, /One wallet transaction launches the pool and makes your first buy\. You pay network gas\./);
  assert.deepEqual(rows(byClass(dialog, "review-tiles"))[2], ["First buy", "0.01 WETH · 30 days lock"]);
  assert.equal(byLabel(dialog, "Payment conversion review"), null);
  const buy = byLabel(dialog, "First buy preview");
  assert.equal(textOf(find(buy, (element) => element.props?.className === "step-number")), "1");
  assert.deepEqual(rows(buy)[0], ["You spend", "0.01 WETH · approval for this amount only"]);
  assert.match(rows(buy)[4][1], /30 days · releases in full/);
  assert.equal(count(text, /five minutes|5-minute|expires/i), 1);
  assert.deepEqual(success(dialog), [`First buy quoted · Predicted token address${token}`]);
  assert(find(dialog, (element) => element.type === "button" && textOf(element) === "Confirm launch and first buy"));
});

test("the preview refuses a conversion quote for another account, so the one recipient shown is the wallet's", async (t) => {
  const form = await launchForm(t, { config: preview, api: { "/first-buy/quote": quote("0x4444444444444444444444444444444444444444"), "/launch/prepare": prepare } });
  await form.type("name", "Preview Cat"); await form.type("symbol", "PCAT");
  await form.submit();
  await form.firstBuy({ amount: "10", payAddress: usdg.address });
  await form.submit();
  assert.deepEqual(form.calls, ["/first-buy/quote"], "no launch is prepared");
  const dialog = form.dialog();
  assert.match(textOf(dialog), /The payment quote is not for the connected wallet\. Preview again\./);
  assert.equal(byLabel(dialog, "Payment conversion review"), null);
  assert.equal(byLabel(dialog, "First buy preview"), null);
});

test("a Muse coin's review keeps the whole NFT block: the NFT, its collection, the fee rules, the treasury, the vault and the disclaimer", async (t) => {
  const vaultFactory = "0x5555555555555555555555555555555555555556";
  const form = await launchForm(t, { config: { ...preview, nftMode: { enabled: true, vaultFactory, launchFeeUsd: 10, freeCollections: [], verifiedCollections: [] } },
    api: { "/launch/prepare": prepare } });
  await form.nftMode(true);
  await form.pick(...muse("1"), "Bard"); await form.check();
  await form.submit(); await form.submit(); await form.submit();
  assert.deepEqual(form.calls, ["/launch/prepare"]);
  const dialog = form.dialog(), text = textOf(dialog);
  assert.match(textOf(byClass(dialog, "review-identity")), /\$BARD · MUSEGOD pair · Robinhood Chain/);
  assert.deepEqual(terms(byClass(dialog, "nft-review-tiles")), ["Bound NFT", "Collection", "Creator fees"], "a Muse pays no launch fee");
  assert.deepEqual(rows(byClass(dialog, "nft-review-tiles")).slice(1), [["Collection", "Verified"],
    ["Creator fees", "To the NFT's treasury; they follow the NFT when it is sold. The current holder can withdraw at any time, including before a sale."]]);
  assert(text.includes(NFT_DISCLAIMER));
  assert.equal(textOf(byClass(dialog, "review-earn")), "The NFT's treasury earns 0.665% of every trade");
  const facts = rows(byClass(dialog, "review-facts"));
  assert.equal(facts[0][1], "NFT treasury 66.5% · Buyback 22.8% · Operations 5.7% · Doppler 5%");
  for (const term of ["NFT treasury (Tokenbound account)", "NFT fee vault"]) assert(facts.some(([name, value]) => name === term && /^0x[\da-fA-F]{40}$/.test(value)), term);
  assert.equal(count(text, /five minutes|5-minute/), 1);
});
