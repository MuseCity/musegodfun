import { observeServerTime, quoteNow } from "./quote-clock";

export type ChallengeRequest = { siteKey: string; action: string; resolve: (token: string) => void; reject: (error: Error) => void };
export class ApiError extends Error {
  // Seconds the server asked the caller to wait before retrying, if any.
  constructor(message: string, public status: number, public code?: string, public retryAfter?: number) { super(message); }
}
// Short capacity waits are absorbed here; a longer server-requested wait is
// returned to the caller (with retryAfter) instead of being cut short.
const AUTOMATIC_RETRY_SECONDS = 3;
export async function api<T>(path: string, body?: unknown): Promise<T> {
  let challengeToken: string | undefined;
  const requestId = crypto.randomUUID();
  const retryable = body === undefined || /\/(prepare|validate|simulate|quote|verify|register|track)$/.test(path);
  for (let attempt = 0; ; attempt++) {
  const started = performance.now();
  const response = await fetch(`/api${path}`, {
    ...(body === undefined
      ? {}
      : {
          method: "POST",
          headers: { "content-type": "application/json", ...(challengeToken ? { "x-turnstile-token": challengeToken } : {}) },
          body: JSON.stringify(body),
        }),
    headers: { ...(body === undefined ? {} : { "content-type": "application/json" }),
      "x-request-id": requestId, ...(challengeToken ? { "x-turnstile-token": challengeToken } : {}) },
    signal: AbortSignal.timeout(/\/launch\/(prepare|simulate)$/.test(path) ? 190_000 : 35_000),
  });
  const result = await response.json();
  observeServerTime(response.headers.get("date"), result?.serverTime, started);
  if (result && typeof result === "object") quoteNow(result);
  if (!response.ok && result.code === "CHALLENGE_REQUIRED" && !challengeToken && typeof window !== "undefined") {
    challengeToken = await new Promise<string>((resolve, reject) => {
      window.dispatchEvent(new CustomEvent<ChallengeRequest>("musegod:challenge", { detail: { siteKey: result.siteKey, action: result.action, resolve, reject } }));
    });
    continue;
  }
  const header = response.headers.get("retry-after"), retryAfter = header !== null && Number.isFinite(Number(header)) ? Math.max(0, Number(header)) : undefined;
  if (!response.ok && retryable && attempt < 2 && [429, 503].includes(response.status) && result.code !== "CHALLENGE_REQUIRED" &&
    (retryAfter ?? 1) <= AUTOMATIC_RETRY_SECONDS) {
    await new Promise((resolve) => setTimeout(resolve, Math.max(500, (retryAfter ?? 1) * 1000)));
    continue;
  }
  if (!response.ok) throw new ApiError(result.error || "Request failed", response.status, result.code, retryAfter);
  return result as T;
  }
}

export function chainApi<T>(chainId: 8453 | 4663, path: string, body?: unknown): Promise<T> {
  if (![8453, 4663].includes(chainId) || !path.startsWith("/") || path.startsWith("//"))
    throw new Error("Unsupported API network or path");
  const target = new URL(`/api/chains/${chainId}${path}`, "https://musegod.fun");
  if (path.includes("#") || !target.pathname.startsWith(`/api/chains/${chainId}/`))
    throw new Error("Unsupported API network or path");
  return api<T>(`/chains/${chainId}${path}`, body);
}
