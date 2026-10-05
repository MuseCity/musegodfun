import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { TokenImages, validateTokenImage } from "../server/token-images";
import { MAX_TOKEN_IMAGE_BYTES, tokenImageSource } from "../src/lib/token-image";
import { launchSchema, restoreDraft } from "../src/lib/validation";
import { createApp } from "../server/app";

// An actual 2 × 3 WebP encoded by Chrome's canvas, including its colour profile.
const data = "data:image/webp;base64,UklGRh4CAABXRUJQVlA4WAoAAAAgAAAAAQAAAgAASUNDUMgBAAAAAAHIAAAAAAQwAABtbnRyUkdCIFhZWiAH4AABAAEAAAAAAABhY3NwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQAA9tYAAQAAAADTLQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAlkZXNjAAAA8AAAACRyWFlaAAABFAAAABRnWFlaAAABKAAAABRiWFlaAAABPAAAABR3dHB0AAABUAAAABRyVFJDAAABZAAAAChnVFJDAAABZAAAAChiVFJDAAABZAAAAChjcHJ0AAABjAAAADxtbHVjAAAAAAAAAAEAAAAMZW5VUwAAAAgAAAAcAHMAUgBHAEJYWVogAAAAAAAAb6IAADj1AAADkFhZWiAAAAAAAABimQAAt4UAABjaWFlaIAAAAAAAACSgAAAPhAAAts9YWVogAAAAAAAA9tYAAQAAAADTLXBhcmEAAAAAAAQAAAACZmYAAPKnAAANWQAAE9AAAApbAAAAAAAAAABtbHVjAAAAAAAAAAEAAAAMZW5VUwAAACAAAAAcAEcAbwBvAGcAbABlACAASQBuAGMALgAgADIAMAAxADZWUDggMAAAABACAJ0BKgIAAwABABwloAJ0ugH4AfgAA8gA/u+sV/7vNgDCX/F7/9pZCFdf85wAAA==";
const bytes = Buffer.from(data.split(",")[1], "base64");
const key = `${createHash("sha256").update(bytes).digest("hex")}.webp`;

test("token image validation rejects non-raster, truncated, oversized and excessive-dimension files", () => {
  validateTokenImage(bytes);
  assert.throws(() => validateTokenImage(Buffer.from("<svg><script>bad</script></svg>")), /supported WebP/);
  assert.throws(() => validateTokenImage(bytes.subarray(0, bytes.length - 1)), /supported WebP/);
  assert.throws(() => validateTokenImage(Buffer.alloc(MAX_TOKEN_IMAGE_BYTES + 1)), /supported WebP/);
  const large = Buffer.from(bytes);
  large.writeUIntLE(512, 24, 3);
  assert.throws(() => validateTokenImage(large), /dimensions|512/);
  const mismatched = Buffer.from(bytes), frameAt = mismatched.indexOf("VP8 ") + 8;
  mismatched.writeUInt16LE(513, frameAt + 6);
  assert.throws(() => validateTokenImage(mismatched), /dimensions/);
  const animated = Buffer.from(bytes);
  animated[20] |= 2;
  assert.throws(() => validateTokenImage(animated), /still image/);
});

test("local images survive storage restart and duplicate upload; metadata keeps its public URL", async () => {
  const directory = await mkdtemp(join(tmpdir(), "musegod-images-"));
  try {
    const images = new TokenImages(directory);
    const uploaded = await images.upload({ image: data });
    assert.equal(uploaded.image, `https://musegod.fun/api/token-images/${key}`);
    assert.deepEqual(await images.upload({ image: data }), uploaded);
    assert.deepEqual(await new TokenImages(directory).get(key), bytes);
    assert.equal(await images.get(`${"0".repeat(64)}.webp`), null);
    await assert.rejects(images.get("../../.env"));
    await assert.rejects(images.upload({ image: "data:image/svg+xml;base64,PHN2Zy8+" }));
    const draft = { ...restoreDraft(null), name: "Image Test", symbol: "IMG", image: uploaded.image };
    assert.equal(launchSchema.parse(draft).image, uploaded.image);
    assert.equal(restoreDraft(JSON.stringify(draft)).image, uploaded.image);
    assert.equal(tokenImageSource(uploaded.image), `/api/token-images/${key}`);
    assert.equal(tokenImageSource("https://example.com/image.webp"), "https://example.com/image.webp");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("Supabase images use a private, server-authenticated immutable object and handle duplicates", async () => {
  const originalFetch = globalThis.fetch;
  let uploads = 0;
  try {
    globalThis.fetch = async (url, init) => {
      assert.equal(String(url), `https://example.supabase.co/storage/v1/object/token-images/${key}`);
      const headers = new Headers(init?.headers);
      assert.equal(headers.get("apikey"), "sb_secret_test");
      assert.equal(headers.get("authorization"), null);
      if (init?.method === "POST") {
        assert.equal(headers.get("x-upsert"), "false");
        assert.equal(headers.get("content-type"), "image/webp");
        assert.deepEqual(Buffer.from(init.body as ArrayBuffer), bytes);
        return ++uploads === 1 ? Response.json({ Key: key }) : Response.json({ code: "Duplicate" }, { status: 400 });
      }
      return new Response(bytes);
    };
    const images = new TokenImages("unused", "https://example.supabase.co", "sb_secret_test");
    const first = await images.upload({ image: data });
    assert.deepEqual(await images.upload({ image: data }), first);
    assert.deepEqual(await images.get(key), bytes);
    assert.equal(JSON.stringify(first).includes("sb_secret"), false);
    globalThis.fetch = async () => new Response("unavailable", { status: 503 });
    await assert.rejects(images.upload({ image: data }), /could not be saved/);
  } finally { globalThis.fetch = originalFetch; }
});

test("image HTTP flow serves saved bytes, rejects cross-site/invalid uploads and bounds per-IP writes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "musegod-image-http-"));
  const changes = { CHAIN_MODE: "fork", FORK_CHAIN_ID: "4663", DATA_DIR: directory,
    PLATFORM_TREASURY: "", ENABLE_MAINNET_TRANSACTIONS: "false", FORK_RPC_URL: "http://127.0.0.1:8547" };
  const previous = Object.fromEntries(Object.keys(changes).map(name => [name, process.env[name]]));
  Object.assign(process.env, changes);
  const { app, service } = createApp();
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  const port = (server.address() as { port: number }).port, origin = `http://127.0.0.1:${port}`;
  const upload = (body: unknown, requestOrigin = origin) => fetch(`${origin}/api/token-images`, {
    method: "POST", headers: { "content-type": "application/json", origin: requestOrigin }, body: JSON.stringify(body),
  });
  try {
    assert.equal((await upload({ image: data }, "https://other.example")).status, 403);
    const uploaded = await upload({ image: data });
    assert.equal(uploaded.status, 200);
    const image = (await uploaded.json() as { image: string }).image;
    const response = await fetch(`${origin}${new URL(image).pathname}`);
    assert.equal(response.headers.get("content-type"), "image/webp");
    assert.match(response.headers.get("cache-control") || "", /immutable/);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
    assert.equal((await fetch(`${origin}/api/token-images/${"0".repeat(64)}.webp`)).status, 404);
    assert.equal((await upload({ image: "not an image" })).status, 400);
    for (let count = 0; count < 8; count++) assert.equal((await upload({ image: data })).status, 200);
    const limited = await upload({ image: data });
    assert.equal(limited.status, 429);
    assert.equal(limited.headers.get("retry-after"), "60");
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    await service.store.close();
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
    await rm(directory, { recursive: true, force: true });
  }
});
