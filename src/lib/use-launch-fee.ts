import { useEffect, useRef, useState } from "react";
import type { Address, Hex } from "viem";
import { deploymentChain, type RuntimeConfig } from "./config";
import { chainApi } from "./api";
import { withLaunchIntentLock } from "./launch-intent";
import { quoteNow } from "./quote-clock";
import { transactions } from "./transactions";
import { errorMessage } from "./validation";
import { transactionClient, useWallet } from "./wallet";
import {
  FEE_QUOTE_TOO_HIGH, FEE_TAKEN, LAUNCH_FEE_LOCK, launchFeeClearedNotice, launchFeeEthTx, launchFeeOf, launchFeeStableTx, launchFeeStorageKey,
  parseLaunchFeeRecord, resolveLaunchFee, saneFeeQuote, type DraftLaunchFee, type FeeResolution, type LaunchFeeAttempt, type LaunchFeeQuote,
  type LaunchFeeRecord, type LaunchFeeState,
} from "./nft-client";
import { attemptAfterSendError, recordAtBroadcast, type NonceMemo, type SendPollStatus } from "./send-record";
import { useSendPoll } from "./use-send-poll";

/** Spent nonces per wallet record key: each stable one is searched once per page (send-record.ts NonceMemo). */
const NONCE_MEMOS = new Map<string, NonceMemo>();
const read = (key: string) => { try { return parseLaunchFeeRecord(localStorage.getItem(key)); } catch { return null; } };
const write = (key: string, record: LaunchFeeRecord | null) => {
  if (record) localStorage.setItem(key, JSON.stringify(record)); else localStorage.removeItem(key);
};
/** The fee shares the launch lock's machinery; its "another tab" refusal is about the fee here. */
const feeError = (cause: unknown) => /another tab|already being submitted in this tab/i.test(cause instanceof Error ? cause.message : "")
  ? "Another tab of this wallet is paying the launch fee. Finish there first." : errorMessage(cause);
/** The same attempt (sending and its pending upgrade share `at`) is still the wallet's record. */
const stillAttempt = (key: string, at: number) => { const current = read(key); return current && current.state !== "paid" && current.at === at ? current : null; };

/** The wallet's $10 launch fee: its record (shared by every draft and tab of this wallet), the payment, and the chain checks that
 * settle a sent payment. The draft's `launchFee` always mirrors the paid record. */
export function useLaunchFee(config: RuntimeConfig, account: Address | null, draftFee: DraftLaunchFee | undefined,
  onFee: (fee: DraftLaunchFee | undefined) => void) {
  const wallet = useWallet();
  const key = account ? launchFeeStorageKey(config, account) : "";
  const [record, setRecord] = useState<LaunchFeeRecord | null>(null);
  const [unknown, setUnknown] = useState(""), [notice, setNotice] = useState(""), [paying, setPaying] = useState(false), [checking, setChecking] = useState(false);
  const [ethQuote, setEthQuote] = useState<LaunchFeeQuote | null>(null), [revision, setRevision] = useState(0);
  const latest = useRef({ onFee, draftFee, key });
  latest.current = { onFee, draftFee, key };
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const visible = (forKey: string) => alive.current && forKey === latest.current.key;
  const refresh = () => setRevision((value) => value + 1);

  // Load, and keep the draft's fee equal to the paid record.
  useEffect(() => {
    if (!key || !account) { setRecord(null); return; }
    const saved = read(key), fee = latest.current.draftFee;
    setRecord(saved);
    if (saved?.state === "paid") { if (fee?.txHash !== saved.fee.txHash) latest.current.onFee(saved.fee); }
    else if (fee) latest.current.onFee(undefined);
  }, [key, draftFee?.txHash, revision]);
  // Another tab of the same wallet may pay, settle or spend the fee.
  useEffect(() => {
    const changed = (event: StorageEvent) => { if (!event.key || event.key === key) refresh(); };
    window.addEventListener("storage", changed);
    return () => window.removeEventListener("storage", changed);
  }, [key]);

  function apply(forKey: string, attempt: LaunchFeeAttempt, outcome: FeeResolution) {
    if (!stillAttempt(forKey, attempt.at)) { refresh(); return; } // Settled or replaced elsewhere: show what is saved now.
    if (outcome.status === "paid") {
      const paid: LaunchFeeRecord = { state: "paid", from: attempt.from, fee: outcome.fee };
      write(forKey, paid);
      if (visible(forKey)) { setRecord(paid); setUnknown(""); latest.current.onFee(outcome.fee); }
    } else if (outcome.status === "failed") {
      write(forKey, null);
      if (visible(forKey)) { setRecord(null); setUnknown(""); setNotice(outcome.reason); }
    } else if (outcome.status === "waiting") {
      if (outcome.record) write(forKey, outcome.record);
      if (visible(forKey)) setUnknown("");
    } else if (visible(forKey)) setUnknown(outcome.reason);
  }
  // A sent or possibly sent payment is checked on the chain until it is decided (useSendPoll): by one tab per wallet at a time, never while
  // the page is hidden, and never while this tab's own wallet request is open, because the wallet decides first.
  const attempt = record && record.state !== "paid" ? record : null;
  async function check(forKey: string): Promise<SendPollStatus> {
    const saved = read(forKey), current = saved && saved.state !== "paid" ? saved : null;
    if (!current) { refresh(); return "decided"; } // Decided elsewhere: nothing left to check.
    // The wallet records a speed-up or cancellation it saw on the original history row.
    const hint = current.state === "pending"
      ? transactions().find((row) => row.hash.toLowerCase() === current.txHash)?.replacement as Hex | undefined : undefined;
    let memo = NONCE_MEMOS.get(forKey);
    if (!memo) NONCE_MEMOS.set(forKey, memo = new Map());
    if (visible(forKey)) setChecking(true);
    try {
      const outcome = await resolveLaunchFee(transactionClient(config.chainId, config), config, current, hint, memo);
      apply(forKey, current, outcome);
      return outcome.status === "paid" || outcome.status === "failed" ? "decided" : outcome.status;
    } finally { if (visible(forKey)) setChecking(false); }
  }
  useEffect(() => { setUnknown(""); }, [key, attempt?.at, attempt?.state, paying]);
  const poll = useSendPoll(key, attempt, paying, check);
  /** "Check again": at once, also in a tab that is not the one polling. */
  function checkAgain() {
    if (!key || checking) return;
    if (!poll.now()) void check(key).catch(() => { if (visible(key)) setNotice("The payment could not be checked. Try again in a minute."); });
  }

  async function pay(asset: DraftLaunchFee["asset"], quote?: LaunchFeeQuote) {
    if (!account || !key || paying) return;
    const forKey = key, from = account, client = transactionClient(config.chainId, config);
    let attemptAt = 0;
    setPaying(true); setNotice(""); setUnknown("");
    try {
      const hash = await withLaunchIntentLock(config, from, LAUNCH_FEE_LOCK, async (assertHeld) => {
        if (read(forKey)) throw new Error("A launch fee payment is already saved for this wallet. Check its status here.");
        const tx = quote ? launchFeeEthTx(config, quote) : launchFeeStableTx(config);
        const [nonce, block] = await Promise.all([client.getTransactionCount({ address: from, blockTag: "pending" }), client.getBlockNumber({ cacheTime: 0 })]);
        await assertHeld();
        const sending: LaunchFeeRecord = { state: "sending", asset, from, nonce, block: block.toString(), at: Date.now(), ...(quote ? { quote } : {}) };
        return wallet.send(tx.to, tx.data, config, (txHash) => {
          if (!stillAttempt(forKey, sending.at)) return;
          const pending: LaunchFeeRecord = { ...sending, state: "pending", txHash: txHash.toLowerCase() as Hex };
          write(forKey, pending);
          if (visible(forKey)) setRecord(pending);
        }, { value: tx.value, feeQuote: quote, beforeSend: async () => {
          // At the wallet request itself, and before every resend: the lock again, and never over another attempt's record.
          await recordAtBroadcast(sending, { assertHeld, read: () => read(forKey), write: (record) => write(forKey, record), taken: FEE_TAKEN });
          attemptAt = sending.at;
          if (visible(forKey)) setRecord(sending);
        } });
      });
      // The wallet saw two confirmations of a successful receipt; a sped-up payment returns its new hash.
      const current = read(forKey);
      if (current?.state === "paid") { if (visible(forKey)) { setRecord(current); latest.current.onFee(current.fee); } }
      else if (current && current.at === attemptAt) apply(forKey, current, { status: "paid", fee: launchFeeOf(asset, hash, quote) });
      else refresh();
      if (visible(forKey)) setEthQuote(null);
    } catch (cause) {
      const current = attemptAt ? read(forKey) : null, kept = attemptAfterSendError(current, attemptAt, cause);
      if (current && !kept) write(forKey, null);
      if (visible(forKey)) {
        setRecord(attemptAt ? kept : read(forKey));
        setNotice(current && !kept ? launchFeeClearedNotice(cause) : feeError(cause));
      }
    } finally {
      if (alive.current) setPaying(false);
    }
  }
  async function requestEthQuote() {
    if (!account || paying) return;
    setNotice("");
    try {
      const { wei, expiresAt, mac } = await chainApi<LaunchFeeQuote>(deploymentChain(config), `/launch-fee-quote?payer=${account}`);
      // A quote above the ceiling is never shown as "about $10"; the wallet would refuse it anyway.
      if (!saneFeeQuote({ wei })) { if (alive.current) { setEthQuote(null); setNotice(FEE_QUOTE_TOO_HIGH); } return; }
      if (alive.current) setEthQuote({ wei, expiresAt, mac });
    } catch (cause) { if (alive.current) setNotice(errorMessage(cause)); }
  }
  async function payEth() {
    if (!ethQuote) return;
    // A quote about to expire is refreshed and shown again instead of being sent.
    if (ethQuote.expiresAt * 1000 - quoteNow() < 10_000) {
      await requestEthQuote();
      if (alive.current) setNotice("The ETH price was refreshed. Check the new amount, then pay.");
      return;
    }
    await pay("native", ethQuote);
  }
  /** The user's explicit choice ("No payment was sent — pay again", "Pay a new fee"). Refused while another tab is paying. */
  async function discard() {
    if (!account || !key) return;
    const forKey = key, saved = read(forKey);
    try {
      await withLaunchIntentLock(config, account, LAUNCH_FEE_LOCK, async () => {
        const current = read(forKey);
        if (JSON.stringify(current) === JSON.stringify(saved)) write(forKey, null);
      });
      if (visible(forKey)) { setNotice(""); setUnknown(""); refresh(); }
    } catch (cause) { if (visible(forKey)) setNotice(feeError(cause)); }
  }

  const state: LaunchFeeState = !record ? "none" : record.state;
  return { state, record, unknown, notice, paying, checking, ethQuote, payStable: () => void pay("stable"), requestEthQuote: () => void requestEthQuote(),
    payEth: () => void payEth(), cancelEthQuote: () => setEthQuote(null), discard: () => void discard(), checkAgain };
}
