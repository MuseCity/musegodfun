import test from "node:test";
import assert from "node:assert/strict";
import { getAddress, InvalidInputRpcError, MethodNotSupportedRpcError, TransactionNotFoundError, TransactionReceiptNotFoundError, UserRejectedRequestError,
  type Address, type Hex } from "viem";
import { ETH_BUY_CANCELLED, ETH_BUY_REVERTED, ETH_BUY_UNCONFIRMED, ethBuyStorageKey, ethBuyTxMatches, parseEthBuyRecord, resolveEthBuy,
  type EthBuyRecord } from "../src/lib/eth-buy-record";
import { attemptAfterSendError, discardable } from "../src/lib/send-record";
import { launchFeeStorageKey } from "../src/lib/nft-client";
import { LOCK_ERROR } from "../src/lib/launch-intent";
import { ethBuyLockError } from "../src/lib/use-eth-buy-record";

test("ETH buy lock refusals name the paired asset and never tell a token-page user to keep a draft", () => {
  const missing = ethBuyLockError(new Error(LOCK_ERROR), "MUSEGOD");
  assert(missing instanceof Error);
  assert.equal(missing.message, "This browser cannot safely buy with ETH (no cross-tab lock). Pay with MUSEGOD, or use another browser.");
  assert.doesNotMatch(missing.message, /draft/i);
  for (const message of ["This launch is open in another tab.", "This launch is already being submitted in this tab."]) {
    const conflict = ethBuyLockError(new Error(message), "MUSEGOD");
    assert(conflict instanceof Error);
    assert.equal(conflict.message, "Another tab of this wallet is buying with ETH. Finish there first.");
  }
  const unrelated = new Error("Wallet disconnected");
  assert.equal(ethBuyLockError(unrelated, "MUSEGOD"), unrelated);
});

// Round 4 F1: an ETH buy through LI.FI keeps a recoverable anti-duplicate record, settled by the Task 9 nonce machinery (send-record.ts).
const config = { mode: "robinhood", chainId: 4663, deploymentChainId: 4663 } as const;
const account = getAddress("0x1111111111111111111111111111111111111111"), diamond = getAddress("0x2222222222222222222222222222222222222222");
const data = "0xabcdef0123" as Hex;
const sending: EthBuyRecord = { state: "sending", from: account, nonce: 3, block: "100", at: 1_800_000_000_000, quoteId: "quote-1",
  tx: { to: diamond, data, value: "1000000000000000" },
  target: { kind: "coin", token: getAddress("0x5555555555555555555555555555555555555555"), symbol: "BARD", decimals: 18, coin: "BARD" } };
const pendingOf = (txHash: Hex, over: object = {}): EthBuyRecord => ({ ...sending, state: "pending", txHash, ...over });

type FakeTx = { hash: Hex; from: Address; to: Address; input: Hex; value: bigint; nonce: number; block: bigint };
const buyTx = (n: number, block: bigint, over: Partial<FakeTx> = {}): FakeTx => ({ hash: `0x${n.toString(16).padStart(64, "0")}`, from: account, to: diamond,
  input: data, value: 10n ** 15n, nonce: n, block, ...over });
const otherTx = (n: number, block: bigint) => buyTx(n, block, { hash: `0x${(1000 + n).toString(16).padStart(64, "f")}`, to: account, input: "0x", value: 0n });
const blockHashOf = (block: bigint) => `0x${block.toString(16).padStart(64, "b")}` as Hex;
/** `stale`: transactions the node still answers a receipt for, in a block that is no longer the chain's block at its height. */
function chain(head: bigint, mined: FakeTx[], { mempool = [] as FakeTx[], reverted = [] as Hex[], stale = [] as FakeTx[] } = {}) {
  const reads: string[] = [];
  const client = {
    getBlockNumber: async () => { reads.push("head"); return head; },
    getTransactionReceipt: async ({ hash }: { hash: Hex }) => {
      reads.push(`receipt:${hash.slice(-4)}`);
      const old = stale.find((row) => row.hash === hash);
      if (old) return { transactionHash: hash, status: "success", blockNumber: old.block, blockHash: `0x${"0c".repeat(32)}` };
      const tx = mined.find((row) => row.hash === hash);
      if (!tx) throw new TransactionReceiptNotFoundError({ hash });
      return { transactionHash: hash, status: reverted.includes(hash) ? "reverted" : "success", blockNumber: tx.block, blockHash: blockHashOf(tx.block) };
    },
    getTransaction: async ({ hash }: { hash: Hex }) => {
      const mine = mined.find((row) => row.hash === hash), pending = mempool.find((row) => row.hash === hash);
      if (mine) return { ...mine, blockNumber: mine.block, blockHash: blockHashOf(mine.block) };
      if (pending) return { ...pending, blockNumber: null, blockHash: null };
      throw new TransactionNotFoundError({ hash });
    },
    getTransactionCount: async ({ address, blockNumber }: { address: Address; blockNumber: bigint }) => {
      reads.push(`count@${blockNumber}`);
      return mined.filter((row) => row.from === address && row.block <= blockNumber).length;
    },
    getBlock: async ({ blockNumber, includeTransactions }: { blockNumber: bigint; includeTransactions?: boolean }) => {
      reads.push(`${includeTransactions ? "block" : "canonical"}:${blockNumber}`);
      return { hash: blockHashOf(blockNumber), transactions: includeTransactions ? mined.filter((row) => row.block === blockNumber) : [] };
    },
  };
  return { client: client as never, reads };
}
const history = [otherTx(0, 5n), otherTx(1, 40n), otherTx(2, 90n)];

test("the ETH-buy record is per chain and wallet, apart from the launch fee's, and round-trips; anything malformed is ignored", () => {
  const key = ethBuyStorageKey(config, account);
  assert.equal(key, `musegod.eth-buy.v1.4663.4663.${account.toLowerCase()}`);
  assert.notEqual(key, ethBuyStorageKey(config, getAddress("0x3333333333333333333333333333333333333333")), "another wallet");
  assert.notEqual(key, ethBuyStorageKey({ mode: "fork", chainId: 31337, deploymentChainId: 4663 }, account), "another chain");
  assert.notEqual(key, launchFeeStorageKey(config, account));
  for (const record of [sending, pendingOf(`0x${"ab".repeat(32)}`), pendingOf(`0x${"ab".repeat(32)}`, { nonceSeen: true })])
    assert.deepEqual(parseEthBuyRecord(JSON.stringify(record)), record);
  assert.equal((parseEthBuyRecord(JSON.stringify({ ...sending, tx: { ...sending.tx, data: "0xABCDEF0123" } })) as EthBuyRecord).tx.data, data, "calldata is kept lower-case");
  for (const raw of [null, "", "{", "[]", JSON.stringify({ ...sending, nonce: undefined }), JSON.stringify({ ...sending, extra: 1 }),
    JSON.stringify({ ...sending, tx: { ...sending.tx, value: "-1" } }), JSON.stringify({ ...sending, target: { ...sending.target, kind: "other" } }),
    JSON.stringify({ ...sending, state: "paid" }), JSON.stringify({ ...sending, quoteId: "" })])
    assert.equal(parseEthBuyRecord(raw), null, String(raw));
});

test("only exactly the recorded transaction matches: its sender, target, calldata and ETH", () => {
  const tx = { hash: `0x${"01".repeat(32)}` as Hex, from: account, to: diamond, input: data, value: 10n ** 15n, nonce: 3 };
  assert.equal(ethBuyTxMatches(sending, tx), true);
  assert.equal(ethBuyTxMatches(sending, { ...tx, input: "0xABCDEF0123" }), true, "calldata case does not matter");
  for (const [why, over] of [["another sender", { from: diamond }], ["another target", { to: account }], ["no target", { to: null }],
    ["other calldata", { input: "0xabcdef0124" }], ["another amount", { value: 10n ** 15n + 1n }]] as const)
    assert.equal(ethBuyTxMatches(sending, { ...tx, ...over } as never), false, why);
});

test("only a rejection or an unprocessed refusal before any hash clears a recorded buy; an ambiguous wallet error keeps it", () => {
  const rejection = { name: "TransactionExecutionError", cause: new UserRejectedRequestError(new Error("User rejected the request.")) };
  assert.equal(attemptAfterSendError(sending, sending.at, rejection), null);
  assert.equal(attemptAfterSendError(sending, sending.at, { cause: new MethodNotSupportedRpcError(new Error("no")) }), null);
  for (const ambiguous of [{ cause: new InvalidInputRpcError(new Error("-32000")) }, new Error("Wallet disconnected"), new Error("timed out")])
    assert.deepEqual(attemptAfterSendError(sending, sending.at, ambiguous), sending, "it may have been broadcast");
  const pending = pendingOf(`0x${"ab".repeat(32)}`);
  assert.deepEqual(attemptAfterSendError(pending, sending.at, rejection), pending, "a hash exists: kept");
  assert.deepEqual(attemptAfterSendError(sending, sending.at + 1, rejection), sending, "another attempt is never touched");
});

test("broadcast without a hash: the exact transaction found at the recorded nonce is adopted after two canonical confirmations", async () => {
  const sent = buyTx(3, 104n), { client, reads } = chain(110n, [...history, sent, otherTx(4, 107n)]);
  assert.deepEqual(await resolveEthBuy(client, sending), { status: "bought", hash: sent.hash });
  assert(reads.includes("block:104") && reads.includes("canonical:104"));
  assert.deepEqual(await resolveEthBuy(chain(104n, [...history, sent]).client, sending), { status: "waiting" }, "one confirmation is not enough");
  assert.deepEqual(await resolveEthBuy(chain(104n, [...history, sent], { reverted: [sent.hash] }).client, sending), { status: "waiting" },
    "nor for a failure");
  assert.deepEqual(await resolveEthBuy(chain(110n, [...history, sent], { reverted: [sent.hash] }).client, sending), { status: "failed", reason: ETH_BUY_REVERTED });
});

test("the nonce unspent, or a predicted nonce spent by something else, stays undecided until the user says no payment was sent", async () => {
  assert.deepEqual(await resolveEthBuy(chain(110n, history).client, sending), { status: "unknown", reason: ETH_BUY_UNCONFIRMED });
  assert.deepEqual(await resolveEthBuy(chain(110n, [...history, otherTx(3, 104n)]).client, sending), { status: "unknown", reason: ETH_BUY_UNCONFIRMED });
  // The wallet queued another transaction first: the buy is found up to three nonces later.
  const later = buyTx(4, 105n);
  assert.deepEqual(await resolveEthBuy(chain(110n, [...history, otherTx(3, 104n), later]).client, sending), { status: "bought", hash: later.hash });
  assert.match(ETH_BUY_UNCONFIRMED, /If no ETH left your wallet for it, choose .No payment was sent./);
});

test("a known hash: confirming waits, a nonce the sent transaction really used spent by another clears it, a reported replacement decides", async () => {
  const sent = buyTx(3, 0n);
  assert.deepEqual(await resolveEthBuy(chain(110n, history, { mempool: [sent] }).client, pendingOf(sent.hash)),
    { status: "waiting", record: pendingOf(sent.hash, { nonceSeen: true }) });
  assert.deepEqual(await resolveEthBuy(chain(110n, [...history, { ...sent, block: 106n }]).client, pendingOf(sent.hash)), { status: "bought", hash: sent.hash });
  assert.deepEqual(await resolveEthBuy(chain(110n, [...history, otherTx(3, 106n)]).client, pendingOf(sent.hash, { nonceSeen: true })),
    { status: "failed", reason: ETH_BUY_CANCELLED });
  const cancel = otherTx(3, 106n);
  assert.deepEqual(await resolveEthBuy(chain(110n, [...history, cancel]).client, pendingOf(sent.hash), cancel.hash), { status: "failed", reason: ETH_BUY_CANCELLED });
  const speedUp = buyTx(3, 106n, { hash: `0x${"5e".repeat(32)}` });
  assert.deepEqual(await resolveEthBuy(chain(110n, [...history, speedUp]).client, pendingOf(sent.hash), speedUp.hash), { status: "bought", hash: speedUp.hash });
});

test("a spent nonce is searched once per page: a later check of the same record makes no search reads", async () => {
  const memo = new Map(), mined = [...history, otherTx(3, 104n), otherTx(4, 105n), otherTx(5, 106n), otherTx(6, 107n)];
  assert.equal((await resolveEthBuy(chain(110n, mined).client, sending, undefined, memo)).status, "unknown");
  const again = chain(110n, mined);
  assert.equal((await resolveEthBuy(again.client, sending, undefined, memo)).status, "unknown");
  assert.deepEqual(again.reads.filter((read) => read.startsWith("block:") || read.startsWith("count@") && read !== "count@110"), [], "no search again");
  assert.deepEqual(again.reads.filter((read) => !read.startsWith("receipt:") && !read.startsWith("canonical:")), ["head", "count@110"],
    "only the head, its nonce count, and each remembered transaction's receipt and block hash checked again");
});

// ---- round 5 P2: only stable chain state decides or is remembered -----------------------------------------------------------------
test("a reorganization replaces a found buy before it was stable: the sped-up transaction is adopted, never the vanished one", async () => {
  const memo = new Map(), original = buyTx(3, 105n), speedUp = buyTx(3, 106n, { hash: `0x${"5e".repeat(32)}` });
  // First check: the original at the recorded nonce has one confirmation.
  assert.deepEqual(await resolveEthBuy(chain(105n, [...history, original]).client, sending, undefined, memo), { status: "waiting" });
  assert.equal(memo.size, 0, "a transaction with one confirmation is never remembered");
  // The block is reorganized away; the sped-up copy of the same buy is mined at the same nonce.
  assert.deepEqual(await resolveEthBuy(chain(107n, [...history, speedUp]).client, sending, undefined, memo), { status: "bought", hash: speedUp.hash });
  assert.equal(memo.get(3)?.hash, speedUp.hash, "remembered once stable");
});

test("a remembered buy whose receipt vanished, or no longer lies in the canonical block, is forgotten and the nonce searched again", async () => {
  const original = buyTx(3, 104n), speedUp = buyTx(3, 108n, { hash: `0x${"5e".repeat(32)}` });
  for (const [why, after] of [["vanished", chain(112n, [...history, speedUp])], ["stale receipt", chain(112n, [...history, speedUp], { stale: [original] })]] as const) {
    const memo = new Map();
    assert.deepEqual(await resolveEthBuy(chain(110n, [...history, original]).client, sending, undefined, memo), { status: "bought", hash: original.hash });
    assert.equal(memo.get(3)?.hash, original.hash, "stable: two confirmations in the canonical block");
    // A deeper reorganization replaced it: the remembered entry no longer decides, so the search runs again and finds the replacement.
    assert.deepEqual(await resolveEthBuy(after.client, sending, undefined, memo), { status: "bought", hash: speedUp.hash }, why);
    assert(after.reads.some((read) => read.startsWith("block:")), `${why}: searched again`);
    assert.equal(memo.get(3)?.hash, speedUp.hash, why);
  }
});

test("another transaction at a nonce the buy used cancels it only once stable, whether found at the nonce or reported by the wallet", async () => {
  const sent = buyTx(3, 0n), other = otherTx(3, 110n), memo = new Map();
  assert.deepEqual(await resolveEthBuy(chain(110n, [...history, other]).client, pendingOf(sent.hash, { nonceSeen: true }), undefined, memo), { status: "waiting" },
    "one confirmation of another transaction never clears the record");
  assert.equal(memo.size, 0);
  assert.deepEqual(await resolveEthBuy(chain(111n, [...history, other]).client, pendingOf(sent.hash, { nonceSeen: true }), undefined, memo),
    { status: "failed", reason: ETH_BUY_CANCELLED });
  assert.deepEqual(await resolveEthBuy(chain(110n, [...history, other]).client, pendingOf(sent.hash), other.hash), { status: "waiting" }, "a reported replacement too");
  assert.deepEqual(await resolveEthBuy(chain(111n, [...history, other]).client, pendingOf(sent.hash), other.hash), { status: "failed", reason: ETH_BUY_CANCELLED });
});

// ---- round 6: a record with a known hash is never offered a re-pay; a remembered nonce result is checked again before any verdict ------
test("a buy with a known hash the node cannot see, its nonce unspent, keeps its record however long, never offering a re-pay; once it lands it is bought", async () => {
  const sent = buyTx(3, 105n, { hash: `0x${"ab".repeat(32)}` }), record = pendingOf(sent.hash);
  // The wallet still holds the transaction; our node lost it (or never saw it). Minutes, hours: the record waits.
  for (let check = 0; check < 3; check++) assert.deepEqual(await resolveEthBuy(chain(110n, history).client, record), { status: "waiting" });
  // Its predicted nonce taken by another, stable transaction and nothing at the next nonces: still not proof, so still no re-pay.
  assert.deepEqual(await resolveEthBuy(chain(110n, [...history, otherTx(3, 104n)]).client, record), { status: "waiting" });
  // It propagates again and lands.
  assert.deepEqual(await resolveEthBuy(chain(110n, [...history, sent]).client, record), { status: "bought", hash: sent.hash });
  // Without a hash, the same chain leaves the decision to the user, as before.
  assert.deepEqual(await resolveEthBuy(chain(110n, history).client, sending), { status: "unknown", reason: ETH_BUY_UNCONFIRMED });
});

test("the user's choice never removes a record with a known hash, nor one that changed since the choice was offered", () => {
  const pending = pendingOf(`0x${"ab".repeat(32)}`);
  assert.equal(discardable(sending, sending), true, "the unchanged record without a hash");
  assert.equal(discardable(pending, pending), false, "a known hash is settled by the chain only");
  assert.equal(discardable(sending, pending), false, "the wallet reported a hash after the choice was offered");
  const another: EthBuyRecord = { ...sending, at: sending.at + 1 };
  assert.equal(discardable(sending, another), false, "another attempt");
  assert.equal(discardable(sending, null), false);
  const paid = { state: "paid", from: account, fee: { asset: "stable", txHash: `0x${"cd".repeat(32)}` } };
  assert.equal(discardable(paid, paid), true, "a paid launch fee the server refused can still be replaced by the user's choice");
});

test("a remembered transaction at the nonce is checked again before a cancel verdict: after a reorganization the sped-up buy is adopted", async () => {
  const memo = new Map(), occupant = otherTx(3, 104n);
  // First the predicted nonce held another, stable transaction: remembered.
  assert.equal((await resolveEthBuy(chain(110n, [...history, occupant]).client, sending, undefined, memo)).status, "unknown");
  assert.equal(memo.get(3)?.hash, occupant.hash);
  // A reorganization removed it. The buy was seen at that nonce and sped up; the speed-up has two confirmations.
  const original = `0x${"ab".repeat(32)}` as Hex, speedUp = buyTx(3, 106n, { hash: `0x${"5e".repeat(32)}` });
  for (const [why, after] of [["vanished", chain(110n, [...history, speedUp])], ["stale receipt", chain(110n, [...history, speedUp], { stale: [occupant] })]] as const) {
    const stale = new Map(memo);
    assert.deepEqual(await resolveEthBuy(after.client, pendingOf(original, { nonceSeen: true }), undefined, stale), { status: "bought", hash: speedUp.hash },
      `${why}: never "cancelled" from the stale entry`);
    assert(after.reads.includes(`receipt:${occupant.hash.slice(-4)}`), `${why}: the remembered entry's receipt was checked`);
    assert.equal(stale.get(3)?.hash, speedUp.hash, `${why}: searched again`);
  }
  // A remembered occupant that still checks out keeps deciding: a nonce the buy really used, spent by it, cancelled the buy.
  assert.deepEqual(await resolveEthBuy(chain(110n, [...history, occupant]).client, pendingOf(original, { nonceSeen: true }), undefined, memo),
    { status: "failed", reason: ETH_BUY_CANCELLED });
});
