import { parseLiveEvent, type LiveEvent } from "./musegod-live";

type Socket = { on(name: string, fn: (...args: any[]) => void): unknown; removeAllListeners(): unknown; disconnect(): unknown };
export type LiveStatus = { connected: boolean; receiving: boolean; receivedAt: number | null };
type Listener = { status(value: LiveStatus): void; event(value: LiveEvent): void };
/** Owns retries rather than layering timers over Socket.IO's reconnect manager. */
export function createLiveConnection(options: { createSocket(): Socket; visible(): boolean; watchVisibility(fn: () => void): () => void }) {
  const listeners = new Set<Listener>();
  let socket: Socket | null = null, retry: ReturnType<typeof setTimeout> | undefined, quiet: ReturnType<typeof setTimeout> | undefined;
  let unwatch: (() => void) | undefined, failures = 0, status: LiveStatus = { connected: false, receiving: false, receivedAt: null };
  const publish = (next: LiveStatus) => { status = next; for (const listener of listeners) listener.status(status); };
  function disconnect() {
    clearTimeout(quiet); quiet = undefined;
    const previous = socket; socket = null; previous?.removeAllListeners(); previous?.disconnect();
    publish({ connected: false, receiving: false, receivedAt: null });
  }
  function failed(current: Socket) {
    if (socket !== current) return;
    disconnect();
    if (listeners.size && options.visible() && !retry) {
      const delay = Math.min(60_000, 2000 * 2 ** Math.min(failures++, 5));
      retry = setTimeout(() => { retry = undefined; connect(); }, delay);
    }
  }
  function connect() {
    if (socket || retry || !listeners.size || !options.visible()) return;
    let current: Socket;
    try { current = options.createSocket(); }
    catch {
      const delay = Math.min(60_000, 2000 * 2 ** Math.min(failures++, 5));
      retry = setTimeout(() => { retry = undefined; connect(); }, delay); return;
    }
    socket = current;
    current.on("connect", () => { if (socket === current) publish({ connected: true, receiving: false, receivedAt: null }); });
    current.on("connect_error", () => failed(current)); current.on("disconnect", () => failed(current));
    for (const name of ["TOKEN_SWAP", "DISCOVER_PRICE_UPDATE", "DISCOVER_VOLUME_UPDATE"]) current.on(name, payload => {
      if (socket !== current || !status.connected || !options.visible()) return;
      const batch = Array.isArray(payload) && name !== "TOKEN_SWAP" ? payload.slice(0, 200) : [payload];
      for (const raw of batch) {
        const event = parseLiveEvent(name, raw);
        if (!event) continue;
        failures = 0;
        for (const listener of listeners) listener.event(event);
        publish({ connected: true, receiving: true, receivedAt: Date.now() });
        clearTimeout(quiet); quiet = setTimeout(() => publish({ ...status, receiving: false }), 30_000);
      }
    });
  }
  function visibility() {
    if (!options.visible()) { clearTimeout(retry); retry = undefined; disconnect(); }
    else connect();
  }
  return {
    subscribe(listener: Listener) {
      listeners.add(listener); listener.status(status);
      if (listeners.size === 1) { unwatch = options.watchVisibility(visibility); connect(); }
      return () => {
        listeners.delete(listener);
        if (!listeners.size) { unwatch?.(); unwatch = undefined; clearTimeout(retry); retry = undefined; disconnect(); failures = 0; }
      };
    },
  };
}
