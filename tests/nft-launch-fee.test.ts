import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { TransactionNotFoundError, TransactionReceiptNotFoundError, encodeEventTopics, encodeFunctionData, erc20Abi, encodeAbiParameters, getAddress, type Address, type Hex } from "viem";
import { launchFeeQuoteMac, verifyLaunchFeeQuoteMac, verifyLaunchFeePayment, NftLaunchError } from "../server/nft-launch";
import { LAUNCH_FEE_MIN_BLOCK, LAUNCH_FEE_STABLE, type LaunchFee } from "../src/lib/launch-fee";
import { LaunchpadService } from "../server/service";
import { createApp } from "../server/app";
import { runtimeFromEnv } from "../server/config";
import { Store, TokenUniqueConflict } from "../server/store";
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

const transferCall = (to: Address, amount: bigint) => encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [to, amount] });
/** No receipt: the node knows the transaction (`pending`, still in its mempool, with `tx` replacing its fields), has never seen it
 * (`missing`), or its lookup fails. By default the pending transaction is a real payer's USDG payment: transfer(treasury, 10 USDG) on USDG. */
const unmined = (transaction: "pending" | "missing" | Error, tx: object = {}, headTimestamp = 1000n) => ({
  getTransactionReceipt: async () => { throw new TransactionReceiptNotFoundError({ hash }); },
  // The chain head while the transaction is pending: only `blockTag: "latest"` is ever asked for.
  getBlock: async (args: { blockTag?: string }) => {
    assert.deepEqual(args, { blockTag: "latest" });
    return { hash: `0x${"22".repeat(32)}`, timestamp: headTimestamp };
  },
  getTransaction: async () => {
    if (transaction instanceof Error) throw transaction;
    if (transaction === "missing") throw new TransactionNotFoundError({ hash });
    return { from: payer, to: usdg.address, value: 0n, input: transferCall(ops, usdg.amount), ...tx };
  },
}) as never;
// "retry:<kind>": NFT_FEE_INVALID that can still change; "node": the node's own error; otherwise the final code and message.
const pendingKind = async (p: Promise<unknown>) => p.then(() => "ok", (e) => e instanceof NftLaunchError ? (e.retry ? `retry:${e.retry}` : `${e.code}:${e.message}`) : "node");
const show = (value: unknown) => JSON.stringify(value, (_k, v) => typeof v === "bigint" ? String(v) : v);

test("a pending ETH payment counts as unconfirmed only with the platform's quote MAC, at least its wei and a head inside its mining window", async () => {
  const wei = "5000000000000000", expiresAt = 2000;
  const fee = { asset: "native" as const, txHash: hash, wei, expiresAt, mac: launchFeeQuoteMac(key, 4663, payer, wei, expiresAt) };
  const native = { fee, payer, recipient: ops, chainId: 4663 as const, keys: [key] };
  const exact = { to: ops, value: 5000000000000000n, input: "0x" };
  assert.equal(await pendingKind(verifyLaunchFeePayment(unmined("pending", exact), native)), "retry:unconfirmed", "a real payer's quoted transfer, still in the mempool");
  assert.equal(await pendingKind(verifyLaunchFeePayment(unmined("pending", exact), { ...native, keys: ["n".repeat(32), key] })), "retry:unconfirmed",
    "a quote signed before a key rotation still counts");
  assert.equal(await pendingKind(verifyLaunchFeePayment(unmined("pending", { ...exact, value: 5000000000000001n }), native)), "retry:unconfirmed",
    "more than the quote can still be mined and accepted, as a mined overpayment is");
  // Block timestamps never go backwards: the head past expiresAt plus the 10-minute grace means no block can include it in time.
  assert.equal(await pendingKind(verifyLaunchFeePayment(unmined("pending", exact, 2000n + 600n), native)), "retry:unconfirmed", "the head exactly at the bound");
  assert.equal(await pendingKind(verifyLaunchFeePayment(unmined("pending", exact, 2000n + 601n), native)),
    "NFT_FEE_INVALID:The launch fee payment is not valid: the quote expired.", "the head one second past the bound");
  const cases: [string, object, typeof native][] = [
    ["a quote MAC the platform never signed", exact, { ...native, fee: { ...fee, mac: launchFeeQuoteMac("x".repeat(32), 4663, payer, wei, expiresAt) } }],
    ["no MAC", exact, { ...native, fee: { ...fee, mac: undefined as never } }],
    ["a MAC for another payer", exact, { ...native, fee: { ...fee, mac: launchFeeQuoteMac(key, 4663, stranger, wei, expiresAt) } }],
    ["no key to check the MAC", exact, { ...native, keys: [] }],
    ["a claim that lowers the signed wei", { ...exact, value: 1n }, { ...native, fee: { ...fee, wei: "1" } }],
    ["one wei", { ...exact, value: 1n }, native],
    ["one wei short", { ...exact, value: 4999999999999999n }, native],
    ["another recipient", { ...exact, to: stranger }, native],
    ["a contract creation", { ...exact, to: null }, native],
    ["calldata", { ...exact, input: "0xdeadbeef" }, native],
    ["another sender", { ...exact, from: stranger }, native],
  ];
  for (const [why, tx, args] of cases)
    assert.match(await pendingKind(verifyLaunchFeePayment(unmined("pending", tx), args)), /^NFT_FEE_INVALID:/, `${why}: ${show(tx)}`);
});

test("a pending USDG payment counts as unconfirmed only as a direct transfer(treasury, 10 USDG) on USDG; a wrong transfer is final, anything else is missing", async () => {
  const stable = { fee: { asset: "stable" as const, txHash: hash }, payer, recipient: ops, chainId: 4663 as const, keys: [key] };
  assert.equal(await pendingKind(verifyLaunchFeePayment(unmined("pending"), stable)), "retry:unconfirmed", "exactly transfer(treasury, 10 USDG), sent to USDG");
  // Not a payment the mempool can show: it retries inside the window and settles rejected: fee after it, like a hash never seen.
  const missing: [string, object][] = [["a wallet-contract or router call", { to: stranger }], ["another token's transfer", { to: stranger, input: transferCall(ops, usdg.amount) }],
    ["USDG without calldata", { input: "0x" }], ["another USDG function", { input: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [ops, usdg.amount] }) }],
    ["undecodable USDG calldata", { input: "0xa9059cbb" }], ["a contract creation", { to: null }]];
  for (const [why, tx] of missing) assert.equal(await pendingKind(verifyLaunchFeePayment(unmined("pending", tx), stable)), "retry:missing", why);
  // A decodable USDG transfer that is not exactly the fee can never become it.
  const wrong: [string, object][] = [["another recipient", { input: transferCall(stranger, usdg.amount) }], ["one unit short", { input: transferCall(ops, usdg.amount - 1n) }],
    ["one unit more", { input: transferCall(ops, usdg.amount + 1n) }], ["another sender", { from: stranger }]];
  for (const [why, tx] of wrong) assert.match(await pendingKind(verifyLaunchFeePayment(unmined("pending", tx), stable)), /^NFT_FEE_INVALID:/, why);
  assert.match(await pendingKind(verifyLaunchFeePayment(unmined("pending"), { ...stable, chainId: 8453 as const })), /^NFT_FEE_INVALID:/, "a chain without a stablecoin fee");
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

const feeConflict = (error: unknown) => error instanceof TokenUniqueConflict && error.kind === "launch_fee";

test("single use excludes only the coin itself, and the database refuses a second coin holding the fee, in any case", () => {
  const directory = mkdtempSync(join(tmpdir(), "nft-fee-store-"));
  const store = new Store(directory, 4663);
  const self = getAddress("0x3333333333333333333333333333333333333333"), rival = getAddress("0x4444444444444444444444444444444444444444");
  const holding = (address: Address, n: string, txHash: Hex = lettered) => syntheticToken({ mode: "robinhood", address, transactionHash: `0x${n.repeat(64)}`, creator: payer,
    launchFee: { asset: "stable", txHash } });
  try {
    store.saveToken(holding(self, "5"));
    assert.equal(store.tokenUsingLaunchFee(lettered, payer, self), null, "the coin's own record is not another use");
    assert.equal(store.tokenUsingLaunchFee(lettered, payer, self.toLowerCase())?.address, undefined);
    assert.equal(store.tokenUsingLaunchFee(lettered, payer, rival)?.address, self, "any other coin finds the holder");
    assert.throws(() => store.saveToken(holding(rival, "6")), feeConflict, "a second coin spending the fee is refused");
    assert.throws(() => store.saveToken(holding(rival, "6", upper(lettered))), feeConflict, "whatever the hash's case");
    assert.equal(store.token(rival), null, "the refused coin was not written");
    store.saveToken(holding(self, "5"));
    assert.equal(store.tokens().length, 1, "registering the same coin again is not a second use");
    // A claim is not a spend: an unconfirmed fee's coin keeps it in nftVerification.feeClaim, which neither the lookup nor the index reads.
    store.saveToken(syntheticToken({ mode: "robinhood", address: rival, transactionHash: `0x${"6".repeat(64)}`, creator: payer,
      nftVerification: { status: "unverified", reason: "fee_unconfirmed", feeClaim: { asset: "stable", txHash: lettered } } }));
    assert.equal(store.tokenUsingLaunchFee(lettered, payer, self), null);
    store.saveToken(holding(getAddress("0x7777777777777777777777777777777777777777"), "7", `0x${"cd".repeat(32)}`));
    assert.equal(store.tokens().length, 3, "another fee is no conflict");
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("assertUnusedLaunchFee with self refuses a fee another coin holds, and accepts the holder itself", async () => {
  const directory = mkdtempSync(join(tmpdir(), "nft-fee-service-"));
  const store = new Store(directory, 4663);
  const self = getAddress("0x3333333333333333333333333333333333333333"), rival = getAddress("0x4444444444444444444444444444444444444444");
  const fee: LaunchFee = { asset: "stable", txHash: hash };
  try {
    const { service } = feeService({ store });
    assert.equal(await codeOf(service.assertUnusedLaunchFee(fee, payer, self)), "ok");
    store.saveToken(syntheticToken({ mode: "robinhood", address: rival, transactionHash: `0x${"6".repeat(64)}`, creator: payer, launchFee: fee }));
    assert.equal(await codeOf(service.assertUnusedLaunchFee(fee, payer, self)), "NFT_FEE_USED");
    assert.equal(await codeOf(service.assertUnusedLaunchFee(fee, payer, rival)), "ok");
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("Supabase: a 409 with code 23505 naming a guard index is that conflict; any other 409 stays a plain database failure", async () => {
  const store = new SupabaseStore("https://fixture.supabase.co", "test-server-key", "verify-fee");
  const original = globalThis.fetch, sent: string[] = [];
  let reply = { status: 204, body: "" };
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    sent.push(`${init?.method} ${decodeURIComponent(String(url))}`);
    return new Response(reply.body || null, { status: reply.status });
  }) as typeof fetch;
  // PostgREST's body for a unique violation.
  const postgres = (constraint: string, code = "23505") => JSON.stringify({ code, details: "Key (...)=(...) already exists.", hint: null,
    message: `duplicate key value violates unique constraint "${constraint}"` });
  const coin = syntheticToken({ mode: "robinhood", creator: payer, launchFee: { asset: "stable", txHash: lettered } });
  const nft = { chainId: 4663 as const, contract: stranger, tokenId: "1" };
  const verified = { ...coin, nft, nftVerification: { status: "verified" as const } };
  try {
    reply = { status: 409, body: postgres("musegod_tokens_launch_fee_once") };
    await assert.rejects(store.saveToken(coin), feeConflict, "the launch-fee index");
    assert.match(sent.at(-1) ?? "", /^POST https:\/\/fixture\.supabase\.co\/rest\/v1\/musegod_tokens\?on_conflict=scope,address$/, "the token insert itself");
    await assert.rejects(store.updateNftVerification(verified), feeConflict, "a PATCH meets the same index");
    reply = { status: 409, body: postgres("musegod_tokens_nft_verified_once") };
    for (const write of [() => store.saveToken(verified), () => store.updateNftVerification(verified), () => store.upgradeTokenProvenance(verified)])
      await assert.rejects(write(), (error: unknown) => error instanceof TokenUniqueConflict && error.kind === "nft_verified", "the verified-NFT index");
    const plain: [string, number, string][] = [
      ["the primary key", 409, postgres("musegod_tokens_pkey")],
      ["the transaction-hash key", 409, postgres("musegod_tokens_scope_tx_hash_key")],
      ["an index whose name only begins like a guard's", 409, postgres("musegod_tokens_launch_fee_once_old")],
      ["another code naming a guard index", 409, postgres("musegod_tokens_nft_verified_once", "23P01")],
      ["a body that is not JSON", 409, "conflict"],
      ["an empty body", 409, ""],
      ["a guard index named on another status", 400, postgres("musegod_tokens_launch_fee_once")],
    ];
    for (const [why, status, body] of plain) {
      reply = { status, body };
      await assert.rejects(store.saveToken(coin), (error: unknown) => !(error instanceof TokenUniqueConflict) && error instanceof Error &&
        error.message === `Database request failed (${status}). Check the server configuration and migrations.`, why);
    }
  } finally { globalThis.fetch = original; }
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

test("Supabase: the guards are ready only when musegod_nft_guards_ready answers true; any failure, including a missing migration, is not ready", async () => {
  const store = new SupabaseStore("https://fixture.supabase.co", "test-server-key", "verify-fee");
  const original = globalThis.fetch, sent: { method?: string; url: string; body: unknown }[] = [];
  let reply: () => Response = () => Response.json(true);
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    sent.push({ method: init?.method, url: String(url), body: init?.body === undefined ? undefined : JSON.parse(String(init.body)) });
    return reply();
  }) as typeof fetch;
  try {
    assert.equal(await store.nftGuardsReady(), true);
    assert.deepEqual(sent, [{ method: "POST", url: "https://fixture.supabase.co/rest/v1/rpc/musegod_nft_guards_ready", body: {} }]);
    const notReady: [string, () => Response][] = [
      ["false", () => Response.json(false)], ["a non-boolean", () => Response.json("true")], ["an empty body", () => new Response(null, { status: 204 })],
      ["the function is missing (no migration)", () => Response.json({ code: "PGRST202", message: "Could not find the function" }, { status: 404 })],
      ["a server error", () => new Response("down", { status: 500 })], ["a network failure", () => { throw new TypeError("fetch failed"); }],
    ];
    for (const [why, answer] of notReady) { reply = answer; assert.equal(await store.nftGuardsReady(), false, why); }
  } finally { globalThis.fetch = original; }
});

// ---- service -----------------------------------------------------------------------------
const nftModeOn: NonNullable<RuntimeConfig["nftMode"]> = { enabled: true, vaultFactory: null, launchFeeUsd: 10, freeCollections: [], verifiedCollections: [] };
function feeService(options: { price?: string; key?: string | null; previous?: string[]; treasury?: Address | null; nftMode?: RuntimeConfig["nftMode"]; store?: object; tx?: object; timestamp?: bigint;
  guards?: boolean } = {}) {
  const calls = { valuations: 0, valued: [] as Address[] };
  const config = { mode: "robinhood", chainId: 4663, deploymentChainId: 4663, treasury: options.treasury === null ? undefined : options.treasury ?? ops,
    writesEnabled: true, blockReason: null, nftMode: options.nftMode ?? nftModeOn } as RuntimeConfig;
  const service = Object.assign(Object.create(LaunchpadService.prototype), {
    runtime: { config, secrets: { planAttestationKey: options.key === null ? undefined : options.key ?? key, planAttestationPreviousKeys: options.previous ?? [] } },
    client: client({ logs: [transferLog(payer, ops, usdg.amount)] }, options.tx, options.timestamp),
    store: options.store ?? { tokenUsingLaunchFee: async () => null, nftGuardsReady: async () => options.guards ?? true },
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
  const unguarded = feeService({ guards: false });
  assert.equal(await codeOf(unguarded.service.launchFeeQuote(payer)), "NFT_MODE_DISABLED", "the flag without the database's single-use guards is off");
  assert.equal(unguarded.calls.valuations, 0);
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
