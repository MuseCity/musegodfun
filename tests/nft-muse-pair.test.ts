import assert from "node:assert/strict";
import test from "node:test";
import { ROBINHOOD_STOCKS } from "../src/lib/config";
import { bardDraft, hood, installGlobals, launchForm, muse, store } from "./launch-form";

// Owner, 2026-10-18: a Muse coin is not required to pair with MUSEGOD. MUSEGOD is its default pair, the person can choose any supported
// asset, and a Muse still launches free whatever the pair.

const musegod = ROBINHOOD_STOCKS.find((asset) => asset.symbol === "MUSEGOD")!.address;
const weth = ROBINHOOD_STOCKS.find((asset) => asset.symbol === "WETH")!.address;
test.before(installGlobals);
test.beforeEach(() => store.clear());

test("picking a Muse selects MUSEGOD, and the person can choose another pair", async (t) => {
  const form = await launchForm(t);
  await form.nftMode(true);
  await form.pick(...muse("1"), "Bard"); await form.check();
  assert.equal(form.pairs().find((pair) => pair.selected)?.address, musegod);
  assert(form.pairs().every((pair) => pair.enabled), "no pair is locked");
  assert.match(form.text(), /MUSEGOD is the default pair for Muse coins\. You can choose any asset\./);
  assert.match(form.stepText(), /Muse launches are free\./);
  assert.doesNotMatch(form.text() + form.stepText(), /Muse coins pair with MUSEGOD/);
  const other = form.pairs().find((pair) => !pair.selected)!;
  await other.choose();
  assert.equal(form.pairs().find((pair) => pair.selected)?.address, other.address);
  assert.equal((await form.saved()).quoteAddress, other.address, "the chosen pair is saved");
});

test("a non-Muse NFT keeps the pair, and picking a Muse again selects its MUSEGOD default", async (t) => {
  const form = await launchForm(t);
  await form.nftMode(true);
  const start = form.pairs().find((pair) => pair.selected)!.address;
  await form.pick(hood, "1202", "The Hood #1202"); await form.check();
  assert.equal(form.pairs().find((pair) => pair.selected)?.address, start);
  await form.pick(...muse("2"), "Cadenza"); await form.check();
  assert.equal(form.pairs().find((pair) => pair.selected)?.address, musegod);
});

test("a restored Muse draft keeps the pair it was saved with, through its re-check", async (t) => {
  const form = await launchForm(t, { saved: bardDraft({ quoteAddress: weth }) });
  await form.check();
  assert.equal((await form.saved()).quoteAddress, weth);
  assert.equal(form.pairs().find((pair) => pair.selected)?.address ?? weth, weth);
  assert(form.pairs().every((pair) => pair.enabled));
});
