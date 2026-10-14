import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { decodeFunctionData, erc20Abi, getAddress, stringToHex, TransactionNotFoundError, TransactionReceiptNotFoundError, UserRejectedRequestError,
  InvalidInputRpcError, InvalidParamsRpcError, MethodNotFoundRpcError, MethodNotSupportedRpcError, type Address, type Hex } from "viem";
import { restoreDraft, type LaunchInput } from "../src/lib/validation";
import { ROBINHOOD_STOCKS } from "../src/lib/config";
import { MUSES, nftKey, type NftRef } from "../src/lib/nft-mode";
import { launchIntentStorageKey } from "../src/lib/launch-intent";
import {
  FEE_CANCELLED, FEE_REVERTED, FEE_UNCONFIRMED, FEE_WALLET_CANCELLED, FEE_WALLET_REFUSED, createFeePoller, feePollDelay, formatFeeEth, isLaunchFeeTx, isUserRejection,
  launchFeeAfterSendError, launchFeeClearedNotice, launchFeeEthTx, launchFeeStableTx,
  launchFeeStorageKey, musePrefill, nftLaunchFeeCost, nftReviewBlocker, parseLaunchFeeRecord, prepareDraft, readNftStatus, resolveLaunchFee, rewardsShareCopy, savedNftMode,
} from "../src/lib/nft-client";
import * as nftClient from "../src/lib/nft-client";
import { LAUNCH_FEE_MAX_WEI } from "../src/lib/launch-fee";
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
  const stable = launchFeeStableTx(config), quote = { wei: "3333333333333334", expiresAt: 1, mac: `0x${"11".repeat(32)}` as Hex };
  assert.equal(isLaunchFeeTx(config, stable), true);
  assert.equal(isLaunchFeeTx(config, { ...stable, value: 1n }), false, "no ETH may ride along with the stablecoin transfer");
  assert.equal(isLaunchFeeTx(config, { ...stable, data: `${stable.data.slice(0, -2)}01` as Hex }), false, "another amount");
  assert.equal(isLaunchFeeTx(config, { ...stable, to: weth.address }), false, "another token");
  assert.equal(isLaunchFeeTx(config, { to: treasury, data: "0x", value: 3333333333333334n }, quote), true, "exactly the quoted wei to the treasury");
  for (const value of [3333333333333333n, 3333333333333335n, 1n, 0n])
    assert.equal(isLaunchFeeTx(config, { to: treasury, data: "0x", value }, quote), false, `not ${value} wei`);
  assert.equal(isLaunchFeeTx(config, { to: treasury, data: "0x", value: 3333333333333334n }), false, "ETH without its quote");
  assert.equal(isLaunchFeeTx(config, { to: treasury, data: "0x12345678", value: 3333333333333334n }, quote), false, "ETH with calldata");
  assert.equal(isLaunchFeeTx(config, { to: account, data: "0x", value: 3333333333333334n }, quote), false, "ETH to someone else");
});

test("the wallet refuses an ETH fee quote above the 0.05 ETH sanity ceiling, even when it matches the quote", () => {
  assert.equal(LAUNCH_FEE_MAX_WEI, 5n * 10n ** 16n, "0.05 ETH: $10 at an ETH price of $200 or more");
  const at = { wei: String(LAUNCH_FEE_MAX_WEI), expiresAt: 1, mac: `0x${"11".repeat(32)}` as Hex }, above = { ...at, wei: String(LAUNCH_FEE_MAX_WEI + 1n) };
  assert.equal(isLaunchFeeTx(config, { to: treasury, data: "0x", value: LAUNCH_FEE_MAX_WEI }, at), true, "exactly the ceiling is allowed");
  assert.equal(isLaunchFeeTx(config, { to: treasury, data: "0x", value: LAUNCH_FEE_MAX_WEI + 1n }, above), false, "one wei above it is refused");
  assert.equal(isLaunchFeeTx(config, { to: treasury, data: "0x", value: 10n ** 18n }, { ...at, wei: String(10n ** 18n) }), false, "a 1 ETH quote is refused");
  assert.throws(() => launchFeeEthTx(config, above), /The ETH price quote is too high to be safe\. Pay with USDG, or try again later\./);
  assert.equal(launchFeeEthTx(config, at).value, LAUNCH_FEE_MAX_WEI);
});

test("the earlier per-draft fee migration is gone", () => {
  assert.equal("migrateLaunchFee" in nftClient, false);
});

test("Launch cost names the $10 only for a non-Muse NFT draft: paid, or due before launch", () => {
  assert.equal(nftLaunchFeeCost({}), "");
  assert.equal(nftLaunchFeeCost({ nft: muse() }), "", "Muses launch free");
  assert.equal(nftLaunchFeeCost({ nft: muse(), launchFee: stableFee }), "");
  assert.equal(nftLaunchFeeCost({ nft: other() }), "$10 launch fee (due before launch)");
  assert.equal(nftLaunchFeeCost({ nft: other(), launchFee: stableFee }), "$10 launch fee (paid)");
});

test("Rewards says NFT coins pay their creator share to the NFT's treasury: in place of the claim when all are NFT coins, as one more sentence when mixed", () => {
  const plain = {}, bound = { nft: other() };
  const normal = "You keep 66.5% of every trading fee on new launches. Fees stay on-chain until you claim them.";
  assert.deepEqual(rewardsShareCopy([], "66.5%"), { lede: normal, tile: "Your creator share", allNft: false });
  assert.deepEqual(rewardsShareCopy([plain, plain], "66.5%"), { lede: normal, tile: "Your creator share", allNft: false });
  assert.deepEqual(rewardsShareCopy([plain, bound], "66.5%"),
    { lede: `${normal} NFT coins pay their creator share to the NFT's treasury instead.`, tile: "Your creator share", allNft: false });
  assert.deepEqual(rewardsShareCopy([bound, { nft: muse() }], "66.5%"), { lede: "All your launches are NFT coins. NFT coins pay their 66.5% creator share to the NFT's treasury, which the NFT's holder controls.",
    tile: "NFT treasury share", allNft: true });
});

test("the quoted ETH is shown rounded up, never below what the wallet sends", () => {
  assert.equal(formatFeeEth("3333333333333334"), "0.003334");
  assert.equal(formatFeeEth("3000000000000000"), "0.003");
  assert.equal(formatFeeEth("1"), "0.000001");
});

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
  const passedFor = (nft: NftRef) => ({ nft: nftKey(nft), account });
  assert.equal(nftReviewBlocker(true, draftOf({ nft: other() }), "", "none", passedFor(other()), account), "Pay the $10 launch fee for this NFT first.");
  assert.match(nftReviewBlocker(true, draftOf({ nft: other() }), "", "pending", passedFor(other()), account) ?? "", /still confirming/, "a pending payment says so");
  assert.match(nftReviewBlocker(true, draftOf({ nft: other() }), "", "sending", passedFor(other()), account) ?? "", /may have been sent/);
  assert.equal(nftReviewBlocker(true, draftOf({ nft: other(), launchFee: stableFee }), "", "paid", passedFor(other()), account), null);
  assert.equal(nftReviewBlocker(true, draftOf({ nft: muse() }), "", "pending", passedFor(muse()), account), null, "Muses are free");
});

// A restored NFT stays in the draft while the step checks it again: review waits for the step's check, not only for `draft.nft`.
test("review stays blocked while the NFT step re-checks an NFT the draft already holds", () => {
  for (const status of ["Checking this NFT…", "Connect the wallet that holds the NFT.", "The NFT status could not be read. Retry."])
    for (const nft of [muse(), other()])
      assert.equal(nftReviewBlocker(true, draftOf({ nft, launchFee: stableFee }), status, "paid", null, account), status, `${status} (${nft.contract})`);
  assert.match(nftReviewBlocker(true, draftOf({ nft: muse() }), "") ?? "", /NFT/, "a step that reported nothing has not checked: blocked");
  const free = "Muse launches are free. Muse coins pair with MUSEGOD.";
  assert.equal(nftReviewBlocker(true, draftOf({ nft: muse() }), free, "none", { nft: nftKey(muse()), account }, account), null);
  assert.equal(nftReviewBlocker(true, draftOf({ nft: muse() }), free, "none", { nft: nftKey(muse()), account: account.toLowerCase() }, account), null,
    "the account compares without case");
  // What the step checked must be this draft's NFT for this wallet: a wallet switch blocks at once, before the step reports again.
  assert.equal(nftReviewBlocker(true, draftOf({ nft: muse() }), free, "none", { nft: nftKey(muse()), account }, treasury), free);
  assert.equal(nftReviewBlocker(true, draftOf({ nft: muse() }), free, "none", { nft: nftKey(muse()), account }, null), free);
  assert.equal(nftReviewBlocker(true, draftOf({ nft: { ...muse(), tokenId: "2" } }), free, "none", { nft: nftKey(muse()), account }, account), free);
});


test("the NFT mode choice is restored from a saved draft", () => {
  assert.equal(savedNftMode(JSON.stringify({ name: "x", nftMode: true })), true, "NFT mode with a check still pending");
  assert.equal(savedNftMode(JSON.stringify({ name: "x", nft: muse() })), true);
  assert.equal(savedNftMode(JSON.stringify({ name: "x" })), false);
  assert.equal(savedNftMode("{broken"), false);
  assert.equal(savedNftMode(null), false);
});

// Ruling 3 (fix round 1): the fee is recorded per creator, with its nonce, before the wallet can broadcast it.
test("the launch-fee record is per chain and wallet, under the payment kind, apart from every draft's first-buy payment", () => {
  const key = launchFeeStorageKey(config, account);
  assert.equal(key, launchIntentStorageKey(config, account, "launch-fee", "payment"));
  assert.notEqual(key, launchIntentStorageKey(config, account, "intent-12345678", "payment"));
  assert.notEqual(key, launchFeeStorageKey(config, getAddress("0x3333333333333333333333333333333333333333")), "another wallet");
  assert.notEqual(key, launchFeeStorageKey({ mode: "fork", chainId: 31337, deploymentChainId: 4663 } as never, account), "another chain");
});

const quote = { wei: "3333333333333334", expiresAt: 1_800_000_000, mac: `0x${"11".repeat(32)}` as Hex };
const sending = { state: "sending" as const, asset: "stable" as const, from: account, nonce: 3, block: "100", at: 1_800_000_000_000 };
const pendingOf = (txHash: Hex, over: object = {}) => ({ ...sending, state: "pending" as const, txHash, ...over });
test("a stored record round-trips in every state; anything malformed is ignored", () => {
  const records = [sending, pendingOf(stableFee.txHash), pendingOf(stableFee.txHash, { nonceSeen: true }), { ...sending, asset: "native", quote },
    { state: "paid", from: account, fee: stableFee }];
  for (const record of records) assert.deepEqual(parseLaunchFeeRecord(JSON.stringify(record)), record);
  assert.equal(parseLaunchFeeRecord(JSON.stringify(pendingOf(`0x${"AB".repeat(32)}`)))?.state === "pending" &&
    (parseLaunchFeeRecord(JSON.stringify(pendingOf(`0x${"AB".repeat(32)}`))) as { txHash: string }).txHash, `0x${"ab".repeat(32)}`);
  for (const raw of [null, "", "{", "[]", JSON.stringify(stableFee), JSON.stringify({ ...stableFee, pending: true }),
    JSON.stringify({ ...sending, nonce: undefined }), JSON.stringify({ ...sending, asset: "native" }), JSON.stringify({ ...sending, extra: 1 }),
    JSON.stringify({ ...sending, nonce: -1 }), JSON.stringify({ state: "paid", from: account, fee: { ...stableFee, extra: 1 } })])
    assert.equal(parseLaunchFeeRecord(raw), null, String(raw));
});

test("only a wallet rejection before any hash clears an attempt; any other failure keeps it for the nonce check", () => {
  const rejection = { name: "TransactionExecutionError", cause: new UserRejectedRequestError(new Error("User rejected the request.")) };
  assert.equal(isUserRejection(rejection), true);
  assert.equal(isUserRejection({ code: 4001 }), true);
  assert.equal(isUserRejection(new Error("Wallet disconnected before returning the transaction hash")), false);
  assert.equal(launchFeeAfterSendError(sending, sending.at, rejection), null, "sending, then rejected: cleared");
  assert.deepEqual(launchFeeAfterSendError(sending, sending.at, new Error("disconnected")), sending, "sending, then unknown: kept");
  const pending = pendingOf(stableFee.txHash);
  assert.deepEqual(launchFeeAfterSendError(pending, sending.at, rejection), pending, "a hash exists: kept");
  assert.deepEqual(launchFeeAfterSendError(sending, sending.at + 1, rejection), sending, "another attempt is never touched");
  assert.equal(launchFeeClearedNotice(rejection), FEE_WALLET_CANCELLED, "the user's own rejection keeps its wording");
  assert.equal(launchFeeClearedNotice({ code: 4001 }), FEE_WALLET_CANCELLED);
});

test("a wallet that refused the payment request unprocessed clears the attempt with its own wording", () => {
  // What viem throws when eth_sendTransaction and its wallet_sendTransaction retry were both refused as unsupported or malformed.
  for (const Refusal of [MethodNotSupportedRpcError, MethodNotFoundRpcError, InvalidParamsRpcError]) {
    const refused = { name: "TransactionExecutionError", cause: new Refusal(new Error("The wallet refused eth_sendTransaction")) };
    assert.equal(launchFeeAfterSendError(sending, sending.at, refused), null, `${Refusal.name}: nothing was sent, cleared`);
    assert.equal(launchFeeClearedNotice(refused), FEE_WALLET_REFUSED, Refusal.name);
    assert.notEqual(launchFeeClearedNotice(refused), FEE_WALLET_CANCELLED);
    const pending = pendingOf(stableFee.txHash);
    assert.deepEqual(launchFeeAfterSendError(pending, sending.at, refused), pending, "a hash exists: kept");
    assert.deepEqual(launchFeeAfterSendError(sending, sending.at + 1, refused), sending, "another attempt is never touched");
  }
  assert.equal(FEE_WALLET_REFUSED, "Your wallet refused the payment request, and nothing was sent. You can try again or use another wallet.");
  // A generic wallet error may follow a broadcast: the record stays for the nonce check.
  for (const ambiguous of [{ name: "TransactionExecutionError", cause: new InvalidInputRpcError(new Error("invalid input")) }, { code: -32603 }, new Error("x")])
    assert.deepEqual(launchFeeAfterSendError(sending, sending.at, ambiguous), sending);
});

type FakeTx = { hash: Hex; from: Address; to: Address; input: Hex; value: bigint; nonce: number; block: bigint };
const stableTx = launchFeeStableTx(config);
const txOf = (n: number, block: bigint, over: Partial<FakeTx> = {}): FakeTx => ({ hash: `0x${n.toString(16).padStart(64, "0")}`, from: account,
  to: stableTx.to, input: stableTx.data, value: 0n, nonce: n, block, ...over });
const otherTx = (n: number, block: bigint) => txOf(n, block, { hash: `0x${(1000 + n).toString(16).padStart(64, "f")}`, to: account, input: "0x" });
/** A chain: `mined` transactions with their blocks (a block past `head` is mined after the head was read), `mempool` ones known but
 * unmined, and receipt statuses. Every read is recorded; `count@N` is a nonce count at block N. */
function chain(head: bigint, mined: FakeTx[], mempool: FakeTx[] = [], reverted: Hex[] = []) {
  const reads: string[] = [];
  const client = {
    getBlockNumber: async () => { reads.push("head"); return head; },
    getTransactionReceipt: async ({ hash }: { hash: Hex }) => {
      reads.push(`receipt:${hash.slice(-4)}`);
      const tx = mined.find((row) => row.hash === hash);
      if (!tx) throw new TransactionReceiptNotFoundError({ hash });
      return { transactionHash: hash, status: reverted.includes(hash) ? "reverted" : "success", blockNumber: tx.block, from: tx.from };
    },
    getTransaction: async ({ hash }: { hash: Hex }) => {
      reads.push(`tx:${hash.slice(-4)}`);
      const mine = mined.find((row) => row.hash === hash), pending = mempool.find((row) => row.hash === hash);
      if (mine) return { ...mine, blockNumber: mine.block };
      if (pending) return { ...pending, blockNumber: null };
      throw new TransactionNotFoundError({ hash });
    },
    getTransactionCount: async ({ address, blockNumber }: { address: Address; blockNumber?: bigint }) => {
      reads.push(blockNumber === undefined ? "count:latest" : `count@${blockNumber}`);
      return mined.filter((row) => row.from === address && (blockNumber === undefined || row.block <= blockNumber)).length;
    },
    getBlock: async ({ blockNumber }: { blockNumber: bigint }) => { reads.push(`block:${blockNumber}`); return { transactions: mined.filter((row) => row.block === blockNumber) }; },
  };
  return { client: client as never, reads };
}
const history = [otherTx(0, 5n), otherTx(1, 40n), otherTx(2, 90n)];
const searchReads = (reads: string[], head: bigint) => reads.filter((read) => read.startsWith("block:") || read.startsWith("count@") && read !== `count@${head}`);

test("sending, then a reload: once the nonce is spent, the fee transfer found at that nonce is adopted", async () => {
  const sent = txOf(3, 104n);
  const { client, reads } = chain(110n, [...history, sent, otherTx(4, 107n)]);
  assert.deepEqual(await resolveLaunchFee(client, config, sending), { status: "paid", fee: { asset: "stable", txHash: sent.hash } });
  assert(reads.includes("block:104"), "the binary search lands on the block that holds nonce 3");
  assert(searchReads(reads, 110n).length <= 10, "a binary search, not a block scan");
  assert.equal(reads.includes("count:latest"), false, "the nonce is counted at the same head the search ends at");
  const young = chain(104n, [...history, sent]);
  assert.deepEqual(await resolveLaunchFee(young.client, config, sending), { status: "waiting" }, "one confirmation is not enough");
  const reverted = chain(110n, [...history, sent], [], [sent.hash]);
  assert.deepEqual(await resolveLaunchFee(reverted.client, config, sending), { status: "failed", reason: FEE_REVERTED });
});
test("sending with the nonce unspent, or spent by something else, stays undecided until the user clears it", async () => {
  assert.deepEqual(await resolveLaunchFee(chain(110n, history).client, config, sending), { status: "unknown", reason: FEE_UNCONFIRMED });
  assert.deepEqual(await resolveLaunchFee(chain(110n, [...history, otherTx(3, 104n)]).client, config, sending), { status: "unknown", reason: FEE_UNCONFIRMED },
    "a predicted nonce spent by another transaction proves nothing: the wallet may have used a later one");
  assert.match(FEE_UNCONFIRMED, /Check your wallet's activity\. If no payment left your wallet, choose .No payment was sent./);
});
test("a predicted nonce taken by another transaction: the fee is found up to three nonces later", async () => {
  const fee = txOf(5, 106n);
  const found = chain(110n, [...history, otherTx(3, 104n), otherTx(4, 105n), fee]);
  assert.deepEqual(await resolveLaunchFee(found.client, config, sending), { status: "paid", fee: { asset: "stable", txHash: fee.hash } });
  const tooFar = chain(110n, [...history, otherTx(3, 101n), otherTx(4, 102n), otherTx(5, 103n), otherTx(6, 104n), txOf(7, 105n)]);
  assert.equal((await resolveLaunchFee(tooFar.client, config, sending)).status, "unknown", "the look-ahead is bounded to three nonces");
});
test("a spent nonce is searched once: with the memo, a later check makes no search reads", async () => {
  const memo = new Map(), mined = [...history, otherTx(3, 104n), otherTx(4, 105n), otherTx(5, 106n), otherTx(6, 107n)];
  const first = chain(110n, mined);
  assert.equal((await resolveLaunchFee(first.client, config, sending, undefined, memo)).status, "unknown");
  assert(searchReads(first.reads, 110n).length > 0);
  assert.deepEqual([...memo.keys()].sort(), [3, 4, 5, 6]);
  const again = chain(110n, mined);
  assert.equal((await resolveLaunchFee(again.client, config, sending, undefined, memo)).status, "unknown");
  assert.deepEqual(searchReads(again.reads, 110n), [], "no nonce search and no block read again");
  assert.deepEqual(again.reads, ["head", "count@110"], "only the head and its nonce count");
});
test("an ETH attempt never adopts a USDG transfer, and a USDG attempt never adopts an ETH transfer", async () => {
  const ethAttempt = { ...sending, asset: "native" as const, quote };
  const usdgAtNonce = chain(110n, [...history, txOf(3, 104n)]);
  assert.notEqual((await resolveLaunchFee(usdgAtNonce.client, config, ethAttempt)).status, "paid");
  const ethAtNonce = chain(110n, [...history, txOf(3, 104n, { to: treasury, input: "0x", value: BigInt(quote.wei) })]);
  assert.notEqual((await resolveLaunchFee(ethAtNonce.client, config, sending)).status, "paid");
  assert.deepEqual(await resolveLaunchFee(ethAtNonce.client, config, ethAttempt),
    { status: "paid", fee: { asset: "native", txHash: txOf(3, 104n).hash, wei: quote.wei, expiresAt: quote.expiresAt, mac: quote.mac } });
});
test("a pending payment waits in the mempool and records the nonce it really uses; it is paid after two confirmations", async () => {
  const sent = txOf(3, 0n);
  assert.deepEqual(await resolveLaunchFee(chain(110n, history, [sent]).client, config, pendingOf(sent.hash)),
    { status: "waiting", record: pendingOf(sent.hash, { nonceSeen: true }) });
  const mined = { ...sent, block: 108n };
  assert.deepEqual(await resolveLaunchFee(chain(108n, [...history, mined]).client, config, pendingOf(sent.hash)), { status: "waiting" });
  assert.deepEqual(await resolveLaunchFee(chain(109n, [...history, mined]).client, config, pendingOf(sent.hash)),
    { status: "paid", fee: { asset: "stable", txHash: sent.hash } });
});
test("a nonce spent only after the head was read is not spent yet", async () => {
  // The original is gone; a later block spends nonce 3. Counting at "latest" would start a search that cannot find it below the head.
  const lateSpent = chain(110n, [...history, otherTx(3, 111n)]);
  assert.deepEqual(await resolveLaunchFee(lateSpent.client, config, pendingOf(`0x${"ab".repeat(32)}`, { nonceSeen: true })), { status: "waiting" });
  assert.deepEqual(searchReads(lateSpent.reads, 110n), []);
});
test("pending, then replaced: a speed-up with the same transfer is adopted; a cancellation is cleared only for a nonce seen on chain", async () => {
  const original = txOf(3, 0n), speedUp = txOf(3, 106n, { hash: `0x${"5e".repeat(32)}` });
  // The original is gone from the node: only the spent nonce finds the replacement.
  const repriced = chain(110n, [...history, speedUp]);
  assert.deepEqual(await resolveLaunchFee(repriced.client, config, pendingOf(original.hash)), { status: "paid", fee: { asset: "stable", txHash: speedUp.hash } });
  assert(repriced.reads.includes("block:106"));
  const cancelled = chain(110n, [...history, otherTx(3, 106n)]);
  assert.deepEqual(await resolveLaunchFee(cancelled.client, config, pendingOf(original.hash, { nonceSeen: true })), { status: "failed", reason: FEE_CANCELLED });
  assert.deepEqual(await resolveLaunchFee(cancelled.client, config, pendingOf(original.hash)), { status: "unknown", reason: FEE_UNCONFIRMED },
    "a predicted nonce is never proof of a cancellation");
});
test("a replacement the wallet reported is proof of the nonce: a speed-up is adopted, anything else cancelled the fee", async () => {
  const speedUp = txOf(3, 106n, { hash: `0x${"5e".repeat(32)}` }), { client, reads } = chain(110n, [...history, speedUp]);
  assert.deepEqual(await resolveLaunchFee(client, config, pendingOf(`0x${"ab".repeat(32)}`), speedUp.hash), { status: "paid", fee: { asset: "stable", txHash: speedUp.hash } });
  assert.deepEqual(searchReads(reads, 110n), [], "no nonce search is needed");
  // A same-tab wallet cancel clears at once, even for a predicted nonce, and never reaches "unknown".
  const cancel = otherTx(3, 106n), cancelled = chain(110n, [...history, cancel]);
  assert.deepEqual(await resolveLaunchFee(cancelled.client, config, pendingOf(`0x${"ab".repeat(32)}`), cancel.hash), { status: "failed", reason: FEE_CANCELLED });
  const ethFee = { ...pendingOf(`0x${"ab".repeat(32)}`), asset: "native" as const, quote };
  const wrongAmount = txOf(3, 106n, { hash: `0x${"5f".repeat(32)}`, to: treasury, input: "0x", value: 1n });
  assert.deepEqual(await resolveLaunchFee(chain(110n, [...history, wrongAmount]).client, config, ethFee, wrongAmount.hash),
    { status: "failed", reason: FEE_CANCELLED }, "an ETH transfer of another amount is never adopted");
  const unmined = otherTx(3, 0n), pendingHint = chain(110n, history, [unmined]);
  assert.notEqual((await resolveLaunchFee(pendingHint.client, config, pendingOf(`0x${"ab".repeat(32)}`), unmined.hash)).status, "failed",
    "an unmined hint proves nothing yet");
});

test("polling: an undecided payment is checked at most six times in ten minutes; a waiting one every 4 s", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const flush = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };
  const run = async (status: "unknown" | "waiting" | "paid", seconds: number, hidden = () => false) => {
    let checks = 0;
    const poller = createFeePoller(async () => { checks++; return status; }, hidden);
    poller.start();
    for (let second = 0; second < seconds; second++) { await flush(); t.mock.timers.tick(1_000); }
    await flush();
    poller.stop();
    return { checks, poller };
  };
  const unknown = await run("unknown", 600);
  assert(unknown.checks <= 6, `${unknown.checks} checks in 10 minutes`);
  assert.equal(unknown.checks, 4, "now, then after 1, 2 and 5 minutes");
  assert.equal((await run("waiting", 40)).checks, 11, "every 4 s while a receipt is awaited");
  assert.equal((await run("paid", 600)).checks, 1, "a decided payment is never checked again");
  assert.equal((await run("waiting", 60, () => true)).checks, 0, "nothing while the page is hidden");
  assert.deepEqual([feePollDelay("unknown", 1), feePollDelay("unknown", 2), feePollDelay("unknown", 3), feePollDelay("unknown", 9), feePollDelay("error", 1)],
    [60_000, 120_000, 300_000, 300_000, 60_000]);
});
test("polling: Check again re-checks at once and restarts the back-off; a hidden page catches up when shown", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const flush = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };
  let checks = 0, hidden = false;
  const poller = createFeePoller(async () => { checks++; return "unknown"; }, () => hidden);
  poller.start(); await flush();
  t.mock.timers.tick(60_000); await flush();
  assert.equal(checks, 2);
  poller.now(); await flush();
  assert.equal(checks, 3, "Check again runs at once");
  t.mock.timers.tick(60_000); await flush();
  assert.equal(checks, 4, "and the next automatic check is one minute later again");
  hidden = true;
  t.mock.timers.tick(120_000); await flush();
  assert.equal(checks, 4, "paused while hidden");
  hidden = false; poller.resume(); await flush();
  assert.equal(checks, 5, "caught up when shown");
  poller.stop();
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
    PLATFORM_TREASURY: "0x2222222222222222222222222222222222222222", NFT_MODE_ENABLED: "true" });
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
    runtime: { config: { mode: "robinhood", chainId: 4663, deploymentChainId: 4663, treasury: null, writesEnabled: false, blockReason: null,
      nftMode: { enabled: true, vaultFactory: null, launchFeeUsd: 10, freeCollections: [], verifiedCollections: [] } } },
    assertNetwork: async () => {},
    store: { verifiedNftCoin: async (key: string) => over.existing?.has(key) ? { address: account } : null, nftGuardsReady: async () => true },
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
