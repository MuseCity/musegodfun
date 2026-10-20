import { getAddress, isAddress, type Address } from "viem";

export const POST_KEY_TTL_MS = 30 * 86_400_000;
export const POST_SIGNATURE_WINDOW_MS = 10 * 60_000;
export const POST_TEXT_MAX = 5_000;
export const POST_IMAGES_MAX = 4;
export const POST_OWNER_ACTIONS = ["create-key", "list-keys", "revoke-key", "delete-post"] as const;
export type PostOwnerAction = typeof POST_OWNER_ACTIONS[number];
export type PostApiKey = { id: string; name: string; prefix: string; issuer: Address; createdAt: number; expiresAt: number; revokedAt: number | null };
export type TokenPost = { id: string; text: string; images: { id: string; url: string }[]; videoUrl: string; createdAt: number };
export type TokenPostsPage = { items: TokenPost[]; nextCursor: string | null };
export const POST_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** A separate, human-readable authority: these signatures never authorize transactions or profile edits. */
export function postOwnerTypedData(chainId: number, token: Address, action: PostOwnerAction, targetId: string, name: string, issuedAt: number) {
  if (![4663, 8453].includes(chainId) || !isAddress(token, { strict: false }) || !POST_OWNER_ACTIONS.includes(action) ||
    !Number.isSafeInteger(issuedAt) || issuedAt <= 0 || name.length > 60 ||
    (action === "list-keys" ? targetId !== "" : !POST_ID_PATTERN.test(targetId)) ||
    (action !== "create-key" && name !== "")) throw new Error("Invalid Posts authorization.");
  return {
    domain: { name: "Musegod Token Posts", version: "1", chainId, verifyingContract: getAddress(token) },
    primaryType: "PostOwnerAction" as const,
    types: { PostOwnerAction: [
      { name: "action", type: "string" }, { name: "targetId", type: "string" }, { name: "name", type: "string" },
      { name: "keyLifetimeDays", type: "uint32" }, { name: "issuedAt", type: "uint256" },
    ] },
    message: { action, targetId, name, keyLifetimeDays: action === "create-key" ? 30 : 0, issuedAt: BigInt(issuedAt) },
  };
}
export type PostOwnerTypedData = ReturnType<typeof postOwnerTypedData>;

/** Link cards are never fetched by the server. Restrict even their navigation targets to public HTTPS names. */
export function publicPostUrl(raw: unknown): string {
  if (raw === undefined || raw === "") return "";
  if (typeof raw !== "string" || raw.length > 2_000) throw new Error("Use a public HTTPS video link, up to 2,000 characters.");
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error("Use a public HTTPS video link."); }
  const host = url.hostname.toLowerCase().replace(/\.$/, ""), labels = host.split("."), tld = labels.at(-1)!;
  const privateTlds = new Set(["local", "localhost", "localdomain", "internal", "intranet", "lan", "home", "corp", "private", "test", "example", "invalid", "arpa", "onion"]);
  if (url.protocol !== "https:" || url.username || url.password || url.port || host.length > 253 || labels.length < 2 ||
    !labels.every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) ||
    !/^(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$/.test(tld) || privateTlds.has(tld)) throw new Error("Use a public HTTPS video link.");
  url.hostname = host;
  return url.href;
}
