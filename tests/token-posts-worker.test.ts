import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { privateKeyToAccount } from "viem/accounts";
import { decodeFunctionData, encodeFunctionResult, multicall3Abi, parseAbi, type Address } from "viem";
import { Store } from "../server/store";
import type { PostCommand } from "../server/post-store";
import { postOwnerTypedData, type PostOwnerAction } from "../src/lib/token-posts";
import { syntheticToken } from "./fixtures";
import { MUSEGOD } from "../src/lib/musegod";

// Public test-only wallets and synthetic records; never read production credentials or send upstream traffic.
const owner = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
const stranger = privateKeyToAccount("0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba");
const otherToken = "0x3333333333333333333333333333333333333333" as Address;
const ownerAbi = parseAbi(["function ownerOf(uint256) view returns (address)"]);
// An actual 2 × 3 static WebP, also used by the existing token-image tests.
const webpImage = "data:image/webp;base64,UklGRh4CAABXRUJQVlA4WAoAAAAgAAAAAQAAAgAASUNDUMgBAAAAAAHIAAAAAAQwAABtbnRyUkdCIFhZWiAH4AABAAEAAAAAAABhY3NwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQAA9tYAAQAAAADTLQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAlkZXNjAAAA8AAAACRyWFlaAAABFAAAABRnWFlaAAABKAAAABRiWFlaAAABPAAAABR3dHB0AAABUAAAABRyVFJDAAABZAAAAChnVFJDAAABZAAAAChiVFJDAAABZAAAAChjcHJ0AAABjAAAADxtbHVjAAAAAAAAAAEAAAAMZW5VUwAAAAgAAAAcAHMAUgBHAEJYWVogAAAAAAAAb6IAADj1AAADkFhZWiAAAAAAAABimQAAt4UAABjaWFlaIAAAAAAAACSgAAAPhAAAts9YWVogAAAAAAAA9tYAAQAAAADTLXBhcmEAAAAAAAQAAAACZmYAAPKnAAANWQAAE9AAAApbAAAAAAAAAABtbHVjAAAAAAAAAAEAAAAMZW5VUwAAACAAAAAcAEcAbwBvAGcAbABlACAASQBuAGMALgAgADIAMAAxADZWUDggMAAAABACAJ0BKgIAAwABABwloAJ0ugH4AfgAA8gA/u+sV/7vNgDCX/F7/9pZCFdf85wAAA==";

test("real Worker Posts routes enforce signed key management, bearer scope, durable writes and machine admission", { timeout: 60_000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), "musegod-posts-worker-"));
  const stores = new Map([
    ["robinhood", new Store(join(directory, "robinhood"), 4663)],
    ["base", new Store(join(directory, "base"), 8453)],
  ]);
  const coin = syntheticToken({ mode: "robinhood", deploymentChainId: 4663, creator: owner.address, quoteAddress: MUSEGOD.weth });
  const secondCoin = { ...coin, address: otherToken, transactionHash: `0x${"c".repeat(64)}` as const };
  const nftCoin = { ...coin, address: "0x5555555555555555555555555555555555555555" as Address,
    creator: stranger.address, nft: { chainId: 4663 as const, contract: "0x6666666666666666666666666666666666666666" as Address, tokenId: "42" } };
  const baseCoin = syntheticToken({ mode: "base", deploymentChainId: 8453, creator: owner.address });
  const fixtures = new Map([["robinhood", [coin, secondCoin, nftCoin]], ["base", [baseCoin]]]);
  let nftHolder = owner.address, nftReadFails = false, nftBlock = 10_000;
  let pinataUploads = 0;
  const ownershipBlocks: string[] = [];
  const rpcRequests: unknown[] = [];
  const commands: { scope: string; command: PostCommand }[] = [];
  const bundled = await build({
    entryPoints: ["worker/index.ts"], bundle: true, write: false, format: "esm", platform: "node", target: "es2022",
    external: ["node:*", "cloudflare:*"],
    banner: { js: 'import {createRequire} from "node:module";const require=createRequire("/fixture.js");' },
  });
  const bindings = {
    CHAIN_MODE: "robinhood", NODE_ENV: "production", PLATFORM_TREASURY: "0x1111111111111111111111111111111111111111",
    SUPABASE_URL: "https://postfixture.supabase.co", SUPABASE_SECRET_KEY: "posts-worker-fixture-only",
    ALCHEMY_API_KEY: "posts-worker-fixture-only", TURNSTILE_SITE_KEY: "fixture-public", TURNSTILE_SECRET_KEY: "fixture-private",
    PINATA_JWT: "posts-worker-fixture-pinata-only",
  };
  const mf = new Miniflare(convertV4MiniflareOptions({
    modules: true, compatibilityDate: "2026-10-04", compatibilityFlags: ["nodejs_compat"],
    script: bundled.outputFiles[0].text, durableObjects: { LAUNCHPAD: { className: "LaunchpadRuntime", useSQLite: true } },
    bindings, serviceBindings: { ASSETS: async () => new Response("asset fixture") },
    outboundService: async request => {
      const url = new URL(request.url);
      if (url.hostname === "postfixture.supabase.co") {
        assert.equal(request.headers.get("apikey"), bindings.SUPABASE_SECRET_KEY);
        if (url.pathname.endsWith("musegod_post_action")) {
          const body = await request.json() as { p_scope: string; p_command: PostCommand };
          const store = stores.get(body.p_scope);
          assert(store, `Unknown test database scope ${body.p_scope}`);
          commands.push({ scope: body.p_scope, command: body.p_command });
          return Response.json(store.postAction(body.p_command));
        }
        if (url.pathname.endsWith("musegod_tokens")) {
          const scope = url.searchParams.get("scope")?.replace(/^eq\./, "") ?? "";
          const address = url.searchParams.get("address")?.replace(/^eq\./, "");
          return Response.json((fixtures.get(scope) ?? []).filter(row => !address || row.address.toLowerCase() === address.toLowerCase()).map(payload => ({ payload })));
        }
        if (url.pathname.endsWith("musegod_reserve_runtime_budget")) return Response.json({ allowed: true, retryAfter: 0 });
        if (url.pathname.endsWith("musegod_runtime_controls") || url.pathname.endsWith("musegod_snapshots")) return Response.json([]);
        throw new Error(`Unexpected database request in Posts Worker test: ${url.pathname}`);
      }
      if (url.hostname.endsWith(".g.alchemy.com")) {
        const input = await request.json() as any;
        rpcRequests.push(input);
        const reply = (body: { id: number; method: string; params: any[] }) => {
          if (body.method === "eth_chainId") return { jsonrpc: "2.0", id: body.id, result: url.hostname.startsWith("base") ? "0x2105" : "0x1237" };
          if (body.method === "eth_blockNumber") return { jsonrpc: "2.0", id: body.id, result: `0x${(++nftBlock).toString(16)}` };
          if (body.method === "eth_call") {
            assert.equal(body.params[1], `0x${nftBlock.toString(16)}`, "ownership reads bind to the freshly fetched block");
            const multicall = body.params[0].to.toLowerCase() === "0xca11bde05977b3631167028862be2a173976ca11";
            const calls = multicall ? (decodeFunctionData({ abi: multicall3Abi, data: body.params[0].data }).args as any)[0]
              : [{ target: body.params[0].to, callData: body.params[0].data }];
            for (const call of calls) {
              assert.equal(call.target.toLowerCase(), nftCoin.nft.contract.toLowerCase());
              assert.equal(decodeFunctionData({ abi: ownerAbi, data: call.callData }).functionName, "ownerOf");
            }
            ownershipBlocks.push(body.params[1]);
            const encodedOwner = encodeFunctionResult({ abi: ownerAbi, functionName: "ownerOf", result: nftHolder });
            return nftReadFails ? { jsonrpc: "2.0", id: body.id, error: { code: -32603, message: "fixture ownership RPC unavailable" } }
              : { jsonrpc: "2.0", id: body.id, result: multicall ? encodeFunctionResult({ abi: multicall3Abi, functionName: "aggregate3", result: calls.map(() => ({ success: true, returnData: encodedOwner })) }) : encodedOwner };
          }
          // A foreign EIP-712 domain is not rescued by the contract-wallet fallback.
          assert.equal(body.method, "eth_getCode");
          return { jsonrpc: "2.0", id: body.id, result: "0x" };
        };
        return Response.json(Array.isArray(input) ? input.map(reply) : reply(input));
      }
      if (url.hostname === "uploads.pinata.cloud" && url.pathname === "/v3/files") {
        assert.equal(request.headers.get("authorization"), `Bearer ${bindings.PINATA_JWT}`);
        const form = await request.formData(), file = form.get("file");
        assert(file && typeof file === "object");
        assert.equal(file.type, "image/webp");
        assert.equal(Buffer.from(await file.arrayBuffer()).toString("base64"), webpImage.split(",")[1]);
        pinataUploads++;
        return Response.json({ data: { cid: "bafkreiexg36mudbth2ete6lyz5pqfejop3k3fgbtlpt6izcka3yraykb6e" } });
      }
      throw new Error(`Real upstream forbidden in Posts Worker test: ${url.hostname}`);
    },
  }));
  const root = `/api/chains/4663/tokens/${coin.address}`;
  const json = async (path: string, options: { body?: unknown; key?: string; idempotency?: string; ip?: string; raw?: string } = {}) => {
    const response = await mf.dispatchFetch(`https://musegod.fun${path}`, {
      method: options.body === undefined && options.raw === undefined ? "GET" : "POST",
      headers: {
        "cf-connecting-ip": options.ip ?? "192.0.2.161",
        ...(options.body === undefined && options.raw === undefined ? {} : { "content-type": "application/json" }),
        ...(options.key ? { authorization: `Bearer ${options.key}` } : {}),
        ...(options.idempotency ? { "idempotency-key": options.idempotency } : {}),
      },
      ...(options.body === undefined && options.raw === undefined ? {} : { body: options.raw ?? JSON.stringify(options.body) }),
    });
    const body = await response.json() as any;
    return { status: response.status, body, headers: response.headers };
  };
  const signed = async (action: PostOwnerAction, id = "", name = "", chain = 4663, token = coin.address, account = owner) => {
    const issuedAt = Date.now();
    return { ...(action === "create-key" ? { keyId: id, name } : {}), issuedAt, signer: account.address,
      signature: await account.signTypedData(postOwnerTypedData(chain, token, action, id, name, issuedAt)) };
  };
  try {
    const empty = await json(`${root}/posts`);
    assert.equal(empty.status, 200, JSON.stringify(empty.body));
    assert.deepEqual(empty.body, { items: [], nextCursor: null });
    const id = randomUUID();
    const creation = await signed("create-key", id, "Fixture agent");
    const created = await json(`${root}/post-api-keys`, { body: creation });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(created.body.key.id, id);
    assert.equal(typeof created.body.apiKey, "string");
    const apiKey = created.body.apiKey as string;
    assert(apiKey.length >= 43, "a key includes at least 256 random bits");
    assert.equal("hash" in created.body.key, false);
    assert.equal(created.headers.get("cache-control"), "no-store");
    const replay = await json(`${root}/post-api-keys`, { body: creation });
    assert.equal(replay.status, 409, "a captured creation signature cannot yield another credential");
    assert.equal("apiKey" in replay.body, false);

    const listed = await json(`${root}/post-api-keys/list`, { body: await signed("list-keys") });
    assert.equal(listed.status, 200, JSON.stringify(listed.body));
    const keys = Array.isArray(listed.body) ? listed.body : listed.body.keys;
    assert.equal(keys.length, 1);
    assert.equal(keys[0].id, id);
    assert.equal(JSON.stringify(listed.body).includes(apiKey), false, "later management reads never reveal the credential");
    assert.equal("hash" in keys[0], false);

    const invalid = await json(`${root}/posts`, { body: { text: "Rejected" }, key: "mgpost_invalid", idempotency: "invalid-credential" });
    assert.equal(invalid.status, 401, JSON.stringify(invalid.body));
    const foreignToken = await json(`/api/chains/4663/tokens/${otherToken}/posts`, { body: { text: "Rejected" }, key: apiKey, idempotency: "foreign-token" });
    assert.equal(foreignToken.status, 401, JSON.stringify(foreignToken.body));
    const foreignChain = await json(`/api/chains/8453/tokens/${coin.address}/posts`, { body: { text: "Rejected" }, key: apiKey, idempotency: "foreign-chain" });
    assert.equal(foreignChain.status, 401, JSON.stringify(foreignChain.body));
    const wrongDomain = await json(`${root}/post-api-keys/list`, { body: await signed("list-keys", "", "", 8453) });
    assert.equal(wrongDomain.status, 401, JSON.stringify(wrongDomain.body));

    const badImage = await json(`${root}/posts/images`, { body: { image: "data:image/webp;base64,AAAA" }, key: apiKey });
    assert.equal(badImage.status, 400, JSON.stringify(badImage.body));
    assert.equal(pinataUploads, 0, "invalid image bytes never reach the simulated Pinata service");
    const image = await json(`${root}/posts/images`, { body: { image: webpImage }, key: apiKey });
    assert.equal(image.status, 200, JSON.stringify(image.body));
    assert.match(image.body.id, /^[0-9a-f]{64}$/);
    const repeatedImage = await json(`${root}/posts/images`, { body: { image: webpImage }, key: apiKey });
    assert.deepEqual(repeatedImage.body, image.body);
    assert.equal(pinataUploads, 1, "the durable media record deduplicates the second upload");

    const input = { text: "A real Worker route; synthetic database and wallet. https://musegod.fun/", imageIds: [image.body.id], videoUrl: "https://www.youtube.com/watch?v=fixture" };
    const post = await json(`${root}/posts`, { body: input, key: apiKey, idempotency: "first-fixture-post" });
    assert.equal(post.status, 201, JSON.stringify(post.body));
    assert.equal(post.body.post.text, input.text);
    assert.deepEqual(post.body.post.images, [image.body]);
    const postId = post.body.post.id as string;
    const repeat = await json(`${root}/posts`, { body: input, key: apiKey, idempotency: "first-fixture-post" });
    assert.equal(repeat.status, 200, JSON.stringify(repeat.body));
    assert.equal(repeat.body.duplicate, true);
    assert.equal(repeat.body.post.id, postId);
    const conflict = await json(`${root}/posts`, { body: { ...input, text: "Changed content" }, key: apiKey, idempotency: "first-fixture-post" });
    assert.equal(conflict.status, 409);
    const page = await json(`${root}/posts?limit=1`);
    assert.equal(page.status, 200);
    assert.equal(page.body.items[0].id, postId);
    assert.deepEqual((await json(`/api/chains/8453/tokens/${coin.address}/posts`)).body.items, []);

    const deleted = await json(`${root}/posts/${postId}/delete`, { body: {}, key: apiKey });
    assert.equal(deleted.status, 200, JSON.stringify(deleted.body));
    assert.deepEqual((await json(`${root}/posts`)).body.items, []);
    const deletedReplay = await json(`${root}/posts`, { body: input, key: apiKey, idempotency: "first-fixture-post" });
    assert.equal(deletedReplay.status, 200, "a duplicate of a deleted post reports the tombstone");
    assert.deepEqual(deletedReplay.body, { post: { id: postId, deleted: true }, duplicate: true });
    assert.deepEqual((await json(`${root}/posts`)).body.items, [], "the deleted Post is never republished");

    const oversized = await json(`${root}/posts`, { raw: "x".repeat(65_537), key: apiKey, ip: "192.0.2.162" });
    assert.equal(oversized.status, 413, "the real Worker ingress enforces the standard 64 KiB bound");

    let limited = false;
    for (let i = 0; i < 18; i++) {
      const result = await json(`${root}/posts`, { body: { text: `Machine post ${i}` }, key: apiKey, idempotency: `machine-post-${i}`, ip: "192.0.2.163" });
      assert.notEqual(result.body.code, "CHALLENGE_REQUIRED", "valid machines never need a browser challenge, including the seventeenth request");
      assert.notEqual(result.status, 403, JSON.stringify(result.body));
      assert([201, 429].includes(result.status), JSON.stringify(result));
      limited ||= result.status === 429;
    }
    assert(limited, "durable token/key quotas still constrain the valid agent");
    const revoked = await json(`${root}/post-api-keys/${id}/revoke`, { body: await signed("revoke-key", id), ip: "192.0.2.164" });
    assert.equal(revoked.status, 200, JSON.stringify(revoked.body));
    const afterRevocation = await json(`${root}/posts`, { body: { text: "Rejected after revoke" }, key: apiKey, idempotency: "after-revoke", ip: "192.0.2.164" });
    assert.equal(afterRevocation.status, 401, JSON.stringify(afterRevocation.body));

    const nftRoot = `/api/chains/4663/tokens/${nftCoin.address}`;
    const nftKeyId = randomUUID();
    const creatorRefused = await json(`${nftRoot}/post-api-keys`, {
      body: await signed("create-key", randomUUID(), "Not the holder", 4663, nftCoin.address, stranger), ip: "192.0.2.165",
    });
    assert.equal(creatorRefused.status, 403, `the recorded NFT launch creator is not a holder authorization: ${JSON.stringify({ body: creatorRefused.body, rpcRequests })}`);
    const nftCreated = await json(`${nftRoot}/post-api-keys`, {
      body: await signed("create-key", nftKeyId, "Holder agent", 4663, nftCoin.address), ip: "192.0.2.165",
    });
    assert.equal(nftCreated.status, 201, JSON.stringify(nftCreated.body));
    const nftApiKey = nftCreated.body.apiKey as string;
    nftReadFails = true;
    const uncertain = await json(`${nftRoot}/posts`, { body: { text: "Hold for verification" }, key: nftApiKey, idempotency: "nft-uncertain", ip: "192.0.2.165" });
    assert.equal(uncertain.status, 503, JSON.stringify(uncertain.body));
    assert.equal(stores.get("robinhood")!.postAction({ action: "keyGet", token: nftCoin.address.toLowerCase(), id: nftKeyId }).key!.revokedAt, null,
      "an RPC failure never turns unknown ownership into permanent revocation");
    nftReadFails = false;
    const recovered = await json(`${nftRoot}/posts`, { body: { text: "Hold for verification" }, key: nftApiKey, idempotency: "nft-uncertain", ip: "192.0.2.165" });
    assert.equal(recovered.status, 201, JSON.stringify(recovered.body));
    nftHolder = stranger.address;
    const lost = await json(`${nftRoot}/posts`, { body: { text: "Old holder is refused" }, key: nftApiKey, idempotency: "nft-transferred", ip: "192.0.2.165" });
    assert.equal(lost.status, 403, JSON.stringify(lost.body));
    assert.equal(lost.body.code, "POST_KEY_OWNER_CHANGED");
    nftHolder = owner.address;
    const transferredBack = await json(`${nftRoot}/posts`, { body: { text: "The revoked key stays revoked" }, key: nftApiKey, idempotency: "nft-returned", ip: "192.0.2.165" });
    assert.equal(transferredBack.status, 401, JSON.stringify(transferredBack.body));
    assert(ownershipBlocks.length >= 5);
    assert.equal(new Set(ownershipBlocks).size, ownershipBlocks.length, "each NFT authorization uses a fresh block instead of a cached holder");
    assert(commands.some(row => row.scope === "robinhood" && row.command.action === "postCreate"));
    assert(commands.some(row => row.scope === "base" && row.command.action === "keyGet"), "chain isolation reaches a separate real runtime/storage scope");
  } finally {
    await mf.dispose();
    for (const store of stores.values()) store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
