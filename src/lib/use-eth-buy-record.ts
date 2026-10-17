import { useEffect, useRef, useState } from "react";
import type { Address, Hash, Hex } from "viem";
import { networkName, type RuntimeConfig } from "./config";
import { ETH_BUY_LOCK, ETH_BUY_TAKEN, ETH_BUY_UNRESOLVED, ethBuyStorageKey, parseEthBuyRecord, resolveEthBuy, type EthBuyRecord, type EthBuyResolution,
  type EthBuyTarget } from "./eth-buy-record";
import type { FirstBuyPaymentQuote } from "./first-buy-payment";
import { ethBuyAvailable, receivedFromLogs } from "./eth-buy";
import { LOCK_ERROR, withLaunchIntentLock } from "./launch-intent";
import { attemptAfterSendError, discardable, recordAtBroadcast, type NonceMemo, type SendPollStatus } from "./send-record";
import { transactions } from "./transactions";
import { useSendPoll } from "./use-send-poll";
import { errorMessage } from "./validation";
import { transactionClient } from "./wallet";

/** Spent nonces per record key: each stable one is searched once per page (send-record.ts NonceMemo). */
const NONCE_MEMOS = new Map<string, NonceMemo>();
const read = (key: string) => { try { return parseEthBuyRecord(localStorage.getItem(key)); } catch { return null; } };
const write = (key: string, record: EthBuyRecord | null) => {
  if (record) localStorage.setItem(key, JSON.stringify(record)); else localStorage.removeItem(key);
};
/** The same attempt (sending and its pending upgrade share `at`) is still the wallet's record. */
const stillAttempt = (key: string, at: number) => { const current = read(key); return current && current.at === at ? current : null; };
/** The ETH buy shares the launch lock's machinery; its refusal describes the token-page buy here. */
export function ethBuyLockError(cause: unknown, pairSymbol = "the paired asset") {
  const message = cause instanceof Error ? cause.message : "";
  if (message === LOCK_ERROR) return new Error(`This browser cannot safely buy with ETH (no cross-tab lock). Pay with ${pairSymbol}, or use another browser.`);
  return /another tab|already being submitted in this tab/i.test(message)
    ? new Error("Another tab of this wallet is buying with ETH. Finish there first.") : cause;
}
/** A recorded buy the chain proved: the transaction and what it delivered (null when its receipt could not be read). */
export type EthBuyAdopted = { hash: Hex; target: EthBuyTarget; received: bigint | null };
/** The hooks one LI.FI wallet request runs under: `beforeSend` re-verifies the lease and writes the record right before the wallet receives
 * it (and before every resend), `onHash` upgrades it. */
export type EthBuySendHooks = { beforeSend: () => Promise<void>; onHash: (hash: Hash) => void };

/** The wallet's ETH-buy record on this network (shared by every coin page and tab of the wallet), the guard every LI.FI ETH transaction is
 * sent under, and the chain checks that settle one whose outcome the wallet never reported. */
export function useEthBuyRecord(config: RuntimeConfig | null, account: Address | null, pairSymbol?: string) {
  // No key on a fork or an unsupported chain: nothing is recorded, polled or guarded there.
  const key = config && account && ethBuyAvailable(config) ? ethBuyStorageKey(config, account) : "";
  const [record, setRecord] = useState<EthBuyRecord | null>(null), [revision, setRevision] = useState(0);
  const [unknown, setUnknown] = useState(""), [notice, setNotice] = useState(""), [checking, setChecking] = useState(false), [sending, setSending] = useState(false);
  const [adopted, setAdopted] = useState<EthBuyAdopted | null>(null);
  const latest = useRef({ key, config });
  latest.current = { key, config };
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const visible = (forKey: string) => alive.current && forKey === latest.current.key;
  const refresh = () => setRevision((value) => value + 1);

  useEffect(() => { setRecord(key ? read(key) : null); setNotice(""); setAdopted(null); }, [key]);
  useEffect(() => { if (key) setRecord(read(key)); }, [revision]);
  // Another tab of the same wallet may record, settle or clear a buy.
  useEffect(() => {
    const changed = (event: StorageEvent) => { if (!event.key || event.key === key) refresh(); };
    window.addEventListener("storage", changed);
    return () => window.removeEventListener("storage", changed);
  }, [key]);

  async function apply(forKey: string, attempt: EthBuyRecord, outcome: EthBuyResolution) {
    if (!stillAttempt(forKey, attempt.at)) { refresh(); return; } // Settled or replaced elsewhere: show what is saved now.
    if (outcome.status === "bought") {
      write(forKey, null);
      let received: bigint | null = null;
      const current = latest.current.config;
      try {
        if (current) received = receivedFromLogs((await transactionClient(current.chainId, current).getTransactionReceipt({ hash: outcome.hash })).logs,
          attempt.target.token, attempt.from);
      } catch { /* Shown as unknown. */ }
      if (visible(forKey)) { setRecord(null); setUnknown(""); setAdopted({ hash: outcome.hash, target: attempt.target, received: received !== null && received > 0n ? received : null }); }
    } else if (outcome.status === "failed") {
      write(forKey, null);
      if (visible(forKey)) { setRecord(null); setUnknown(""); setNotice(outcome.reason); }
    } else if (outcome.status === "waiting") {
      if (outcome.record) write(forKey, outcome.record);
      if (visible(forKey)) setUnknown("");
    } else if (visible(forKey)) setUnknown(outcome.reason);
  }
  async function check(forKey: string): Promise<SendPollStatus> {
    const current = read(forKey), runtime = latest.current.config;
    if (!current || !runtime) { refresh(); return "decided"; } // Decided elsewhere: nothing left to check.
    // The wallet records a speed-up or cancellation it saw on the original history row.
    const hint = current.state === "pending"
      ? transactions().find((row) => row.hash.toLowerCase() === current.txHash)?.replacement as Hex | undefined : undefined;
    let memo = NONCE_MEMOS.get(forKey);
    if (!memo) NONCE_MEMOS.set(forKey, memo = new Map());
    if (visible(forKey)) setChecking(true);
    try {
      const outcome = await resolveEthBuy(transactionClient(runtime.chainId, runtime), current, hint, memo);
      await apply(forKey, current, outcome);
      return outcome.status === "bought" || outcome.status === "failed" ? "decided" : outcome.status;
    } finally { if (visible(forKey)) setChecking(false); }
  }
  useEffect(() => { setUnknown(""); }, [key, record?.at, record?.state, sending]);
  const poll = useSendPoll(key, record, sending, check);
  /** "Check again": at once, also in a tab that is not the one polling. */
  function checkAgain() {
    if (!key || checking) return;
    if (!poll.now()) void check(key).catch(() => { if (visible(key)) setNotice("The ETH buy could not be checked. Try again in a minute."); });
  }
  /** The user's explicit "No payment was sent": only for the unchanged record it was offered for, never one with a known hash. Refused while
   * another tab of the wallet is buying. */
  async function discard() {
    if (!key || !account || !config) return;
    const forKey = key, saved = read(forKey);
    try {
      await withLaunchIntentLock(config, account, ETH_BUY_LOCK, async () => {
        if (discardable(saved, read(forKey))) write(forKey, null);
      });
      if (visible(forKey)) { setNotice(""); setUnknown(""); refresh(); }
    } catch (cause) { if (visible(forKey)) setNotice(errorMessage(ethBuyLockError(cause, pairSymbol))); }
  }
  /** Sends one LI.FI ETH transaction (`quote`) under the record. Inside this wallet's cross-tab lock it refuses while a record exists, reads
   * the account's pending nonce and the head, and hands `send` the hooks: at the wallet request itself, and before every resend, the lock is
   * verified again and another attempt's record is never overwritten (`recordAtBroadcast`), then the record is written; at the hash it is
   * upgraded. `send` resolves once the wallet saw two canonical confirmations of a successful receipt, which
   * decides the buy and removes the record. A rejection or unprocessed refusal before any hash removes it too; anything else keeps it for
   * the chain checks. */
  async function guard<T>(quote: FirstBuyPaymentQuote, target: EthBuyTarget, send: (hooks: EthBuySendHooks) => Promise<T>): Promise<T> {
    if (!key || !account || !config) throw new Error(`Buying a coin with ETH is unavailable on ${config ? networkName(config) : "this network"}.`);
    const forKey = key, from = account, client = transactionClient(config.chainId, config);
    let attemptAt = 0;
    setSending(true); setNotice(""); setUnknown(""); setAdopted(null);
    try {
      const result = await withLaunchIntentLock(config, from, ETH_BUY_LOCK, async (assertHeld) => {
        if (read(forKey)) throw new Error(ETH_BUY_UNRESOLVED);
        const [nonce, block] = await Promise.all([client.getTransactionCount({ address: from, blockTag: "pending" }), client.getBlockNumber({ cacheTime: 0 })]);
        await assertHeld();
        const sendingRecord: EthBuyRecord = { state: "sending", from, nonce, block: block.toString(), at: Date.now(), quoteId: quote.id,
          tx: { to: quote.transaction.to, data: quote.transaction.data.toLowerCase() as Hex, value: quote.transaction.value }, target };
        return send({
          beforeSend: async () => {
            await recordAtBroadcast(sendingRecord, { assertHeld, read: () => read(forKey), write: (record) => write(forKey, record), taken: ETH_BUY_TAKEN });
            attemptAt = sendingRecord.at;
            if (visible(forKey)) setRecord(sendingRecord);
          },
          onHash: (hash) => {
            if (!stillAttempt(forKey, sendingRecord.at)) return;
            const pending: EthBuyRecord = { ...sendingRecord, state: "pending", txHash: hash.toLowerCase() as Hex };
            write(forKey, pending);
            if (visible(forKey)) setRecord(pending);
          },
        });
      }).catch((cause: unknown) => { throw attemptAt ? cause : ethBuyLockError(cause, pairSymbol); });
      if (attemptAt && stillAttempt(forKey, attemptAt)) write(forKey, null);
      if (visible(forKey)) setRecord(read(forKey));
      return result;
    } catch (cause) {
      const current = attemptAt ? read(forKey) : null, kept = attemptAfterSendError(current, attemptAt, cause);
      if (current && !kept) write(forKey, null);
      if (visible(forKey)) setRecord(read(forKey));
      throw cause;
    } finally {
      if (alive.current) setSending(false);
    }
  }
  return { record, unknown, notice, checking, sending, adopted, checkAgain, discard: () => void discard(), guard,
    clearAdopted: () => setAdopted(null) };
}
