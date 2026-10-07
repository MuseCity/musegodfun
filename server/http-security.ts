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
export async function readBoundedBody(body: { getReader(): BodyReader }, maximum: number, deadlineMs: number): Promise<BoundedBody> {
  const reader = body.getReader(), chunks: Uint8Array[] = [];
  let size = 0, timedOut = false;
  const timer = setTimeout(() => { timedOut = true; reader.cancel().catch(() => {}); }, deadlineMs);
  try {
    while (true) {
      let next: { done: boolean; value?: Uint8Array };
      try { next = await reader.read(); }
      catch (error) { if (timedOut) return { status: 408 }; throw error; }
      if (timedOut) return { status: 408 };
      if (next.done || !next.value) break;
      size += next.value.byteLength;
      if (size > maximum) { await reader.cancel().catch(() => {}); return { status: 413 }; }
      chunks.push(next.value);
    }
  } finally { clearTimeout(timer); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return { bytes };
}
