export type AutoQuoteInput = { key: string; lifi: boolean; valid: boolean; pool: boolean; visible: boolean; busy: boolean; connected: boolean };
/** One debounced request plus a bounded expiry budget per input. Hiding or blocking the panel invalidates outstanding work. */
export function createAutoQuoteScheduler<T>(callbacks: {
  request: () => Promise<T>; remaining: (quote: T) => number; result: (quote: T) => void;
  error: (error: unknown) => void; pending: (value: boolean) => void; manual: (value: boolean) => void;
}) {
  let current: AutoQuoteInput | undefined, timer: ReturnType<typeof setTimeout> | undefined;
  let generation = 0, refreshes = 0, deadline: number | null = null, attempted = false, inFlight = false, disposed = false;
  const enabled = () => !!current && current.valid && current.pool && current.visible && !current.busy && (!current.lifi || current.connected);
  function cancel() { clearTimeout(timer); timer = undefined; }
  function invalidate() {
    generation++; cancel();
    if (inFlight) { inFlight = false; attempted = deadline !== null; callbacks.pending(false); }
  }
  function schedule() {
    cancel();
    if (disposed || !enabled() || inFlight) return;
    if (!attempted) { timer = setTimeout(() => void request(false), current!.lifi ? 1_000 : 600); return; }
    if (deadline === null) return;
    const remaining = deadline - Date.now(), cap = current!.lifi ? 1 : 3;
    if (remaining <= 0 && refreshes >= cap) { callbacks.manual(true); return; }
    timer = setTimeout(() => {
      if (refreshes < cap) void request(true);
      else callbacks.manual(true);
    }, Math.max(0, remaining));
  }
  async function request(automaticRefresh: boolean) {
    cancel();
    if (disposed || !enabled() || inFlight) return;
    if (automaticRefresh) refreshes++;
    const token = ++generation;
    inFlight = true; attempted = true; callbacks.manual(false); callbacks.pending(true);
    try {
      const quote = await callbacks.request();
      if (token !== generation || disposed) return;
      deadline = Date.now() + Math.max(0, callbacks.remaining(quote));
      callbacks.result(quote);
    } catch (error) {
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
      const wasEnabled = enabled();
      if (changed) { invalidate(); refreshes = 0; deadline = null; attempted = false; callbacks.manual(false); }
      current = next;
      if (!enabled()) { invalidate(); return; }
      if (changed || !wasEnabled) schedule();
    },
    refresh() { if (!disposed) void request(false); },
    dispose() { disposed = true; invalidate(); },
  };
}
