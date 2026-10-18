import { getAddress, isAddress, type Address } from "viem";
import { safeImage } from "./validation";
import type { TokenRecord } from "./config";

/** A coin's social links (tasks/token-ip-detail-plan.md §5): each one optional, stored as a canonical https URL, or "" when absent. */
export const PROFILE_FIELDS = ["x", "youtube", "tiktok", "telegram", "website"] as const;
export type ProfileField = (typeof PROFILE_FIELDS)[number];
export type ProfileLinks = Record<ProfileField, string>;
/** A saved profile: the links, the wallet that signed them, when it signed (`issuedAt`) and when the server stored it (`savedAt`). */
export type TokenProfile = { links: ProfileLinks; signer: Address; issuedAt: number; savedAt: number };
export const EMPTY_PROFILE_LINKS: ProfileLinks = Object.freeze({ x: "", youtube: "", tiktok: "", telegram: "", website: "" });
export const PROFILE_FIELD_LABELS: Record<ProfileField, string> = { x: "X", youtube: "YouTube", tiktok: "TikTok", telegram: "Telegram", website: "Website" };
export const PROFILE_LINK_MAX = 200;
/** A signature older than this, or this far in the future, is refused. */
export const PROFILE_SIGNATURE_WINDOW_MS = 10 * 60_000;

export class ProfileLinkError extends Error {
  constructor(readonly field: ProfileField, message: string) { super(message); this.name = "ProfileLinkError"; }
}

type Platform = { host: string; aliases: readonly string[]; handle: RegExp; path: (handle: string) => string; paths: RegExp; hint: string };
// `paths` is matched against the URL path with its trailing slash removed; a query or fragment is dropped.
const PLATFORMS: Record<Exclude<ProfileField, "website">, Platform> = {
  x: { host: "x.com", aliases: ["x.com", "www.x.com", "twitter.com", "www.twitter.com", "mobile.twitter.com", "mobile.x.com"],
    handle: /^[A-Za-z0-9_]{1,15}$/, path: (h) => `/${h}`, paths: /^\/(?:[A-Za-z0-9_]{1,15}|i\/communities\/\d{1,25})$/,
    hint: "Enter an X handle or an x.com profile or community link." },
  youtube: { host: "youtube.com", aliases: ["youtube.com", "www.youtube.com", "m.youtube.com"],
    handle: /^[A-Za-z0-9._-]{3,30}$/, path: (h) => `/@${h}`, paths: /^\/(?:@[A-Za-z0-9._-]{3,30}|channel\/UC[A-Za-z0-9_-]{22}|c\/[A-Za-z0-9._-]{1,100}|user\/[A-Za-z0-9._-]{1,100})$/,
    hint: "Enter a YouTube handle or a youtube.com channel link." },
  tiktok: { host: "tiktok.com", aliases: ["tiktok.com", "www.tiktok.com"],
    handle: /^[A-Za-z0-9._]{2,24}$/, path: (h) => `/@${h}`, paths: /^\/@[A-Za-z0-9._]{2,24}$/,
    hint: "Enter a TikTok handle or a tiktok.com profile link." },
  telegram: { host: "t.me", aliases: ["t.me", "telegram.me", "www.t.me"],
    handle: /^[A-Za-z0-9_]{5,32}$/, path: (h) => `/${h}`, paths: /^\/(?:[A-Za-z0-9_]{5,32}|\+[A-Za-z0-9_-]{10,40})$/,
    hint: "Enter a Telegram username or a t.me link." },
};
// The website field never holds a social profile: these domains and every subdomain of them are refused there.
const SOCIAL_DOMAINS = ["x.com", "twitter.com", "youtube.com", "youtu.be", "tiktok.com", "t.me", "telegram.me", "telegram.org"];
// Top-level names that never resolve publicly (RFC 2606, RFC 6761, RFC 6762, ICANN's .internal and common private ones).
const PRIVATE_TLDS = new Set(["local", "localhost", "localdomain", "internal", "intranet", "lan", "home", "corp", "private", "test", "example", "invalid", "arpa", "onion"]);
/** A public DNS name: lowercase, without its root dot, at least two valid labels and an alphabetic (or IDN) public top-level name. */
function publicHostname(hostname: string): string | null {
  const host = hostname.toLowerCase().replace(/\.$/, ""), labels = host.split("."), tld = labels[labels.length - 1];
  if (labels.length < 2 || host.length > 253 || !labels.every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) return null;
  return /^(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$/.test(tld) && !PRIVATE_TLDS.has(tld) ? host : null;
}

function parseUrl(value: string): URL | null {
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(value) ? value : `https://${value}`;
  try { return new URL(withScheme); } catch { return null; }
}

/** One field as the owner typed it (a handle, `@handle`, or a link) → its canonical https URL, or "" when empty. Throws ProfileLinkError. */
export function normalizeProfileLink(field: ProfileField, raw: unknown): string {
  if (raw === undefined || raw === null) return "";
  if (typeof raw !== "string") throw new ProfileLinkError(field, `${PROFILE_FIELD_LABELS[field]} must be text.`);
  const value = raw.trim();
  if (!value) return "";
  if (value.length > PROFILE_LINK_MAX) throw new ProfileLinkError(field, `${PROFILE_FIELD_LABELS[field]} is longer than ${PROFILE_LINK_MAX} characters.`);
  if (field === "website") {
    const url = parseUrl(value), host = url ? publicHostname(url.hostname) : null;
    const safe = url && host && url.protocol === "https:" && !url.port ? safeImage(url.href) : "";
    if (!safe || SOCIAL_DOMAINS.some((domain) => host === domain || host!.endsWith(`.${domain}`)))
      throw new ProfileLinkError(field, "Enter a public https website link. Social profiles have their own fields.");
    const canonical = new URL(safe);
    canonical.hostname = host!;
    canonical.hash = "";
    if (canonical.href.length > PROFILE_LINK_MAX) throw new ProfileLinkError(field, `Website is longer than ${PROFILE_LINK_MAX} characters.`);
    return canonical.href;
  }
  const platform = PLATFORMS[field], lower = value.toLowerCase();
  // A handle is `@name`, or a bare name that is not a link (no slash or scheme, and not one of the platform's own hosts).
  const link = !value.startsWith("@") && (/[/:]/.test(value) || platform.aliases.some((host) => lower === host));
  if (!link) {
    const handle = value.replace(/^@/, "");
    if (!platform.handle.test(handle)) throw new ProfileLinkError(field, platform.hint);
    return `https://${platform.host}${platform.path(handle)}`;
  }
  const url = parseUrl(value);
  if (!url || url.protocol !== "https:" || url.username || url.password || url.port || !platform.aliases.includes(url.hostname.toLowerCase()))
    throw new ProfileLinkError(field, platform.hint);
  const path = url.pathname.replace(/\/+$/, "");
  if (!platform.paths.test(path)) throw new ProfileLinkError(field, platform.hint);
  return `https://${platform.host}${path}`;
}

/** All five fields of a request body; unknown keys are refused so a typo never silently drops a link. */
export function parseProfileLinks(raw: unknown): ProfileLinks {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new ProfileLinkError("website", "Send the profile links as an object.");
  const input = raw as Record<string, unknown>;
  for (const key of Object.keys(input)) if (!(PROFILE_FIELDS as readonly string[]).includes(key)) throw new ProfileLinkError("website", `Unknown profile field: ${key.slice(0, 40)}.`);
  return Object.fromEntries(PROFILE_FIELDS.map((field) => [field, normalizeProfileLink(field, input[field])])) as ProfileLinks;
}

/** A stored value read back: it must already be canonical, so a tampered row never renders. */
export function isCanonicalProfileLinks(value: unknown): value is ProfileLinks {
  if (!value || typeof value !== "object") return false;
  try {
    const links = value as Record<string, unknown>;
    return Object.keys(links).length === PROFILE_FIELDS.length &&
      PROFILE_FIELDS.every((field) => typeof links[field] === "string" && normalizeProfileLink(field, links[field]) === links[field]);
  } catch { return false; }
}

/** The launch record's links (validated at launch as any https x.com, t.me or public URL), as profile links; one that does not fit a
 * profile field is left out rather than shown in a different form. */
export function launchProfileLinks(token: Pick<TokenRecord, "twitter" | "telegram" | "website">): ProfileLinks {
  const read = (field: ProfileField, value: string | undefined) => { try { return normalizeProfileLink(field, value ?? ""); } catch { return ""; } };
  return { ...EMPTY_PROFILE_LINKS, x: read("x", token.twitter), telegram: read("telegram", token.telegram), website: read("website", token.website) };
}

/** What the page shows: the saved profile once an owner has saved one (it may clear a launch link), otherwise the launch links. */
export function effectiveProfileLinks(token: Pick<TokenRecord, "twitter" | "telegram" | "website">, profile?: Pick<TokenProfile, "links"> | null): ProfileLinks {
  return profile && isCanonicalProfileLinks(profile.links) ? { ...profile.links } : launchProfileLinks(token);
}
/** A token detail's profile answer when the store could not give one in time (tasks/ip-page-improvements-2026-10-18-plan.md §1):
 * "stale" is the server's last answer (`profileCheckedAt` says when it was confirmed), "unavailable" means no answer is known. */
export type ProfileStatus = "stale" | "unavailable";
/** The links a page view may show, or null while the saved profile is unknown: a launch link its owner replaced or cleared must not
 * return in its place. */
export function displayedProfileLinks(token: Pick<TokenRecord, "twitter" | "telegram" | "website">, profile: Pick<TokenProfile, "links"> | null | undefined,
  status: ProfileStatus | undefined): ProfileLinks | null {
  return status === "unavailable" ? null : effectiveProfileLinks(token, profile);
}

/** The visible text of a link: the platform and its handle when the link names one, else the platform alone (or the site's host). */
export function profileLinkLabel(field: ProfileField, href: string): string {
  const url = new URL(href), path = url.pathname;
  if (field === "website") return url.hostname.replace(/^www\./, "") + (path === "/" ? "" : path.replace(/\/+$/, ""));
  const name = PROFILE_FIELD_LABELS[field];
  if (field === "x") return /^\/i\/communities\//.test(path) ? "X community" : `X @${path.slice(1)}`;
  if (field === "telegram") return path.startsWith("/+") ? "Telegram group" : `Telegram ${path.slice(1)}`;
  const at = /^\/@(.+)$/.exec(path);
  return at ? `${name} @${at[1]}` : name;
}

/** The links to render, in a fixed order, skipping empty fields. */
export function profileLinkList(links: ProfileLinks): { field: ProfileField; href: string; label: string }[] {
  return PROFILE_FIELDS.filter((field) => links[field]).map((field) => ({ field, href: links[field], label: profileLinkLabel(field, links[field]) }));
}

/** EIP-712 data the owner signs to save links. The domain has no verifying contract, so no token contract can treat it as an approval. */
export const PROFILE_DOMAIN_NAME = "musegod.fun";
export const PROFILE_DOMAIN_VERSION = "1";
export const PROFILE_PRIMARY_TYPE = "TokenProfile";
export const PROFILE_TYPES = {
  TokenProfile: [
    { name: "token", type: "address" },
    { name: "x", type: "string" },
    { name: "youtube", type: "string" },
    { name: "tiktok", type: "string" },
    { name: "telegram", type: "string" },
    { name: "website", type: "string" },
    { name: "issuedAt", type: "uint256" },
  ],
} as const;
export type ProfileTypedData = {
  domain: { name: string; version: string; chainId: number };
  types: typeof PROFILE_TYPES;
  primaryType: typeof PROFILE_PRIMARY_TYPE;
  message: { token: Address; issuedAt: bigint } & ProfileLinks;
};
export function profileTypedData(chainId: number, token: Address, links: ProfileLinks, issuedAt: number): ProfileTypedData {
  if (!Number.isSafeInteger(chainId) || chainId <= 0 || !isAddress(token, { strict: false }) || !Number.isSafeInteger(issuedAt) || issuedAt <= 0)
    throw new Error("Invalid profile signature request");
  return {
    domain: { name: PROFILE_DOMAIN_NAME, version: PROFILE_DOMAIN_VERSION, chainId },
    types: PROFILE_TYPES,
    primaryType: PROFILE_PRIMARY_TYPE,
    message: { token: getAddress(token), ...links, issuedAt: BigInt(issuedAt) },
  };
}
