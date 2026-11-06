import { AsyncLocalStorage } from "node:async_hooks";

export type BuybackReadFetchSource = "rpc" | "storage";
export type BuybackReadPhaseDiagnostics = {
  rpcFetches: number;
  storageFetches: number;
  rpcAttempts: number;
  rpcRetries: number;
  maxActiveFetches: number;
  http429s: number;
  runtimeBudgetRejections: number;
};
export type BuybackReadDiagnostics = BuybackReadPhaseDiagnostics & {
  readId: string;
  /** Active diagnostic read scopes, including this one, when it started. */
  activeReadsAtStart: number;
  maxConcurrentReads: number;
  /** Pending fetch promises at snapshot time; response bodies are not tracked. */
  activeFetches: number;
  /** Pending fetches when the read settled; null while the read is running. */
  activeFetchesAtCompletion: number | null;
  rpcMethods: Record<string, { attempts: number; retries: number }>;
  byPhase: Record<string, BuybackReadPhaseDiagnostics>;
};

type State = {
  diagnostics: BuybackReadDiagnostics;
  activeFetches: number;
  activeByPhase: Map<string, number>;
  closed: boolean;
};
type Context = { state: State; phases: string[] };
const context = new AsyncLocalStorage<Context>();
const activeReads = new Set<State>();
const counts = (): BuybackReadPhaseDiagnostics => ({
  rpcFetches: 0, storageFetches: 0, rpcAttempts: 0, rpcRetries: 0,
  maxActiveFetches: 0, http429s: 0, runtimeBudgetRejections: 0,
});
const snapshot = (state: State): BuybackReadDiagnostics => ({ ...structuredClone(state.diagnostics), activeFetches: state.activeFetches });
const rpcMethods = new Set([
  "eth_chainId", "eth_blockNumber", "eth_maxPriorityFeePerGas", "eth_feeHistory", "eth_call",
  "eth_getBalance", "eth_getBlockByNumber", "eth_getBlockByHash", "eth_getCode", "eth_getStorageAt",
  "eth_getTransactionCount", "eth_getTransactionByHash", "eth_getTransactionReceipt", "eth_estimateGas",
  "eth_gasPrice", "eth_sendRawTransaction", "eth_simulateV1", "net_version", "web3_clientVersion",
]);
const safeMethod = (method: string) => rpcMethods.has(method) ? method : "other";
function lateIo(selected: Context, source: BuybackReadFetchSource, kind: "fetch" | "rpc_attempt", method?: string, retry?: boolean) {
  try {
    console.warn(JSON.stringify({ event: "buyback_engine_late_io", readId: selected.state.diagnostics.readId,
      phase: selected.phases.join("/") || "read", source, kind,
      ...(kind === "rpc_attempt" ? { method: safeMethod(method ?? ""), retry: retry === true } : {}) }));
  } catch { /* Logging cannot alter the late operation. */ }
}
function current() {
  const selected = context.getStore();
  return selected && !selected.state.closed ? selected : undefined;
}
function phase(selected: Context) {
  const name = selected.phases.join("/") || "read";
  const phases = selected.state.diagnostics.byPhase;
  if (!Object.hasOwn(phases, name)) phases[name] = counts();
  return phases[name];
}
function increment(selected: Context, field: keyof Omit<BuybackReadPhaseDiagnostics, "maxActiveFetches">) {
  selected.state.diagnostics[field]++;
  phase(selected)[field]++;
}

/** Measures one fresh engine read's own dispatches, not Cloudflare's internal
 * quota counter. Fetches belong to the context actually dispatching the HTTP
 * batch; RPC attempts belong to the context initiating each method. */
export async function runBuybackReadDiagnostics<T>(read: () => Promise<T>,
  onComplete?: (diagnostics: BuybackReadDiagnostics) => void,
): Promise<{ value: T; diagnostics: BuybackReadDiagnostics }> {
  const concurrency = activeReads.size + 1;
  const state: State = {
    diagnostics: { ...counts(), readId: crypto.randomUUID(), activeReadsAtStart: concurrency,
      maxConcurrentReads: concurrency, activeFetches: 0, activeFetchesAtCompletion: null, rpcMethods: {}, byPhase: {} },
    activeFetches: 0, activeByPhase: new Map(), closed: false,
  };
  activeReads.add(state);
  for (const active of activeReads)
    active.diagnostics.maxConcurrentReads = Math.max(active.diagnostics.maxConcurrentReads, concurrency);
  return context.run({ state, phases: [] }, async () => {
    let value: T;
    try {
      value = await read();
    } finally {
      state.closed = true;
      state.diagnostics.activeFetchesAtCompletion = state.activeFetches;
      activeReads.delete(state);
      // Diagnostic logging must never replace the original read outcome.
      try { onComplete?.(snapshot(state)); } catch { /* Preserve the read result or original failure. */ }
    }
    return { value, diagnostics: snapshot(state) };
  });
}

export function currentBuybackReadDiagnostics(): BuybackReadDiagnostics | undefined {
  const selected = current();
  return selected ? snapshot(selected.state) : undefined;
}

/** Nested work is counted once under its full leaf path, e.g. graph/feeds. */
export function withBuybackReadPhase<T>(name: string, read: () => Promise<T>): Promise<T> {
  const selected = context.getStore();
  if (!selected) return read();
  // Phase and method labels are internal identifiers, never URLs or raw errors.
  const label = /^[a-zA-Z][a-zA-Z0-9:_-]{0,95}$/.test(name) ? name : "other";
  return context.run({ state: selected.state, phases: [...selected.phases, label] }, read);
}

export function recordBuybackRpcAttempt(method: string, retry: boolean): void {
  const selected = context.getStore();
  if (!selected) return;
  if (selected.state.closed) { lateIo(selected, "rpc", "rpc_attempt", method, retry); return; }
  const name = safeMethod(method);
  const row = selected.state.diagnostics.rpcMethods[name] ??= { attempts: 0, retries: 0 };
  row.attempts++;
  increment(selected, "rpcAttempts");
  if (retry) { row.retries++; increment(selected, "rpcRetries"); }
}

function rejected(error: unknown): { rateLimited: boolean; runtimeBudget: boolean } {
  let rateLimited = false, runtimeBudget = false, item = error;
  const seen = new Set<unknown>();
  for (let depth = 0; depth < 6 && item && typeof item === "object" && !seen.has(item); depth++) {
    seen.add(item);
    // An unusual error getter must not cause diagnostics to mask the error.
    try {
      const details = item as { status?: unknown; code?: unknown; message?: unknown; shortMessage?: unknown; cause?: unknown };
      const message = [details.message, details.shortMessage].filter(value => typeof value === "string").join(" ");
      rateLimited ||= details.status === 429 || details.code === 429 || /\b429\b/.test(message);
      runtimeBudget ||= /Too many subrequests\b|Too many API requests by single worker invocation\b/i.test(message);
      item = details.cause;
    } catch { break; }
  }
  return { rateLimited, runtimeBudget };
}

export function countedBuybackFetch(source: BuybackReadFetchSource,
  nativeFetch: typeof fetch = fetch.bind(globalThis),
): typeof fetch {
  return (input, init) => {
    const selected = context.getStore();
    if (!selected) return nativeFetch(input, init);
    if (selected.state.closed) { lateIo(selected, source, "fetch"); return nativeFetch(input, init); }
    const { state } = selected, name = selected.phases.join("/") || "read";
    increment(selected, source === "rpc" ? "rpcFetches" : "storageFetches");
    const active = (state.activeByPhase.get(name) ?? 0) + 1;
    state.activeByPhase.set(name, active);
    const row = phase(selected);
    row.maxActiveFetches = Math.max(row.maxActiveFetches, active);
    state.diagnostics.maxActiveFetches = Math.max(state.diagnostics.maxActiveFetches, ++state.activeFetches);
    const finish = () => {
      state.activeFetches--;
      state.activeByPhase.set(name, (state.activeByPhase.get(name) ?? 1) - 1);
    };
    const failure = (error: unknown): never => {
      if (!state.closed) {
        const category = rejected(error);
        if (category.rateLimited) increment(selected, "http429s");
        if (category.runtimeBudget) increment(selected, "runtimeBudgetRejections");
      }
      finish();
      throw error;
    };
    // Keep the original response, rejection object, arguments and dispatch
    // count. Bodies are never read, cloned, serialized or retained here.
    let result: Promise<Response>;
    try { result = nativeFetch(input, init); }
    catch (error) { return failure(error); }
    return result.then(response => {
      if (!state.closed && response.status === 429) increment(selected, "http429s");
      finish();
      return response;
    }, failure);
  };
}
