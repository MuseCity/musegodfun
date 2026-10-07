// HTTP serverTime is stamped when the response is produced. The request can
// include minutes of SDK work, so its full round-trip is not network latency.
type ClockAnchor = { server: number; monotonic: number };
let anchor: ClockAnchor | undefined;
let windows = new Map<string, ClockAnchor>();
let objects = new WeakMap<object, ClockAnchor>();
function current(time: ClockAnchor) { return time.server + Math.max(0, performance.now() - time.monotonic); }
function windowKey(value: object): string | null {
  const q = value as { id?: unknown; transactionId?: unknown; blockHash?: unknown; chainId?: unknown;
    preparedAt?: unknown; quotedAt?: unknown; finalizedAt?: unknown; expiresAt?: unknown; signingExpiresAt?: unknown;
    openingValuation?: { blockHash?: unknown; expiresAt?: unknown; chainId?: unknown } };
  const start = q.finalizedAt ?? q.quotedAt ?? q.preparedAt;
  const expiry = q.signingExpiresAt ?? q.expiresAt ?? q.openingValuation?.expiresAt;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(expiry)) return null;
  return JSON.stringify([q.chainId ?? q.openingValuation?.chainId, q.id ?? q.transactionId ?? q.blockHash ?? q.openingValuation?.blockHash, start, expiry]);
}
/** With a quote/plan, keep that displayed window monotonic even if a later
 * response corrects the global clock. Cloned frozen windows share the same key. */
export function quoteNow(value?: object): number {
  if (value && anchor) {
    let time = objects.get(value);
    if (!time) {
      const key = windowKey(value);
      if (key) {
        time = windows.get(key) ?? { server: current(anchor), monotonic: performance.now() };
        windows.set(key, time); objects.set(value, time);
      }
    }
    if (time) return current(time);
  }
  return anchor ? current(anchor) : Date.now();
}
export function inheritQuoteClock<T extends object>(source: object, target: T): T {
  quoteNow(source);
  const time = objects.get(source);
  if (time) objects.set(target, time);
  return target;
}
export function observeServerTime(dateHeader: string | null, serverTime: unknown, _startedAt: number, receivedAt = performance.now()) {
  const header = dateHeader ? Date.parse(dateHeader) : NaN;
  const precise = typeof serverTime === "number" && Number.isSafeInteger(serverTime) && serverTime > 0 ? serverTime : NaN;
  const sent = Number.isFinite(header)
    ? Number.isFinite(precise) && Math.abs(precise - header) < 5_000 ? precise : header + 1_000
    : precise;
  if (!Number.isFinite(sent) || !Number.isFinite(receivedAt)) return;
  // New responses may correct a bad offset in either direction. Existing quote
  // anchors are kept separately, so this never renews an accepted window.
  anchor = { server: sent, monotonic: receivedAt };
}
export function resetQuoteClock() { anchor = undefined; windows = new Map(); objects = new WeakMap(); }
