export function securityHeaders(secure: boolean, production = true): Record<string, string> {
  return {
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "X-Frame-Options": "DENY",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
    "Cross-Origin-Opener-Policy": "same-origin-allow-popups",
    ...(production ? {
      "Content-Security-Policy": "default-src 'self'; script-src 'self' https://challenges.cloudflare.com; style-src 'self' 'unsafe-inline'; img-src 'self' https: data:; font-src 'self'; connect-src 'self' https://challenges.cloudflare.com; frame-src https://challenges.cloudflare.com; frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'",
      ...(secure ? { "Strict-Transport-Security": "max-age=31536000" } : {}),
    } : {}),
  };
}
/** Frozen creation backups repeat encoded metadata; other request bodies keep
 * the smaller ingress bound. Both Node and Worker enforce this same limit. */
export function requestBodyLimitForPath(path: string): number {
  if (/^\/api\/(?:chains\/(?:8453|4663)\/)?webhooks\/alchemy$/.test(path.split("?")[0])) return 1_048_576;
  return /^\/api\/(?:chains\/(?:8453|4663)\/)?launch\/register\/?$/i.test(path.split("?")[0]) ? 262_144 : 65_536;
}
export type BoundedBody = { status: 408 | 413 } | { bytes: Uint8Array };
type BodyReader = { read(): Promise<{ done: boolean; value?: Uint8Array }>; cancel(): Promise<void> };
// A legitimate body, including a 256KiB recovery backup, arrives well within
// this; a trickled one must not hold its ingress slot for long.
export const BODY_READ_DEADLINE_MS = 10_000;
/** Reads an ingress body under its size bound and deadline. A trickled body
 * is 408 and an oversized one 413, whether the runtime resolves or rejects a
 * read pending at cancellation (workerd rejects it). */
export async function readBoundedBody(body: { getReader(): BodyReader }, maximum: number, deadlineMs: number, signal?: AbortSignal): Promise<BoundedBody> {
  const reader = body.getReader(), chunks: Uint8Array[] = [];
  let size = 0, stopped = false, cancelled = false, interrupt!: (value: {status:408}) => void;
  const interrupted = new Promise<{status:408}>(resolve => { interrupt = resolve; });
  const cancel = () => { if (!cancelled) { cancelled = true; void reader.cancel().catch(() => {}); } };
  const stop = () => { stopped = true; interrupt({status:408}); cancel(); };
  const timer = setTimeout(stop, deadlineMs);
  signal?.addEventListener('abort',stop,{once:true});
  const read = async (): Promise<BoundedBody> => {
    while (true) {
      const next = await reader.read();
      if (stopped) return {status:408};
      if (next.done || !next.value) break;
      size += next.value.byteLength;
      if (size > maximum) { cancel(); return { status: 413 }; }
      chunks.push(next.value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return {bytes};
  };
  try {
    if (signal?.aborted) { stop(); return {status:408}; }
    return await Promise.race([read(),interrupted]);
  } catch (error) { cancel(); if (stopped) return {status:408}; throw error; }
  finally { clearTimeout(timer); signal?.removeEventListener('abort',stop); }
}
