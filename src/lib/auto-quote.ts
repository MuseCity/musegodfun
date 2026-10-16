import { ApiError } from "./api";

export type AutoQuoteInput = { key: string; lifi: boolean; valid: boolean; pool: boolean; visible: boolean; busy: boolean; completed: boolean; connected: boolean };
export type AutoQuoteRequestOptions = { challenge: boolean; retry: false };
/** One debounced request plus a bounded expiry budget per input. Hiding or blocking the panel invalidates outstanding work. */
export function createAutoQuoteScheduler<T>(callbacks: {
  request: (options: AutoQuoteRequestOptions) => Promise<T>; remaining: (quote: T) => number; result: (quote: T) => void;
  error: (error: unknown) => void; pending: (value: boolean) => void; manual: (value: boolean) => void;
}) {
  let current: AutoQuoteInput | undefined, timer: ReturnType<typeof setTimeout> | undefined;
  let generation = 0, refreshes = 0, deadline: number | null = null, attempted = false, inFlight = false, disposed = false, challengeBlocked = false;
  const enabled = () => !!current && current.valid && current.pool && current.visible && !current.busy && (!current.lifi || current.connected);
  function cancel() { clearTimeout(timer); timer = undefined; }
  function invalidate() {
    generation++; cancel();
    if (inFlight) { inFlight = false; attempted = deadline !== null; callbacks.pending(false); }
  }
  function schedule() {
    cancel();
    if (disposed || !enabled() || inFlight) return;
    if (current!.completed || current!.lifi && challengeBlocked) { callbacks.manual(true); return; }
    if (!attempted) { timer = setTimeout(() => void request(false), current!.lifi ? 1_000 : 600); return; }
    if (deadline === null) return;
    const remaining = deadline - Date.now(), cap = current!.lifi ? 1 : 3;
    if (remaining <= 0 && refreshes >= cap) { callbacks.manual(true); return; }
    timer = setTimeout(() => {
      if (refreshes < cap) void request(true);
      else callbacks.manual(true);
    }, Math.max(0, remaining));
  }
  async function request(automaticRefresh: boolean, manual = false) {
    cancel();
    if (disposed || !enabled() || inFlight) return;
    if (!manual && (current!.completed || current!.lifi && challengeBlocked)) { callbacks.manual(true); return; }
    if (manual && current!.completed) refreshes = 0;
    if (automaticRefresh) refreshes++;
    const lifi = current!.lifi;
    const token = ++generation;
    inFlight = true; attempted = true; callbacks.manual(false); callbacks.pending(true);
    try {
      const quote = await callbacks.request({ challenge: manual, retry: false });
      if (token !== generation || disposed) return;
      if (manual && lifi) challengeBlocked = false;
      deadline = Date.now() + Math.max(0, callbacks.remaining(quote));
      callbacks.result(quote);
    } catch (error) {
      // A source-level challenge also applies to newer input; only an interactive success unlocks it.
      if (lifi && error instanceof ApiError && error.code === "CHALLENGE_REQUIRED") { challengeBlocked = true; schedule(); }
      if (token !== generation || disposed) return;
      deadline = null; callbacks.error(error); callbacks.manual(true);
    } finally {
      if (token === generation && !disposed) { inFlight = false; callbacks.pending(false); schedule(); }
    }
  }
  return {
    update(next: AutoQuoteInput) {
      if (disposed) return;
      const changed = !current || current.key !== next.key || current.lifi !== next.lifi;
      const wasEnabled = enabled(), wasCompleted = current?.completed;
      if (changed) { invalidate(); refreshes = 0; deadline = null; attempted = false; callbacks.manual(false); }
      current = next;
      if (!enabled() || next.completed) { invalidate(); if (next.completed) callbacks.manual(true); return; }
      if (changed || !wasEnabled || wasCompleted) schedule();
    },
    refresh() { if (!disposed) void request(false, true); },
    dispose() { disposed = true; invalidate(); },
  };
}
