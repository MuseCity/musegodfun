import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { NFT_IMAGE_ERROR, prepareTokenImage, prepareTokenImageFromUrl } from "../src/lib/image-upload";

const encoded = "data:image/webp;base64,AAAA";
function imageBrowser(t: TestContext, options: { width?: number; height?: number; fail?: string; largeEncodes?: number } = {}) {
  const images: TestImage[] = [], inputs: unknown[] = [], attempts: { width: number; height: number; quality: number }[] = [];
  let closed = 0, fetches = 0;
  class TestImage {
    crossOrigin = ""; referrerPolicy = ""; src = "";
    constructor() { images.push(this); }
    async decode() {
      assert.equal(this.crossOrigin, "anonymous");
      assert.equal(this.referrerPolicy, "no-referrer");
      assert.equal(this.src, "https://images.test/nft.avif");
      if (options.fail === "decode") throw new Error("decode/CORS failure");
    }
  }
  const canvas = { width: 0, height: 0,
    getContext: () => options.fail === "context" ? null : { drawImage() {} },
    toDataURL(type: string, quality: number) {
      assert.equal(type, "image/webp");
      attempts.push({ width: canvas.width, height: canvas.height, quality });
      if (options.fail === "canvas") throw new Error("tainted canvas");
      if (options.fail === "format") return "data:image/png;base64,AAAA";
      return options.fail === "size" || attempts.length <= (options.largeEncodes ?? 0)
        ? `data:image/webp;base64,${"A".repeat(60_000)}` : encoded;
    } };
  const globals = { Image: TestImage, document: { createElement: (tag: string) => { assert.equal(tag, "canvas"); return canvas; } },
    createImageBitmap: async (input: unknown) => {
      inputs.push(input);
      if (options.fail === "bitmap") throw new Error("unreadable bitmap");
      return { width: options.width ?? 1024, height: options.height ?? 512, close() { closed++; } };
    }, fetch: async () => { fetches++; throw new Error("CDN fetch is forbidden"); } };
  for (const [key, value] of Object.entries(globals)) {
    const prior = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
    t.after(() => { if (prior) Object.defineProperty(globalThis, key, prior); else Reflect.deleteProperty(globalThis, key); });
  }
  return { images, inputs, attempts, closed: () => closed, fetches: () => fetches };
}

test("NFT images decode anonymously through an Image, then use the upload encoder without fetching", async t => {
  const browser = imageBrowser(t);
  assert.equal(await prepareTokenImageFromUrl("https://images.test/nft.avif"), encoded);
  assert.equal(browser.images.length, 1);
  assert.equal(browser.inputs[0], browser.images[0]);
  assert.deepEqual(browser.attempts, [{ width: 512, height: 256, quality: 0.85 }]);
  assert.equal(browser.closed(), 1);
  assert.equal(browser.fetches(), 0);
});

test("NFT image URLs must pass httpsImage before any image is loaded", async t => {
  const browser = imageBrowser(t);
  for (const url of ["http://images.test/nft.png", "data:image/png;base64,AAAA", "ipfs://art", "garbage", `https://images.test/${"x".repeat(2048)}`])
    await assert.rejects(prepareTokenImageFromUrl(url), { message: NFT_IMAGE_ERROR });
  assert.equal(browser.images.length, 0);
  assert.equal(browser.inputs.length, 0);
});

test("manual and NFT images share size and quality fallback without changing the manual result", async t => {
  const browser = imageBrowser(t, { largeEncodes: 4 });
  assert.equal(await prepareTokenImageFromUrl("https://images.test/nft.avif"), encoded);
  assert.deepEqual(browser.attempts, [
    { width: 512, height: 256, quality: 0.85 }, { width: 512, height: 256, quality: 0.65 },
    { width: 512, height: 256, quality: 0.45 }, { width: 384, height: 192, quality: 0.85 },
    { width: 384, height: 192, quality: 0.65 },
  ]);
  const file = new File(["png"], "image.png", { type: "image/png" });
  assert.equal(await prepareTokenImage(file), encoded);
  assert.equal(browser.inputs[1], file);
  assert.equal(browser.closed(), 2);
});

for (const fail of ["decode", "bitmap", "context", "canvas", "format", "size"]) {
  test(`NFT ${fail} failures use the W6 message and release any bitmap`, async t => {
    const browser = imageBrowser(t, { fail });
    await assert.rejects(prepareTokenImageFromUrl("https://images.test/nft.avif"), { message: NFT_IMAGE_ERROR });
    assert.equal(browser.closed(), ["decode", "bitmap"].includes(fail) ? 0 : 1);
    assert.equal(browser.fetches(), 0);
    if (fail === "size") {
      assert.equal(browser.attempts.length, 9);
      assert.deepEqual(browser.attempts.at(-1), { width: 256, height: 128, quality: 0.45 });
    }
  });
}

test("the shared encoder never enlarges an image", async t => {
  const browser = imageBrowser(t, { width: 20, height: 10 });
  await prepareTokenImageFromUrl("https://images.test/nft.avif");
  assert.deepEqual(browser.attempts[0], { width: 20, height: 10, quality: 0.85 });
});

for (const width of [0, 40_000_001]) {
  test(`pixel limit rejects width ${width} for both upload paths, preserving manual copy`, async t => {
    const browser = imageBrowser(t, { width, height: 1 });
    await assert.rejects(prepareTokenImageFromUrl("https://images.test/nft.avif"), { message: NFT_IMAGE_ERROR });
    await assert.rejects(prepareTokenImage(new File(["png"], "image.png", { type: "image/png" })),
      { message: "Choose an image with fewer than 40 million pixels." });
    assert.equal(browser.closed(), 2);
    assert.equal(browser.attempts.length, 0);
  });
}

test("manual file validation and decode errors keep their existing messages", async t => {
  imageBrowser(t, { fail: "bitmap" });
  await assert.rejects(prepareTokenImage(new File(["svg"], "image.svg", { type: "image/svg+xml" })),
    { message: "Choose a PNG, JPG, WebP or GIF image." });
  await assert.rejects(prepareTokenImage(new File([], "image.png", { type: "image/png" })),
    { message: "Choose an image smaller than 5 MB." });
  await assert.rejects(prepareTokenImage(new File(["png"], "image.png", { type: "image/png" })),
    { message: "This image could not be read. Choose another image." });
});
