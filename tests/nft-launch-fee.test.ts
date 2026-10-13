import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { TransactionReceiptNotFoundError, encodeEventTopics, erc20Abi, encodeAbiParameters, getAddress, type Address, type Hex } from "viem";
import { launchFeeQuoteMac, verifyLaunchFeeQuoteMac, verifyLaunchFeePayment, NftLaunchError } from "../server/nft-launch";
import { LAUNCH_FEE_STABLE, type LaunchFee } from "../src/lib/launch-fee";
import { LaunchpadService } from "../server/service";
import { createApp } from "../server/app";
import { runtimeFromEnv } from "../server/config";
import { Store } from "../server/store";
import { SupabaseStore } from "../server/supabase-store";
import { ROBINHOOD_STOCKS, sameAddress, type RuntimeConfig } from "../src/lib/config";
import { syntheticToken } from "./fixtures";

// getAddress: the brief's literal is mixed-case with an invalid checksum, which viem's strict encodeEventTopics rejects.
const key = "k".repeat(32), payer = getAddress("0xAAAA000000000000000000000000000000000001");
const ops = "0xc4F87C3715374445C4657aa14c47CBB339b59d1A" as Address, usdg = LAUNCH_FEE_STABLE[4663]!;
const hash = `0x${"11".repeat(32)}` as Hex, stranger = getAddress("0xCCCC000000000000000000000000000000000003");
const transferLog = (from: Address, to: Address, value: bigint) => ({ address: usdg.address,
  topics: encodeEventTopics({ abi: erc20Abi, eventName: "Transfer", args: { from, to } }),
  data: encodeAbiParameters([{ type: "uint256" }], [value]) });
const client = (receipt: object, tx: object = {}, timestamp = 1000n, head = 100n) => ({
  getTransactionReceipt: async () => ({ status: "success", blockNumber: 10n, blockHash: `0x${"22".repeat(32)}`, from: payer, logs: [], ...receipt }),
  getTransaction: async () => ({ from: payer, to: ops, value: 0n, ...tx }),
  getBlock: async () => ({ hash: `0x${"22".repeat(32)}`, timestamp }),
  getBlockNumber: async () => head,
}) as never;
const codeOf = async (p: Promise<unknown>) => p.then(() => "ok", (e) => e instanceof NftLaunchError ? e.code : String(e));

test("the quote MAC has its own domain and binds payer, amount and expiry", () => {
  const mac = launchFeeQuoteMac(key, 4663, payer, "5000000000000000", 2000);
  assert.equal(verifyLaunchFeeQuoteMac([key], 4663, payer, "5000000000000000", 2000, mac), true);
  assert.equal(verifyLaunchFeeQuoteMac([key], 4663, payer, "4000000000000000", 2000, mac), false);
  assert.equal(verifyLaunchFeeQuoteMac([key], 8453, payer, "5000000000000000", 2000, mac), false);
  assert.equal(verifyLaunchFeeQuoteMac([key], 4663, ops, "5000000000000000", 2000, mac), false);
});

test("the quote MAC rejects a changed expiry, a wrong or missing key and malformed input", () => {
  const mac = launchFeeQuoteMac(key, 4663, payer, "5000000000000000", 2000);
  assert.equal(verifyLaunchFeeQuoteMac([key], 4663, payer, "5000000000000000", 2001, mac), false);
  assert.equal(verifyLaunchFeeQuoteMac(["j".repeat(32)], 4663, payer, "5000000000000000", 2000, mac), false);
  assert.equal(verifyLaunchFeeQuoteMac([], 4663, payer, "5000000000000000", 2000, mac), false);
  assert.equal(verifyLaunchFeeQuoteMac([key], 4663, payer, "5000000000000000", 2000, mac.toUpperCase().replace("0X", "0x")), true, "hex case is not significant");
  for (const bad of [undefined, null, 5, "", "0x", mac.slice(0, -2), `${mac}00`, mac.replace("0x", "0z")])
    assert.equal(verifyLaunchFeeQuoteMac([key], 4663, payer, "5000000000000000", 2000, bad), false);
  assert.equal(verifyLaunchFeeQuoteMac(["j".repeat(32), key], 4663, payer, "5000000000000000", 2000, mac), true, "a retained previous key still verifies");
});

test("the quote MAC is domain-separated from the plan attestation", async () => {
  const { planAttestation } = await import("../server/plan-attestation");
  const id = `0x${"ab".repeat(32)}` as Hex;
  assert.notEqual(launchFeeQuoteMac(key, 4663, payer, "1", 1), planAttestation(key, 4663, id));
  assert.equal(verifyLaunchFeeQuoteMac([key], 4663, payer, "1", 1, planAttestation(key, 4663, id)), false);
});

test("a USDG payment needs an exact 10 USDG transfer from the payer to the operations wallet", async () => {
  const fee = { asset: "stable" as const, txHash: hash };
  const args = { fee, payer, recipient: ops, chainId: 4663 as const, keys: [key] };
  assert.equal(await codeOf(verifyLaunchFeePayment(client({ logs: [transferLog(payer, ops, usdg.amount)] }), args)), "ok");
  assert.equal(await codeOf(verifyLaunchFeePayment(client({ logs: [transferLog(payer, ops, usdg.amount - 1n)] }), args)), "NFT_FEE_INVALID");
  assert.equal(await codeOf(verifyLaunchFeePayment(client({ logs: [transferLog(ops, payer, usdg.amount)] }), args)), "NFT_FEE_INVALID");
  assert.equal(await codeOf(verifyLaunchFeePayment(client({ logs: [transferLog(payer, ops, usdg.amount)] }, {}, 1000n, 10n), args)), "NFT_FEE_INVALID");
  assert.equal(await codeOf(verifyLaunchFeePayment(client({ status: "reverted", logs: [transferLog(payer, ops, usdg.amount)] }), args)), "NFT_FEE_INVALID");
});

test("a USDG payment is refused when the stablecoin is another token, the sender differs or the chain has none", async () => {
  const fee = { asset: "stable" as const, txHash: hash };
  const args = { fee, payer, recipient: ops, chainId: 4663 as const, keys: [key] };
  const foreign = { ...transferLog(payer, ops, usdg.amount), address: "0x1111111111111111111111111111111111111111" as Address };
  assert.equal(await codeOf(verifyLaunchFeePayment(client({ logs: [foreign] }), args)), "NFT_FEE_INVALID", "a token that merely emits a Transfer is not USDG");
  assert.equal(await codeOf(verifyLaunchFeePayment(client({ logs: [{ ...transferLog(payer, ops, usdg.amount), data: "0x" }] }), args)), "NFT_FEE_INVALID", "an undecodable log is no payment");
  assert.equal(await codeOf(verifyLaunchFeePayment(client({ from: ops, logs: [transferLog(payer, ops, usdg.amount)] }), args)), "NFT_FEE_INVALID", "another wallet cannot spend this payer's transfer");
  assert.equal(await codeOf(verifyLaunchFeePayment(client({ logs: [transferLog(payer, ops, usdg.amount)] }), { ...args, chainId: 8453 as const })), "NFT_FEE_INVALID", "Base has no stablecoin fee");
  assert.equal(await codeOf(verifyLaunchFeePayment(client({ logs: [transferLog(payer, ops, usdg.amount + 1n)] }), args)), "NFT_FEE_INVALID", "the stable fee is exact, not at-least");
});

test("an unmined hash is an invalid fee, while a node failure propagates as itself", async () => {
  const args = { fee: { asset: "stable" as const, txHash: hash }, payer, recipient: ops, chainId: 4663 as const, keys: [key] };
  const failing = (error: Error) => ({ getTransactionReceipt: async () => { throw error; } }) as never;
  assert.equal(await codeOf(verifyLaunchFeePayment(failing(new TransactionReceiptNotFoundError({ hash })), args)), "NFT_FEE_INVALID");
  assert.equal(await codeOf(verifyLaunchFeePayment(failing(new Error("rpc down")), args)), "Error: rpc down");
});

test("an ETH payment needs the quoted wei, a valid MAC and a block within expiry plus 10 minutes", async () => {
  const wei = "5000000000000000", expiresAt = 2000;
  const fee = { asset: "native" as const, txHash: hash, wei, expiresAt, mac: launchFeeQuoteMac(key, 4663, payer, wei, expiresAt) };
  const args = { fee, payer, recipient: ops, chainId: 4663 as const, keys: [key] };
  assert.equal(await codeOf(verifyLaunchFeePayment(client({}, { value: 5000000000000000n }, 2000n + 600n), args)), "ok");
  assert.equal(await codeOf(verifyLaunchFeePayment(client({}, { value: 5000000000000000n }, 2000n + 601n), args)), "NFT_FEE_INVALID");
  assert.equal(await codeOf(verifyLaunchFeePayment(client({}, { value: 4999999999999999n }), args)), "NFT_FEE_INVALID");
  assert.equal(await codeOf(verifyLaunchFeePayment(client({}, { value: 5000000000000000n }), { ...args, keys: [] })), "NFT_FEE_INVALID");
  assert.equal(await codeOf(verifyLaunchFeePayment(client({}, { value: 5000000000000000n, from: ops }), args)), "NFT_FEE_INVALID");
});

test("an ETH payment also fails on a wrong recipient, a forged quote, a reorganized block or too few confirmations", async () => {
  const wei = "5000000000000000", expiresAt = 2000;
  const mac = launchFeeQuoteMac(key, 4663, payer, wei, expiresAt);
  const fee = { asset: "native" as const, txHash: hash, wei, expiresAt, mac };
  const args = { fee, payer, recipient: ops, chainId: 4663 as const, keys: [key] };
  const paid = { value: 5000000000000000n };
  assert.equal(await codeOf(verifyLaunchFeePayment(client({}, { ...paid, value: 6000000000000000n }, 2000n), args)), "ok", "paying more than the quote is accepted");
  assert.equal(await codeOf(verifyLaunchFeePayment(client({}, { ...paid, to: payer }, 2000n), args)), "NFT_FEE_INVALID", "the recipient is the operations wallet");
  assert.equal(await codeOf(verifyLaunchFeePayment(client({}, { ...paid, to: null }, 2000n), args)), "NFT_FEE_INVALID", "a contract creation is no payment");
  assert.equal(await codeOf(verifyLaunchFeePayment(client({}, paid, 2000n), { ...args, fee: { ...fee, wei: "4000000000000000" } })), "NFT_FEE_INVALID", "a quote with a lowered amount fails its MAC");
  assert.equal(await codeOf(verifyLaunchFeePayment(client({}, paid, 2000n), { ...args, fee: { ...fee, expiresAt: 9_999_999 } })), "NFT_FEE_INVALID", "a quote with a stretched expiry fails its MAC");
  assert.equal(await codeOf(verifyLaunchFeePayment(client({}, paid, 2000n), { ...args, fee: { ...fee, mac: undefined } })), "NFT_FEE_INVALID");
  assert.equal(await codeOf(verifyLaunchFeePayment(client({}, paid, 2000n), { ...args, fee: { asset: "native", txHash: hash } as LaunchFee })), "NFT_FEE_INVALID", "an unquoted ETH fee is refused");
  assert.equal(await codeOf(verifyLaunchFeePayment(client({ blockHash: `0x${"33".repeat(32)}` }, paid, 2000n), args)), "NFT_FEE_INVALID", "the receipt's block was reorganized away");
  assert.equal(await codeOf(verifyLaunchFeePayment(client({}, paid, 2000n, 10n), args)), "NFT_FEE_INVALID", "one confirmation is not enough");
  assert.equal(await codeOf(verifyLaunchFeePayment(client({}, paid, 2000n, 11n), args)), "ok", "two confirmations are");
  assert.equal(await codeOf(verifyLaunchFeePayment(client({}, paid, 2000n), { ...args, chainId: 8453 as const })), "NFT_FEE_INVALID", "the MAC is bound to the chain");
});

// ---- stores ------------------------------------------------------------------------------
test("a used fee is refused for the same payer", () => {
  const directory = mkdtempSync(join(tmpdir(), "nft-fee-store-"));
  const store = new Store(directory, 4663);
  try {
    assert.equal(store.tokenUsingLaunchFee(hash, payer), null);
    store.saveToken(syntheticToken({ mode: "robinhood", creator: payer, launchFee: { asset: "stable", txHash: hash } }));
    assert.equal(store.tokenUsingLaunchFee(hash, payer)?.symbol, "SYNTH");
    assert.equal(store.tokenUsingLaunchFee(hash.toUpperCase().replace("0X", "0x") as Hex, payer)?.symbol, "SYNTH", "the hash compares case-insensitively");
    assert.equal(store.tokenUsingLaunchFee(hash, payer.toLowerCase()) !== null, true, "the creator compares case-insensitively");
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("another wallet's coin carrying the hash does not consume it", () => {
  const directory = mkdtempSync(join(tmpdir(), "nft-fee-store-"));
  const store = new Store(directory, 4663);
  const someoneElse = getAddress("0xBBBB000000000000000000000000000000000002");
  try {
    store.saveToken(syntheticToken({ mode: "robinhood", creator: someoneElse, launchFee: { asset: "stable", txHash: hash } }));
    assert.equal(store.tokenUsingLaunchFee(hash, payer), null);
    assert.equal(store.tokenUsingLaunchFee(`0x${"99".repeat(32)}`, someoneElse), null, "a different hash is a different fee");
    assert.notEqual(store.tokenUsingLaunchFee(hash, someoneElse), null);
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("the Supabase store queries the same hash-and-creator predicate", async () => {
  const store = new SupabaseStore("https://fixture.supabase.co", "test-server-key", "verify-fee");
  let path = "";
  store.request = async <T>(requested: string) => { path = requested; return [{ payload: syntheticToken({ creator: payer, launchFee: { asset: "stable", txHash: hash } }) }] as T; };
  const found = await store.tokenUsingLaunchFee(hash.toUpperCase().replace("0X", "0x"), "0xAAAA000000000000000000000000000000000001");
  assert.equal(found?.symbol, "SYNTH");
  const query = decodeURIComponent(path);
  for (const part of ["scope=eq.verify-fee", `payload->launchFee->>txHash=eq.${hash}`, `payload->>creator=ilike.${payer.toLowerCase()}`, "limit=1"])
    assert(query.includes(part), `missing ${part} in ${query}`);
  store.request = async <T>() => [] as T;
  assert.equal(await store.tokenUsingLaunchFee(hash, payer), null);
});

// ---- service -----------------------------------------------------------------------------
const nftModeOn: NonNullable<RuntimeConfig["nftMode"]> = { enabled: true, vaultFactory: null, launchFeeUsd: 10, freeCollections: [], verifiedCollections: [] };
function feeService(options: { price?: string; key?: string | null; previous?: string[]; treasury?: Address | null; nftMode?: RuntimeConfig["nftMode"]; store?: object; tx?: object; timestamp?: bigint } = {}) {
  const calls = { valuations: 0, valued: [] as Address[] };
  const config = { mode: "robinhood", chainId: 4663, deploymentChainId: 4663, treasury: options.treasury === null ? undefined : options.treasury ?? ops,
    writesEnabled: true, blockReason: null, nftMode: options.nftMode ?? nftModeOn } as RuntimeConfig;
  const service = Object.assign(Object.create(LaunchpadService.prototype), {
    runtime: { config, secrets: { planAttestationKey: options.key === null ? undefined : options.key ?? key, planAttestationPreviousKeys: options.previous ?? [] } },
    client: client({ logs: [transferLog(payer, ops, usdg.amount)] }, options.tx, options.timestamp),
    store: options.store ?? { tokenUsingLaunchFee: async () => null },
    openingValuation: async (address: Address) => { calls.valuations++; calls.valued.push(address); return { quotePriceUsd: options.price ?? "2000" }; },
  }) as LaunchpadService;
  return { service, calls };
}
const weth = ROBINHOOD_STOCKS.find((asset) => asset.symbol === "WETH")!;

test("launchFeeQuote prices $10 in wei from the WETH opening valuation and signs it for this payer", async () => {
  const { service, calls } = feeService({ price: "2000" });
  const before = Date.now();
  const quote = await service.launchFeeQuote(payer);
  assert.equal(quote.wei, "5000000000000000", "10 / 2000 ETH");
  assert.equal(calls.valuations, 1);
  assert(calls.valued.length === 1 && sameAddress(calls.valued[0], weth.address), "the ETH price comes from the WETH reference");
  assert(quote.expiresAt >= Math.floor((before + 60_000) / 1000) && quote.expiresAt <= Math.floor((Date.now() + 60_000) / 1000), "the quote lives 60 seconds, in seconds");
  assert.equal(verifyLaunchFeeQuoteMac([key], 4663, payer, quote.wei, quote.expiresAt, quote.mac), true);
  assert.equal(verifyLaunchFeeQuoteMac([key], 4663, stranger, quote.wei, quote.expiresAt, quote.mac), false, "another wallet cannot reuse it");
  assert.deepEqual(quote.stable, { address: usdg.address, amount: "10000000" });
  assert.equal((await feeService({ price: "3000" }).service.launchFeeQuote(payer)).wei, "3333333333333334", "the wei amount rounds up, never under $10");
  assert.equal((await feeService({ price: "0.000001" }).service.launchFeeQuote(payer)).wei, (10n * 10n ** 24n).toString(), "a tiny price stays exact");
});

test("launchFeeQuote fails closed without a plan-attestation key, a usable price or NFT mode", async () => {
  const noKey = feeService({ key: null });
  assert.equal(await codeOf(noKey.service.launchFeeQuote(payer)), "NFT_FEE_INVALID");
  assert.equal(noKey.calls.valuations, 0, "no price is fetched for a quote that cannot be signed");
  for (const price of ["0", "-1", "abc", "", "NaN"])
    assert.equal(await codeOf(feeService({ price }).service.launchFeeQuote(payer)), "NFT_FEE_INVALID", `price ${JSON.stringify(price)}`);
  const off = feeService({ nftMode: { ...nftModeOn, enabled: false } });
  assert.equal(await codeOf(off.service.launchFeeQuote(payer)), "NFT_MODE_DISABLED");
  assert.equal(off.calls.valuations, 0);
  assert.match(await codeOf(feeService().service.launchFeeQuote("not-an-address")), /ZodError|Invalid|address/i, "a malformed payer is a validation error, not a quote");
});

test("assertUnusedLaunchFee accepts a fresh payment, refuses a used one and a foreign payer's", async () => {
  const directory = mkdtempSync(join(tmpdir(), "nft-fee-service-"));
  const store = new Store(directory, 4663);
  try {
    const { service } = feeService({ store });
    const fee: LaunchFee = { asset: "stable", txHash: hash };
    assert.equal(await codeOf(service.assertUnusedLaunchFee(fee, payer)), "ok");
    store.saveToken(syntheticToken({ mode: "robinhood", creator: payer, launchFee: fee }));
    assert.equal(await codeOf(service.assertUnusedLaunchFee(fee, payer)), "NFT_FEE_USED");
    assert.equal(await codeOf(service.assertUnusedLaunchFee(fee, stranger)), "NFT_FEE_INVALID", "the transfer was sent by the payer, so nobody else can claim it");
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("assertUnusedLaunchFee pays the platform treasury and verifies ETH quotes against the current and previous keys", async () => {
  const wei = "5000000000000000", expiresAt = 2000, old = "o".repeat(32);
  const eth = (signingKey: string): LaunchFee => ({ asset: "native", txHash: hash, wei, expiresAt, mac: launchFeeQuoteMac(signingKey, 4663, payer, wei, expiresAt) });
  const make = (options: Parameters<typeof feeService>[0], value = 5000000000000000n) =>
    feeService({ ...options, tx: { value }, timestamp: 2000n }).service;
  assert.equal(await codeOf(make({}).assertUnusedLaunchFee(eth(key), payer)), "ok");
  assert.equal(await codeOf(make({ key: "n".repeat(32), previous: [key] }).assertUnusedLaunchFee(eth(key), payer)), "ok", "a quote signed before a key rotation still counts");
  assert.equal(await codeOf(make({ key: "n".repeat(32) }).assertUnusedLaunchFee(eth(old), payer)), "NFT_FEE_INVALID");
  assert.equal(await codeOf(make({ key: null }).assertUnusedLaunchFee(eth(key), payer)), "NFT_FEE_INVALID", "no key, no ETH fee");
  assert.equal(await codeOf(make({}, 4999999999999999n).assertUnusedLaunchFee(eth(key), payer)), "NFT_FEE_INVALID");
  const noTreasury = make({ treasury: null });
  assert.equal(await codeOf(noTreasury.assertUnusedLaunchFee(eth(key), payer)), "Error: The platform treasury is not configured.");
  // The recipient is the configured treasury, not a request value.
  const elsewhere = make({ treasury: "0x3333333333333333333333333333333333333333" as Address });
  assert.equal(await codeOf(elsewhere.assertUnusedLaunchFee(eth(key), payer)), "NFT_FEE_INVALID");
});

// ---- HTTP --------------------------------------------------------------------------------
test("GET /api/launch-fee-quote returns a signed quote, and refuses without a key or a payer", async () => {
  const directory = mkdtempSync(join(tmpdir(), "nft-fee-http-"));
  const environment = { NODE_ENV: "test", CHAIN_MODE: "fork", FORK_CHAIN_ID: "4663", DATA_DIR: directory, NFT_MODE_ENABLED: "true",
    PLATFORM_TREASURY: "0x2222222222222222222222222222222222222222" };
  const open = async (extra: Record<string, string>) => {
    const entry = createApp(undefined, "loopback", runtimeFromEnv(4663, { ...environment, ...extra }));
    const server = entry.app.listen(0, "127.0.0.1"); await once(server, "listening");
    const address = server.address(); assert(address && typeof address !== "string");
    entry.service.openingValuation = (async () => ({ quotePriceUsd: "2500" })) as never;
    return { entry, server, base: `http://127.0.0.1:${address.port}` };
  };
  const closed: (() => Promise<void>)[] = [];
  try {
    const keyless = await open({}); closed.push(() => new Promise<void>((resolve) => keyless.server.close(() => { keyless.entry.service.store.close(); resolve(); })));
    const refused = await fetch(`${keyless.base}/api/launch-fee-quote?payer=${payer}`);
    assert.equal(refused.status, 422);
    assert.equal((await refused.json() as { code: string }).code, "NFT_FEE_INVALID");

    const keyed = await open({ PLAN_ATTESTATION_KEY: key }); closed.push(() => new Promise<void>((resolve) => keyed.server.close(() => { keyed.entry.service.store.close(); resolve(); })));
    const response = await fetch(`${keyed.base}/api/launch-fee-quote?payer=${payer}`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    const quote = await response.json() as { wei: string; expiresAt: number; mac: Hex; stable: { address: string; amount: string } };
    assert.equal(quote.wei, "4000000000000000", "10 / 2500 ETH");
    assert.equal(verifyLaunchFeeQuoteMac([key], 4663, payer, quote.wei, quote.expiresAt, quote.mac), true);
    assert.equal(quote.stable.amount, "10000000");
    assert.equal((await fetch(`${keyed.base}/api/launch-fee-quote`)).status, 400, "a missing payer is a validation error");
    assert.equal((await fetch(`${keyed.base}/api/launch-fee-quote?payer=0x1234`)).status, 400);
  } finally { for (const close of closed) await close(); rmSync(directory, { recursive: true, force: true }); }
});
