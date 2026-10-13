import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { TransactionNotFoundError, TransactionReceiptNotFoundError, encodeEventTopics, erc20Abi, encodeAbiParameters, getAddress, type Address, type Hex } from "viem";
import { launchFeeQuoteMac, verifyLaunchFeeQuoteMac, verifyLaunchFeePayment, NftLaunchError } from "../server/nft-launch";
import { LAUNCH_FEE_MIN_BLOCK, LAUNCH_FEE_STABLE, type LaunchFee } from "../src/lib/launch-fee";
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
const BLOCK = LAUNCH_FEE_MIN_BLOCK[4663]!, txHash = hash;
// Case-insensitivity needs a hash with a-f letters: upper-casing a digits-only hash changes nothing.
const lettered = `0x${"ab".repeat(32)}` as Hex, upper = (value: string) => value.toUpperCase().replace("0X", "0x") as Hex;
// The receipt sits 10 blocks after the first block that can hold a launch fee, with 90 more blocks on top of it.
const client = (receipt: object, tx: object = {}, timestamp = 1000n, head = BLOCK + 100n) => ({
  getTransactionReceipt: async () => ({ status: "success", transactionHash: txHash, blockNumber: BLOCK + 10n, blockHash: `0x${"22".repeat(32)}`, from: payer, logs: [], ...receipt }),
  getTransaction: async () => ({ from: payer, to: ops, value: 0n, input: "0x", ...tx }),
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
  assert.equal(await codeOf(verifyLaunchFeePayment(client({ logs: [transferLog(payer, ops, usdg.amount)] }, {}, 1000n, BLOCK + 10n), args)), "NFT_FEE_INVALID");
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

/** No receipt: the node knows the transaction (`pending`, still in its mempool, with `tx` replacing its fields), has never seen it
 * (`missing`), or its lookup fails. */
const unmined = (transaction: "pending" | "missing" | Error, tx: object = {}) => ({
  getTransactionReceipt: async () => { throw new TransactionReceiptNotFoundError({ hash }); },
  getTransaction: async () => {
    if (transaction instanceof Error) throw transaction;
    if (transaction === "missing") throw new TransactionNotFoundError({ hash });
    return { from: payer, to: usdg.address, value: 0n, input: "0x", ...tx };
  },
}) as never;

test("a transaction still in the mempool is only a pending payment when it can still become one: another sender's, or a wrong ETH transfer, is final", async () => {
  const kind = async (p: Promise<unknown>) => p.then(() => "ok", (e) => e instanceof NftLaunchError ? (e.retry ? `retry:${e.retry}` : `${e.code}:${e.message}`) : "node");
  const stable = { fee: { asset: "stable" as const, txHash: hash }, payer, recipient: ops, chainId: 4663 as const, keys: [key] };
  assert.equal(await kind(verifyLaunchFeePayment(unmined("pending", { to: stranger }), stable)), "retry:unconfirmed", "a token payment may go through a wallet contract");
  assert.equal(await kind(verifyLaunchFeePayment(unmined("pending", { from: stranger }), stable)),
    "NFT_FEE_INVALID:The launch fee payment is not valid: it was not sent by this wallet.");
  const wei = "5000000000000000", expiresAt = 2000;
  const native = { ...stable, fee: { asset: "native" as const, txHash: hash, wei, expiresAt, mac: launchFeeQuoteMac(key, 4663, payer, wei, expiresAt) } };
  assert.equal(await kind(verifyLaunchFeePayment(unmined("pending", { to: ops, value: 5000000000000000n }), native)), "retry:unconfirmed");
  for (const tx of [{ to: stranger, value: 5000000000000000n }, { to: ops, value: 1n }, { to: ops, value: 5000000000000000n, input: "0xdeadbeef" }, { to: null, value: 5000000000000000n }])
    assert.match(await kind(verifyLaunchFeePayment(unmined("pending", tx), native)), /^NFT_FEE_INVALID:/, JSON.stringify(tx, (_k, v) => typeof v === "bigint" ? String(v) : v));
});

test("an unmined hash is an invalid fee, while a node failure propagates as itself", async () => {
  const args = { fee: { asset: "stable" as const, txHash: hash }, payer, recipient: ops, chainId: 4663 as const, keys: [key] };
  const failing = (error: Error) => ({ getTransactionReceipt: async () => { throw error; } }) as never;
  assert.equal(await codeOf(verifyLaunchFeePayment(unmined("missing"), args)), "NFT_FEE_INVALID");
  assert.equal(await codeOf(verifyLaunchFeePayment(unmined("pending"), args)), "NFT_FEE_INVALID");
  assert.equal(await codeOf(verifyLaunchFeePayment(failing(new Error("rpc down")), args)), "Error: rpc down");
  assert.equal(await codeOf(verifyLaunchFeePayment(unmined(new Error("rpc down")), args)), "Error: rpc down", "a failed transaction lookup is the node's too");
});

test("a fee still confirming, reorganized or not found is retryable, marked by kind; every definite mismatch is final", async () => {
  // "retry:<kind>": NFT_FEE_INVALID that can still change; "node": the node's own error; otherwise the final code.
  const kind = async (p: Promise<unknown>) => p.then(() => "ok", (e) => e instanceof NftLaunchError ? (e.retry ? `retry:${e.retry}:${e.message}` : e.code) : "node");
  const stable = { fee: { asset: "stable" as const, txHash: hash }, payer, recipient: ops, chainId: 4663 as const, keys: [key] };
  const paid = { logs: [transferLog(payer, ops, usdg.amount)] };
  const failing = (error: Error) => ({ getTransactionReceipt: async () => { throw error; } }) as never;
  assert.equal(await kind(verifyLaunchFeePayment(unmined("missing"), stable)),
    "retry:missing:The launch fee payment is not valid: the transaction has not been mined yet.", "a hash the chain has never seen; the wording prepare shows is unchanged");
  assert.equal(await kind(verifyLaunchFeePayment(unmined("pending"), stable)),
    "retry:unconfirmed:The launch fee payment is not valid: the transaction has not been mined yet.", "a known transaction still in the mempool");
  assert.equal(await kind(verifyLaunchFeePayment(client(paid, {}, 1000n, BLOCK + 10n), stable)), "retry:unconfirmed:The launch fee payment is not valid: wait for two confirmations.");
  assert.equal(await kind(verifyLaunchFeePayment(client({ ...paid, blockHash: `0x${"33".repeat(32)}` }), stable)), "retry:unconfirmed:The launch fee payment is not valid: the block was reorganized.");
  assert.equal(await kind(verifyLaunchFeePayment(failing(new Error("rpc down")), stable)), "node");
  assert.equal(await kind(verifyLaunchFeePayment(client({ ...paid, blockNumber: BLOCK - 1n }), stable)), "NFT_FEE_INVALID", "a block below the minimum is final");
  const foreignToken = { ...transferLog(payer, ops, usdg.amount), address: "0x1111111111111111111111111111111111111111" as Address };
  for (const [why, receipt] of [["wrong amount", { logs: [transferLog(payer, ops, usdg.amount - 1n)] }], ["wrong recipient", { logs: [transferLog(payer, stranger, usdg.amount)] }],
    ["wrong asset", { logs: [foreignToken] }], ["wrong payer", { ...paid, from: stranger }], ["reverted", { ...paid, status: "reverted" }]] as const)
    assert.equal(await kind(verifyLaunchFeePayment(client(receipt), stable)), "NFT_FEE_INVALID", why);
  const wei = "5000000000000000", expiresAt = 2000;
  const native = { ...stable, fee: { asset: "native" as const, txHash: hash, wei, expiresAt, mac: launchFeeQuoteMac(key, 4663, payer, wei, expiresAt) } };
  assert.equal(await kind(verifyLaunchFeePayment(client({}, { value: 5000000000000000n }, 2000n), native)), "ok");
  for (const [why, tx, args] of [["invalid MAC", {}, { ...native, keys: ["j".repeat(32)] }], ["not a plain transfer", { input: "0xdeadbeef" }, native],
    ["wrong recipient", { to: stranger }, native], ["too little", { value: 4999999999999999n }, native]] as const)
    assert.equal(await kind(verifyLaunchFeePayment(client({}, { value: 5000000000000000n, ...tx }, 2000n), args)), "NFT_FEE_INVALID", why);
});

test("an ETH payment needs the quoted wei, a valid MAC and a block within expiry plus 10 minutes", async () => {
  const wei = "5000000000000000", expiresAt = 2000;
  const fee = { asset: "native" as const, txHash: hash, wei, expiresAt, mac: launchFeeQuoteMac(key, 4663, payer, wei, expiresAt) };
  const args = { fee, payer, recipient: ops, chainId: 4663 as const, keys: [key] };
  assert.equal(await codeOf(verifyLaunchFeePayment(client({}, { value: 5000000000000000n }, 2000n + 600n), args)), "ok");
  assert.equal(await codeOf(verifyLaunchFeePayment(client({}, { value: 5000000000000000n }, 2000n + 601n), args)), "NFT_FEE_INVALID");
  assert.equal(await codeOf(verifyLaunchFeePayment(client({}, { value: 4999999999999999n }, 2000n), args)), "NFT_FEE_INVALID");
  assert.equal(await codeOf(verifyLaunchFeePayment(client({}, { value: 5000000000000000n }, 2000n), { ...args, keys: [] })), "NFT_FEE_INVALID");
  assert.equal(await codeOf(verifyLaunchFeePayment(client({}, { value: 5000000000000000n, from: ops }, 2000n), args)), "NFT_FEE_INVALID");
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
  assert.equal(await codeOf(verifyLaunchFeePayment(client({}, paid, 2000n, BLOCK + 10n), args)), "NFT_FEE_INVALID", "one confirmation is not enough");
  assert.equal(await codeOf(verifyLaunchFeePayment(client({}, paid, 2000n, BLOCK + 11n), args)), "ok", "two confirmations are");
  assert.equal(await codeOf(verifyLaunchFeePayment(client({}, paid, 2000n), { ...args, chainId: 8453 as const })), "NFT_FEE_INVALID", "the MAC is bound to the chain");
});

test("a payment must be recent enough: a USDG transfer below the minimum block and an ETH payment that predates its quote are refused", async () => {
  const stable = { fee: { asset: "stable" as const, txHash: hash }, payer, recipient: ops, chainId: 4663 as const, keys: [key] };
  const paid = { logs: [transferLog(payer, ops, usdg.amount)] };
  assert.equal(await codeOf(verifyLaunchFeePayment(client({ ...paid, blockNumber: BLOCK }, {}, 1000n, BLOCK + 1n), stable)), "ok", "the minimum block itself counts");
  assert.equal(await codeOf(verifyLaunchFeePayment(client({ ...paid, blockNumber: BLOCK - 1n }), stable)), "NFT_FEE_INVALID", "an older exact transfer is not a launch fee");
  assert.equal(await codeOf(verifyLaunchFeePayment(client({ ...paid, blockNumber: 1n }), stable)), "NFT_FEE_INVALID");
  assert.equal(typeof LAUNCH_FEE_MIN_BLOCK[4663], "bigint");
  assert.equal(LAUNCH_FEE_MIN_BLOCK[8453], undefined, "a chain without an entry accepts no stablecoin fee");

  const wei = "5000000000000000", expiresAt = 2000;
  const fee = { asset: "native" as const, txHash: hash, wei, expiresAt, mac: launchFeeQuoteMac(key, 4663, payer, wei, expiresAt) };
  const native = { ...stable, fee };
  const eth = { value: 5000000000000000n };
  // The quote was issued 60 s before expiresAt, and 120 s of clock skew is allowed.
  assert.equal(await codeOf(verifyLaunchFeePayment(client({}, eth, 2000n - 60n - 120n), native)), "ok");
  assert.equal(await codeOf(verifyLaunchFeePayment(client({}, eth, 2000n - 60n - 121n), native)), "NFT_FEE_INVALID", "a payment that predates its quote");
  assert.equal(await codeOf(verifyLaunchFeePayment(client({}, eth, 1n), native)), "NFT_FEE_INVALID");
});

test("both assets need a canonical receipt for this exact transaction and block", async () => {
  const stable = { fee: { asset: "stable" as const, txHash: hash }, payer, recipient: ops, chainId: 4663 as const, keys: [key] };
  const paid = { logs: [transferLog(payer, ops, usdg.amount)] };
  const other = `0x${"44".repeat(32)}`;
  assert.equal(await codeOf(verifyLaunchFeePayment(client({ ...paid, transactionHash: other }), stable)), "NFT_FEE_INVALID", "the receipt belongs to another transaction");
  assert.notEqual(upper(lettered), lettered);
  assert.equal(await codeOf(verifyLaunchFeePayment(client({ ...paid, transactionHash: upper(lettered) }), { ...stable, fee: { ...stable.fee, txHash: lettered } })), "ok",
    "the hash compares case-insensitively");
  assert.equal(await codeOf(verifyLaunchFeePayment(client({ ...paid, blockHash: `0x${"33".repeat(32)}` }), stable)), "NFT_FEE_INVALID", "a USDG receipt from a reorganized block");
  const wei = "5000000000000000", expiresAt = 2000;
  const native = { ...stable, fee: { asset: "native" as const, txHash: hash, wei, expiresAt, mac: launchFeeQuoteMac(key, 4663, payer, wei, expiresAt) } };
  assert.equal(await codeOf(verifyLaunchFeePayment(client({ transactionHash: other }, { value: 5000000000000000n }, 2000n), native)), "NFT_FEE_INVALID");
});

test("an ETH payment must be a plain transfer with no calldata", async () => {
  const wei = "5000000000000000", expiresAt = 2000;
  const args = { fee: { asset: "native" as const, txHash: hash, wei, expiresAt, mac: launchFeeQuoteMac(key, 4663, payer, wei, expiresAt) },
    payer, recipient: ops, chainId: 4663 as const, keys: [key] };
  assert.equal(await codeOf(verifyLaunchFeePayment(client({}, { value: 5000000000000000n, input: "0x" }, 2000n), args)), "ok");
  assert.equal(await codeOf(verifyLaunchFeePayment(client({}, { value: 5000000000000000n, input: "0xdeadbeef" }, 2000n), args)), "NFT_FEE_INVALID");
  assert.equal(await codeOf(verifyLaunchFeePayment(client({}, { value: 5000000000000000n, input: "0x00" }, 2000n), args)), "NFT_FEE_INVALID");
});

// ---- stores ------------------------------------------------------------------------------
test("a used fee is refused for the same payer", () => {
  const directory = mkdtempSync(join(tmpdir(), "nft-fee-store-"));
  const store = new Store(directory, 4663);
  try {
    assert.equal(store.tokenUsingLaunchFee(hash, payer), null);
    store.saveToken(syntheticToken({ mode: "robinhood", creator: payer, launchFee: { asset: "stable", txHash: lettered } }));
    assert.equal(store.tokenUsingLaunchFee(lettered, payer)?.symbol, "SYNTH");
    assert.equal(store.tokenUsingLaunchFee(upper(lettered), payer)?.symbol, "SYNTH", "the hash compares case-insensitively");
    assert.notEqual(payer.toLowerCase(), payer);
    assert.equal(store.tokenUsingLaunchFee(lettered, payer.toLowerCase()) !== null, true, "the creator compares case-insensitively");
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

test("single use excludes only the coin itself: another coin holding the fee still counts, whichever row comes first", () => {
  const directory = mkdtempSync(join(tmpdir(), "nft-fee-store-"));
  const store = new Store(directory, 4663);
  const self = getAddress("0x3333333333333333333333333333333333333333"), rival = getAddress("0x4444444444444444444444444444444444444444");
  const holding = (address: Address, n: string) => syntheticToken({ mode: "robinhood", address, transactionHash: `0x${n.repeat(64)}`, creator: payer,
    launchFee: { asset: "stable", txHash: lettered } });
  try {
    store.saveToken(holding(self, "5"));
    assert.equal(store.tokenUsingLaunchFee(lettered, payer, self), null, "the coin's own record is not another use");
    assert.equal(store.tokenUsingLaunchFee(lettered, payer, self.toLowerCase())?.address, undefined);
    store.saveToken(holding(rival, "6"));
    assert.equal(store.tokenUsingLaunchFee(lettered, payer, self)?.address, rival, "the other holder is found even when the first row is the coin itself");
    assert.equal(store.tokenUsingLaunchFee(lettered, payer, rival)?.address, self);
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("assertUnusedLaunchFee with self refuses a fee another coin also holds", async () => {
  const directory = mkdtempSync(join(tmpdir(), "nft-fee-service-"));
  const store = new Store(directory, 4663);
  const self = getAddress("0x3333333333333333333333333333333333333333"), rival = getAddress("0x4444444444444444444444444444444444444444");
  const fee: LaunchFee = { asset: "stable", txHash: hash };
  try {
    const { service } = feeService({ store });
    store.saveToken(syntheticToken({ mode: "robinhood", address: self, transactionHash: `0x${"5".repeat(64)}`, creator: payer, launchFee: fee }));
    assert.equal(await codeOf(service.assertUnusedLaunchFee(fee, payer, self)), "ok");
    store.saveToken(syntheticToken({ mode: "robinhood", address: rival, transactionHash: `0x${"6".repeat(64)}`, creator: payer, launchFee: fee }));
    assert.equal(await codeOf(service.assertUnusedLaunchFee(fee, payer, self)), "NFT_FEE_USED");
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("the Supabase store queries the same hash-and-creator predicate", async () => {
  const store = new SupabaseStore("https://fixture.supabase.co", "test-server-key", "verify-fee");
  let path = "";
  store.request = async <T>(requested: string) => { path = requested; return [{ payload: syntheticToken({ creator: payer, launchFee: { asset: "stable", txHash: hash } }) }] as T; };
  const found = await store.tokenUsingLaunchFee(upper(lettered), "0xAAAA000000000000000000000000000000000001");
  assert.equal(found?.symbol, "SYNTH");
  const query = decodeURIComponent(path);
  for (const part of ["scope=eq.verify-fee", `payload->launchFee->>txHash=ilike.${lettered}`, `payload->>creator=ilike.${payer.toLowerCase()}`, "limit=1"])
    assert(query.includes(part), `missing ${part} in ${query}`);
  assert(!query.includes("address=neq."), "no exclusion unless asked");
  await store.tokenUsingLaunchFee(lettered, payer, "0x3333333333333333333333333333333333333333");
  assert(decodeURIComponent(path).includes("address=neq.0x3333333333333333333333333333333333333333"), "the coin itself is excluded in the query, before LIMIT 1");
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
