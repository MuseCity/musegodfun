import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { decodeFunctionData, erc20Abi, getAddress, stringToHex, type Address, type Hex } from "viem";
import { restoreDraft, type LaunchInput } from "../src/lib/validation";
import { ROBINHOOD_STOCKS } from "../src/lib/config";
import { MUSES, nftKey, type NftRef } from "../src/lib/nft-mode";
import { launchIntentStorageKey } from "../src/lib/launch-intent";
import {
  isLaunchFeeTx, launchFeeEthTx, launchFeeStableTx, launchFeeStorageKey, musePrefill, nftReviewBlocker, parseLaunchFeeRecord,
  prepareDraft, readNftStatus, savedNftMode, settleLaunchFee,
} from "../src/lib/nft-client";
import { createApp } from "../server/app";
import { ingressClass } from "../server/abuse";
import { runtimeFromEnv } from "../server/config";
import { LaunchpadService } from "../server/service";

const config = { mode: "robinhood", deploymentChainId: 4663, chainId: 4663, treasury: "0xc4F87C3715374445C4657aa14c47CBB339b59d1A" } as never;
const weth = ROBINHOOD_STOCKS.find((a) => a.symbol === "WETH")!, musegod = ROBINHOOD_STOCKS.find((a) => a.symbol === "MUSEGOD")!;
const treasury = getAddress("0xc4F87C3715374445C4657aa14c47CBB339b59d1A");
const account = getAddress("0x1111111111111111111111111111111111111111");
const muse = (tokenId = "1"): NftRef => ({ chainId: 4663, contract: MUSES.contract, tokenId });
const other = (tokenId = "5"): NftRef => ({ chainId: 4663, contract: getAddress("0x9999999999999999999999999999999999999999"), tokenId });
const stableFee = { asset: "stable" as const, txHash: `0x${"ab".repeat(32)}` as Hex };
const draftOf = (over: Partial<LaunchInput> = {}): LaunchInput => ({ name: "Bard", symbol: "BARD", description: "", image: "", website: "", twitter: "",
  telegram: "", quoteAddress: musegod.address, tradingFeeBps: 100, ...over });

test("restoring a Muse draft locks the MUSEGOD pair", () => {
  const draft = restoreDraft(JSON.stringify({ name: "Bard", quoteAddress: weth.address, nft: { chainId: 4663, contract: MUSES.contract, tokenId: "1" } }), config);
  assert.equal(draft.quoteAddress, musegod.address);
  assert.equal(draft.nft?.tokenId, "1");
});

test("restoring a malformed nft drops it and keeps the rest", () => {
  const draft = restoreDraft(JSON.stringify({ name: "Bard", nft: { chainId: 4663, contract: MUSES.contract, tokenId: "007" } }), config);
  assert.equal(draft.nft, undefined);
  assert.equal(draft.name, "Bard");
});

test("restoring a non-Muse NFT draft keeps the chosen pair", () => {
  const draft = restoreDraft(JSON.stringify({ name: "Bard", quoteAddress: weth.address, nft: other() }), config);
  assert.equal(draft.quoteAddress, weth.address);
  assert.equal(draft.nft?.tokenId, "5");
});

test("fee payment transactions pay exactly 10 USDG or the quoted wei to the treasury", () => {
  const stable = launchFeeStableTx(config);
  const decoded = decodeFunctionData({ abi: erc20Abi, data: stable.data });
  assert.equal(decoded.functionName, "transfer");
  assert.deepEqual(decoded.args, [(config as { treasury: Address }).treasury, 10_000_000n]);
  const eth = launchFeeEthTx(config, { wei: "5000000000000000", expiresAt: 1, mac: `0x${"11".repeat(32)}` });
  assert.equal(eth.to, (config as { treasury: Address }).treasury);
  assert.equal(eth.value, 5000000000000000n);
  assert.equal(eth.data, "0x");
});

test("a chain without a stablecoin fee, or a missing treasury, cannot build a fee payment", () => {
  assert.throws(() => launchFeeStableTx({ mode: "base", deploymentChainId: 8453, chainId: 8453, treasury } as never), /stablecoin/);
  assert.throws(() => launchFeeStableTx({ ...(config as object), treasury: null } as never), /stablecoin/);
  assert.throws(() => launchFeeEthTx({ ...(config as object), treasury: null } as never, { wei: "1", expiresAt: 1, mac: `0x${"11".repeat(32)}` }), /treasury/);
});

test("the wallet allows exactly the launch-fee transfers and nothing near them", () => {
  const stable = launchFeeStableTx(config);
  assert.equal(isLaunchFeeTx(config, stable), true);
  assert.equal(isLaunchFeeTx(config, { ...stable, value: 1n }), false, "no ETH may ride along with the stablecoin transfer");
  assert.equal(isLaunchFeeTx(config, { ...stable, data: `${stable.data.slice(0, -2)}01` as Hex }), false, "another amount");
  assert.equal(isLaunchFeeTx(config, { ...stable, to: weth.address }), false, "another token");
  assert.equal(isLaunchFeeTx(config, { to: treasury, data: "0x", value: 1n }), true, "a plain ETH transfer to the treasury");
  assert.equal(isLaunchFeeTx(config, { to: treasury, data: "0x", value: 0n }), false, "an empty transfer");
  assert.equal(isLaunchFeeTx(config, { to: treasury, data: "0x12345678", value: 1n }), false, "ETH with calldata");
  assert.equal(isLaunchFeeTx(config, { to: account, data: "0x", value: 1n }), false, "ETH to someone else");
});

// Ruling 1: the fee is consumed per creator, not per NFT, so it survives NFT changes; only a paid NFT draft sends it.
test("prepare carries a launch fee only for a paid NFT draft", () => {
  assert.deepEqual(prepareDraft(draftOf({ nft: other(), launchFee: stableFee })).launchFee, stableFee);
  assert.equal("launchFee" in prepareDraft(draftOf({ nft: muse(), launchFee: stableFee })), false, "a Muse is free; its prepare omits any fee");
  assert.equal("launchFee" in prepareDraft(draftOf({ launchFee: stableFee })), false, "a normal coin never sends a fee");
  assert.deepEqual(prepareDraft(draftOf({ nft: muse() })).nft, muse(), "the NFT itself is always sent");
});

// Ruling 2: NFT mode never falls back to a normal launch.
test("review waits in NFT mode until the NFT is confirmed and, for a paid NFT, the fee is paid", () => {
  const status = "This wallet does not hold the NFT and has no delegation for it.";
  assert.equal(nftReviewBlocker(false, draftOf(), status), null, "Normal mode is never blocked by the NFT step");
  assert.equal(nftReviewBlocker(true, draftOf(), status), status, "the step's status is the reason");
  assert.match(nftReviewBlocker(true, draftOf(), "") ?? "", /NFT/, "an empty status still blocks");
  assert.equal(nftReviewBlocker(true, draftOf({ nft: other() }), ""), "Pay the $10 launch fee for this NFT first.");
  assert.equal(nftReviewBlocker(true, draftOf({ nft: other(), launchFee: stableFee }), ""), null);
  assert.equal(nftReviewBlocker(true, draftOf({ nft: muse() }), ""), null, "Muses are free");
});

test("the NFT mode choice is restored from a saved draft", () => {
  assert.equal(savedNftMode(JSON.stringify({ name: "x", nftMode: true })), true, "NFT mode with a check still pending");
  assert.equal(savedNftMode(JSON.stringify({ name: "x", nft: muse() })), true);
  assert.equal(savedNftMode(JSON.stringify({ name: "x" })), false);
  assert.equal(savedNftMode("{broken"), false);
  assert.equal(savedNftMode(null), false);
});

// Ruling 3: a sent payment is persisted with its hash before confirmation and is re-checked on chain before use.
test("the launch-fee record lives under the intent's payment kind without replacing the first-buy payment", () => {
  const intent = "intent-12345678", key = launchFeeStorageKey(config, account, intent);
  const firstBuyPayment = launchIntentStorageKey(config, account, intent, "payment");
  assert(key.startsWith(firstBuyPayment), "scoped to the same chain, wallet and intent as other payments");
  assert.notEqual(key, firstBuyPayment, "the first-buy conversion record keeps its own key");
  assert.notEqual(key, launchFeeStorageKey(config, account, "intent-87654321"));
  assert.throws(() => launchFeeStorageKey(config, account, "bad"));
});

test("a stored launch-fee record round-trips with its pending marker; anything malformed is ignored", () => {
  const native = { asset: "native", txHash: `0x${"CD".repeat(32)}`, wei: "5000000000000000", expiresAt: 1_800_000_000, mac: `0x${"11".repeat(32)}` };
  assert.deepEqual(parseLaunchFeeRecord(JSON.stringify({ ...stableFee, pending: true })), { ...stableFee, pending: true });
  assert.deepEqual(parseLaunchFeeRecord(JSON.stringify(stableFee)), stableFee);
  assert.deepEqual(parseLaunchFeeRecord(JSON.stringify({ ...native, pending: true })), { ...native, txHash: native.txHash.toLowerCase(), pending: true });
  for (const raw of [null, "", "{", "[]", JSON.stringify({ asset: "stable" }), JSON.stringify({ ...stableFee, extra: 1 }),
    JSON.stringify({ ...native, wei: "0" }), JSON.stringify({ ...stableFee, pending: "yes" })])
    assert.equal(parseLaunchFeeRecord(raw), null, String(raw));
});

function receiptClient(receipt: { status: "success" | "reverted"; transactionHash: Hex }, replaced?: { reason: string; hash: Hex }) {
  const calls: { hash: Hex; confirmations?: number }[] = [];
  return { calls, client: { waitForTransactionReceipt: async (args: { hash: Hex; confirmations?: number; onReplaced?: (r: never) => void }) => {
    calls.push({ hash: args.hash, confirmations: args.confirmations });
    if (replaced) args.onReplaced?.({ reason: replaced.reason, transaction: { hash: replaced.hash } } as never);
    return receipt;
  } } };
}
test("a pending fee becomes usable only after two confirmations of a successful receipt", async () => {
  const hash = stableFee.txHash, { client, calls } = receiptClient({ status: "success", transactionHash: hash });
  assert.deepEqual(await settleLaunchFee(client as never, { ...stableFee, pending: true }), { status: "paid", fee: stableFee });
  assert.deepEqual(calls, [{ hash, confirmations: 2 }]);
});
test("a reverted, cancelled or replaced fee payment is refused; a repriced one keeps its new hash", async () => {
  const hash = stableFee.txHash, newer = `0x${"ef".repeat(32)}` as Hex;
  const reverted = await settleLaunchFee(receiptClient({ status: "reverted", transactionHash: hash }).client as never, { ...stableFee, pending: true });
  assert.equal(reverted.status, "failed");
  for (const reason of ["cancelled", "replaced"]) {
    const result = await settleLaunchFee(receiptClient({ status: "success", transactionHash: newer }, { reason, hash: newer }).client as never, stableFee);
    assert.equal(result.status, "failed", reason);
  }
  const repriced = await settleLaunchFee(receiptClient({ status: "success", transactionHash: newer }, { reason: "repriced", hash: newer }).client as never, stableFee);
  assert.deepEqual(repriced, { status: "paid", fee: { ...stableFee, txHash: newer } });
});
test("a receipt wait that times out or fails propagates, so the pending record stays", async () => {
  const client = { waitForTransactionReceipt: async () => { throw new Error("Timed out while waiting for transaction"); } };
  await assert.rejects(() => settleLaunchFee(client as never, { ...stableFee, pending: true }), /Timed out/);
});

test("a Muse name prefills only empty fields, and the symbol keeps up to 10 letters in upper case", () => {
  assert.deepEqual(musePrefill(draftOf({ name: "", symbol: "" }), "Bard of the 7 Seas"), { name: "Bard of the 7 Seas", symbol: "BARDOFTHES" });
  assert.deepEqual(musePrefill(draftOf({ name: "Mine", symbol: "" }), "Bard"), { symbol: "BARD" });
  assert.deepEqual(musePrefill(draftOf({ name: "", symbol: "MINE" }), "Bard"), { name: "Bard" });
  assert.deepEqual(musePrefill(draftOf({ name: "Mine", symbol: "MINE" }), "Bard"), {});
  assert.deepEqual(musePrefill(draftOf({ name: "  ", symbol: "" }), "7 8"), { name: "7 8" }, "no letters, no symbol");
  assert.equal(musePrefill(draftOf({ name: "", symbol: "" }), "x".repeat(40)).name?.length, 32);
});

test("readNftStatus asks the deployment chain's API with the canonical query", async () => {
  const original = globalThis.fetch, urls: string[] = [];
  globalThis.fetch = (async (url: string) => {
    urls.push(String(url));
    return new Response(JSON.stringify({ erc721: true, owner: account, controls: true, alreadyLaunched: false, free: true, name: "Bard" }),
      { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  try {
    const status = await readNftStatus({ mode: "fork", chainId: 31337, deploymentChainId: 4663 } as never, muse("12"), account);
    assert.equal(status.name, "Bard");
    assert.deepEqual(urls, [`/api/chains/4663/nft-status?nft=${encodeURIComponent(`4663:${MUSES.contract}:12`)}&account=${account}`]);
  } finally { globalThis.fetch = original; }
});

// ---- server: GET /api/nft-status -----------------------------------------------------------
async function httpFixture(run: (entry: ReturnType<typeof createApp>, origin: string) => Promise<void>) {
  const directory = mkdtempSync(join(tmpdir(), "nft-status-"));
  const runtime = runtimeFromEnv(4663, { NODE_ENV: "test", CHAIN_MODE: "fork", FORK_CHAIN_ID: "4663", DATA_DIR: directory,
    PLATFORM_TREASURY: "0x2222222222222222222222222222222222222222" });
  const entry = createApp(undefined, "loopback", runtime);
  const server = entry.app.listen(0, "127.0.0.1"); await once(server, "listening");
  const bound = server.address(); assert(bound && typeof bound !== "string");
  try { await run(entry, `http://127.0.0.1:${bound.port}`); }
  finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    entry.service.store.close(); rmSync(directory, { recursive: true, force: true });
  }
}

test("/api/nft-status is a read-class API that validates its query before any chain read", async () => {
  assert.equal(ingressClass("/api/nft-status"), "read");
  assert.equal(ingressClass(`/api/chains/4663/nft-status?nft=4663:${MUSES.contract}:1&account=${account}`), "read");
  await httpFixture(async ({ service }, origin) => {
    let reads = 0;
    (service as unknown as { client: unknown }).client = new Proxy({}, { get: () => { reads++; throw new Error("no chain reads expected"); } });
    const status = (query: string) => fetch(`${origin}/api/nft-status${query}`);
    for (const query of [`?nft=4663:${MUSES.contract}:1`, `?nft=4663:${MUSES.contract}:1&account=0x12`, `?account=${account}`,
      `?nft=4663:${MUSES.contract}:007&account=${account}`, `?nft=any&account=${account}`, `?nft=4663:${MUSES.contract}:1&account=${account}&account=${account}`])
      assert.equal((await status(query)).status, 400, query);
    const wrongChain = await status(`?nft=8453:${MUSES.contract}:1&account=${account}`);
    assert.equal(wrongChain.status, 422);
    assert.equal((await wrongChain.json()).code, "NFT_CHAIN_UNSUPPORTED");
    assert.equal(reads, 0);
  });
});

test("/api/nft-status passes the raw query to the service", async () => {
  await httpFixture(async ({ service }, origin) => {
    const received: unknown[] = [];
    service.nftStatus = async (nft, who) => { received.push([nft, who]); return { erc721: true, owner: account, controls: true, alreadyLaunched: false, free: true }; };
    const plain = await fetch(`${origin}/api/nft-status?nft=4663:${MUSES.contract}:1&account=${account}`);
    assert.equal(plain.status, 200);
    assert.deepEqual(received, [[`4663:${MUSES.contract}:1`, account]]);
    assert.equal((await plain.json()).free, true);
  });
});

const ERC721 = "0x80ac58cd", ERC8048 = "0xdf670be1";
function statusFixture(over: { owner?: Address; existing?: Set<string>; failName?: boolean; failAgent?: boolean; erc8048?: boolean } = {}) {
  const calls: string[] = [];
  const state = { failName: !!over.failName, failAgent: !!over.failAgent };
  const service = Object.assign(Object.create(LaunchpadService.prototype), {
    runtime: { config: { mode: "robinhood", chainId: 4663, deploymentChainId: 4663, treasury: null, writesEnabled: false, blockReason: null } },
    assertNetwork: async () => {},
    store: { verifiedNftCoin: async (key: string) => over.existing?.has(key) ? { address: account } : null },
    client: {
      readContract: async ({ functionName, args }: { functionName: string; args: readonly unknown[] }) => {
        calls.push(functionName === "supportsInterface" ? `supportsInterface:${args[0]}` : functionName);
        if (functionName === "supportsInterface") return args[0] === ERC721 || (args[0] === ERC8048 && over.erc8048 !== false);
        if (functionName === "ownerOf") return over.owner ?? account;
        if (functionName === "checkDelegateForERC721") return false;
        if (functionName === "metadata") { if (state.failName) throw new Error("rpc down"); return stringToHex(`Muse ${args[0]}`); }
        if (functionName === "agentOf") { if (state.failAgent) throw new Error("rpc down"); return [`0x${"00".repeat(32)}`, 6592n]; }
        throw new Error(`unexpected ${functionName}`);
      },
    },
  }) as LaunchpadService;
  return { service, calls, state };
}

test("nftStatus reports control, the one-coin rule and the free tier, with a Muse's name and agent", async () => {
  const { service } = statusFixture();
  assert.deepEqual(await service.nftStatus(`4663:${MUSES.contract.toLowerCase()}:1`, account.toLowerCase()),
    { erc721: true, owner: account, controls: true, alreadyLaunched: false, free: true, name: "Muse 1", agentId: "6592" });
  const launched = statusFixture({ existing: new Set([nftKey(other())]), owner: getAddress("0x3333333333333333333333333333333333333333") });
  assert.deepEqual(await launched.service.nftStatus(`4663:${other().contract}:5`, account),
    { erc721: true, owner: getAddress("0x3333333333333333333333333333333333333333"), controls: false, alreadyLaunched: true, free: false });
  assert.deepEqual(launched.calls.filter((call) => ["metadata", "agentOf", `supportsInterface:${ERC8048}`].includes(call)), [], "only Muses read a profile");
});

test("a failed Muse name or agent read is omitted, never failing the status, and is asked again next time", async () => {
  const { service, calls, state } = statusFixture({ failName: true });
  const first = await service.nftStatus(`4663:${MUSES.contract}:2`, account);
  assert.equal("name" in first, false);
  assert.equal(first.agentId, "6592");
  assert.equal(first.controls, true);
  state.failName = false;
  calls.length = 0;
  const second = await service.nftStatus(`4663:${MUSES.contract}:2`, account);
  assert.equal(second.name, "Muse 2");
  assert.deepEqual(calls.filter((call) => call === "metadata" || call === "agentOf"), ["metadata"], "the cached agent id is not read again");
  calls.length = 0;
  await service.nftStatus(`4663:${MUSES.contract}:2`, account);
  assert.deepEqual(calls.filter((call) => call === "metadata" || call === "agentOf"), [], "both successes are cached");
  const unsupported = statusFixture({ erc8048: false, failAgent: true });
  const bare = await unsupported.service.nftStatus(`4663:${MUSES.contract}:3`, account);
  assert.equal("name" in bare || "agentId" in bare, false);
  assert.equal(unsupported.calls.includes("metadata"), false, "no metadata read without ERC-8048 support");
});

test("nftStatus refuses another chain's NFT before any read", async () => {
  const { service, calls } = statusFixture();
  await assert.rejects(() => service.nftStatus(`8453:${MUSES.contract}:1`, account), (error: { code?: string }) => error.code === "NFT_CHAIN_UNSUPPORTED");
  assert.deepEqual(calls, []);
});
