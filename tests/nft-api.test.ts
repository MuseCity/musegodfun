import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { getAddress, keccak256, pad, type Address, type Hex } from "viem";
import { ROBINHOOD_STOCKS, type RuntimeConfig, type TokenRecord } from "../src/lib/config";
import { MUSES, NFT_VAULT_MANIFEST, TOKENBOUND_V3_IMPLEMENTATION, treasuryFor, vaultFor, type NftRef, type NftVaultManifest } from "../src/lib/nft-mode";
import { ERC1967_IMPLEMENTATION_SLOT } from "../src/lib/nft-treasury";
import { createApp, createDualChainApp, knownPage, setHiddenTokens } from "../server/app";
import { ingressClass } from "../server/abuse";
import { runtimeFromEnv } from "../server/config";
import { LaunchpadService } from "../server/service";
import committedHideList from "../src/lib/hidden-tokens.json";
import { syntheticToken } from "./fixtures";

const weth = ROBINHOOD_STOCKS.find((asset) => asset.symbol === "WETH")!;
const musegod = ROBINHOOD_STOCKS.find((asset) => asset.symbol === "MUSEGOD")!;
const nftOf = (tokenId: string, contract: Address = MUSES.contract): NftRef => ({ chainId: 4663, contract, tokenId });
const address = (n: number) => getAddress(`0x${n.toString(16).padStart(40, "a")}`);
const coin = (n: number, over: Partial<TokenRecord> = {}): TokenRecord => syntheticToken({ address: address(n), name: `Coin ${n}`, symbol: `C${n}`,
  mode: "fork", deploymentChainId: 4663, quoteAddress: weth.address, createdAt: 1_800_000_000_000 + n,
  transactionHash: `0x${n.toString(16).padStart(64, "b")}`, poolId: `0x${n.toString(16).padStart(64, "a")}`, ...over });
const verified = { status: "verified" as const }, unverified = { status: "unverified" as const }, rejected = { status: "rejected" as const, reason: "fee" };
const symbols = (rows: { symbol: string }[]) => rows.map((row) => row.symbol).sort();
const noHidden = { "4663": [], "8453": [] };

// ---- HTTP: catalog, ?nft= filter, hide list, page route ----------------------------------------
// NFT mode is on unless `nftMode: false`: these surfaces are dark while it is off.
async function httpFixture(run: (entry: ReturnType<typeof createApp>, origin: string) => Promise<void>, configurePages?: (app: express.Express) => void,
  { nftMode = true, chainScoped = false } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "nft-api-"));
  const runtime = runtimeFromEnv(4663, { NODE_ENV: "test", CHAIN_MODE: "fork", FORK_CHAIN_ID: "4663", DATA_DIR: directory,
    PLATFORM_TREASURY: "0x2222222222222222222222222222222222222222", ...(nftMode ? { NFT_MODE_ENABLED: "true" } : {}) });
  const dual = chainScoped ? createDualChainApp(configurePages, "loopback", [runtime]) : null;
  const entry = dual ? { app: dual.app, service: dual.services.get(4663)! } : createApp(configurePages, "loopback", runtime);
  const server = entry.app.listen(0, "127.0.0.1"); await once(server, "listening");
  const bound = server.address(); assert(bound && typeof bound !== "string");
  try { await run(entry, `http://127.0.0.1:${bound.port}`); }
  finally {
    setHiddenTokens(noHidden);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    entry.service.store.close(); rmSync(directory, { recursive: true, force: true });
  }
}
const get = (origin: string, path: string) => fetch(origin + path);
// One verified coin, one rejected coin, one normal coin and one verified coin the operator hid.
const catalog = () => {
  const hiddenAddress = getAddress("0xabcdef0000000000000000000000000000000001");
  return { hiddenAddress, rows: [
    coin(1, { nft: nftOf("1"), nftVerification: verified }),
    coin(2, { nft: nftOf("1"), nftVerification: rejected }),
    coin(3),
    coin(4, { address: hiddenAddress, nft: nftOf("1"), nftVerification: verified }),
  ] };
};

test("?nft=any lists verified bound coins only: not rejected, not normal, not hidden, with open CORS", async () => {
  await httpFixture(async ({ service }, origin) => {
    const { hiddenAddress, rows } = catalog();
    // The operator list is lower-case; records carry checksummed addresses.
    setHiddenTokens({ "4663": [hiddenAddress.toLowerCase()], "8453": [] });
    service.tokens = async () => structuredClone(rows);
    const response = await get(origin, "/api/tokens?nft=any");
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("access-control-allow-origin"), "*");
    assert.deepEqual((await response.json()).map((row: TokenRecord) => row.symbol), ["C1"]);
  });
});

test("?nft=<chain>:<contract>:<id> keeps verified, unverified and status-less coins of exactly that NFT", async () => {
  await httpFixture(async ({ service }, origin) => {
    const { hiddenAddress, rows } = catalog();
    setHiddenTokens({ "4663": [hiddenAddress], "8453": [] });
    const other = "0x1111111111111111111111111111111111111111" as Address;
    service.tokens = async () => structuredClone([...rows,
      coin(5, { nft: nftOf("1"), nftVerification: unverified }),
      coin(6, { nft: nftOf("1") }), // registered by a build that predates verification: counts as unverified
      coin(7, { nft: nftOf("2"), nftVerification: verified }),
      coin(8, { nft: nftOf("1", other), nftVerification: verified }),
      coin(9, { nft: { ...nftOf("1"), chainId: 8453 }, nftVerification: verified })]);
    for (const contract of [MUSES.contract, MUSES.contract.toLowerCase()]) {
      const response = await get(origin, `/api/tokens?nft=4663:${contract}:1`);
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("access-control-allow-origin"), "*");
      assert.deepEqual(symbols(await response.json()), ["C1", "C5", "C6"]);
    }
    assert.deepEqual(symbols(await (await get(origin, `/api/tokens?nft=4663:${other}:1`)).json()), ["C8"]);
    assert.deepEqual(symbols(await (await get(origin, `/api/tokens?nft=any`)).json()), ["C1", "C5", "C6", "C7", "C8", "C9"]);
    assert.deepEqual(await (await get(origin, `/api/tokens?nft=4663:${MUSES.contract}:3`)).json(), []);
  });
});

test("plain /tokens keeps every coin and marks only the hidden one; stored records never gain the flag", async () => {
  await httpFixture(async ({ service }, origin) => {
    const { hiddenAddress, rows } = catalog();
    // The same address listed under another chain does not hide this chain's coin.
    setHiddenTokens({ "4663": [hiddenAddress.toLowerCase()], "8453": [rows[0].address] });
    service.tokens = async () => rows;
    const response = await get(origin, "/api/tokens");
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("access-control-allow-origin"), null, "only the ?nft= filter is public cross-origin");
    const listed: TokenRecord[] = await response.json();
    assert.deepEqual(listed.map((row) => row.symbol), ["C1", "C2", "C3", "C4"]);
    assert.deepEqual(listed.filter((row) => row.hidden).map((row) => row.symbol), ["C4"]);
    assert.equal(listed[3].hidden, true);
    assert(rows.every((row) => !("hidden" in row)), "the response is a copy; the service's records are untouched");
  });
});

test("cursor pages and token detail carry the hidden flag too", async () => {
  await httpFixture(async ({ service }, origin) => {
    const { hiddenAddress, rows } = catalog();
    setHiddenTokens({ "4663": [hiddenAddress], "8453": [] });
    // The database holds one verified coin per NFT, so the stored hidden coin is bound to another Muse.
    for (const row of [rows[0], { ...rows[3], nft: nftOf("2") }]) await service.store.saveToken(row);
    const page = await (await get(origin, "/api/tokens?limit=10")).json();
    assert.deepEqual(page.items.map((row: TokenRecord) => [row.symbol, row.hidden]).sort(), [["C1", undefined], ["C4", true]]);
    service.tokenDetail = async (token) => ({ token: rows.find((row) => row.address === token)!, state: null });
    const hiddenDetail = await (await get(origin, `/api/tokens/${hiddenAddress}`)).json();
    assert.equal(hiddenDetail.token.hidden, true);
    assert.equal(hiddenDetail.token.symbol, "C4");
    const plainDetail = await (await get(origin, `/api/tokens/${rows[0].address}`)).json();
    assert.equal(plainDetail.token.symbol, "C1");
    assert.equal("hidden" in plainDetail.token, false);
  });
});

test("a malformed ?nft= is a 400 on both endpoints; the parser is strict about every part", async () => {
  await httpFixture(async ({ service }, origin) => {
    service.tokens = async () => [];
    const contract = MUSES.contract;
    const bad = [`4663:${contract}:007`, `4663:${contract}:`, `4663:${contract}`, `4663:${contract}:1:2`, `4663:0x1234:1`, `1:${contract}:1`,
      `4663.0:${contract}:1`, `0x1237:${contract}:1`, `04663:${contract}:1`, `4663:${contract}:1.0`, `4663:${contract}:-1`, `4663:${contract}:1e3`,
      `4663:${contract}:${2n ** 256n}`, "ANY", "garbage", "", "any:1"];
    for (const value of bad) {
      for (const path of ["/api/tokens", "/api/nft-treasury"]) {
        const response = await get(origin, `${path}?nft=${encodeURIComponent(value)}`);
        assert.equal(response.status, 400, `${path} nft=${value}`);
        if (path === "/api/tokens") assert.equal(response.headers.get("access-control-allow-origin"), "*", "a cross-origin caller can read the error");
      }
    }
    for (const query of ["nft=any&nft=any", `nft=4663:${contract}:1&nft=4663:${contract}:2`])
      assert.equal((await get(origin, `/api/tokens?${query}`)).status, 400, query);
    assert.equal((await get(origin, `/api/tokens?nft=any`)).status, 200);
  });
});

test("/api/chains/:id/tokens?nft= reaches the selected chain and answers cross-origin", async () => {
  const directory = mkdtempSync(join(tmpdir(), "nft-api-dual-"));
  const runtime = runtimeFromEnv(4663, { NODE_ENV: "test", CHAIN_MODE: "fork", FORK_CHAIN_ID: "4663", DATA_DIR: directory,
    PLATFORM_TREASURY: "0x2222222222222222222222222222222222222222", NFT_MODE_ENABLED: "true" });
  const { app, services } = createDualChainApp(undefined, "loopback", [runtime]);
  const service = services.get(4663)!;
  service.tokens = async () => structuredClone(catalog().rows);
  const server = app.listen(0, "127.0.0.1"); await once(server, "listening");
  const bound = server.address(); assert(bound && typeof bound !== "string");
  try {
    const response = await get(`http://127.0.0.1:${bound.port}`, `/api/chains/4663/tokens?nft=4663:${MUSES.contract}:1`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("access-control-allow-origin"), "*");
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.deepEqual((await response.json()).map((row: TokenRecord) => row.symbol), ["C1", "C4"]);
    assert.equal((await get(`http://127.0.0.1:${bound.port}`, `/api/chains/4663/nft-treasury?nft=any`)).status, 400);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    for (const item of services.values()) item.store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("/nft/:chain/:contract/:id is a known SPA page; leading zeros and unknown chains are not", async () => {
  const contract = MUSES.contract;
  assert.equal(knownPage(`/nft/robinhood/${contract}/1`), true);
  assert.equal(knownPage(`/nft/base/${contract.toLowerCase()}/0`), true);
  assert.equal(knownPage(`/nft/base/${contract}/${"9".repeat(78)}`), true);
  for (const path of [`/nft/robinhood/${contract}/007`, `/nft/robinhood/${contract}/`, `/nft/robinhood/${contract}`, `/nft/ethereum/${contract}/1`,
    `/nft/${contract}/1`, `/nft/robinhood/0x1234/1`, `/nft/robinhood/${contract}/1/extra`, `/nft/robinhood/${contract}/1x`, `/nft/`, `/nft`])
    assert.equal(knownPage(path), false, path);
  // Mirrors server/index.ts: every unknown path gets the SPA shell with a 404, a known page with a 200.
  await httpFixture(async (_entry, origin) => {
    const page = await get(origin, `/nft/robinhood/${contract}/1`);
    assert.equal(page.status, 200);
    assert.match(page.headers.get("content-type") ?? "", /text\/html/);
    assert.match(await page.text(), /<div id="root">/);
    assert.equal((await get(origin, `/nft/robinhood/${contract}/007`)).status, 404);
  }, (app) => app.get("/{*path}", (req, res) => { res.status(knownPage(req.path) ? 200 : 404).type("html").send('<!doctype html><div id="root"></div>'); }));
});

test("the treasury endpoint is a read-class API and refuses an unavailable factory or another chain with a 422 code", async () => {
  assert.equal(ingressClass("/api/chains/4663/nft-treasury?nft=any"), "read");
  assert.equal(ingressClass("/api/nft-treasury"), "read");
  await httpFixture(async (_entry, origin) => {
    const noFactory = await get(origin, `/api/nft-treasury?nft=4663:${MUSES.contract}:1`);
    assert.equal(noFactory.status, 422, "the committed manifest has no deployed factory yet");
    assert.equal((await noFactory.json()).code, "NFT_VAULT_UNAVAILABLE");
    const wrongChain = await get(origin, `/api/nft-treasury?nft=8453:${MUSES.contract}:1`);
    assert.equal(wrongChain.status, 422);
    assert.equal((await wrongChain.json()).code, "NFT_CHAIN_UNSUPPORTED");
    assert.equal((await get(origin, "/api/nft-treasury")).status, 400, "the NFT is required");
    assert.equal((await get(origin, "/api/nft-treasury?nft=any")).status, 400, "any is only a catalog filter");
  });
});

test("while NFT mode is off, nft-status and nft-treasury answer 422 NFT_MODE_UNAVAILABLE before any read; the ?nft= listing stays empty", async () => {
  await httpFixture(async ({ service }, origin) => {
    let reads = 0, catalogReads = 0;
    (service as unknown as { client: unknown }).client = new Proxy({}, { get: () => { reads++; throw new Error("no chain reads expected"); } });
    const catalog = service.tokens.bind(service);
    service.tokens = async () => { catalogReads++; return catalog(); };
    service.store.verifiedNftCoin = () => { reads++; throw new Error("no database reads expected"); };
    const account = "0x1111111111111111111111111111111111111111";
    for (const path of [`/api/nft-treasury?nft=4663:${MUSES.contract}:1`, `/api/nft-status?nft=4663:${MUSES.contract}:1&account=${account}`,
      "/api/nft-treasury?nft=garbage", "/api/nft-status",
      "/api/nft-collections?owner=0x1111111111111111111111111111111111111111",
      `/api/nft-tokens?owner=0x1111111111111111111111111111111111111111&contract=${MUSES.contract}`]) {
      const response = await get(origin, path);
      assert.equal(response.status, 422, path);
      assert.deepEqual(await response.json(), { error: "NFT mode is not available on this network.", code: "NFT_MODE_UNAVAILABLE" }, path);
    }
    assert.equal(reads, 0, "no RPC or database read while dark");
    assert.equal(catalogReads, 0, "not even the catalog");
    const listing = await get(origin, "/api/tokens?nft=any");
    assert.equal(listing.status, 200);
    assert.deepEqual(await listing.json(), [], "the public listing stays, empty and harmless");
  }, undefined, { nftMode: false });
  // The chain-scoped routes the page uses are dark too.
  const directory = mkdtempSync(join(tmpdir(), "nft-api-dark-"));
  const runtime = runtimeFromEnv(4663, { NODE_ENV: "test", CHAIN_MODE: "fork", FORK_CHAIN_ID: "4663", DATA_DIR: directory,
    PLATFORM_TREASURY: "0x2222222222222222222222222222222222222222" });
  const { app, services } = createDualChainApp(undefined, "loopback", [runtime]);
  const server = app.listen(0, "127.0.0.1"); await once(server, "listening");
  const bound = server.address(); assert(bound && typeof bound !== "string");
  try {
    for (const path of [`/api/chains/4663/nft-treasury?nft=4663:${MUSES.contract}:1`,
      `/api/chains/4663/nft-status?nft=4663:${MUSES.contract}:1&account=0x1111111111111111111111111111111111111111`]) {
      const response = await get(`http://127.0.0.1:${bound.port}`, path);
      assert.equal(response.status, 422, path);
      assert.equal((await response.json()).code, "NFT_MODE_UNAVAILABLE", path);
    }
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    for (const item of services.values()) item.store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("nftTreasury and nftStatus refuse with NFT_MODE_UNAVAILABLE before parsing or reading while the flag is off", async () => {
  const { service, calls } = treasuryFixture([coin(71, { nft: nftOf("1"), nftVerification: verified })]);
  (service as unknown as { runtime: { config: RuntimeConfig } }).runtime.config.nftMode!.enabled = false;
  let catalogReads = 0;
  service.tokens = async () => { catalogReads++; return []; };
  assert.equal(await rejectionCode(() => service.nftTreasury(`4663:${MUSES.contract}:1`)), "NFT_MODE_UNAVAILABLE");
  assert.equal(await rejectionCode(() => service.nftTreasury("garbage")), "NFT_MODE_UNAVAILABLE");
  assert.equal(await rejectionCode(() => service.nftStatus(`4663:${MUSES.contract}:1`, "0x1111111111111111111111111111111111111111")), "NFT_MODE_UNAVAILABLE");
  assert.deepEqual([calls.codes, calls.multicalls, calls.fees, catalogReads], [[], [], [], 0]);
  (service as unknown as { runtime: { config: RuntimeConfig } }).runtime.config.nftMode = undefined;
  assert.equal(await rejectionCode(() => service.nftTreasury(`4663:${MUSES.contract}:1`)), "NFT_MODE_UNAVAILABLE", "a runtime without nftMode is dark too");
});

test("the treasury endpoint passes the raw query to the service and serializes bigint amounts", async () => {
  await httpFixture(async ({ service }, origin) => {
    const received: unknown[] = [];
    service.nftTreasury = async (raw) => { received.push(raw); return { nft: nftOf("1"), balances: [{ amount: 10n ** 30n }] } as never; };
    const response = await get(origin, `/api/nft-treasury?nft=4663:${MUSES.contract}:1`);
    assert.equal(response.status, 200);
    assert.deepEqual(received, [`4663:${MUSES.contract}:1`]);
    assert.equal((await response.json()).balances[0].amount, (10n ** 30n).toString());
  });
});

// ---- service: nftTreasury ---------------------------------------------------------------
const factory = getAddress("0x00000000000000000000000000000000000fac70");
const factoryCode = "0x60016001556000" as Hex;
const deployedManifest: NftVaultManifest = { ...NFT_VAULT_MANIFEST, chains: { ...NFT_VAULT_MANIFEST.chains,
  "4663": { status: "deployed_verified", factory, factoryRuntimeHash: keccak256(factoryCode), transactionHash: `0x${"11".repeat(32)}`, blockNumber: 1 } } };
const runtimeConfig = (vaultFactory: Address | null): RuntimeConfig => ({ mode: "robinhood", chainId: 4663, deploymentChainId: 4663, treasury: null, writesEnabled: false,
  blockReason: null, nftMode: { enabled: true, vaultFactory, launchFeeUsd: 10, freeCollections: [], verifiedCollections: [] } });
const derived = (nft: NftRef) => ({ vault: vaultFor(nft, factory, deployedManifest.vaultInitCodeHash), treasury: treasuryFor(nft) });

// `initialized`: accounts whose ERC-1967 implementation slot holds Tokenbound V3 (an active treasury); any other account reads zero there.
function treasuryFixture(rows: TokenRecord[], over: { factory?: Address | null; deployed?: Address[]; initialized?: Address[] } = {}) {
  const calls = { codes: [] as string[], multicalls: [] as { address: Address; functionName: string; args: Address[] }[][], fees: [] as [Address, Address][],
    slots: [] as [Address, Hex][] };
  const initialized = new Set((over.initialized ?? []).map((a) => a.toLowerCase()));
  // Mutable faults: the whole multicall, single reads by their index in the multicall, and fee previews by coin address (lower-case).
  const state = { failMulticall: false, failReads: new Set<number>(), failFees: new Set<string>() };
  const deployed = new Set((over.deployed ?? []).map((a) => a.toLowerCase()));
  const service = Object.assign(Object.create(LaunchpadService.prototype), {
    runtime: { config: runtimeConfig(over.factory === undefined ? factory : over.factory), nftVaultManifest: deployedManifest },
    assertNetwork: async () => {},
    store: { nftGuardsReady: async () => true }, // the database's single-use guards are in place
    tokens: async () => structuredClone(rows),
    client: {
      getCode: async ({ address: target }: { address: Address }) => { calls.codes.push(target); return target === factory ? factoryCode : deployed.has(target.toLowerCase()) ? "0x6001" : "0x"; },
      getStorageAt: async ({ address: target, slot }: { address: Address; slot: Hex }) => {
        calls.slots.push([target, slot]);
        return initialized.has(target.toLowerCase()) ? pad(TOKENBOUND_V3_IMPLEMENTATION, { size: 32 }) : pad("0x00", { size: 32 });
      },
      multicall: async ({ contracts }: { contracts: { address: Address; functionName: string; args: Address[] }[] }) => {
        calls.multicalls.push(contracts);
        if (state.failMulticall) throw new Error("rpc down");
        // Distinct, checkable amounts: (the contract's index + 1) * 1e18.
        return contracts.map((_, index) => state.failReads.has(index) ? { status: "failure", error: new Error("reverted") } : { status: "success", result: BigInt(index + 1) * 10n ** 18n });
      },
    },
    fees: async (token: Address, account: Address) => {
      calls.fees.push([token, account]);
      if (state.failFees.has(token.toLowerCase())) throw new Error("pool read failed at https://rpc.example/v2/secret-key");
      return { lp: { fees0: 1n, fees1: 2n }, trade: { fees0: 3n, fees1: 4n }, poolKey: { hooks: account } };
    },
  }) as LaunchpadService;
  return { service, calls, state };
}
const rejectionCode = async (run: () => Promise<unknown>) => { try { await run(); return "resolved"; } catch (e) { return (e as { code?: string }).code ?? `other:${(e as Error).message}`; } };

test("nftTreasury derives both addresses, reads their code and the bound coins' balances in one multicall, and previews fees for the vault", async () => {
  const nft = nftOf("101"), { vault, treasury } = derived(nft);
  const a = coin(11, { nft, nftVerification: verified }), b = coin(12, { nft, nftVerification: unverified, quoteAddress: musegod.address });
  const c = coin(13, { nft, nftVerification: rejected });
  const rows = [a, b, c, coin(14, { nft: nftOf("102"), nftVerification: verified }), coin(15),
    coin(16, { nft, nftVerification: verified, quoteAddress: weth.address, symbol: "SIXTEEN" })];
  const { service, calls } = treasuryFixture(rows, { deployed: [vault] });
  const view = await service.nftTreasury(`4663:${MUSES.contract.toLowerCase()}:101`);
  assert.deepEqual(view.nft, nft, "the NFT is normalized to the checksummed contract");
  assert.deepEqual({ vault: view.vault, vaultDeployed: view.vaultDeployed, treasury: view.treasury, treasuryDeployed: view.treasuryDeployed },
    { vault, vaultDeployed: true, treasury, treasuryDeployed: false });
  // Every coin bound to this NFT, whatever its status (a rejected coin still pays the vault; other NFTs and normal coins are excluded),
  // then each distinct paired asset once.
  const bound = [a, b, c, rows[5]];
  assert.deepEqual(view.coins, bound.map((row) => ({ token: row.address, symbol: row.symbol, poolId: row.poolId, quoteAddress: row.quoteAddress })),
    "the sweep set: each bound coin's pool and assets");
  assert.equal(calls.multicalls.length, 1, "exactly one multicall");
  const assets = [a.address, b.address, c.address, rows[5].address, weth.address, musegod.address];
  assert.deepEqual(calls.multicalls[0].map((call) => [call.address, call.functionName, call.args[0]]),
    assets.flatMap((asset) => [[asset, "balanceOf", treasury], [asset, "balanceOf", vault]]));
  assert.deepEqual(view.balances.map((row) => [row.token, row.symbol, row.amount, row.vaultAmount]), [
    [a.address, "C11", String(1n * 10n ** 18n), String(2n * 10n ** 18n)],
    [b.address, "C12", String(3n * 10n ** 18n), String(4n * 10n ** 18n)],
    [c.address, "C13", String(5n * 10n ** 18n), String(6n * 10n ** 18n)],
    [rows[5].address, "SIXTEEN", String(7n * 10n ** 18n), String(8n * 10n ** 18n)],
    [weth.address, weth.symbol, String(9n * 10n ** 18n), String(10n * 10n ** 18n)],
    [musegod.address, musegod.symbol, String(11n * 10n ** 18n), String(12n * 10n ** 18n)],
  ]);
  assert.deepEqual(calls.fees.map(([token]) => token), [a.address, b.address, c.address, rows[5].address]);
  assert(calls.fees.every(([, account]) => account === vault), "pending fees are those of the vault");
  assert.deepEqual(view.pendingFees, bound.map((row) => ({ token: row.address, lp: { fees0: 1n, fees1: 2n }, trade: { fees0: 3n, fees1: 4n }, poolKey: { hooks: vault } })));
});

test("nftTreasury tells a created treasury from an initialized one by its ERC-1967 implementation slot", async () => {
  for (const [why, deployed, initialized] of [["not created", false, false], ["created, initialize not done", true, false], ["active", true, true]] as const) {
    const nft = nftOf(why === "active" ? "111" : why === "not created" ? "112" : "113"), { treasury } = derived(nft);
    const { service, calls } = treasuryFixture([coin(91, { nft, nftVerification: verified })],
      { deployed: deployed ? [treasury] : [], initialized: initialized ? [treasury] : [] });
    const view = await service.nftTreasury(`4663:${MUSES.contract}:${nft.tokenId}`);
    assert.deepEqual([view.treasuryDeployed, view.treasuryInitialized], [deployed, initialized], why);
    assert.deepEqual(calls.slots, [[treasury, ERC1967_IMPLEMENTATION_SLOT]], `${why}: the treasury's implementation slot, read once`);
  }
});

test("a rejected coin bound to the NFT is in the treasury view and its sweep set, but never in the public listing", async () => {
  const nft = nftOf("1");
  const listed = coin(81, { nft, nftVerification: verified }), refused = coin(82, { nft, nftVerification: rejected, quoteAddress: musegod.address });
  const { service } = treasuryFixture([listed, refused]);
  const view = await service.nftTreasury(`4663:${MUSES.contract}:1`);
  assert.deepEqual(view.coins.map((row) => row.token), [listed.address, refused.address]);
  assert.deepEqual(view.pendingFees.map((row) => (row as { token: Address }).token), [listed.address, refused.address]);
  assert(view.balances.some((row) => row.token === refused.address), "its balance is shown");
  await httpFixture(async ({ service: http }, origin) => {
    http.tokens = async () => structuredClone([listed, refused]);
    assert.deepEqual(symbols(await (await get(origin, `/api/tokens?nft=4663:${MUSES.contract}:1`)).json()), ["C81"]);
  });
});

test("an NFT with no coin still answers with its addresses, and no balance read is made", async () => {
  const nft = nftOf("103");
  const { service, calls } = treasuryFixture([coin(21, { nft: nftOf("104"), nftVerification: verified })]);
  const view = await service.nftTreasury(`4663:${MUSES.contract}:103`);
  assert.deepEqual([view.vault, view.treasury], [derived(nft).vault, derived(nft).treasury]);
  assert.deepEqual([view.balances, view.pendingFees, calls.multicalls.length, calls.fees.length], [[], [], 0, 0]);
});

test("one failing fee preview becomes an error entry; the endpoint still answers", async () => {
  const nft = nftOf("105"), { vault } = derived(nft);
  const a = coin(31, { nft, nftVerification: verified }), b = coin(32, { nft, nftVerification: unverified });
  const { service, state } = treasuryFixture([a, b]);
  state.failFees.add(a.address.toLowerCase());
  const view = await service.nftTreasury(`4663:${MUSES.contract}:105`);
  assert.deepEqual(view.pendingFees, [{ token: a.address, error: "pool read failed at [upstream]" },
    { token: b.address, lp: { fees0: 1n, fees1: 2n }, trade: { fees0: 3n, fees1: 4n }, poolKey: { hooks: vault } }]);
  assert.deepEqual(view.balances.map((row) => row.token), [a.address, b.address, weth.address], "the balances are read independently of the previews");
});

test("a failed vault balance keeps the treasury balance with vaultAmount null; a failed treasury balance drops the row; neither is cached", async () => {
  const nft = nftOf("108");
  const a = coin(51, { nft, nftVerification: verified }), b = coin(52, { nft, nftVerification: verified });
  const { service, calls, state } = treasuryFixture([a, b]);
  // Reads, in order: a.treasury, a.vault, b.treasury, b.vault, weth.treasury, weth.vault.
  state.failReads = new Set([1, 2]);
  const query = `4663:${MUSES.contract}:108`;
  const rowOf = (view: Awaited<ReturnType<typeof service.nftTreasury>>) => view.balances.map((row) => [row.token, row.amount, row.vaultAmount]);
  assert.deepEqual(rowOf(await service.nftTreasury(query)), [[a.address, String(1n * 10n ** 18n), null], [weth.address, String(5n * 10n ** 18n), String(6n * 10n ** 18n)]]);
  assert.equal(calls.multicalls.length, 1);
  await service.nftTreasury(query);
  assert.equal(calls.multicalls.length, 2, "a degraded read is asked again, not served from memory");
  state.failReads = new Set();
  assert.equal((await service.nftTreasury(query)).balances.length, 3);
  assert.equal(calls.multicalls.length, 3);
  await service.nftTreasury(query);
  assert.equal(calls.multicalls.length, 3, "once every read succeeds the result is cached");
});

test("a result with a failed fee preview is returned but not cached; the next clean one is", async () => {
  const nft = nftOf("109");
  const a = coin(61, { nft, nftVerification: verified });
  const { service, calls, state } = treasuryFixture([a]);
  const query = `4663:${MUSES.contract}:109`;
  state.failFees.add(a.address.toLowerCase());
  assert.equal(((await service.nftTreasury(query)).pendingFees[0] as { error?: string }).error, "pool read failed at [upstream]");
  await service.nftTreasury(query);
  assert.deepEqual([calls.multicalls.length, calls.fees.length], [2, 2], "the degraded answer hit the RPC again");
  state.failFees.clear();
  const clean = await service.nftTreasury(query);
  assert.equal("error" in (clean.pendingFees[0] as object), false);
  await service.nftTreasury(query);
  assert.deepEqual([calls.multicalls.length, calls.fees.length], [3, 3], "the clean answer is cached");
});

test("an unverified factory or another chain's NFT is refused with a client error before any NFT read", async () => {
  const none = treasuryFixture([], { factory: null });
  assert.equal(await rejectionCode(() => none.service.nftTreasury(`4663:${MUSES.contract}:106`)), "NFT_VAULT_UNAVAILABLE");
  assert.deepEqual(none.calls.codes, []);
  const wrong = treasuryFixture([]);
  assert.equal(await rejectionCode(() => wrong.service.nftTreasury(`8453:${MUSES.contract}:106`)), "NFT_CHAIN_UNSUPPORTED");
  assert.deepEqual(wrong.calls.codes, [], "the chain check precedes every RPC read");
  // A factory whose deployed code does not match the manifest is unverified too.
  const foreign = treasuryFixture([]);
  (foreign.service as unknown as { client: { getCode: () => Promise<Hex> } }).client.getCode = async () => "0x6002600255";
  assert.equal(await rejectionCode(() => foreign.service.nftTreasury(`4663:${MUSES.contract}:106`)), "NFT_VAULT_UNAVAILABLE");
  for (const raw of [undefined, "any", `4663:${MUSES.contract}:007`, ["x"]])
    assert.match(await rejectionCode(() => treasuryFixture([]).service.nftTreasury(raw)), /^other:/, "a malformed query is a validation error (400), not a vault error");
});

test("results are cached for 15 seconds; a failure is never cached", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const query = `4663:${MUSES.contract}:107`;
  const { service, calls, state } = treasuryFixture([coin(41, { nft: nftOf("107"), nftVerification: verified })]);
  state.failMulticall = true;
  assert.equal(await rejectionCode(() => service.nftTreasury(query)), "other:rpc down");
  state.failMulticall = false;
  const first = await service.nftTreasury(query);
  assert.equal(calls.multicalls.length, 2, "the failed attempt was not remembered");
  t.mock.timers.tick(14_999);
  assert.deepEqual(await service.nftTreasury(query), first);
  assert.equal(calls.multicalls.length, 2, "served from memory inside the window");
  t.mock.timers.tick(2);
  await service.nftTreasury(query);
  assert.equal(calls.multicalls.length, 3, "recomputed once the window has passed");
});

test("the cache is bounded by 500 entries and evicts the oldest first", async () => {
  const { service, calls } = treasuryFixture([]);
  const key = (id: number) => `4663:${MUSES.contract}:${10_000 + id}`;
  for (let id = 1; id <= 501; id++) await service.nftTreasury(key(id));
  const reads = calls.codes.length;
  await service.nftTreasury(key(501));
  assert.equal(calls.codes.length, reads, "the newest entry is cached");
  await service.nftTreasury(key(2));
  assert.equal(calls.codes.length, reads, "an entry within the newest 500 is cached");
  await service.nftTreasury(key(1));
  assert(calls.codes.length > reads, "the oldest entry was evicted to stay within 500");
});

test("the committed hide list names both chains", () => {
  assert.deepEqual(Object.keys(committedHideList).sort(), ["4663", "8453"]);
  for (const addresses of Object.values(committedHideList)) for (const a of addresses) assert.match(a, /^0x[0-9a-f]{40}$/);
  // A Base coin launched as "Musegod" (MUSEGOD) under the official X link, before the reserved-name rule; the official token is 0x0379… on Robinhood.
  assert.ok(committedHideList["8453"].includes("0x79ea556198c33bb3025f0243144e74cb9416e670"));
});

// ---- the NFT step's wallet lists (tasks/nft-mode-wallet-picker.md §4) ----------------------------------------
const holder = "0x1111111111111111111111111111111111111111";
test("wallet lists: 400 on a bad address, 503 NFT_LIST_UNAVAILABLE without an Alchemy key, never the key", async () => {
  for (const path of ["/api/nft-collections", "/api/chains/4663/nft-tokens"]) assert.equal(ingressClass(path), "read");
  await httpFixture(async (_entry, origin) => {
    for (const path of ["/api/nft-collections?owner=nope", `/api/nft-tokens?owner=${holder}&contract=nope`])
      assert.equal((await get(origin, path)).status, 400, path);
    for (const path of [`/api/nft-collections?owner=${holder}`, `/api/chains/4663/nft-tokens?owner=${holder}&contract=${MUSES.contract}`]) {
      const response = await get(origin, path);
      assert.equal(response.status, 503, path);
      assert.deepEqual(await response.json(), { error: "Your NFTs could not be loaded. Enter the contract and token number instead.", code: "NFT_LIST_UNAVAILABLE" });
    }
  }, undefined, { chainScoped: true });
});

test("wallet lists answer the §4 shapes; launched marks verified coins only; Muses are free", async () => {
  await httpFixture(async ({ service }, origin) => {
    await service.store.saveToken(coin(1, { nft: nftOf("1"), nftVerification: verified }));
    await service.store.saveToken(coin(2, { nft: nftOf("2"), nftVerification: rejected }));
    await service.store.saveToken(coin(3, { nft: nftOf("3"), nftVerification: unverified }));
    const seen: string[] = [];
    service.nftHoldings = {
      collections: async (owner, isFree) => { seen.push(`c:${owner}`); return { truncated: false, collections: [
        { contract: MUSES.contract, name: "MUSEGOD Muses", held: 3, free: isFree(MUSES.contract), openSeaVerified: true }] }; },
      tokens: async (owner, contract) => { seen.push(`t:${owner}:${contract}`); return { truncated: true, tokens: [{ tokenId: "1" }, { tokenId: "2", name: "Two" }, { tokenId: "3" }] }; },
    };
    const collections = await (await get(origin, `/api/chains/4663/nft-collections?owner=${holder}`)).json();
    assert.deepEqual(collections, { owner: getAddress(holder), truncated: false,
      collections: [{ contract: MUSES.contract, name: "MUSEGOD Muses", held: 3, free: true, openSeaVerified: true }] });
    const tokens = await (await get(origin, `/api/nft-tokens?owner=${holder}&contract=${MUSES.contract.toLowerCase()}`)).json();
    assert.deepEqual(tokens, { owner: getAddress(holder), contract: MUSES.contract, truncated: true,
      tokens: [{ tokenId: "1", launched: true }, { tokenId: "2", name: "Two", launched: false }, { tokenId: "3", launched: false }] });
    assert.deepEqual(seen, [`c:${getAddress(holder)}`, `t:${getAddress(holder)}:${MUSES.contract}`]);
  }, undefined, { chainScoped: true });
});

test("wallet lists stay dark on Base: NFT_MODE_UNAVAILABLE before any read", async () => {
  const directory = mkdtempSync(join(tmpdir(), "nft-base-"));
  const service = new LaunchpadService(runtimeFromEnv(8453, { NODE_ENV: "test", CHAIN_MODE: "fork", FORK_CHAIN_ID: "8453", DATA_DIR: directory,
    PLATFORM_TREASURY: "0x2222222222222222222222222222222222222222", NFT_MODE_ENABLED: "true" }));
  try {
    service.nftHoldings = { collections: async () => assert.fail("no read"), tokens: async () => assert.fail("no read") };
    for (const run of [() => service.nftCollections(holder), () => service.nftTokens(holder, MUSES.contract)])
      await assert.rejects(run, (e: any) => e.code === "NFT_MODE_UNAVAILABLE");
  } finally { service.store.close(); rmSync(directory, { recursive: true, force: true }); }
});
