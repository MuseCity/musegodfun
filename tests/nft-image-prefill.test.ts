import test from "node:test";
import assert from "node:assert/strict";
import { createNftImagePrefill } from "../src/lib/nft-image-prefill";
import { NFT_IMAGE_ERROR } from "../src/lib/image-upload";
import type { NftIdentity, NftPrefill } from "../src/lib/nft-client";

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function fixture(initial: NftIdentity = { name: "", symbol: "", image: "" }, owned: NftPrefill = {}) {
  const state = { draft: { ...initial }, busy: false, error: "", pins: [] as { image: string; interactive: boolean }[], conversions: [] as string[] };
  const work = createNftImagePrefill(owned);
  const io = {
    getDraft: () => state.draft,
    apply: (field: keyof NftIdentity, value: string) => { state.draft = { ...state.draft, [field]: value }; },
    setBusy: (value: boolean) => { state.busy = value; }, setError: (value: string) => { state.error = value; },
    convertUrl: async (url: string) => { state.conversions.push(url); return url; },
    convertFile: async (_file: File) => "manual",
    pin: async (image: string, interactive: boolean) => { state.pins.push({ image, interactive }); return `https://pin.test/${image}`; },
  };
  return { state, work, io };
}
const a = { name: "A", image: "a" }, b = { name: "B", image: "b" };
const file = new File(["png"], "mine.png", { type: "image/png" });

test("manual upload pending during a live check keeps priority, including when the NFT clears", async () => {
  const { state, work, io } = fixture(), held = deferred<string>();
  io.convertFile = () => held.promise;
  const upload = work.upload(file, io);
  work.clearNft(io);
  assert.equal(state.busy, true);
  await work.prefill(a, io);
  assert.equal(state.draft.name, "A");
  assert.deepEqual(state.conversions, []);
  held.resolve("mine"); await upload;
  assert.equal(state.draft.image, "https://pin.test/mine");
  assert.deepEqual(state.pins, [{ image: "mine", interactive: true }]);
  assert.equal(state.busy, false); assert.equal(work.previous.image, undefined);
});

test("A to B during conversion keeps only B and never pins stale A", async () => {
  const { state, work, io } = fixture(), held = deferred<string>();
  io.convertUrl = url => url === "a" ? held.promise : Promise.resolve(url);
  const first = work.prefill(a, io);
  await work.prefill(b, io);
  held.resolve("a"); await first;
  assert.deepEqual(state.draft, { name: "B", symbol: "B", image: "https://pin.test/b" });
  assert.deepEqual(state.pins, [{ image: "b", interactive: false }]);
  assert.equal(state.busy, false);
});

test("a late NFT pin is dropped when the next NFT has no image", async () => {
  const { state, work, io } = fixture(), held = deferred<string>(), entered = deferred<void>();
  io.pin = async (image, interactive) => {
    state.pins.push({ image, interactive }); entered.resolve(); return held.promise;
  };
  const pending = work.prefill(a, io); await entered.promise;
  await work.prefill({ name: "B" }, io);
  assert.equal(state.busy, false);
  held.resolve("https://pin.test/a"); await pending;
  assert.deepEqual(state.draft, { name: "B", symbol: "B", image: "" });
  assert.equal(work.previous.image, undefined); assert.equal(state.error, "");
  assert.deepEqual(state.pins, [{ image: "a", interactive: false }]);
});

test("a stale NFT conversion finishing keeps the current conversion busy", async () => {
  const { state, work, io } = fixture(), first = deferred<string>(), second = deferred<string>();
  io.convertUrl = url => url === "a" ? first.promise : second.promise;
  const pendingA = work.prefill(a, io), pendingB = work.prefill(b, io);
  assert.equal(state.busy, true);
  first.resolve("a"); await pendingA;
  assert.equal(state.busy, true); assert.deepEqual(state.pins, []);
  second.resolve("b"); await pendingB;
  assert.equal(state.draft.image, "https://pin.test/b"); assert.equal(state.busy, false);
});

test("typing an image stops the spinner immediately and suppresses a late NFT failure", async () => {
  const { state, work, io } = fixture(), held = deferred<string>();
  io.convertUrl = () => held.promise;
  const pending = work.prefill(a, io);
  assert.equal(state.busy, true);
  work.edit("image", io); state.draft.image = "https://mine.test/typed";
  const busyAfterEdit = state.busy;
  held.reject(new Error("late conversion failure")); await pending;
  assert.equal(busyAfterEdit, false); assert.equal(state.busy, false); assert.equal(state.error, "");
  assert.equal(state.draft.image, "https://mine.test/typed"); assert.deepEqual(state.pins, []);
});

for (const edit of ["typed", "uploaded"] as const) test(`a late NFT pin cannot overwrite a ${edit} image`, async () => {
  const { state, work, io } = fixture(), held = deferred<string>(), entered = deferred<void>();
  io.pin = async (image, interactive) => {
    state.pins.push({ image, interactive });
    if (!interactive) { entered.resolve(); return held.promise; }
    return "https://pin.test/manual";
  };
  const pending = work.prefill(a, io); await entered.promise;
  if (edit === "typed") { work.edit("image", io); state.draft.image = "https://mine.test/typed"; }
  else await work.upload(file, io);
  const manual = state.draft.image;
  held.resolve("https://pin.test/a"); await pending;
  assert.equal(state.draft.image, manual); assert.equal(work.previous.image, undefined);
  assert.equal(state.busy, false); assert.equal(state.error, "");
});

test("replace and adopt reset ownership, busy state and late conversions", async () => {
  for (const adopt of [false, true]) {
    const initial = { name: "Old", symbol: "OLD", image: "https://pin.test/old" };
    const { state, work, io } = fixture(initial, initial), held = deferred<string>();
    io.convertUrl = () => held.promise;
    const pending = work.prefill(a, io);
    assert.equal(state.draft.image, "", "the previous owned image clears before conversion");
    const next = { name: "Adopted", symbol: "ADOPTED", image: "https://pin.test/adopted" };
    state.draft = adopt ? next : { name: "", symbol: "", image: "" };
    work.replace(adopt ? next : {}, io);
    assert.equal(state.busy, false); assert.equal(state.error, "");
    held.resolve("a"); await pending;
    assert.deepEqual(work.previous, adopt ? next : {});
    assert.equal(state.draft.image, adopt ? next.image : ""); assert.deepEqual(state.pins, []);
  }
});

test("only the current NFT request shows W6; a current challenge failure is nonblocking", async () => {
  const { state, work, io } = fixture(), held = deferred<string>();
  io.convertUrl = url => url === "a" ? held.promise : Promise.resolve(url);
  const pending = work.prefill(a, io);
  await work.prefill(b, io);
  held.reject(new Error("late failure")); await pending;
  assert.equal(state.error, "");
  io.pin = async (_image, interactive) => { assert.equal(interactive, false); throw new Error("CHALLENGE_REQUIRED"); };
  await work.prefill({ name: "C", image: "c" }, io);
  assert.equal(state.error, NFT_IMAGE_ERROR); assert.equal(state.busy, false); assert.equal(state.draft.image, "");
});

test("clearing the NFT cancels NFT work and its late error", async () => {
  const { state, work, io } = fixture(), held = deferred<string>();
  io.convertUrl = () => held.promise;
  const pending = work.prefill(a, io);
  work.clearNft(io);
  assert.equal(state.busy, false);
  held.reject(new Error("cancelled load")); await pending;
  assert.equal(state.error, ""); assert.equal(state.draft.image, ""); assert.deepEqual(state.pins, []);
});

test("repeat picks and rechecks reuse the tab cache without conversion or posting", async () => {
  const { state, work, io } = fixture();
  await work.prefill(a, io); const firstImage = state.draft.image;
  await work.prefill(b, io); await work.prefill(a, io); await work.prefill(a, io);
  assert.equal(state.draft.image, firstImage);
  assert.deepEqual(state.conversions, ["a", "b"]);
  assert.equal(state.pins.length, 2); assert(state.pins.every(pin => !pin.interactive));
});

test("a restored NFT recheck preserves exact owned fields and notice without pinning", async () => {
  const initial = { name: "Listed A", symbol: "LISTEDA", image: "https://pin.test/a" };
  const { state, work, io } = fixture(initial, initial);
  await work.prefill({}, io, true);
  assert.deepEqual(state.draft, initial); assert.deepEqual(work.previous, initial); assert.deepEqual(state.pins, []);
  await work.prefill(b, io);
  assert.deepEqual(state.draft, { name: "B", symbol: "B", image: "https://pin.test/b" });
});

test("failed manual uploads keep the existing prefill and error, and manual edits release exact ownership", async () => {
  const initial = { name: "A", symbol: "A", image: "https://pin.test/a" };
  const { state, work, io } = fixture(initial, initial);
  io.convertFile = async () => { throw new Error("manual validation failed"); };
  await work.upload(file, io);
  assert.deepEqual(state.draft, initial); assert.deepEqual(work.previous, initial);
  assert.equal(state.error, "manual validation failed"); assert.equal(state.busy, false);
  for (const field of ["name", "symbol", "image"] as const) work.edit(field, io);
  await work.prefill(b, io);
  assert.deepEqual(state.draft, initial); assert.deepEqual(work.previous, {}); assert.deepEqual(state.pins, []);
});

test("a failed manual upload releases priority for a later NFT image", async () => {
  const { state, work, io } = fixture();
  io.convertFile = async () => { throw new Error("manual validation failed"); };
  await work.upload(file, io);
  assert.equal(state.error, "manual validation failed"); assert.equal(state.busy, false);
  await work.prefill(a, io);
  assert.equal(state.draft.image, "https://pin.test/a"); assert.equal(work.previous.image, state.draft.image);
  assert.deepEqual(state.conversions, ["a"]); assert.deepEqual(state.pins, [{ image: "a", interactive: false }]);
  assert.equal(state.busy, false); assert.equal(state.error, "");
});

test("replacing the draft during a manual conversion drops the late result without pinning", async () => {
  const { state, work, io } = fixture(), held = deferred<string>();
  io.convertFile = () => held.promise;
  const pending = work.upload(file, io);
  const next = { name: "Adopted", symbol: "ADOPTED", image: "https://pin.test/adopted" };
  state.draft = next; work.replace(next, io);
  assert.equal(state.busy, false);
  held.resolve("mine"); await pending;
  assert.deepEqual(state.draft, next); assert.deepEqual(work.previous, next); assert.deepEqual(state.pins, []);
  assert.equal(state.busy, false); assert.equal(state.error, "");
});

for (const outcome of ["success", "failure"] as const) test(`replacing the draft during a manual pin drops its late ${outcome}`, async () => {
  const { state, work, io } = fixture(), held = deferred<string>(), entered = deferred<void>();
  io.pin = async (image, interactive) => {
    state.pins.push({ image, interactive }); entered.resolve(); return held.promise;
  };
  const pending = work.upload(file, io); await entered.promise;
  const next = { name: "Adopted", symbol: "ADOPTED", image: "https://pin.test/adopted" };
  state.draft = next; work.replace(next, io);
  assert.equal(state.busy, false);
  if (outcome === "success") held.resolve("https://pin.test/mine");
  else held.reject(new Error("late manual pin failure"));
  await pending;
  assert.deepEqual(state.draft, next); assert.deepEqual(work.previous, next);
  assert.deepEqual(state.pins, [{ image: "manual", interactive: true }]);
  assert.equal(state.busy, false); assert.equal(state.error, "");
});
