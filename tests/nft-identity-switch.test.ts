import assert from "node:assert/strict";
import test from "node:test";
import { bardDraft, hood, installGlobals, launchForm, muse, museNames, pinned, store } from "./launch-form";

// Switching the NFT must move every NFT-derived identity field (name, symbol, image) to the new NFT, keep what the person typed, and
// never show the old NFT's values.

test.before(installGlobals);
test.beforeEach(() => store.clear());

test("switching the NFT moves name, symbol and image to the new NFT", async (t) => {
  const form = await launchForm(t);
  await form.nftMode(true);
  await form.pick(...muse("1"), "Bard"); await form.check();
  assert.deepEqual(form.fields(), { name: "Bard", symbol: "BARD", image: pinned("https://img.test/1") });
  assert.equal(form.nftImageNotice(), true);
  await form.pick(hood, "1202", "The Hood #1202");
  assert.deepEqual(form.fields(), { name: "", symbol: "", image: "" }, "while the new NFT is checked, the old NFT's values are gone");
  await form.check();
  assert.deepEqual(form.fields(), { name: "The Hood #1202", symbol: "THEHOOD", image: pinned("https://img.test/1202") });
  await form.pick(...muse("2"), "Cadenza"); await form.check();
  assert.deepEqual(form.fields(), { name: "Cadenza", symbol: "CADENZA", image: pinned("https://img.test/2") });
  assert.equal(form.nftImageNotice(), true);
});

test("a field the person typed over keeps their value; the fields still holding the NFT's values follow it", async (t) => {
  const form = await launchForm(t);
  await form.nftMode(true);
  await form.pick(...muse("1"), "Bard"); await form.check();
  await form.type("name", "Bard the Brave");
  await form.pick(...muse("2"), "Cadenza");
  assert.equal(form.fields().name, "Bard the Brave", "a typed value is never cleared");
  await form.check();
  assert.deepEqual(form.fields(), { name: "Bard the Brave", symbol: "CADENZA", image: pinned("https://img.test/2") });
  await form.type("name", "Cadenza");
  await form.pick(...muse("3"), "Moonlet"); await form.check();
  assert.equal(form.fields().name, "Moonlet", "a value typed back to exactly the NFT's is the NFT's again");
});

test("a draft saved before prefill ownership was recorded follows the next NFT", async (t) => {
  // NFT mode went live on 2026-10-14 with a Muse name prefill that recorded no ownership; such a draft holds the Muse's values only.
  const form = await launchForm(t, { saved: bardDraft() });
  await form.check();
  assert.deepEqual(form.fields(), { name: "Bard", symbol: "BARD", image: "" }, "the restored NFT's re-check changes nothing");
  await form.pick(...muse("2"), "Cadenza"); await form.check();
  assert.deepEqual(form.fields(), { name: "Cadenza", symbol: "CADENZA", image: pinned("https://img.test/2") });
});

test("a draft without a prefill record follows the next NFT even when its own NFT's check says no", async (t) => {
  const form = await launchForm(t, { saved: bardDraft(), refuse: ["1"] });
  await form.check();
  assert.deepEqual(form.fields(), { name: "Bard", symbol: "BARD", image: "" });
  await form.pick(...muse("2"), "Cadenza"); await form.check();
  assert.deepEqual(form.fields(), { name: "Cadenza", symbol: "CADENZA", image: pinned("https://img.test/2") });
});

for (const order of ["before", "after"] as const)
  test(`a draft without a prefill record follows an NFT picked before its own NFT's check answered (it answers ${order} the new NFT passes)`, async (t) => {
    const form = await launchForm(t, { saved: bardDraft(), hold: ["1"] });
    await form.pick(...muse("2"), "Cadenza");
    if (order === "before") { await form.answer("1"); assert.deepEqual(form.fields(), { name: "", symbol: "", image: "" }); }
    await form.check();
    if (order === "after") await form.answer("1");
    assert.deepEqual(form.fields(), { name: "Cadenza", symbol: "CADENZA", image: pinned("https://img.test/2") });
    assert.deepEqual((await form.saved()).nftPrefill, form.fields());
  });

test("a draft without a prefill record clears its NFT's values when the person chooses Normal before the check answered", async (t) => {
  const form = await launchForm(t, { saved: bardDraft({ symbol: "MINE" }), hold: ["1"] });
  await form.nftMode(false);
  await form.answer("1");
  assert.deepEqual(form.fields(), { name: "", symbol: "MINE", image: "" }, "only the NFT's own value clears");
});

for (const typed of [false, true])
  test(`an NFT renamed since its prefill was saved: ${typed ? "its current name, typed back, follows" : "the saved values follow"} the next NFT`, async (t) => {
    const form = await launchForm(t, { saved: bardDraft({ nftPrefill: { name: "Bard", symbol: "BARD" } }), names: { ...museNames, "1": "Renamed" } });
    await form.check();
    assert.deepEqual(form.fields(), { name: "Bard", symbol: "BARD", image: "" }, "the saved prefill stays on the re-check");
    if (typed) { await form.type("name", "Renamed"); await form.type("symbol", "RENAMED"); }
    await form.pick(...muse("3"), "Moonlet"); await form.check();
    assert.deepEqual(form.fields(), { name: "Moonlet", symbol: "MOONLET", image: pinned("https://img.test/3") });
  });

test("a restored draft keeps its recorded prefill, which follows the next NFT", async (t) => {
  const image = pinned("https://img.test/1");
  const form = await launchForm(t, { saved: bardDraft({ image, nftPrefill: { name: "Bard", symbol: "BARD", image } }) });
  await form.check();
  assert.deepEqual(form.fields(), { name: "Bard", symbol: "BARD", image });
  assert.equal(form.nftImageNotice(), true);
  await form.pick(...muse("2"), "Cadenza"); await form.check();
  assert.deepEqual(form.fields(), { name: "Cadenza", symbol: "CADENZA", image: pinned("https://img.test/2") });
  assert.deepEqual((await form.saved()).nftPrefill, form.fields(), "the autosave records the new NFT's prefill");
});

test("an NFT whose check says no leaves no values of the previous NFT behind", async (t) => {
  const form = await launchForm(t, { refuse: ["9"] });
  await form.nftMode(true);
  await form.pick(...muse("1"), "Bard"); await form.check();
  await form.pick(hood, "9", "Not Mine #9"); await form.check();
  assert.deepEqual(form.fields(), { name: "", symbol: "", image: "" });
  assert.equal(form.nftImageNotice(), false);
});

test("a restored NFT the check drops keeps its values until the person picks another NFT, which clears them", async (t) => {
  const image = pinned("https://img.test/1");
  const form = await launchForm(t, { refuse: ["1", "9"], saved: bardDraft({ image, nftPrefill: { name: "Bard", symbol: "BARD", image } }) });
  await form.check();
  assert.deepEqual(form.fields(), { name: "Bard", symbol: "BARD", image }, "an automatic drop is not the person's change");
  await form.pick(hood, "9", "Not Mine #9");
  assert.deepEqual(form.fields(), { name: "", symbol: "", image: "" });
  await form.check();
  assert.deepEqual(form.fields(), { name: "", symbol: "", image: "" });
});

test("leaving NFT mode clears the NFT's values instead of presenting them as the coin's own", async (t) => {
  const form = await launchForm(t);
  await form.nftMode(true);
  await form.pick(...muse("1"), "Bard"); await form.check();
  await form.type("symbol", "MINE");
  await form.nftMode(false);
  assert.deepEqual(form.fields(), { name: "", symbol: "MINE", image: "" });
  assert.equal(form.nftImageNotice(), false);
});
