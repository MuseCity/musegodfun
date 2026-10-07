export async function api<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`/api${path}`, {
    ...(body === undefined
      ? {}
      : {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
    signal: AbortSignal.timeout(/\/launch\/(prepare|simulate)$/.test(path) ? 190_000 : 35_000),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || "Request failed");
  return result as T;
}

export function chainApi<T>(chainId: 8453 | 4663, path: string, body?: unknown): Promise<T> {
  if (![8453, 4663].includes(chainId) || !path.startsWith("/") || path.startsWith("//"))
    throw new Error("Unsupported API network or path");
  const target = new URL(`/api/chains/${chainId}${path}`, "https://musegod.fun");
  if (path.includes("#") || !target.pathname.startsWith(`/api/chains/${chainId}/`))
    throw new Error("Unsupported API network or path");
  return api<T>(`/chains/${chainId}${path}`, body);
}
