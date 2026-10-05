import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { TokenImages, validateTokenImage } from "../server/token-images";
import { MAX_TOKEN_IMAGE_BYTES } from "../src/lib/token-image";
import { launchSchema, restoreDraft } from "../src/lib/validation";
import { tokenMetadata } from "../src/lib/protocol";
import { syntheticOpeningValuation } from "./fixtures";
import { createApp } from "../server/app";

// An actual 2 × 3 WebP encoded by Chrome's canvas, including its colour profile.
const data = "data:image/webp;base64,UklGRh4CAABXRUJQVlA4WAoAAAAgAAAAAQAAAgAASUNDUMgBAAAAAAHIAAAAAAQwAABtbnRyUkdCIFhZWiAH4AABAAEAAAAAAABhY3NwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQAA9tYAAQAAAADTLQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAlkZXNjAAAA8AAAACRyWFlaAAABFAAAABRnWFlaAAABKAAAABRiWFlaAAABPAAAABR3dHB0AAABUAAAABRyVFJDAAABZAAAAChnVFJDAAABZAAAAChiVFJDAAABZAAAAChjcHJ0AAABjAAAADxtbHVjAAAAAAAAAAEAAAAMZW5VUwAAAAgAAAAcAHMAUgBHAEJYWVogAAAAAAAAb6IAADj1AAADkFhZWiAAAAAAAABimQAAt4UAABjaWFlaIAAAAAAAACSgAAAPhAAAts9YWVogAAAAAAAA9tYAAQAAAADTLXBhcmEAAAAAAAQAAAACZmYAAPKnAAANWQAAE9AAAApbAAAAAAAAAABtbHVjAAAAAAAAAAEAAAAMZW5VUwAAACAAAAAcAEcAbwBvAGcAbABlACAASQBuAGMALgAgADIAMAAxADZWUDggMAAAABACAJ0BKgIAAwABABwloAJ0ugH4AfgAA8gA/u+sV/7vNgDCX/F7/9pZCFdf85wAAA==";
const bytes = Buffer.from(data.split(",")[1], "base64");
const key = `${createHash("sha256").update(bytes).digest("hex")}.webp`;
const cid = "bafkreiexg36mudbth2ete6lyz5pqfejop3k3fgbtlpt6izcka3yraykb6e";
const imageUrl = `https://gateway.pinata.cloud/ipfs/${cid}`;
const pinataJwt = "pinata-jwt-test-only";

async function assertPinataUpload(url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) {
  assert.equal(String(url), "https://uploads.pinata.cloud/v3/files");
  assert.equal(init?.method, "POST");
  const headers = new Headers(init?.headers);
  assert.equal(headers.get("authorization"), `Bearer ${pinataJwt}`);
  assert.equal(headers.get("content-type"), null, "fetch must supply the multipart boundary");
  assert.equal(headers.get("apikey"), null);
  assert.equal(headers.get("x-upsert"), null);
  assert.ok(init?.signal instanceof AbortSignal);
  const form = init?.body;
  assert.ok(form instanceof FormData);
  assert.equal(form.get("network"), "public");
  assert.equal(form.get("name"), key);
  assert.equal(form.get("cid_version"), "v1");
  const file = form.get("file");
  assert.ok(file instanceof File);
  assert.equal(file.name, key);
  assert.equal(file.type, "image/webp");
  assert.deepEqual(Buffer.from(await file.arrayBuffer()), bytes);
}

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

test("Pinata receives public WebP uploads and duplicate uploads retain their metadata URL", async () => {
  const originalFetch = globalThis.fetch;
  let uploads = 0;
  try {
    globalThis.fetch = async (url, init) => {
      await assertPinataUpload(url, init);
      uploads++;
      return Response.json({ data: { cid } });
    };
    const images = new TokenImages(pinataJwt);
    const uploaded = await images.upload({ image: data });
    assert.deepEqual(uploaded, { image: imageUrl });
    assert.deepEqual(await images.upload({ image: data }), uploaded);
    assert.equal(uploads, 2);
    assert.equal(JSON.stringify(uploaded).includes(pinataJwt), false);
    assert.ok(uploaded.image.length <= 500);
    const draft = { ...restoreDraft(null), name: "Image Test", symbol: "IMG", image: uploaded.image };
    assert.equal(launchSchema.parse(draft).image, uploaded.image);
    assert.equal(restoreDraft(JSON.stringify(draft)).image, uploaded.image);
    assert.equal(tokenMetadata(launchSchema.parse(draft), syntheticOpeningValuation(draft.quoteAddress)).image, uploaded.image);
  } finally { globalThis.fetch = originalFetch; }
});

test("invalid image inputs are rejected before Pinata receives a request", async () => {
  const originalFetch = globalThis.fetch;
  try {
    let requests = 0;
    globalThis.fetch = async () => {
      requests++;
      return Response.json({ data: { cid } });
    };
    const images = new TokenImages(pinataJwt);
    for (const body of [
      { image: "data:image/svg+xml;base64,PHN2Zy8+" },
      { image: "data:image/webp;base64,AAAA" },
      { image: data.slice(0, -1) },
      { image: data, jwt: pinataJwt },
      { image: `data:image/webp;base64,${Buffer.alloc(MAX_TOKEN_IMAGE_BYTES + 1).toString("base64")}` },
    ]) await assert.rejects(images.upload(body));
    assert.equal(requests, 0);
  } finally { globalThis.fetch = originalFetch; }
});

test("Pinata failures and invalid CIDs return safe errors without retrying elsewhere", async () => {
  const originalFetch = globalThis.fetch;
  try {
    const images = new TokenImages(pinataJwt);
    const failures: (() => Promise<Response>)[] = [
      ...[401, 403, 429, 503].map(status => async () => Response.json({ error: pinataJwt }, { status })),
      async () => new Response(pinataJwt, { status: 200 }),
      ...[{}, { data: {} }, { data: { cid: 123 } },
        { data: { cid: "../../.env" } }, { data: { cid: "QmInvalidV0" } },
        { data: { cid: `b${"a".repeat(121)}` } }, { data: { cid: `b${"A".repeat(30)}` } }]
        .map(body => async () => Response.json(body)),
      async () => { throw new Error(`Network failed with ${pinataJwt}`); },
      async () => { throw new DOMException(`Timeout with ${pinataJwt}`, "TimeoutError"); },
    ];
    let commonError: string | undefined;
    for (const fail of failures) {
      let requests = 0;
      globalThis.fetch = async (url, init) => {
        await assertPinataUpload(url, init);
        requests++;
        return fail();
      };
      await assert.rejects(images.upload({ image: data }), error => {
        assert.ok(error instanceof Error);
        assert.equal(error.message.includes(pinataJwt), false);
        assert.equal(error.message.includes("https://"), false);
        assert.match(error.message, /could not be saved|unavailable|upload.*again/i);
        commonError ??= error.message;
        assert.equal(error.message, commonError);
        return true;
      });
      assert.equal(requests, 1, "failures must not retry elsewhere");
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("missing Pinata credentials reject uploads before a request is made", async () => {
  const originalFetch = globalThis.fetch;
  try {
    let requests = 0;
    globalThis.fetch = async () => { requests++; return Response.json({ data: { cid } }); };
    const images = new TokenImages();
    await assert.rejects(images.upload({ image: data }), /configuration|configured|Pinata/i);
    await assert.rejects(new TokenImages(" ").upload({ image: data }), /configuration|configured|Pinata/i);
    assert.equal(requests, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("image HTTP flow uploads to Pinata, removes old reads and bounds same-origin writes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "musegod-image-http-"));
  const changes = { CHAIN_MODE: "fork", FORK_CHAIN_ID: "4663", DATA_DIR: directory,
    PLATFORM_TREASURY: "", ENABLE_MAINNET_TRANSACTIONS: "false", FORK_RPC_URL: "http://127.0.0.1:8547", PINATA_JWT: pinataJwt };
  const previous = Object.fromEntries(Object.keys(changes).map(name => [name, process.env[name]]));
  Object.assign(process.env, changes);
  const { app, service } = createApp();
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  const port = (server.address() as { port: number }).port, origin = `http://127.0.0.1:${port}`;
  const upload = (body: unknown, requestOrigin = origin) => fetch(`${origin}/api/token-images`, {
    method: "POST", headers: { "content-type": "application/json", origin: requestOrigin }, body: JSON.stringify(body),
  });
  const originalFetch = globalThis.fetch;
  let pinataRequests = 0, failUpload = false;
  globalThis.fetch = async (url, init) => {
    if (String(url) !== "https://uploads.pinata.cloud/v3/files") return originalFetch(url, init);
    await assertPinataUpload(url, init);
    pinataRequests++;
    return failUpload ? Response.json({ error: pinataJwt }, { status: 503 }) : Response.json({ data: { cid } });
  };
  try {
    assert.equal((await upload({ image: data }, "https://other.example")).status, 403);
    const uploaded = await upload({ image: data });
    assert.equal(uploaded.status, 200);
    const image = (await uploaded.json() as { image: string }).image;
    assert.equal(image, imageUrl);
    assert.equal(pinataRequests, 1);
    const response = await fetch(`${origin}/api/token-images/${key}`);
    assert.equal(response.status, 404);
    assert.equal(response.headers.get("cache-control")?.includes("immutable"), false);
    assert.equal((await fetch(`${origin}/api/token-images/${"0".repeat(64)}.webp`)).status, 404);
    assert.equal((await upload({ image: "not an image" })).status, 400);
    assert.equal(pinataRequests, 1);
    // The existing Node error handler maps parser errors to 422; workerd rejects ingress at 413.
    assert.equal((await upload({ image: "x".repeat(65_536) })).status, 422);
    assert.equal(pinataRequests, 1);
    failUpload = true;
    const failed = await upload({ image: data });
    assert.equal(failed.status, 422);
    assert.equal((await failed.text()).includes(pinataJwt), false);
    failUpload = false;
    for (let count = 0; count < 7; count++) assert.equal((await upload({ image: data })).status, 200);
    const limited = await upload({ image: data });
    assert.equal(limited.status, 429);
    assert.equal(limited.headers.get("retry-after"), "60");
    assert.equal(pinataRequests, 9);
  } finally {
    globalThis.fetch = originalFetch;
    await new Promise<void>(resolve => server.close(() => resolve()));
    await service.store.close();
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
    await rm(directory, { recursive: true, force: true });
  }
});
