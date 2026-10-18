import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { createWalletClient, custom, getAddress, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { robinhood } from "viem/chains";
import {
  EMPTY_PROFILE_LINKS, displayedProfileLinks, effectiveProfileLinks, isCanonicalProfileLinks, launchProfileLinks, normalizeProfileLink, parseProfileLinks,
  profileLinkLabel, profileLinkList, profileTypedData, ProfileLinkError, PROFILE_SIGNATURE_WINDOW_MS, type ProfileLinks,
} from "../src/lib/token-profile";
import { creatorOwnsProfile, profileKey, readTokenProfile, saveTokenProfile, ProfileError, type ProfileStore } from "../server/token-profile";
import { assertProfileSignRequest, profileSigningRequest, walletMethodPolicy, type ProfileSignature } from "../src/lib/wallet-signing";
import { LaunchpadService } from "../server/service";
import { syntheticToken } from "./fixtures";
import { MUSEGOD } from "../src/lib/musegod";

const owner = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
const stranger = privateKeyToAccount("0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba");
const NOW = 1_800_000_000_000;
const coin = syntheticToken({ mode: "robinhood", deploymentChainId: 4663, quoteAddress: MUSEGOD.weth, creator: owner.address, twitter: "https://x.com/alexanderchopan" });
const links: ProfileLinks = { ...EMPTY_PROFILE_LINKS, x: "https://x.com/musegod_rh", youtube: "https://youtube.com/@musegod", website: "https://musegod.fun/" };

function memoryStore(): ProfileStore & { rows: Map<string, { at: number; data: unknown }> } {
  const rows = new Map<string, { at: number; data: unknown }>();
  return { rows, snapshot: (key) => rows.get(key) ?? null, saveProfileSnapshot: (key, data, issuedAt) => {
    // The stores' conditional write: only over no row or an earlier signature.
    if ((rows.get(key)?.at ?? -Infinity) >= issuedAt) return false;
    rows.set(key, { at: issuedAt, data: structuredClone(data) }); return true;
  } };
}
async function signed(account = owner, values: ProfileLinks = links, issuedAt = NOW, chainId = 4663, token: Address = coin.address) {
  const signature = await account.signTypedData(profileTypedData(chainId, token, values, issuedAt));
  return { links: values, issuedAt, signer: account.address, signature };
}
const deps = (store = memoryStore(), extra: Partial<Parameters<typeof saveTokenProfile>[2]> = {}) => ({
  store, chainId: 4663, now: () => NOW, isOwner: async (token: typeof coin, signer: Address) => creatorOwnsProfile(token, signer) ?? false, ...extra,
});
const refused = (code: string, status: number) => (error: unknown) => error instanceof ProfileError && error.code === code && error.status === status;

/** Track timers until explicitly cleared or fired, as in fetch-deadline.test.ts. */
function timerLedger(t: TestContext) {
  const live = new Map<object, () => void>();
  t.mock.method(globalThis, "setTimeout", (callback: () => void) => {
    const id = {};
    live.set(id, () => { live.delete(id); callback(); });
    return id;
  });
  t.mock.method(globalThis, "clearTimeout", (id: object) => { live.delete(id); });
  return { live, fireAll() { for (const fire of [...live.values()]) fire(); } };
}

test("profile links accept handles, @handles and platform links, and store one canonical https URL each", () => {
  assert.equal(normalizeProfileLink("x", "@musegod_rh"), "https://x.com/musegod_rh");
  assert.equal(normalizeProfileLink("x", "musegod_rh"), "https://x.com/musegod_rh");
  assert.equal(normalizeProfileLink("x", "https://twitter.com/musegod_rh/?s=20#top"), "https://x.com/musegod_rh");
  assert.equal(normalizeProfileLink("x", "x.com/i/communities/1234567890"), "https://x.com/i/communities/1234567890");
  assert.equal(normalizeProfileLink("youtube", "@my.channel"), "https://youtube.com/@my.channel");
  assert.equal(normalizeProfileLink("youtube", "my.channel"), "https://youtube.com/@my.channel");
  assert.equal(normalizeProfileLink("youtube", "https://www.youtube.com/channel/UC1234567890123456789012"), "https://youtube.com/channel/UC1234567890123456789012");
  assert.equal(normalizeProfileLink("tiktok", "https://www.tiktok.com/@jubilee.cakes"), "https://tiktok.com/@jubilee.cakes");
  assert.equal(normalizeProfileLink("telegram", "t.me/musegodfun"), "https://t.me/musegodfun");
  assert.equal(normalizeProfileLink("telegram", "https://t.me/+AbCdEfGhIjKl"), "https://t.me/+AbCdEfGhIjKl");
  assert.equal(normalizeProfileLink("website", "musegod.fun/about#team"), "https://musegod.fun/about");
  assert.equal(normalizeProfileLink("website", "  "), "");
  assert.equal(normalizeProfileLink("tiktok", undefined), "");
});

test("profile links refuse other hosts, schemes, credentials, private hosts and social links in the website field", () => {
  for (const [field, value] of [
    ["x", "https://evil.example/musegod"], ["x", "javascript:alert(1)"], ["x", "@bad-handle!"], ["x", "x.com"], ["x", "https://x.com/a/b/c"],
    ["youtube", "https://youtube.com/watch?v=1"], ["tiktok", "https://tiktok.com/video/1"], ["telegram", "t.me/abc"], ["telegram", "http://t.me/musegodfun"],
    ["website", "http://musegod.fun"], ["website", "https://user:pass@musegod.fun"], ["website", "https://127.0.0.1/"], ["website", "https://localhost/"],
    ["website", "https://x.com/musegod"], ["website", "https://musegod.fun:8443/"], ["website", `https://musegod.fun/${"a".repeat(200)}`],
  ] as const) assert.throws(() => normalizeProfileLink(field, value), ProfileLinkError, `${field} ${value}`);
  assert.throws(() => parseProfileLinks({ ...links, instagram: "x" }), /Unknown profile field/);
  assert.throws(() => parseProfileLinks(["x"]), ProfileLinkError);
});

test("labels name the platform and handle; only filled links render, in a fixed order", () => {
  assert.equal(profileLinkLabel("x", "https://x.com/musegod_rh"), "X @musegod_rh");
  assert.equal(profileLinkLabel("x", "https://x.com/i/communities/1"), "X community");
  assert.equal(profileLinkLabel("youtube", "https://youtube.com/@musegod"), "YouTube @musegod");
  assert.equal(profileLinkLabel("youtube", "https://youtube.com/channel/UC1234567890123456789012"), "YouTube");
  assert.equal(profileLinkLabel("telegram", "https://t.me/+AbCdEfGhIjKl"), "Telegram group");
  assert.equal(profileLinkLabel("website", "https://www.musegod.fun/"), "musegod.fun");
  assert.deepEqual(profileLinkList(links).map((link) => link.field), ["x", "youtube", "website"]);
  assert.deepEqual(profileLinkList(EMPTY_PROFILE_LINKS), []);
});

test("a saved profile replaces the launch links entirely; without one, launch links that fit a field show", () => {
  assert.deepEqual(launchProfileLinks({ twitter: "https://x.com/alexanderchopan", telegram: "https://t.me/+invitecode1234", website: "https://example.org" }),
    { ...EMPTY_PROFILE_LINKS, x: "https://x.com/alexanderchopan", telegram: "https://t.me/+invitecode1234", website: "https://example.org/" });
  assert.deepEqual(launchProfileLinks({ twitter: "https://x.com/home/feed/extra" }), EMPTY_PROFILE_LINKS, "a link that fits no field is left out");
  assert.deepEqual(effectiveProfileLinks(coin, null), { ...EMPTY_PROFILE_LINKS, x: "https://x.com/alexanderchopan" });
  assert.deepEqual(effectiveProfileLinks(coin, { links: { ...EMPTY_PROFILE_LINKS, youtube: "https://youtube.com/@musegod" } }),
    { ...EMPTY_PROFILE_LINKS, youtube: "https://youtube.com/@musegod" }, "the owner cleared X");
  assert.equal(isCanonicalProfileLinks({ ...links, x: "@musegod_rh" }), false, "a stored value must already be canonical");
  assert.equal(isCanonicalProfileLinks({ ...links, extra: "" }), false);
});

test("the owner's EOA signature saves the links; the newest signature wins and a replay or an older one is refused", async () => {
  const store = memoryStore();
  const profile = await saveTokenProfile(coin, await signed(), deps(store));
  assert.deepEqual(profile, { links, signer: owner.address, issuedAt: NOW, savedAt: NOW });
  assert.deepEqual(await readTokenProfile(store, coin.address), profile);
  assert.equal(store.rows.has(profileKey(coin.address)), true);
  assert.equal(profileKey(coin.address), `profile:${coin.address.toLowerCase()}`);
  await assert.rejects(saveTokenProfile(coin, await signed(), deps(store)), refused("PROFILE_STALE", 409), "replay");
  await assert.rejects(saveTokenProfile(coin, await signed(owner, links, NOW - 1), deps(store)), refused("PROFILE_STALE", 409), "older");
  const cleared = await saveTokenProfile(coin, await signed(owner, EMPTY_PROFILE_LINKS, NOW + 1), deps(store, { now: () => NOW + 1 }));
  assert.deepEqual(cleared.links, EMPTY_PROFILE_LINKS, "an owner may clear every link");
});

test("a save is refused unless the signer owns the profile and signed exactly these links, this coin, this chain and a fresh time", async () => {
  await assert.rejects(saveTokenProfile(coin, await signed(stranger), deps()), refused("PROFILE_NOT_OWNER", 403));
  const tampered = { ...(await signed()), links: { ...links, website: "https://attacker.org/" } };
  await assert.rejects(saveTokenProfile(coin, tampered, deps()), refused("PROFILE_SIGNATURE", 401), "links changed after signing");
  await assert.rejects(saveTokenProfile(coin, { ...(await signed()), signer: stranger.address }, deps()), refused("PROFILE_SIGNATURE", 401), "claimed signer");
  await assert.rejects(saveTokenProfile(coin, await signed(owner, links, NOW, 8453), deps()), refused("PROFILE_SIGNATURE", 401), "another chain");
  await assert.rejects(saveTokenProfile(coin, await signed(owner, links, NOW, 4663, getAddress("0x3333333333333333333333333333333333333333")), deps()),
    refused("PROFILE_SIGNATURE", 401), "another coin");
  await assert.rejects(saveTokenProfile(coin, await signed(owner, links, NOW - PROFILE_SIGNATURE_WINDOW_MS - 1), deps()), refused("PROFILE_EXPIRED", 409));
  await assert.rejects(saveTokenProfile(coin, await signed(owner, links, NOW + PROFILE_SIGNATURE_WINDOW_MS + 1), deps()), refused("PROFILE_EXPIRED", 409));
  await assert.rejects(saveTokenProfile(coin, { ...(await signed()), links: { ...links, x: "https://evil.example/x" } }, deps()), refused("PROFILE_INVALID", 400));
  await assert.rejects(saveTokenProfile(coin, { ...(await signed()), extra: true }, deps()), refused("PROFILE_INVALID", 400));
  await assert.rejects(saveTokenProfile(coin, { ...(await signed()), signature: "0x123" }, deps()), refused("PROFILE_INVALID", 400), "half a byte");
  await assert.rejects(saveTokenProfile(coin, { ...(await signed()), signature: "0x1234" }, deps()), refused("PROFILE_SIGNATURE", 401), "well-formed, but no EOA signature");
  await assert.rejects(saveTokenProfile({ ...coin, mode: "fork" }, await signed(), deps()), refused("PROFILE_UNAVAILABLE", 409));
});

test("a contract wallet's signature is checked by the injected verifier only when local recovery does not attribute it", async () => {
  const wallet = getAddress("0x4444444444444444444444444444444444444444"), checked: Address[] = [];
  const contractCoin = { ...coin, creator: wallet };
  const body = { links, issuedAt: NOW, signer: wallet, signature: `0x${"ab".repeat(100)}` as Hex };
  await assert.rejects(saveTokenProfile(contractCoin, body, deps()), refused("PROFILE_SIGNATURE", 401), "no verifier: EOA only");
  const saved = await saveTokenProfile(contractCoin, body, deps(memoryStore(), { verifyContractSignature: async (signer) => { checked.push(signer); return true; } }));
  assert.deepEqual([checked, saved.signer], [[wallet], wallet]);
  const ownerChecks: Address[] = [];
  await saveTokenProfile(coin, await signed(), deps(memoryStore(), { verifyContractSignature: async (signer) => { ownerChecks.push(signer); return false; } }));
  assert.deepEqual(ownerChecks, [], "an EOA signature never calls the contract verifier");
});

test("NFT coins defer ownership to the holder check; a tampered stored row never renders", async () => {
  assert.equal(creatorOwnsProfile({ creator: owner.address }, owner.address), true);
  assert.equal(creatorOwnsProfile({ creator: owner.address }, stranger.address), false);
  assert.equal(creatorOwnsProfile({ creator: null }, owner.address), false);
  assert.equal(creatorOwnsProfile({ creator: owner.address, nft: { chainId: 4663, contract: coin.address, tokenId: "1" } }, owner.address), null);
  const store = memoryStore();
  store.rows.set(profileKey(coin.address), { at: NOW, data: { links: { ...links, x: "javascript:alert(1)" }, signer: owner.address, issuedAt: NOW, savedAt: NOW } });
  assert.equal(await readTokenProfile(store, coin.address), null);
  store.rows.set(profileKey(coin.address), { at: NOW, data: { links, signer: "nobody", issuedAt: NOW, savedAt: NOW } });
  assert.equal(await readTokenProfile(store, coin.address), null);
});

test("the service saves through the store, keeps profiles through cleanup and reads them back", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "token-profile-service-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const service = new LaunchpadService({
    config: { mode: "robinhood", chainId: 4663, deploymentChainId: 4663, treasury: null, writesEnabled: false, blockReason: null },
    rpcUrl: "https://rpc.fixture.test", dataDir: directory, dataScope: "robinhood",
    launchGuardCandidate: null, firstBuyGuardCandidate: null, lifi: { integrator: "musegodfun" },
  });
  t.after(() => service.store.close());
  await service.store.saveToken(coin);
  const now = Date.now();
  const body = await signed(owner, links, now);
  const saved = await service.saveTokenProfile(coin.address, body);
  assert.deepEqual(saved.links, links);
  assert.deepEqual(await service.tokenProfile(coin.address), saved);
  await service.store.cleanup(now + 3 * 86_400_000);
  assert.deepEqual(await readTokenProfile(service.store, coin.address), saved, "cleanup keeps profile: rows");
  await assert.rejects(service.saveTokenProfile(coin.address, await signed(stranger, links, now + 1)), refused("PROFILE_NOT_OWNER", 403));
  await assert.rejects(service.saveTokenProfile("0x9999999999999999999999999999999999999999", body), /Platform token not found/);
});

test("the profile signer passes exactly one TokenProfile request; every other signature and every transaction stays refused", async () => {
  assert.equal(walletMethodPolicy("eth_signTypedData_v4"), "refuse", "the shared policy still refuses every signature");
  assert.equal(walletMethodPolicy("personal_sign"), "refuse");
  const data = profileTypedData(4663, coin.address, links, NOW);
  const expected: ProfileSignature = { account: owner.address, domain: data.domain, types: data.types, primaryType: data.primaryType,
    message: { ...data.message, issuedAt: data.message.issuedAt.toString() } };
  const seen: { method: string; params?: unknown }[] = [];
  const provider = { request: async (request: { method: string; params?: unknown }) => {
    seen.push(request);
    if (request.method === "eth_chainId") return "0x1237";
    if (request.method === "eth_signTypedData_v4") return owner.signTypedData(data);
    throw new Error("unexpected " + request.method);
  } };
  let validations = 0;
  const transport = custom({ request: profileSigningRequest(provider, expected, async () => { validations++; }) }, { retryCount: 0 });
  const client = createWalletClient({ account: owner.address, chain: robinhood, transport });
  const signature = await client.signTypedData({ account: owner.address, ...data });
  assert.equal(signature, await owner.signTypedData(data));
  assert.deepEqual(seen.map((r) => r.method).filter((m) => m !== "eth_chainId"), ["eth_signTypedData_v4"], "viem's request matches the guard");
  assert.equal(validations, 1);
  await assert.rejects(client.signTypedData({ account: owner.address, ...data }), /already signed/, "one signature per editor save");
  const fresh = profileSigningRequest(provider, expected, async () => {});
  for (const request of [
    { method: "eth_sendTransaction", params: [{ to: coin.address }] }, { method: "personal_sign", params: ["0x00", owner.address] },
    { method: "eth_signTypedData_v3", params: [owner.address, "{}"] },
  ]) await assert.rejects(fresh(request), /not allowed/);
  const params = (mutate: (value: Record<string, any>) => void, account: string = owner.address) => {
    const value: Record<string, any> = { domain: { ...data.domain }, message: { ...expected.message }, primaryType: data.primaryType,
      types: { EIP712Domain: [{ name: "name", type: "string" }, { name: "version", type: "string" }, { name: "chainId", type: "uint256" }], ...data.types } };
    mutate(value);
    return { method: "eth_signTypedData_v4", params: [account, JSON.stringify(value)] };
  };
  assert.doesNotThrow(() => assertProfileSignRequest(params(() => {}), expected));
  for (const [name, request] of [
    ["verifying contract", params((v) => { v.domain.verifyingContract = coin.address; v.types.EIP712Domain.push({ name: "verifyingContract", type: "address" }); })],
    ["another chain", params((v) => { v.domain.chainId = 8453; })],
    ["another primary type", params((v) => { v.primaryType = "Permit"; })],
    ["another link", params((v) => { v.message.website = "https://evil.example/"; })],
    ["extra type", params((v) => { v.types.Permit = [{ name: "value", type: "uint256" }]; })],
    ["another account", params(() => {}, stranger.address)],
  ] as const) assert.throws(() => assertProfileSignRequest(request, expected), /does not match/, name);
});

test("the profile route saves a signed body, maps refusals to their codes and is classed as a capped workflow", async (t) => {
  const { createApp } = await import("../server/app");
  const { runtimeFromEnv } = await import("../server/config");
  const { ingressClass, expensiveRoute } = await import("../server/abuse");
  const native = globalThis.fetch, outside: string[] = [];
  t.mock.method(globalThis, "fetch", async (input: any, init: any) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    if (url.hostname === "127.0.0.1") return native(input, init);
    outside.push(url.hostname); throw new Error("offline test");
  });
  const scratch = mkdtempSync(join(tmpdir(), "token-profile-http-"));
  const entry = createApp(undefined, "loopback", runtimeFromEnv(4663, { NODE_ENV: "test", CHAIN_MODE: "robinhood", DATA_DIR: scratch, FOMO_INVITE_HANDLE: "musegod" }));
  await entry.service.store.saveToken(coin);
  const server = entry.app.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(async () => { await new Promise<void>((resolve) => server.close(() => resolve())); (entry.service.store as any).close(); rmSync(scratch, { recursive: true, force: true }); });
  const origin = `http://127.0.0.1:${(server.address() as any).port}`, path = `/api/tokens/${coin.address}/profile`;
  const post = (body: unknown, headers: Record<string, string> = {}) => fetch(`${origin}${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  const body = await signed(owner, links, Date.now());
  const saved = await post(body);
  assert.equal(saved.status, 200);
  assert.deepEqual((await saved.json() as any).links, links);
  const replay = await post(body);
  assert.deepEqual([replay.status, (await replay.json() as any).code], [409, "PROFILE_STALE"]);
  const invalid = await post({ ...body, links: { ...links, x: "https://evil.example/x" } });
  assert.deepEqual([invalid.status, (await invalid.json() as any).code], [400, "PROFILE_INVALID"]);
  assert.equal((await post(body, { origin: "https://evil.example" })).status, 403, "a cross-site save is refused before the service");
  assert.deepEqual(outside, [], "an EOA save never reaches an RPC or another host");
  assert.equal((await (await fetch(`${origin}/api/config`)).json() as any).fomoInvite, "musegod");
  for (const route of [path, `/api/chains/4663/tokens/${coin.address.toLowerCase()}/profile`]) {
    assert.equal(ingressClass(route), "workflow");
    assert.equal(expensiveRoute(route), true);
  }
  assert.equal(ingressClass(`/api/tokens/${coin.address}`), "read");
  assert.equal(expensiveRoute("/api/trade/eth-quote"), false, "the removed ETH-buy quote route is gone");
  assert.throws(() => runtimeFromEnv(4663, { NODE_ENV: "test", CHAIN_MODE: "robinhood", DATA_DIR: scratch, FOMO_INVITE_HANDLE: "https://fomo.family/r/x" }), /FOMO_INVITE_HANDLE/);
});

test("overlapping saves keep the newest signature: an older or duplicate request that finishes last is refused, not written", async () => {
  const store = memoryStore();
  let release!: () => void;
  const paused = new Promise<void>((resolve) => { release = resolve; });
  const slowOwner = deps(store, { isOwner: async () => { await paused; return true; } });
  const older = saveTokenProfile(coin, await signed(owner, { ...links, website: "https://old.example.org/" }, NOW), slowOwner);
  const newer = await saveTokenProfile(coin, await signed(owner, links, NOW + 1), deps(store, { now: () => NOW + 1 }));
  release();
  await assert.rejects(older, refused("PROFILE_STALE", 409));
  assert.deepEqual(await readTokenProfile(store, coin.address), newer, "the newer save stays");
  const body = await signed(owner, links, NOW + 2), later = deps(store, { now: () => NOW + 2 });
  const twice = await Promise.allSettled([saveTokenProfile(coin, body, later), saveTokenProfile(coin, body, later)]);
  assert.deepEqual(twice.map((result) => result.status).sort(), ["fulfilled", "rejected"], "one copy of a signature saves, the other is stale");
});

test("both stores write a profile only over an earlier signature", async (t) => {
  const { Store } = await import("../server/store");
  const directory = mkdtempSync(join(tmpdir(), "token-profile-store-"));
  const sqlite = new Store(directory, 4663);
  t.after(() => { sqlite.close(); rmSync(directory, { recursive: true, force: true }); });
  const key = profileKey(coin.address);
  assert.equal(sqlite.saveProfileSnapshot(key, { v: 2 }, 2), true, "no row yet");
  assert.equal(sqlite.saveProfileSnapshot(key, { v: 1 }, 1), false, "older");
  assert.equal(sqlite.saveProfileSnapshot(key, { v: 2 }, 2), false, "same time");
  assert.deepEqual(sqlite.snapshot(key), { at: 2, data: { v: 2 } });
  assert.equal(sqlite.saveProfileSnapshot(key, { v: 3 }, 3), true, "newer");
  assert.deepEqual(sqlite.snapshot(key), { at: 3, data: { v: 3 } });

  const { SupabaseStore } = await import("../server/supabase-store");
  const calls: { url: string; method: string; prefer: string | null; body: any }[] = [];
  let answers: unknown[][] = [];
  t.mock.method(globalThis, "fetch", async (input: any, init: any) => {
    calls.push({ url: String(input), method: init.method, prefer: new Headers(init.headers).get("prefer"), body: init.body ? JSON.parse(init.body) : undefined });
    return new Response(JSON.stringify(answers.shift() ?? []), { status: 200 });
  });
  const supabase = new SupabaseStore("https://fixture.supabase.co", "fixture-only", "robinhood");
  answers = [[{ key }]];
  assert.equal(await supabase.saveProfileSnapshot(key, { v: 5 }, 5), true);
  assert.deepEqual(calls.map((call) => [call.method, call.prefer]), [["POST", "resolution=ignore-duplicates,return=representation"]], "insert when absent, never merge");
  assert.deepEqual(calls[0].body, { scope: "robinhood", key, at: 5, payload: { v: 5 } });
  calls.length = 0; answers = [[], [{ key }]];
  assert.equal(await supabase.saveProfileSnapshot(key, { v: 6 }, 6), true);
  assert.equal(calls[1].method, "PATCH");
  assert.match(calls[1].url, new RegExp(`musegod_snapshots\\?scope=eq\\.robinhood&key=eq\\.${encodeURIComponent(key).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}&at=lt\\.6&select=key$`));
  assert.deepEqual(calls[1].body, { at: 6, payload: { v: 6 } });
  calls.length = 0; answers = [[], []];
  assert.equal(await supabase.saveProfileSnapshot(key, { v: 4 }, 4), false, "a stored newer row is kept");
});

test("a short contract-wallet signature reaches the contract check; malformed or oversized ones are refused first", async () => {
  const wallet = getAddress("0x4444444444444444444444444444444444444444"), contractCoin = { ...coin, creator: wallet };
  const checked: Hex[] = [];
  const verifier = deps(memoryStore(), { verifyContractSignature: async (_signer, _data, signature) => { checked.push(signature); return true; } });
  const compact = `0x${"cd".repeat(64)}` as Hex;
  const saved = await saveTokenProfile(contractCoin, { links, issuedAt: NOW, signer: wallet, signature: compact }, verifier);
  assert.deepEqual([saved.signer, checked], [wallet, [compact]], "a 64-byte EIP-2098 signature is the wallet's to judge");
  for (const signature of ["0x", "0xabc", `0x${"ab".repeat(2049)}`, "0xzz"])
    await assert.rejects(saveTokenProfile(contractCoin, { links, issuedAt: NOW + 1, signer: wallet, signature }, verifier), refused("PROFILE_INVALID", 400), signature.slice(0, 8));
  assert.equal(checked.length, 1);
});

test("a website is a public DNS name without its root dot, never a social domain, subdomain or private name", () => {
  assert.equal(normalizeProfileLink("website", "https://musegod.fun./about"), "https://musegod.fun/about");
  assert.equal(normalizeProfileLink("website", "https://WWW.Example.org/"), "https://www.example.org/");
  for (const value of ["https://x.com./owner", "https://youtube.com./@owner", "https://music.youtube.com/channel/x", "https://vm.tiktok.com/abc",
    "https://dashboard.local/", "https://router.lan/", "https://intranet.internal/", "https://a.test/", "https://-bad.example.org/", "https://1.2.3.4/", "https://[::1]/"])
    assert.throws(() => normalizeProfileLink("website", value), ProfileLinkError, value);
  assert.equal(isCanonicalProfileLinks({ ...EMPTY_PROFILE_LINKS, website: "https://x.com./owner" }), false, "a stored alias never renders");
  assert.deepEqual(launchProfileLinks({ website: "https://dashboard.local/" }), EMPTY_PROFILE_LINKS, "a launch link that fails the rule is left out");
});

test("the token record answers within the state deadline even while a Muse's metadata read hangs; simultaneous views share one read", async (t) => {
  const { MUSES } = await import("../src/lib/nft-mode");
  const directory = mkdtempSync(join(tmpdir(), "token-detail-deadline-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const service = new LaunchpadService({
    config: { mode: "robinhood", chainId: 4663, deploymentChainId: 4663, treasury: null, writesEnabled: false, blockReason: null },
    rpcUrl: "https://rpc.fixture.test", dataDir: directory, dataScope: "robinhood",
    launchGuardCandidate: null, firstBuyGuardCandidate: null, lifi: { integrator: "musegodfun" },
  });
  t.after(() => service.store.close());
  const muse = { ...coin, nft: { chainId: 4663 as const, contract: MUSES.contract, tokenId: "931" } };
  await service.store.saveToken(muse);
  let museReads = 0, finish!: (value: { name: string; agentId: string }) => void;
  (service as any).state = () => new Promise(() => {});
  (service as any).museProfile = () => { museReads++; return new Promise((resolve) => { finish = resolve; }); };
  const started = Date.now();
  const [first, second] = await Promise.all([service.tokenDetail(muse.address, 30), service.tokenDetail(muse.address, 30)]);
  assert(Date.now() - started < 1_000, "neither view waits for the hanging read");
  for (const detail of [first, second]) {
    assert.equal(detail?.state, null);
    assert.equal(detail?.nftProfile, undefined, "an unfinished read is left out, never shown empty");
  }
  assert.equal(museReads, 1, "one read for both views");
  finish({ name: "Jubilee", agentId: "42" }); await new Promise((resolve) => setImmediate(resolve));
  (service as any).museProfile = async () => ({ name: "Jubilee", agentId: "42" });
  assert.deepEqual((await service.tokenDetail(muse.address, 30))?.nftProfile, { name: "Jubilee", agentId: "42" }, "a ready read is included");
});

test("the service cache keeps the newest profile when a save or a read finishes out of order", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "token-profile-cache-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const service = new LaunchpadService({
    config: { mode: "robinhood", chainId: 4663, deploymentChainId: 4663, treasury: null, writesEnabled: false, blockReason: null },
    rpcUrl: "https://rpc.fixture.test", dataDir: directory, dataScope: "robinhood",
    launchGuardCandidate: null, firstBuyGuardCandidate: null, lifi: { integrator: "musegodfun" },
  });
  t.after(() => service.store.close());
  await service.store.saveToken(coin);
  const store = service.store as any, write = store.saveProfileSnapshot.bind(store), read = store.snapshot.bind(store);
  const now = Date.now();

  // A save whose store answer arrives after a newer save has finished.
  let releaseOlder!: () => void;
  const olderAnswer = new Promise<void>((resolve) => { releaseOlder = resolve; });
  store.saveProfileSnapshot = async (key: string, data: unknown, issuedAt: number) => {
    const wrote = write(key, data, issuedAt);
    if (issuedAt === now) await olderAnswer;
    return wrote;
  };
  const older = service.saveTokenProfile(coin.address, await signed(owner, { ...links, website: "https://older.org/" }, now));
  await new Promise((resolve) => setImmediate(resolve));
  const newer = await service.saveTokenProfile(coin.address, await signed(owner, links, now + 1));
  releaseOlder(); await older;
  assert.deepEqual(await service.tokenProfile(coin.address), newer, "the older save's late answer does not replace the newer one");

  // A read that began before a save and answers after it.
  const fresh = coin.address.replace(/1$/, "2") as Address;
  await service.store.saveToken({ ...coin, address: fresh, transactionHash: `0x${"c".repeat(64)}`, poolId: `0x${"d".repeat(64)}` });
  let releaseRead!: () => void, paused = true;
  const readAnswer = new Promise<void>((resolve) => { releaseRead = resolve; });
  store.saveProfileSnapshot = write;
  store.snapshot = async (key: string) => {
    const row = read(key);
    if (paused) { paused = false; await readAnswer; }
    return row;
  };
  const early = service.tokenProfile(fresh);
  await new Promise((resolve) => setImmediate(resolve));
  const saved = await service.saveTokenProfile(fresh, await signed(owner, links, now + 2, 4663, fresh));
  releaseRead();
  assert.deepEqual(await early, saved, "a read the save overtook answers with the save, not the replaced launch links");
  assert.deepEqual(await service.tokenProfile(fresh), saved, "and does not cache its older answer over the save");
});

test("a page view assembled across a save returns the save, whether it replaced or cleared the launch links", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "token-profile-page-save-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const service = new LaunchpadService({
    config: { mode: "robinhood", chainId: 4663, deploymentChainId: 4663, treasury: null, writesEnabled: false, blockReason: null },
    rpcUrl: "https://rpc.fixture.test", dataDir: directory, dataScope: "robinhood",
    launchGuardCandidate: null, firstBuyGuardCandidate: null, lifi: { integrator: "musegodfun" },
  });
  t.after(() => service.store.close());
  await service.store.saveToken(coin);
  const store = service.store as any, read = store.snapshot.bind(store);
  let issuedAt = Date.now();
  for (const replacement of [{ ...EMPTY_PROFILE_LINKS, website: "https://b.example.org/" }, EMPTY_PROFILE_LINKS]) {
    (service as any).profileCache.clear();
    // Two views share a paused profile read that captured the previous answer; the owner saves before it lands.
    let releaseRead!: () => void, paused = true;
    const readAnswer = new Promise<void>((resolve) => { releaseRead = resolve; });
    store.snapshot = async (key: string) => { const row = read(key); if (paused) { paused = false; await readAnswer; } return row; };
    (service as any).state = async () => { throw new Error("offline"); };
    const views = Promise.all([service.tokenDetail(coin.address, 5_000), service.tokenDetail(coin.address, 5_000)]);
    await new Promise((resolve) => setImmediate(resolve));
    const saved = await service.saveTokenProfile(coin.address, await signed(owner, replacement, ++issuedAt));
    releaseRead();
    for (const detail of await views) assert.deepEqual([detail?.profile, detail?.profileStatus], [saved, undefined], "shared read overtaken by a save");

    // A view whose profile answer arrived first, while its pool state read is still pending when the owner saves again.
    store.snapshot = read;
    let releaseState!: () => void;
    (service as any).state = () => new Promise((_resolve, reject) => { releaseState = () => reject(new Error("offline")); });
    const pending = service.tokenDetail(coin.address, 5_000);
    await new Promise((resolve) => setImmediate(resolve));
    const newer = await service.saveTokenProfile(coin.address, await signed(owner, { ...replacement, x: "https://x.com/newer_handle" }, ++issuedAt));
    releaseState();
    assert.deepEqual((await pending)?.profile, newer, "the response carries the save that finished while the view was assembled");
  }
});

test("an unknown save outcome discards pre-save answers, including reads and views overtaken by the save", async (t) => {
  for (const scenario of ["fresh", "expired", "shared read", "pending view"]) {
    const directory = mkdtempSync(join(tmpdir(), "token-profile-unknown-save-"));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const service = new LaunchpadService({
      config: { mode: "robinhood", chainId: 4663, deploymentChainId: 4663, treasury: null, writesEnabled: false, blockReason: null },
      rpcUrl: "https://rpc.fixture.test", dataDir: directory, dataScope: "robinhood",
      launchGuardCandidate: null, firstBuyGuardCandidate: null, lifi: { integrator: "musegodfun" },
    });
    t.after(() => service.store.close());
    await service.store.saveToken(coin);
    assert.equal(await service.tokenProfile(coin.address), null, "the pre-save answer permits launch link A");
    const store = service.store as any, read = store.snapshot.bind(store), write = store.saveProfileSnapshot.bind(store);
    const cache = (service as any).profileCache, key = coin.address.toLowerCase(), entry = cache.get(key);
    (service as any).state = async () => { throw new Error("offline"); };
    let releaseRead = () => {}, releaseState = () => {};
    let views: Promise<any[]> | undefined;
    let overtakenRead: Promise<void> | undefined;
    if (scenario === "shared read") {
      entry.at -= 120_000;
      let paused = true;
      const answer = new Promise<void>((resolve) => { releaseRead = resolve; });
      store.snapshot = async (key: string) => { const row = read(key); if (paused) { paused = false; await answer; } return row; };
      views = Promise.all([service.tokenDetail(coin.address, 5_000), service.tokenDetail(coin.address, 5_000)]);
      await settle();
      overtakenRead = assert.rejects(service.tokenProfile(coin.address), /could not be confirmed after a save/);
    } else if (scenario === "pending view") {
      (service as any).state = () => new Promise((_resolve, reject) => { releaseState = () => reject(new Error("offline")); });
      views = Promise.all([service.tokenDetail(coin.address, 5_000)]);
      await settle();
    }
    const replaced = { ...EMPTY_PROFILE_LINKS, website: "https://b.example.org/" };
    store.saveProfileSnapshot = (key: string, data: unknown, at: number) => { assert.equal(write(key, data, at), true); throw new Error("Write response lost"); };
    await assert.rejects(service.saveTokenProfile(coin.address, await signed(owner, replaced, Date.now())), /Write response lost/);
    assert.deepEqual(read(profileKey(coin.address)).data.links, replaced, "the write committed before its response was lost");
    store.snapshot = async () => { throw new Error("Storage unavailable"); };
    if (scenario === "expired") entry.at -= 120_000;
    releaseRead(); releaseState();
    await overtakenRead;
    const details = views ? await views : [await service.tokenDetail(coin.address, 30)];
    for (const detail of details) {
      assert.deepEqual([detail?.profile, detail?.profileStatus], [undefined, "unavailable"], scenario);
      assert.equal(displayedProfileLinks(coin, detail?.profile ?? null, detail?.profileStatus), null, `${scenario}: no launch-link fallback`);
    }
    assert.equal(cache.has(key), false, `${scenario}: an overtaken read cannot restore the old cache entry`);
    store.snapshot = read;
    (service as any).state = async () => { throw new Error("offline"); };
    const recovered = await service.tokenDetail(coin.address, 30);
    assert.deepEqual([recovered?.profile?.links, recovered?.profileStatus], [replaced, undefined], "a confirmed read recovers B");
  }
});

test("a token page never falls back to launch links the store could not confirm, and a late profile read stays within the deadline", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "token-profile-page-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const service = new LaunchpadService({
    config: { mode: "robinhood", chainId: 4663, deploymentChainId: 4663, treasury: null, writesEnabled: false, blockReason: null },
    rpcUrl: "https://rpc.fixture.test", dataDir: directory, dataScope: "robinhood",
    launchGuardCandidate: null, firstBuyGuardCandidate: null, lifi: { integrator: "musegodfun" },
  });
  t.after(() => service.store.close());
  await service.store.saveToken(coin);
  const ledger = timerLedger(t);
  (service as any).state = async () => { throw new Error("offline"); };
  const store = service.store as any, read = store.snapshot.bind(store), key = coin.address.toLowerCase();
  const failing = async () => { throw new Error("Storage unavailable"); };

  // No answer known yet: unavailable, never "absent" (which would show the launch link A).
  store.snapshot = failing;
  const cold = await service.tokenDetail(coin.address, 30);
  assert.deepEqual([cold?.profile, cold?.profileStatus, cold?.profileCheckedAt], [undefined, "unavailable", undefined]);

  // The owner replaces A with B; then the cached answer ages out and the store fails: B is served stale with its confirmation time.
  store.snapshot = read;
  const replaced = { ...EMPTY_PROFILE_LINKS, website: "https://b.example.org/" };
  const saved = await service.saveTokenProfile(coin.address, await signed(owner, replaced, Date.now()));
  (service as any).profileCache.clear();
  const definitive = await service.tokenDetail(coin.address, 30);
  assert.deepEqual([definitive?.profile, definitive?.profileStatus], [saved, undefined]);
  assert.equal(ledger.live.size, 0, "a fast profile read leaves no live deadline timer");
  const entry = (service as any).profileCache.get(key); entry.at -= 120_000;
  store.snapshot = failing;
  const stale = await service.tokenDetail(coin.address, 30);
  assert.deepEqual([stale?.profile, stale?.profileStatus, stale?.profileCheckedAt], [saved, "stale", entry.at]);

  // A store read that never settles: both views answer by the deadline and share one read; once it lands, the next view has B.
  (service as any).profileCache.clear();
  let reads = 0, finish!: () => void;
  store.snapshot = (row: string) => { reads++; return new Promise((resolve) => { finish = () => resolve(read(row)); }); };
  const started = Date.now();
  const pending = Promise.all([service.tokenDetail(coin.address, 30), service.tokenDetail(coin.address, 30)]);
  await settle();
  assert(ledger.live.size > 0, "the unfinished views have armed deadlines");
  ledger.fireAll();
  const late = await pending;
  assert(Date.now() - started < 1_000, "the page does not wait for the store's own timeout");
  assert.deepEqual(late.map((detail) => detail?.profileStatus), ["unavailable", "unavailable"]);
  assert.equal(ledger.live.size, 0, "a profile read past the page deadline leaves no live timer");
  assert.equal(reads, 1, "simultaneous views share one store read");
  finish(); await new Promise((resolve) => setImmediate(resolve));
  const filled = await service.tokenDetail(coin.address, 30);
  assert.deepEqual([filled?.profile, filled?.profileStatus], [saved, undefined], "the late read filled the cache for the next view");
  assert.equal(reads, 1);
  assert.equal(ledger.live.size, 0, "the late cache fill and its next view leave no timers");
});

test("NFT profile saves use the status gate: off flag or missing database guards refuses before owner RPC", async () => {
  const nftCoin = { ...coin, nft: { chainId: 4663 as const, contract: coin.address, tokenId: "1" } };
  for (const gate of ["off", "guards missing", "guards failed"] as const) {
    let rpc = 0;
    const store = memoryStore();
    const service = Object.assign(Object.create(LaunchpadService.prototype), {
      runtime: { config: { mode: "robinhood", deploymentChainId: 4663, nftMode: { enabled: gate !== "off" } } },
      token: async () => nftCoin, store: { ...store, nftGuardsReady: async () => { if (gate === "guards failed") throw new Error("Database unavailable"); return false; } },
      client: { readContract: async () => { rpc++; throw new Error("Owner RPC must not run"); } },
    }) as LaunchpadService;
    await assert.rejects(service.saveTokenProfile(coin.address, await signed()), refused("PROFILE_UNAVAILABLE", 409));
    await assert.rejects(service.nftStatus("4663:invalid:1", owner.address), (error: any) => error.code === "NFT_MODE_UNAVAILABLE");
    assert.equal(rpc, 0); assert.equal(store.rows.size, 0);
  }
});

test("NFT profile saves accept the current holder or delegate when NFT mode and guards are available", async () => {
  for (const delegate of [false, true]) {
    const store = memoryStore(), now = Date.now();
    const service = Object.assign(Object.create(LaunchpadService.prototype), {
      runtime: { config: { mode: "robinhood", deploymentChainId: 4663, nftMode: { enabled: true } } },
      token: async () => ({ ...coin, nft: { chainId: 4663, contract: coin.address, tokenId: "1" } }),
      store: { ...store, nftGuardsReady: async () => true }, profileCache: new Map(), profileSaves: new Map(),
      assertNetwork: async () => {},
      client: { readContract: async ({ functionName }: any) => functionName === "ownerOf" ? delegate ? stranger.address : owner.address : true },
    }) as LaunchpadService;
    const saved = await service.saveTokenProfile(coin.address, await signed(owner, links, now));
    assert.equal(saved.signer, owner.address); assert.equal(store.rows.size, 1);
  }
});

// Exercise the real editor's hooks and event handlers, keeping only wallet and HTTP at fixture boundaries.
import { hookRuntime, importFresh, settle } from "./hook-runtime";
import { observeServerTime, resetQuoteClock } from "../src/lib/quote-clock";
import { ApiError } from "../src/lib/api";
const editorNodes = (node: any): any[] => Array.isArray(node) ? node.flatMap(editorNodes) : node && typeof node === "object" ? [node, ...editorNodes(node.props?.children)] : [];
const editorText = (node: any): string => Array.isArray(node) ? node.map(editorText).join("") : node && typeof node === "object" ? editorText(node.props?.children) : String(node ?? "");
async function editorRuntime(options: { wallet?: any; post?: (...args: any[]) => Promise<any> } = {}) {
  let View: any, closed = 0;
  const saved: any[] = [], signed: any[][] = [], calls: any[][] = [];
  const wallet = { account: owner.address, chainId: 4663, connection: () => ({ chainId: 4663 }), connect: async () => {}, switchChain: async () => {},
    signProfile: async (...args: any[]) => { signed.push(args); return { signer: owner.address, signature: "0x1234" }; }, ...options.wallet };
  const runtime = hookRuntime(() => View({ token: coin, links, owner: "Only the creator can save.", onClose: () => { closed++; }, onSaved: (profile: any) => saved.push(profile) }));
  ({ default: View } = await importFresh("src/components/ProfileEditor.tsx", {
    react: { file: import.meta.resolve("react"), bindings: runtime.hooks },
    "../lib/wallet": { file: import.meta.resolve("../src/lib/wallet.tsx"), bindings: { useWallet: () => wallet } },
    "../lib/api": { file: import.meta.resolve("../src/lib/api.ts"), bindings: { chainApi: async (...args: any[]) => {
      calls.push(args); return options.post ? options.post(...args) : { links, signer: owner.address, issuedAt: args[2].issuedAt, savedAt: args[2].issuedAt };
    } } },
  }));
  const node = (predicate: (value: any) => boolean) => editorNodes(runtime.output()).find(predicate);
  const submit = () => node((value) => value.type === "form").props.onSubmit({ preventDefault() {} });
  return { ...runtime, node, submit, saved, signed, calls, wallet, closed: () => closed };
}

test("ProfileEditor switches chains, signs server time despite a skewed clock, and reports the saved profile", async (t) => {
  observeServerTime(null, NOW, 0);
  t.mock.method(Date, "now", () => NOW + 15 * 60_000);
  const switched: number[] = [];
  const runtime = await editorRuntime({ wallet: { chainId: 8453, switchChain: async (chain: number) => { switched.push(chain); } } });
  try {
    runtime.render(); assert.equal(runtime.node((node) => node.props?.role === "status").props.children, "", "status exists before signing");
    runtime.submit(); await settle();
    assert.deepEqual(switched, [4663]); assert.equal(runtime.signed.length, 1);
    const issuedAt = runtime.signed[0][3]; assert(issuedAt >= NOW && issuedAt < NOW + 5_000, String(issuedAt)); assert(Number.isInteger(issuedAt));
    assert.equal(runtime.calls[0][2].issuedAt, issuedAt); assert.equal(runtime.saved.length, 1);
  } finally { runtime.unmount(); resetQuoteClock(); }
});

test("ProfileEditor blocks duplicate submission and Escape/X while a signature is pending, then keeps wallet rejection visible", async () => {
  let refuse: (cause: unknown) => void = () => {}, signatures = 0;
  const runtime = await editorRuntime({ wallet: { signProfile: async () => { signatures++; return new Promise((_resolve, reject) => { refuse = reject; }); } } });
  try {
    runtime.render(); runtime.submit(); runtime.submit(); await settle(); assert.equal(signatures, 1);
    assert.equal(runtime.node((node) => node.props?.["aria-label"] === "Close profile editor").props.disabled, true);
    let prevented = false; runtime.output().props.onCancel({ preventDefault: () => { prevented = true; } }); assert(prevented); assert.equal(runtime.closed(), 0);
    runtime.output().props.onClose(); assert.equal(runtime.closed(), 0, "a forced close (a second Escape) reopens instead of dropping the pending save");
    assert.match(editorText(runtime.node((node) => node.props?.role === "status")), /Sign in your wallet/);
    refuse(Object.assign(new Error("User rejected"), { code: 4001 })); await settle();
    assert.match(editorText(runtime.output()), /You cancelled the wallet request/); assert.equal(runtime.calls.length, 0);
    assert.equal(runtime.node((node) => node.props?.["aria-label"] === "Close profile editor").props.disabled, false);
    runtime.output().props.onCancel({ preventDefault() { assert.fail("idle editor can close"); } }); assert.equal(runtime.closed(), 1);
  } finally { runtime.unmount(); }
});

test("ProfileEditor uses profile wording for wallet changes and actionable clock advice for expiry", async () => {
  for (const error of [new Error("The wallet has changed. Preview again."), new Error("The wallet network does not match. Switch networks and preview again."),
    new ApiError("Expired", 409, "PROFILE_EXPIRED")]) {
    const runtime = await editorRuntime({ post: async () => { throw error; } });
    try {
      runtime.render(); runtime.submit(); await settle(); assert.equal(runtime.saved.length, 0);
      assert.match(editorText(runtime.output()), error instanceof ApiError ? /device clock may be wrong; reload to sync/ : /The wallet changed. Open the editor again/);
      assert.doesNotMatch(editorText(runtime.output()), /Preview again|Sign again to save/);
    } finally { runtime.unmount(); }
  }
});

test("readNftStatus shares only in-flight requests, separates accounts and retries fresh after completion or failure", async () => {
  let reads = 0, resolve: (value: any) => void = () => {}, reject: (error: any) => void = () => {};
  const { readNftStatus } = await importFresh("src/lib/nft-client.ts", {
    "./api": { file: import.meta.resolve("../src/lib/api.ts"), bindings: { chainApi: async () => {
      reads++; return new Promise((yes, no) => { resolve = yes; reject = no; });
    } } },
  });
  const config = { mode: "robinhood", deploymentChainId: 4663 }, nft = { chainId: 4663, contract: coin.address, tokenId: "1" };
  const first = readNftStatus(config, nft, owner.address), same = readNftStatus(config, nft, owner.address.toLowerCase());
  assert.equal(first, same); assert.equal(reads, 1); resolve({ controls: true }); await first;
  const fresh = readNftStatus(config, nft, owner.address); assert.equal(reads, 2); resolve({ controls: false }); assert.equal((await fresh).controls, false);
  const failed = readNftStatus(config, nft, owner.address); reject(new Error("Status failure")); await assert.rejects(failed, /Status failure/);
  const retry = readNftStatus(config, nft, owner.address); const resolveOwner = resolve;
  const other = readNftStatus(config, nft, stranger.address); assert.equal(reads, 5); resolve({ controls: false }); resolveOwner({ controls: true }); await Promise.all([retry, other]);
});
