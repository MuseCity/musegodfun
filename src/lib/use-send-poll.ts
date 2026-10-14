import { useEffect, useRef } from "react";
import { createSendPoller, type SendPollStatus } from "./send-record";

/** Checks an open recorded send (`open`, keyed by `key`) on the chain until it is decided, as `sendPollDelay` paces it: by one tab per
 * record at a time (a Web Lock per key; the others take over when it closes and follow its writes through storage events), never while the
 * page is hidden, and never while this tab's own wallet request for it is open (`paused`), because the wallet decides first. `now()` checks
 * again at once and returns false when this tab is not the one polling (the caller then checks once itself). */
export function useSendPoll(key: string, open: { at: number; state: string } | null, paused: boolean, check: (forKey: string) => Promise<SendPollStatus>) {
  const latest = useRef(check);
  latest.current = check;
  const poller = useRef<ReturnType<typeof createSendPoller> | null>(null);
  useEffect(() => {
    if (!open || paused || !key) return;
    const forKey = key, abort = new AbortController();
    let active = true, release = () => {};
    const begin = () => {
      if (!active) return;
      poller.current = createSendPoller(() => latest.current(forKey));
      poller.current.start();
    };
    if (typeof navigator !== "undefined" && navigator.locks) {
      const held = new Promise<void>((resolve) => { release = resolve; });
      navigator.locks.request(`musegod.send-poll.${forKey}`, { signal: abort.signal }, async () => { begin(); await held; }).catch(() => {});
    } else begin();
    const resume = () => poller.current?.resume();
    document.addEventListener("visibilitychange", resume);
    return () => {
      active = false; abort.abort(); release();
      poller.current?.stop(); poller.current = null;
      document.removeEventListener("visibilitychange", resume);
    };
  }, [key, open?.at, open?.state, paused]);
  return { now: () => { if (!poller.current) return false; poller.current.now(); return true; } };
}
