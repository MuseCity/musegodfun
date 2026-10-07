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
