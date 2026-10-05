export async function api<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`/api${path}`, {
    ...(body === undefined
      ? {}
      : {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
    signal: AbortSignal.timeout(["/launch/prepare", "/launch/simulate"].includes(path) ? 190_000 : 35_000),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || "Request failed");
  return result as T;
}
