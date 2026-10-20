import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { privateKeyToAccount } from "viem/accounts";
import { type Address } from "viem";
import { TokenPosts, PostError, type TokenPostsDependencies } from "../server/token-posts";
import { Store } from "../server/store";
import { postOwnerTypedData, POST_KEY_TTL_MS, publicPostUrl, type PostOwnerAction } from "../src/lib/token-posts";
import { syntheticToken } from "./fixtures";
import { redact } from "../server/config";
import { runtimeFromEnv } from "../server/config";
import { createApp } from "../server/app";
import { MUSEGOD } from "../src/lib/musegod";
import { BudgetUnavailable } from "../server/runtime-policy";
import { IngressLimiter, expensiveRoute, ingressClass } from "../server/abuse";

const alice = privateKeyToAccount(`0x${"11".repeat(32)}`), bob = privateKeyToAccount(`0x${"22".repeat(32)}`);
const START = 1_800_000_000_000;
const fail = (code: string, status?: number) => (error: unknown) => error instanceof PostError && error.code === code && (status === undefined || error.status === status);
function fixture(t: TestContext, nft = false) {
  const directory = mkdtempSync(join(tmpdir(), "musegod-posts-")), store = new Store(join(directory, "robinhood"), 4663);
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  let now = START, holder: Address = alice.address, rpcFails = false, uploads = 0;
  const token = syntheticToken({ mode: "robinhood", deploymentChainId: 4663, creator: alice.address,
    ...(nft ? { nft: { contract: "0x3333333333333333333333333333333333333333" as Address, chainId: 4663, tokenId: "1" } } : {}) });
  const deps: TokenPostsDependencies = {
    chainId: 4663, store, token: async address => { if (address.toLowerCase() !== token.address.toLowerCase()) throw new Error("Platform token not found"); return token; },
    now: () => now, nftOwner: async () => { if (rpcFails) throw Error("RPC down"); return holder; }, verifyContractSignature: async () => false,
    uploadImage: async () => { uploads++; return { image: "https://gateway.pinata.cloud/ipfs/bafkreiexg36mudbth2ete6lyz5pqfejop3k3fgbtlpt6izcka3yraykb6e" }; },
  };
  const service = new TokenPosts(deps);
  async function sign(action: PostOwnerAction, id = "", name = "", signer = alice, chainId = 4663) {
    const signature = await signer.signTypedData(postOwnerTypedData(chainId, token.address, action, id, name, now));
    return { signer: signer.address, signature, issuedAt: now };
  }
  async function create(signer = alice, id = randomUUID()) { return service.createKey(token.address, { ...await sign("create-key", id, "Test Agent", signer), keyId: id, name: "Test Agent" }); }
  return { directory, store, token, deps, service, sign, create, advance: (ms: number) => { now += ms; },
    setHolder: (value: Address) => { holder = value; }, rpcFailure: (value: boolean) => { rpcFails = value; }, uploads: () => uploads };
}

test("Posts keys require owner signatures, bind arguments and chain, reveal the secret once and preserve creation nonces", async t => {
  const f = fixture(t), id = randomUUID();
  await assert.rejects(f.create(bob), fail("POST_NOT_OWNER", 403));
  const signed = await f.sign("create-key", id, "Test Agent");
  const result = await f.service.createKey(f.token.address, { ...signed, keyId: id, name: "Test Agent" });
  assert.match(result.apiKey, /^mgp_[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}$/);
  assert.equal(result.key.expiresAt - result.key.createdAt, POST_KEY_TTL_MS);
  assert(!JSON.stringify(f.store.backup()).includes(result.apiKey));
  const listed = await f.service.listKeys(f.token.address, await f.sign("list-keys"));
  assert.equal(listed.keys.length, 1); assert(!JSON.stringify(listed).includes(result.apiKey)); assert(!("hash" in listed.keys[0]));
  await assert.rejects(f.service.createKey(f.token.address, { ...signed, keyId: id, name: "Test Agent" }), fail("POST_KEY_EXISTS", 409));
  const other = randomUUID();
  await assert.rejects(f.service.createKey(f.token.address, { ...await f.sign("create-key", other, "Test Agent", alice, 8453), keyId: other, name: "Test Agent" }), fail("POST_SIGNATURE_INVALID", 401));
  await assert.rejects(f.service.createKey(f.token.address, { ...await f.sign("create-key", other, "Original"), keyId: other, name: "Changed" }), fail("POST_SIGNATURE_INVALID", 401));
  await assert.rejects(f.service.listKeys(f.token.address, await f.sign("list-keys"), `Bearer ${result.apiKey}`), fail("POST_AUTH_AMBIGUOUS"));
  const expired = await f.sign("list-keys"); f.advance(600_001);
  await assert.rejects(f.service.listKeys(f.token.address, expired), fail("POST_SIGNATURE_EXPIRED", 409));
  assert.equal(redact(Error(`failure ${result.apiKey}`), {}), "failure [redacted]");
});

test("Posts supports contract-wallet signatures without changing the owner rule", async t => {
  const f = fixture(t), id = randomUUID(); let checks = 0;
  f.deps.verifyContractSignature = async (signer, data, signature) => { checks++; return signer === alice.address && data.message.targetId === id && signature === "0xabcd"; };
  const result = await f.service.createKey(f.token.address, { signer: alice.address, signature: "0xabcd", issuedAt: START, keyId: id, name: "Smart account" });
  assert.equal(result.key.issuer, alice.address); assert.equal(checks, 1);
  f.deps.verifyContractSignature = async () => { throw Error("unavailable"); };
  await assert.rejects(f.service.listKeys(f.token.address, { signer: alice.address, signature: "0xabcd", issuedAt: START }), fail("POST_SIGNATURE_UNAVAILABLE", 503));
});

test("Posts key limits, expiry, permanent revocation and ordinary creator ownership", async t => {
  const f = fixture(t), keys = [];
  for (let i = 0; i < 5; i++) keys.push(await f.create());
  await assert.rejects(f.create(), fail("POST_KEY_LIMIT", 409));
  const first = keys[0];
  await f.service.revokeKey(f.token.address, first.key.id, await f.sign("revoke-key", first.key.id));
  await assert.rejects(f.service.publish(f.token.address, { text: "revoked" }, `Bearer ${first.apiKey}`, "revoked"), fail("POST_KEY_INVALID", 401));
  const replacement = await f.create(); f.advance(POST_KEY_TTL_MS);
  await assert.rejects(f.service.publish(f.token.address, { text: "expired" }, `Bearer ${replacement.apiKey}`, "expired"), fail("POST_KEY_INVALID", 401));
  assert.equal((await f.create()).key.revokedAt, null);
});

test("NFT Posts uses current holder, never delegates; RPC uncertainty does not revoke and observed loss revokes permanently", async t => {
  const f = fixture(t, true), key = await f.create(), bearer = `Bearer ${key.apiKey}`;
  f.rpcFailure(true);
  await assert.rejects(f.service.publish(f.token.address, { text: "rpc unknown" }, bearer, "unknown"), fail("POST_OWNER_UNAVAILABLE", 503));
  assert.equal(f.store.postAction({ action: "keyGet", token: f.token.address, id: key.key.id }).key!.revokedAt, null);
  f.rpcFailure(false); f.setHolder(bob.address);
  // A transfer away and back between calls is intentionally not indexed.
  f.setHolder(alice.address); await f.service.publish(f.token.address, { text: "back before observation" }, bearer, "returned");
  f.setHolder(bob.address);
  await assert.rejects(f.create(), fail("POST_NOT_OWNER", 403));
  await assert.rejects(f.service.publish(f.token.address, { text: "lost" }, bearer, "lost"), fail("POST_KEY_OWNER_CHANGED", 403));
  const newKey = await f.create(bob); assert.equal(newKey.key.issuer, bob.address);
  f.setHolder(alice.address);
  await assert.rejects(f.service.publish(f.token.address, { text: "no revival" }, bearer, "revival"), fail("POST_KEY_INVALID", 401));
});

test("Posts publishes canonical content, paginates deterministically and keeps deleted idempotency tombstones", async t => {
  const f = fixture(t), key = await f.create(), bearer = `Bearer ${key.apiKey}`;
  const one = await f.service.publish(f.token.address, { text: "  <script>literal</script> https://musegod.fun  " }, bearer, "one");
  assert.equal(one.duplicate, false); assert("text" in one.post && one.post.text.startsWith("<script>"));
  assert.deepEqual(await f.service.publish(f.token.address, { text: "<script>literal</script> https://musegod.fun" }, bearer, "one"), { ...one, duplicate: true });
  await assert.rejects(f.service.publish(f.token.address, { text: "changed" }, bearer, "one"), fail("POST_IDEMPOTENCY_CONFLICT", 409));
  const two = await f.service.publish(f.token.address, { videoUrl: "https://youtube.com/watch?v=example" }, bearer, "two");
  await assert.rejects(f.service.publish(f.token.address, { text: "too soon" }, bearer, "three"), fail("POST_RATE_LIMITED", 429));
  const page = await f.service.list(f.token.address, { limit: "1" }); assert.equal(page.items.length, 1); assert(page.nextCursor);
  const next = await f.service.list(f.token.address, { limit: "1", cursor: page.nextCursor }); assert.notEqual(next.items[0].id, page.items[0].id);
  const otherKey = await f.create();
  await f.service.delete(f.token.address, one.post.id, {}, `Bearer ${otherKey.apiKey}`);
  const tombstone = await f.service.publish(f.token.address, { text: "<script>literal</script> https://musegod.fun" }, bearer, "one");
  assert.deepEqual(tombstone, { post: { id: one.post.id, deleted: true }, duplicate: true });
  await f.service.delete(f.token.address, two.post.id, await f.sign("delete-post", two.post.id));
  assert.equal((await f.service.list(f.token.address, {})).items.length, 0);
  await assert.rejects(f.service.delete(f.token.address, one.post.id, await f.sign("delete-post", one.post.id), bearer), fail("POST_AUTH_AMBIGUOUS"));
  f.advance(60_000); await f.service.publish(f.token.address, { text: "new minute" }, bearer, "three");
});

test("Posts rejects empty, duplicate media, unsafe URLs and oversized Unicode content", async t => {
  const f = fixture(t), key = await f.create(), bearer = `Bearer ${key.apiKey}`;
  await assert.rejects(f.service.publish(f.token.address, {}, bearer, "empty"), fail("POST_CONTENT_EMPTY"));
  await assert.rejects(f.service.publish(f.token.address, { text: "😀".repeat(5_001) }, bearer, "long"), fail("POST_CONTENT_INVALID"));
  const accepted = await f.service.publish(f.token.address, { text: "😀".repeat(5_000) }, bearer, "max"); assert("text" in accepted.post && Array.from(accepted.post.text).length === 5_000);
  for (const url of ["javascript:alert(1)", "http://example.org", "https://127.0.0.1/v.mp4", "https://172.16.1.1/v.mp4", "https://host.local/v.mp4", "https://user:pass@example.org/", "https://example.org:8443/"]) {
    assert.throws(() => publicPostUrl(url));
    await assert.rejects(f.service.publish(f.token.address, { videoUrl: url }, bearer, "unsafe"), fail("POST_VIDEO_INVALID"));
  }
  await assert.rejects(f.service.publish(f.token.address, { imageIds: ["a".repeat(64), "a".repeat(64)] }, bearer, "duplicate"), fail("POST_CONTENT_INVALID"));
  await assert.rejects(f.service.publish(f.token.address, { imageIds: ["a".repeat(64)] }, bearer, "unknown"), fail("POST_MEDIA_INVALID"));
  await assert.rejects(f.service.publish("0x4444444444444444444444444444444444444444", { text: "unknown token" }, bearer, "unknown"), fail("TOKEN_NOT_REGISTERED", 404));
});

test("Posts image uploads validate, reserve, deduplicate and refuse a key revoked during pinning", async t => {
  const f = fixture(t), key = await f.create(), bearer = `Bearer ${key.apiKey}`;
  // A valid tiny lossless WebP framing isolates the existing image validator and the upload authorization path.
  const bytes = Buffer.alloc(26); bytes.write("RIFF"); bytes.writeUInt32LE(18, 4); bytes.write("WEBP", 8); bytes.write("VP8L", 12); bytes.writeUInt32LE(5, 16); bytes[20] = 0x2f;
  const image = `data:image/webp;base64,${bytes.toString("base64")}`;
  const uploaded = await f.service.upload(f.token.address, { image }, bearer);
  assert.equal(uploaded.id.length, 64); assert.equal(f.uploads(), 1);
  assert.deepEqual(await f.service.upload(f.token.address, { image }, bearer), uploaded); assert.equal(f.uploads(), 1);
  const posted = await f.service.publish(f.token.address, { imageIds: [uploaded.id] }, bearer, "image");
  assert("images" in posted.post && posted.post.images[0].url === uploaded.url);
  await assert.rejects(f.service.upload(f.token.address, { image: "data:image/webp;base64,YWJj" }, bearer), fail("POST_IMAGE_INVALID"));
  bytes[21] = 1;
  f.deps.uploadImage = async () => {
    await f.service.revokeKey(f.token.address, key.key.id, await f.sign("revoke-key", key.key.id));
    return { image: uploaded.url };
  };
  await assert.rejects(f.service.upload(f.token.address, { image: `data:image/webp;base64,${bytes.toString("base64")}` }, bearer), fail("POST_KEY_INVALID", 401));
});

test("Posts mutation transaction refuses a key revoked after service authentication", async t => {
  const f = fixture(t), key = await f.create(), bearer = `Bearer ${key.apiKey}`, original = f.store.postAction.bind(f.store);
  f.deps.store = { postAction(command) {
    if (command.action === "postCreate") original({ action: "keyRevoke", token: f.token.address, id: key.key.id, now: START });
    return original(command);
  } };
  await assert.rejects(f.service.publish(f.token.address, { text: "late write" }, bearer, "race"), fail("POST_KEY_INVALID", 401));
  assert.equal((await f.service.list(f.token.address, {})).items.length, 0);
});

test("Node HTTP Posts works while financial signing is paused and keeps machine requests under hard ingress limits", async t => {
  const directory = mkdtempSync(join(tmpdir(), "musegod-posts-http-"));
  const { app, service } = createApp(undefined, true, runtimeFromEnv(4663, { CHAIN_MODE: "robinhood", DATA_DIR: directory }));
  const token = syntheticToken({ mode: "robinhood", deploymentChainId: 4663, creator: alice.address, quoteAddress: MUSEGOD.weth });
  await service.store.saveToken(token);
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  t.after(async () => { await new Promise<void>(resolve => server.close(() => resolve())); await service.store.close(); rmSync(directory, { recursive: true, force: true }); });
  const address = server.address(); assert(address && typeof address !== "string");
  const root = `http://127.0.0.1:${address.port}/api/tokens/${token.address}`;
  const keyId = randomUUID(), issuedAt = Date.now(), name = "HTTP Agent";
  const signature = await alice.signTypedData(postOwnerTypedData(4663, token.address, "create-key", keyId, name, issuedAt));
  const created = await fetch(`${root}/post-api-keys`, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ keyId, name, issuedAt, signature, signer: alice.address }) });
  assert.equal(created.status, 201); assert.equal(created.headers.get("cache-control"), "no-store");
  const key = await created.json() as { apiKey: string };
  const publish = (origin?: string) => fetch(`${root}/posts`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${key.apiKey}`,
    "idempotency-key": "http", ...(origin ? { origin } : {}) }, body: JSON.stringify({ text: "A local Node HTTP fixture" }) });
  assert.equal((await publish("https://other.example.org")).status, 403);
  assert.equal((await publish()).status, 201);
  let limited = false;
  for (let i = 0; i < 20; i++) {
    const response = await publish(); assert([200, 429].includes(response.status));
    const data = await response.json() as { code?: string }; assert.notEqual(data.code, "CHALLENGE_REQUIRED");
    limited ||= response.status === 429;
  }
  assert(limited, "machine requests retain the source hard limit");
  const publicRead = await fetch(`${root}/posts`, { headers: { "x-forwarded-for": "192.0.2.55" } });
  assert.equal(publicRead.status, 200); assert.equal((await publicRead.json() as { items: unknown[] }).items.length, 1);
});

test("A Pinata budget refusal reports its real wait and spends no Posts image slot", async t => {
  const f = fixture(t), key = await f.create(), bearer = `Bearer ${key.apiKey}`;
  const bytes = Buffer.alloc(26); bytes.write("RIFF"); bytes.writeUInt32LE(18, 4); bytes.write("WEBP", 8); bytes.write("VP8L", 12); bytes.writeUInt32LE(5, 16); bytes[20] = 0x2f;
  const image = `data:image/webp;base64,${bytes.toString("base64")}`;
  let attempts = 0;
  f.deps.uploadImage = async () => { attempts++; throw new BudgetUnavailable(3_600); };
  for (let i = 0; i < 12; i++) {
    f.advance(61_000);
    await assert.rejects(f.service.upload(f.token.address, { image }, bearer), error => error instanceof BudgetUnavailable && error.retryAfter === 3_600);
  }
  assert.equal(attempts, 12, "every refusal reached the budget, none was rate-limited by its own earlier refusals");
  f.deps.uploadImage = async () => ({ image: "https://gateway.pinata.cloud/ipfs/bafkreiexg36mudbth2ete6lyz5pqfejop3k3fgbtlpt6izcka3yraykb6e" });
  f.advance(61_000);
  assert.equal((await f.service.upload(f.token.address, { image }, bearer)).id.length, 64, "the token keeps its whole daily image allowance");
});

test("Posts admission classifies percent-encoded routes the way Express matches them", () => {
  const address = `%30x${"ab".repeat(20)}`, plain = `0x${"ab".repeat(20)}`, id = randomUUID();
  for (const route of [`/post-api-keys/list`, `/post-api-keys/${id}/revoke`, `/posts`, `/posts/${id}/delete`]) {
    assert.equal(ingressClass(`/api/tokens/${address}${route}`, "POST"), ingressClass(`/api/tokens/${plain}${route}`, "POST"), route);
    assert.equal(ingressClass(`/api/tokens/${address}${route}`, "POST"), "workflow", route);
    assert.equal(expensiveRoute(`/api/chains/4663/tokens/${address}${route}`, "POST"), true, route);
  }
  assert.equal(ingressClass(`/api/chains/8453/tokens/${address}/posts/images`, "POST"), "upload");
  assert.equal(ingressClass(`/api/tokens/${address}/profile`, "POST"), "workflow");
  assert.equal(ingressClass(`/api/tokens/${address}/posts`, "GET"), "read");
  assert.equal(ingressClass("/api/tokens/%E0%A4%A/posts", "POST"), "read", "a malformed escape is left for Express to reject");
  const limiter = new IngressLimiter(), statuses: (number | undefined)[] = [];
  for (let i = 0; i < 21; i++) { const admission = limiter.admit("203.0.113.9", `/api/tokens/${address}/post-api-keys/list`, START, "POST"); statuses.push(admission.status); admission.release(); }
  assert.deepEqual(statuses.slice(0, 20), Array(20).fill(undefined)); assert.equal(statuses[20], 429, "encoded owner requests share the expensive cap");
});

test("Posts admission challenges owner key routes while bearer routes keep machine quotas", () => {
  const id = randomUUID();
  for (const root of ["/api", "/api/chains/8453", "/api/chains/4663"]) for (const address of [`0x${"ab".repeat(20)}`, `%30x${"ab".repeat(20)}`]) {
    for (const [suffix, owner] of [["/post-api-keys", true], ["/post-api-keys/list", true], [`/post-api-keys/${id}/revoke`, true],
      ["/posts", false], ["/posts/images", false], [`/posts/${id}/delete`, false], ["/post-api-keys/unknown", false]] as const) {
      const path = `${root}/tokens/${address}${suffix}/?fixture=1`, burst = new IngressLimiter(), sustained = new IngressLimiter();
      for (let i = 0; i < 17; i++) {
        const admission = burst.admit("203.0.113.10", path, START, "POST"); admission.release();
        assert.equal(admission.status, undefined, path); assert.equal(admission.challenge, owner && i === 16, `burst ${path}`);
      }
      for (let i = 0; i < 41; i++) {
        const admission = sustained.admit("203.0.113.10", path, START + Math.floor(i / 10) * 60_000, "POST"); admission.release();
        assert.equal(admission.status, undefined, path); assert.equal(admission.challenge, owner && i === 40, `sustained ${path}`);
      }
    }
  }
});
