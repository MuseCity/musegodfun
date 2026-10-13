import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { getAddress, keccak256, type Address, type Hex } from "viem";
import { ROBINHOOD_STOCKS, type RuntimeConfig, type TokenRecord } from "../src/lib/config";
import { CURVE_POLICY } from "../src/lib/launch-curve";
import { MUSES, NFT_VAULT_MANIFEST, nftKey, type NftVaultManifest } from "../src/lib/nft-mode";
import { NftLaunchError, assertNftDraftRules, readNftControl, verifyVaultFactory } from "../server/nft-launch";
import { LaunchpadService } from "../server/service";
import { createApp } from "../server/app";
import { runtimeFromEnv } from "../server/config";
import { Store, TokenUniqueConflict } from "../server/store";
import { SupabaseStore } from "../server/supabase-store";
import { syntheticToken } from "./fixtures";

const musegod = ROBINHOOD_STOCKS.find((a) => a.symbol === "MUSEGOD")!;
const weth = ROBINHOOD_STOCKS.find((a) => a.symbol === "WETH")!;
const holder = "0xAAAA000000000000000000000000000000000001" as Address;
const muse = { chainId: 4663 as const, contract: MUSES.contract, tokenId: "1" };
const draft = { name: "Bard", symbol: "BARD", description: "", image: "", quoteAddress: musegod.address, tradingFeeBps: 100, nft: muse };
const code = (fn: () => unknown) => { try { fn(); } catch (e) { return e instanceof NftLaunchError ? e.code : `other:${String(e)}`; } return "ok"; };

test("draft rules run before RPC and return stable codes", () => {
  assert.equal(code(() => assertNftDraftRules(draft, 4663, false)), "NFT_MODE_DISABLED");
  assert.equal(code(() => assertNftDraftRules(draft, 8453, true)), "NFT_CHAIN_UNSUPPORTED");
  assert.equal(code(() => assertNftDraftRules({ ...draft, quoteAddress: weth.address }, 4663, true)), "NFT_MUSE_PAIR_REQUIRED");
  assert.equal(code(() => assertNftDraftRules({ ...draft, name: "Muse God", symbol: "MUSEGOD" }, 4663, true)), "NFT_RESERVED_NAME");
  assert.equal(code(() => assertNftDraftRules({ ...draft, nft: { ...muse, contract: "0x1111111111111111111111111111111111111111" as Address },
    quoteAddress: weth.address }, 4663, true)), "ok");
  assert.equal(code(() => assertNftDraftRules({ ...draft, nft: undefined, name: "MUSEGOD", symbol: "MG" }, 4663, true)), "NFT_RESERVED_NAME");
});

test("MUSEGOD is reserved for every launch, normal and NFT, on both chains, in any spelling the normalised check sees", () => {
  for (const [chainId, enabled] of [[4663, true], [4663, false], [8453, false]] as const) {
    for (const name of ["MUSEGOD", "musegod", " Muse God ", "muse\tgod", "MUSE-GOD", "m.u.s.e.g.o.d", "Muse_God!"])
      assert.equal(code(() => assertNftDraftRules({ ...draft, nft: undefined, name, symbol: "MG" }, chainId, enabled)), "NFT_RESERVED_NAME", `${chainId} ${name}`);
    assert.equal(code(() => assertNftDraftRules({ ...draft, nft: undefined, name: "Muse", symbol: "MUSEGOD" }, chainId, enabled)), "NFT_RESERVED_NAME");
    assert.equal(code(() => assertNftDraftRules({ ...draft, nft: undefined, name: "Muse Gods", symbol: "MUSEGODS" }, chainId, enabled)), "ok", "only the exact name");
  }
});

test("control is the owner or a delegate.xyz delegate; non-ERC-721 contracts are refused", async () => {
  const owner = holder, delegate = "0xBBBB000000000000000000000000000000000002" as Address, stranger = "0xCCCC000000000000000000000000000000000003" as Address;
  const client = { readContract: async ({ functionName, args }: { functionName: string; args: unknown[] }) => {
    if (functionName === "supportsInterface") return true;
    if (functionName === "ownerOf") return owner;
    if (functionName === "checkDelegateForERC721") return (args[0] as string).toLowerCase() === delegate.toLowerCase();
    throw new Error(functionName);
  } } as never;
  assert.deepEqual(await readNftControl(client, muse, owner), { erc721: true, owner, controls: true });
  assert.equal((await readNftControl(client, muse, delegate)).controls, true);
  assert.equal((await readNftControl(client, muse, stranger)).controls, false);
  const not721 = { readContract: async ({ functionName }: { functionName: string }) => functionName === "supportsInterface" ? false : owner } as never;
  assert.equal((await readNftControl(not721, muse, owner)).erc721, false);
});

// ---- prepare wiring ----------------------------------------------------------------------
const factory = getAddress("0x00000000000000000000000000000000000fac70");
const factoryCode = "0x60016001556000" as Hex;
const deployedManifest = (code: Hex | null = factoryCode): NftVaultManifest => ({ ...NFT_VAULT_MANIFEST, chains: { ...NFT_VAULT_MANIFEST.chains,
  "4663": { status: "deployed_verified", factory, factoryRuntimeHash: code ? keccak256(code) : null, transactionHash: `0x${"11".repeat(32)}`, blockNumber: 1 } } });
const stranger = "0xCCCC000000000000000000000000000000000003" as Address;
const other = { chainId: 4663 as const, contract: "0x1111111111111111111111111111111111111111" as Address, tokenId: "7" };
const treasury = "0x2222222222222222222222222222222222222222" as Address;
const nftMode = (over: Partial<NonNullable<RuntimeConfig["nftMode"]>> = {}): NonNullable<RuntimeConfig["nftMode"]> =>
  ({ enabled: true, vaultFactory: factory, launchFeeUsd: 10, freeCollections: [], verifiedCollections: [], ...over });

function prepareFixture(options: { owner?: Address; erc721?: boolean; existing?: TokenRecord | null; mode?: Partial<NonNullable<RuntimeConfig["nftMode"]>>;
  getCode?: () => Promise<Hex | undefined>; manifest?: NftVaultManifest; guards?: () => Promise<boolean> } = {}) {
  const calls = { network: 0, codeReads: 0, prepared: 0, uniquenessKeys: [] as string[], guardReads: 0 };
  const owner = options.owner ?? holder;
  const config: RuntimeConfig = { mode: "robinhood", chainId: 4663, deploymentChainId: 4663, treasury, writesEnabled: true, blockReason: null, nftMode: nftMode(options.mode) };
  const client = {
    readContract: async ({ functionName }: { functionName: string }) => {
      if (functionName === "supportsInterface") return options.erc721 ?? true;
      if (functionName === "ownerOf") return owner;
      if (functionName === "checkDelegateForERC721") return false;
      throw new Error(functionName);
    },
    getCode: async () => { calls.codeReads++; return options.getCode ? options.getCode() : factoryCode; },
  };
  const service = Object.assign(Object.create(LaunchpadService.prototype), {
    runtime: { config, nftVaultManifest: options.manifest ?? deployedManifest() },
    assertNetwork: async () => { calls.network++; },
    assertCreatorAccount: async () => {},
    assertLaunchPolicyCurrent: () => { throw new Error("REACHED_POLICY_CHECK"); },
    client,
    store: { verifiedNftCoin: async (key: string) => { calls.uniquenessKeys.push(key); return options.existing ?? null; }, runtimeControl: async () => ({ revision: 1, paused: false, reason: "" }),
      nftGuardsReady: async () => { calls.guardReads++; return options.guards ? options.guards() : true; } },
    sdk: { factory: { prepareCreateMulticurve: async () => { calls.prepared++; throw new Error("PREPARED"); } } },
  }) as LaunchpadService;
  return { service, calls, config };
}
const outcome = async (run: () => Promise<unknown>) => { try { await run(); return "ok"; } catch (e) { return e instanceof NftLaunchError ? e.code : `other:${(e as Error).message}`; } };

test("prepare refuses a non-holder with NFT_NOT_CONTROLLED before preparing calldata", async () => {
  const { service, calls } = prepareFixture();
  assert.equal(await outcome(() => service.prepare(draft, stranger, CURVE_POLICY)), "NFT_NOT_CONTROLLED");
  assert.equal(calls.prepared, 0);
});

test("prepare refuses a contract that is not ERC-721", async () => {
  const { service, calls } = prepareFixture({ erc721: false });
  assert.equal(await outcome(() => service.prepare(draft, holder, CURVE_POLICY)), "NFT_NOT_ERC721");
  assert.equal(calls.prepared, 0);
});

test("prepare refuses a second coin for the same NFT", async () => {
  const existing = syntheticToken({ nft: muse, nftVerification: { status: "verified" } });
  const { service, calls } = prepareFixture({ existing });
  assert.equal(await outcome(() => service.prepare(draft, holder, CURVE_POLICY)), "NFT_ALREADY_LAUNCHED");
  assert.deepEqual(calls.uniquenessKeys, [nftKey(muse)], "uniqueness is asked of the store for exactly this chain, contract and token");
  assert.equal(calls.prepared, 0);
});

test("prepare refuses a non-Muse NFT without payment", async () => {
  const { service, calls } = prepareFixture();
  const plain = { ...draft, nft: other, quoteAddress: weth.address };
  assert.equal(await outcome(() => service.prepare(plain, holder, CURVE_POLICY)), "NFT_FEE_REQUIRED");
  assert.equal(calls.prepared, 0);
});

test("prepare lets a holder's Muse past every NFT gate with no launch fee", async () => {
  const { service, calls } = prepareFixture();
  assert.equal(await outcome(() => service.prepare(draft, holder, CURVE_POLICY)), "other:REACHED_POLICY_CHECK",
    "control, uniqueness and the verified factory all passed, so preparation moved on to the shared launch-policy check");
  assert.equal(calls.codeReads, 1);
});

test("NFT and reserved-name rules refuse before any RPC", async () => {
  const off = prepareFixture({ mode: { enabled: false } });
  assert.equal(await outcome(() => off.service.prepare(draft, holder, CURVE_POLICY)), "NFT_MODE_DISABLED");
  const undeployed = prepareFixture({ mode: { vaultFactory: null } });
  assert.equal(await outcome(() => undeployed.service.prepare(draft, holder, CURVE_POLICY)), "NFT_VAULT_UNAVAILABLE");
  const reserved = prepareFixture();
  assert.equal(await outcome(() => reserved.service.prepare({ ...draft, nft: undefined, name: "Muse God" }, holder, CURVE_POLICY)), "NFT_RESERVED_NAME");
  for (const { calls } of [off, undeployed, reserved]) { assert.equal(calls.network, 0); assert.equal(calls.codeReads, 0, "not even the factory code is read"); }
});

test("a factory whose runtime hash differs from the manifest makes prepare refuse with NFT_VAULT_UNAVAILABLE", async () => {
  const foreign = prepareFixture({ getCode: async () => "0x6002600255" });
  assert.equal(await outcome(() => foreign.service.prepare(draft, holder, CURVE_POLICY)), "NFT_VAULT_UNAVAILABLE");
  assert.equal(foreign.calls.prepared, 0);
  const empty = prepareFixture({ getCode: async () => "0x" });
  assert.equal(await outcome(() => empty.service.prepare(draft, holder, CURVE_POLICY)), "NFT_VAULT_UNAVAILABLE");
  const nohash = prepareFixture({ manifest: deployedManifest(null) });
  assert.equal(await outcome(() => nohash.service.prepare(draft, holder, CURVE_POLICY)), "NFT_VAULT_UNAVAILABLE");
});

test("the factory identity is verified once per runtime; an RPC failure only blocks briefly", async () => {
  const good = prepareFixture();
  assert.equal((await good.service.config(true)).nftMode?.vaultFactory, factory);
  assert.equal((await good.service.config(true)).nftMode?.vaultFactory, factory);
  assert.equal(good.calls.codeReads, 1, "a definitive verdict is final for the runtime's lifetime");

  const bad = prepareFixture({ getCode: async () => "0x6002600255" });
  assert.equal((await bad.service.config(true)).nftMode?.vaultFactory, null);
  assert.equal((await bad.service.config(true)).nftMode?.vaultFactory, null);
  assert.equal(bad.calls.codeReads, 1, "a foreign runtime is not re-read either");

  let failing = true;
  const flaky = prepareFixture({ getCode: async () => { if (failing) throw new Error("rpc down"); return factoryCode; } });
  assert.equal((await flaky.service.config(true)).nftMode?.vaultFactory, null);
  failing = false;
  assert.equal((await flaky.service.config(true)).nftMode?.vaultFactory, null, "the outage verdict is held for a short backoff");
  assert.equal(flaky.calls.codeReads, 1);
  (flaky.service as unknown as { nftFactoryCheck: { at: number } }).nftFactoryCheck.at -= 61_000;
  assert.equal((await flaky.service.config(true)).nftMode?.vaultFactory, factory, "a later successful read recovers");
});

test("empty factory code is a transient verdict: it blocks for a minute, then a deployed factory is picked up", async () => {
  for (const empty of ["0x", undefined] as const) {
    let deployed = false;
    const late = prepareFixture({ getCode: async () => deployed ? factoryCode : empty });
    assert.equal((await late.service.config(true)).nftMode?.vaultFactory, null);
    deployed = true;
    assert.equal((await late.service.config(true)).nftMode?.vaultFactory, null, "held for the short backoff, not re-read on every request");
    assert.equal(late.calls.codeReads, 1);
    (late.service as unknown as { nftFactoryCheck: { at: number } }).nftFactoryCheck.at -= 61_000;
    assert.equal((await late.service.config(true)).nftMode?.vaultFactory, factory, `a factory deployed after an empty read (${String(empty)}) is found without a restart`);
    assert.equal(late.calls.codeReads, 2);
    assert.equal((await late.service.config(true)).nftMode?.vaultFactory, factory);
    assert.equal(late.calls.codeReads, 2, "and then the match is final");
  }
  const foreign = prepareFixture({ getCode: async () => "0x6002600255" });
  await foreign.service.config(true);
  assert.equal((foreign.service as unknown as { nftFactoryCheck: { ttl: number } }).nftFactoryCheck.ttl, Infinity, "only a definitive mismatch is permanent");
});

test("without the database's single-use guards NFT mode is off: /config, prepare, quotes and the NFT APIs refuse; registration is never gated", async () => {
  let ready = false;
  const { service, calls } = prepareFixture({ guards: async () => ready });
  assert.deepEqual((await service.config(true)).nftMode, { ...nftMode(), enabled: false }, "the flag alone is not enough");
  const network = calls.network;
  assert.equal(await outcome(() => service.prepare(draft, holder, CURVE_POLICY)), "NFT_MODE_DISABLED");
  assert.equal(await outcome(() => service.launchFeeQuote(holder)), "NFT_MODE_DISABLED");
  assert.equal(await outcome(() => service.nftStatus(`4663:${muse.contract}:1`, holder)), "NFT_MODE_UNAVAILABLE");
  assert.equal(await outcome(() => service.nftTreasury(`4663:${muse.contract}:1`)), "NFT_MODE_UNAVAILABLE");
  assert.equal(calls.network, network, "refused before any RPC");
  assert.equal(calls.guardReads, 1, "a missing verdict is held for a short backoff, not re-read on every request");
  assert.equal(await outcome(() => service.prepare({ ...draft, nft: undefined }, holder, CURVE_POLICY)), "other:REACHED_POLICY_CHECK", "normal launches are unaffected");
  // The migration is applied: picked up after the backoff, without a restart, and then final.
  ready = true;
  (service as unknown as { nftGuardsCheck: { at: number } }).nftGuardsCheck.at -= 61_000;
  assert.deepEqual((await service.config(true)).nftMode, nftMode());
  assert.equal(await outcome(() => service.prepare(draft, holder, CURVE_POLICY)), "other:REACHED_POLICY_CHECK");
  ready = false;
  (service as unknown as { nftGuardsCheck: { at: number } }).nftGuardsCheck.at -= 3_600_000;
  assert.equal((await service.config(true)).nftMode?.enabled, true, "a ready verdict lasts for the runtime's lifetime");
  assert.equal(calls.guardReads, 2);
  // A failing read is not ready either.
  const failing = prepareFixture({ guards: async () => { throw new Error("database down"); } });
  assert.equal((await failing.service.config(true)).nftMode?.enabled, false);
  assert.equal(await outcome(() => failing.service.prepare(draft, holder, CURVE_POLICY)), "NFT_MODE_DISABLED");
  // With the flag off the guards are never asked.
  const off = prepareFixture({ mode: { enabled: false } });
  assert.equal((await off.service.config(true)).nftMode?.enabled, false);
  assert.equal(off.calls.guardReads, 0);
});

test("SQLite always has both guards (the store creates them or refuses to start)", () => {
  const directory = mkdtempSync(join(tmpdir(), "nft-store-"));
  const store = new Store(directory, 4663);
  try { assert.equal(store.nftGuardsReady(), true); }
  finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("SQLite refuses to start on a database that already breaks a single-use rule, naming the index, the coins and the fix", () => {
  const cases: [string, string[], RegExp][] = [
    ["tokens_launch_fee_once", [JSON.stringify({ launchFee: { asset: "stable", txHash: "0xAB" } }), JSON.stringify({ launchFee: { asset: "stable", txHash: "0xab" } })],
      /Cannot create the tokens_launch_fee_once index on .*launchpad\.sqlite: two or more coins spend one launch-fee payment \(0x1+ 0x2+\)\. Resolve each group before starting: keep the one coin the payment funded; on each other coin remove "launchFee" and set "nftVerification" to \{"status":"rejected","reason":"fee"\}\./],
    ["tokens_nft_verified_once", [1, 2].map(() => JSON.stringify({ nft: muse, nftVerification: { status: "verified" } })),
      /Cannot create the tokens_nft_verified_once index on .*: an NFT has two or more verified coins \(0x1+ 0x2+\)\. Resolve each group before starting: keep the earliest verified coin; set "nftVerification" on each other coin to \{"status":"rejected","reason":"already_launched"\}\./],
  ];
  for (const [name, payloads, message] of cases) {
    const directory = mkdtempSync(join(tmpdir(), "nft-store-"));
    try {
      // A database written before the guards existed.
      const legacy = new DatabaseSync(join(directory, "launchpad.sqlite"));
      legacy.exec("CREATE TABLE tokens (address TEXT PRIMARY KEY, tx_hash TEXT UNIQUE NOT NULL, created_at INTEGER NOT NULL, payload TEXT NOT NULL)");
      payloads.forEach((payload, index) => legacy.prepare("INSERT INTO tokens VALUES(?,?,?,?)").run(`0x${String(index + 1).repeat(40)}`, `0x${String(index + 1).repeat(64)}`, 1, payload));
      legacy.close();
      assert.throws(() => new Store(directory, 4663), (error: unknown) => error instanceof Error && message.test(error.message) &&
        (error.cause as Error).message === `UNIQUE constraint failed: index '${name}'`, name);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  }
});

test("NFT mode is Robinhood-only and off unless NFT_MODE_ENABLED is exactly true", () => {
  const base = { NODE_ENV: "test", PLATFORM_TREASURY: "0x2222222222222222222222222222222222222222" };
  assert.equal(runtimeFromEnv(8453, { ...base, NFT_MODE_ENABLED: "true" }).config.nftMode?.enabled, false, "Base stays locked even when the flag is true");
  assert.equal(runtimeFromEnv(8453, base).config.nftMode?.enabled, false);
  assert.equal(runtimeFromEnv(4663, base).config.nftMode?.enabled, false, "unset is off");
  assert.equal(runtimeFromEnv(4663, { ...base, NFT_MODE_ENABLED: "false" }).config.nftMode?.enabled, false);
  assert.equal(runtimeFromEnv(4663, { ...base, NFT_MODE_ENABLED: "TRUE" }).config.nftMode?.enabled, false, "only the exact string true enables it");
  assert.equal(runtimeFromEnv(4663, { ...base, NFT_MODE_ENABLED: "true" }).config.nftMode?.enabled, true);
});

test("verifyVaultFactory compares the deployed runtime hash, never the build template hash", async () => {
  const client = (code: Hex | undefined) => ({ getCode: async () => code });
  assert.equal(await verifyVaultFactory(client(factoryCode), 4663, deployedManifest()), factory);
  assert.equal(await verifyVaultFactory(client("0x00"), 4663, deployedManifest()), null);
  assert.equal(await verifyVaultFactory(client(undefined), 4663, deployedManifest()), null);
  assert.equal(await verifyVaultFactory(client(factoryCode), 8453, deployedManifest()), null, "Base has no deployed factory in this manifest");
  assert.equal(await verifyVaultFactory(client(factoryCode), 4663), null, "the committed manifest is not deployed yet");
});

// ---- stores ------------------------------------------------------------------------------
const storeCoin = (n: number, over: Partial<TokenRecord>) => syntheticToken({ mode: "robinhood", address: `0x${String(n).repeat(40)}` as Address,
  transactionHash: `0x${String(n).repeat(64)}` as Hex, createdAt: 1_800_000_000_000 + n, ...over });
const nftConflict = (error: unknown) => error instanceof TokenUniqueConflict && error.kind === "nft_verified";

test("verifiedNftCoin finds only a verified coin for exactly this NFT and can exclude the coin being registered", () => {
  const directory = mkdtempSync(join(tmpdir(), "nft-store-"));
  const store = new Store(directory, 4663), coin = storeCoin;
  try {
    store.saveToken(coin(1, { nft: { ...muse, contract: MUSES.contract.toLowerCase() as Address }, nftVerification: { status: "rejected" } }));
    store.saveToken(coin(2, { nft: muse, nftVerification: { status: "unverified" } }));
    store.saveToken(coin(3, { nft: { ...muse, tokenId: "2" }, nftVerification: { status: "verified" } }));
    store.saveToken(coin(4, {}));
    assert.equal(store.verifiedNftCoin(nftKey(muse)), null, "rejected, unverified, other-token and non-NFT records never reserve the NFT");
    store.saveToken(coin(5, { nft: { ...muse, contract: MUSES.contract.toLowerCase() as Address }, nftVerification: { status: "verified" }, createdAt: 1_800_000_000_050 }));
    assert.equal(store.verifiedNftCoin(nftKey(muse))?.address, `0x${"5".repeat(40)}`, "the contract compares case-insensitively");
    assert.equal(store.verifiedNftCoin(nftKey(muse), `0x${"5".repeat(40)}`.toUpperCase().replace("0X", "0x")), null, "the coin itself is excluded");
    assert.equal(store.verifiedNftCoin(nftKey({ ...muse, tokenId: "3" })), null);
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("SQLite refuses a second verified coin for one NFT, by any writer and in any contract case, while rejected and unverified duplicates are allowed", () => {
  const directory = mkdtempSync(join(tmpdir(), "nft-store-"));
  const store = new Store(directory, 4663), lower = { ...muse, contract: MUSES.contract.toLowerCase() as Address };
  try {
    store.saveToken(storeCoin(1, { nft: muse, nftVerification: { status: "verified" } }));
    assert.throws(() => store.saveToken(storeCoin(2, { nft: muse, nftVerification: { status: "verified", block: "9" } })), nftConflict, "a second verified insert");
    assert.throws(() => store.saveToken(storeCoin(2, { nft: lower, nftVerification: { status: "verified" } })), nftConflict, "the contract compares case-insensitively");
    assert.equal(store.token(`0x${"2".repeat(40)}`), null, "the refused coin was not written");
    store.saveToken(storeCoin(2, { nft: lower, nftVerification: { status: "rejected", reason: "already_launched" } }));
    store.saveToken(storeCoin(3, { nft: muse, nftVerification: { status: "unverified", reason: "rpc" } }));
    store.saveToken(storeCoin(4, { nft: muse }));
    store.saveToken(storeCoin(6, { nft: muse, nftVerification: { status: "rejected", reason: "not_controller" } }));
    assert.throws(() => store.updateNftVerification({ ...storeCoin(3, { nft: muse }), nftVerification: { status: "verified" } }), nftConflict, "a compare-and-swap to verified");
    assert.equal(store.token(`0x${"3".repeat(40)}`)?.nftVerification?.status, "unverified", "the refused write changed nothing");
    store.updateNftVerification({ ...storeCoin(3, { nft: muse }), nftVerification: { status: "rejected", reason: "already_launched" } });
    assert.equal(store.token(`0x${"3".repeat(40)}`)?.nftVerification?.reason, "already_launched");
    // The key is the stored JSON's own types: chainId a number and tokenId a decimal string, exactly as verifiedNftCoin reads them.
    store.saveToken(storeCoin(7, { nft: { ...muse, tokenId: "2" }, nftVerification: { status: "verified" } }));
    store.saveToken(storeCoin(8, { nft: { ...muse, chainId: 8453 as never }, nftVerification: { status: "verified" } }));
    store.saveToken(storeCoin(9, { nft: { ...muse, contract: weth.address }, nftVerification: { status: "verified" } }));
    store.saveToken(storeCoin(1, { nft: muse, nftVerification: { status: "verified" } }));
    assert.equal(store.tokens().length, 8, "other NFTs are no conflict, and registering the verified coin again is not a second one");
    assert.equal(store.verifiedNftCoin(nftKey(muse))?.address, `0x${"1".repeat(40)}`);
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("SQLite answers both single-use lookups from the guard indexes, so a lookup and the database's refusal can never disagree", () => {
  const directory = mkdtempSync(join(tmpdir(), "nft-store-"));
  const store = new Store(directory, 4663);
  try {
    const statements: string[] = [], prepare = store.db.prepare.bind(store.db);
    Object.assign(store.db, { prepare: (sql: string) => { statements.push(sql); return prepare(sql); } });
    store.verifiedNftCoin(nftKey(muse), holder);
    store.tokenUsingLaunchFee(`0x${"ab".repeat(32)}`, holder, holder);
    Object.assign(store.db, { prepare });
    assert.equal(statements.length, 2);
    const plan = (sql: string, ...values: (string | number)[]) =>
      (store.db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...values) as { detail: string }[]).map((row) => row.detail).join("; ");
    assert.match(plan(statements[0], 4663, muse.contract.toLowerCase(), "1", ""), /USING INDEX tokens_nft_verified_once/);
    assert.match(plan(statements[1], `0x${"ab".repeat(32)}`, holder.toLowerCase(), ""), /USING INDEX tokens_launch_fee_once/);
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("the Supabase store queries the same verified-NFT predicate", async () => {
  const store = new SupabaseStore("https://fixture.supabase.co", "test-server-key", "verify-nft");
  let path = "";
  store.request = async <T>(requested: string) => { path = requested; return [{ payload: syntheticToken({ nft: muse }) }] as T; };
  const found = await store.verifiedNftCoin(nftKey(muse), "0xABCDEF0000000000000000000000000000000001");
  assert.equal(found?.symbol, "SYNTH");
  const query = decodeURIComponent(path);
  for (const part of ["payload->nft->>chainId=eq.4663", `payload->nft->>contract=ilike.${MUSES.contract.toLowerCase()}`, "payload->nft->>tokenId=eq.1",
    "payload->nftVerification->>status=eq.verified", "address=neq.0xabcdef0000000000000000000000000000000001", "order=created_at.asc"])
    assert(query.includes(part), `missing ${part} in ${query}`);
  store.request = async <T>() => [] as T;
  assert.equal(await store.verifiedNftCoin(nftKey(muse)), null);
});

// ---- HTTP --------------------------------------------------------------------------------
test("NftLaunchError codes reach the HTTP response body", async () => {
  const directory = mkdtempSync(join(tmpdir(), "nft-launch-http-"));
  const runtime = runtimeFromEnv(4663, { NODE_ENV: "test", CHAIN_MODE: "fork", FORK_CHAIN_ID: "4663", DATA_DIR: directory,
    PLATFORM_TREASURY: "0x2222222222222222222222222222222222222222" });
  const entry = createApp(undefined, "loopback", runtime);
  const server = entry.app.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); assert(address && typeof address !== "string");
  try {
    entry.service.prepare = async () => { throw new NftLaunchError("NFT_NOT_CONTROLLED", "Connect the wallet that holds this NFT."); };
    const response = await fetch(`http://127.0.0.1:${address.port}/api/launch/prepare`, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ draft, creator: stranger, expectedCurvePolicy: CURVE_POLICY }) });
    assert.equal(response.status, 422);
    assert.deepEqual(await response.json(), { error: "Connect the wallet that holds this NFT.", code: "NFT_NOT_CONTROLLED" });
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); entry.service.store.close(); rmSync(directory, { recursive: true, force: true }); }
});
