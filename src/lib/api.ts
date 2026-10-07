import { observeServerTime, quoteNow } from "./quote-clock";

export type ChallengeRequest = { siteKey: string; action: string; resolve: (token: string) => void; reject: (error: Error) => void };
export class ApiError extends Error {
  constructor(message: string, public status: number, public code?: string) { super(message); }
}
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
  if (!response.ok && retryable && attempt < 2 && [429, 503].includes(response.status) && result.code !== "CHALLENGE_REQUIRED") {
    const seconds = Number(response.headers.get("retry-after") || "1");
    await new Promise((resolve) => setTimeout(resolve, Math.min(3000, Math.max(500, seconds * 1000))));
    continue;
  }
  if (!response.ok) throw new ApiError(result.error || "Request failed", response.status, result.code);
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
