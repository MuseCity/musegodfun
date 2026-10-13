import type { RuntimeConfig } from "./config";
import { launchSchema, type LaunchInput } from "./validation";

// An agent hands its holder a prefilled create page: `/create?chainId=4663#draft=<base64url JSON>`. The fragment never reaches a
// server, it only prefills identity fields (and the NFT), and the holder reviews and signs everything in their own wallet. The
// pairing asset and the launch fee are never part of a link: the form picks the pair (a Muse always pairs with MUSEGOD) and the
// fee is paid in the holder's wallet.
const MAX = 4096;
const PREFIX = "#draft=";
const FIELDS = ["name", "symbol", "description", "image", "website", "twitter", "telegram", "tradingFeeBps", "nft"] as const;

function toBase64Url(text: string) {
  let binary = "";
  for (const byte of new TextEncoder().encode(text)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function fromBase64Url(value: string) {
  const bytes = Uint8Array.from(atob(value.replace(/-/g, "+").replace(/_/g, "/")), (char) => char.charCodeAt(0));
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

/** The create-page link for a draft. The fields are written in one fixed order, so the same draft always gives the same link. */
export function encodeDraftLink(draft: Partial<LaunchInput>, origin = "https://musegod.fun", chainId = 4663) {
  const fields = Object.fromEntries(FIELDS.filter((key) => draft[key] !== undefined).map((key) => [key, draft[key]]));
  return `${origin}/create?chainId=${chainId}${PREFIX}${toBase64Url(JSON.stringify({ v: 1, ...fields }))}`;
}

export type DraftFragment = { draft: Partial<LaunchInput> } | { error: string };
/** The draft in a `#draft=` fragment: null when the hash is not one, otherwise the checked fields or why they were refused. Each present
 * field passes the launch form's own check; an absent field stays absent. */
export function decodeDraftFragment(hash: string): DraftFragment | null {
  if (!hash.startsWith(PREFIX)) return null;
  const encoded = hash.slice(PREFIX.length);
  if (encoded.length > MAX) return { error: "This draft link is too long." };
  if (!/^[A-Za-z0-9_-]+$/.test(encoded)) return { error: "This draft link is malformed." };
  let json: unknown;
  try { json = JSON.parse(fromBase64Url(encoded)); } catch { return { error: "This draft link could not be read." }; }
  if (!json || typeof json !== "object" || Array.isArray(json)) return { error: "This draft link could not be read." };
  const { v: version, ...fields } = json as Record<string, unknown>;
  if (version !== 1) return { error: "This draft link is from a version this page does not support." };
  if (Object.keys(fields).some((key) => !(FIELDS as readonly string[]).includes(key))) return { error: "This draft link has fields this page does not accept." };
  const draft: Record<string, unknown> = {};
  for (const key of FIELDS) {
    if (fields[key] === undefined) continue;
    const field = launchSchema.shape[key].safeParse(fields[key]);
    if (!field.success) {
      // The form's own messages are specific; zod's generic ones ("Invalid input…") only say which field.
      const reason = field.error.issues[0]?.message ?? "";
      return { error: `This draft link was not imported: ${reason && !reason.startsWith("Invalid input") ? reason : `"${key}" is not valid.`}` };
    }
    draft[key] = field.data;
  }
  return { draft: draft as Partial<LaunchInput> };
}

const IMPORTED = "Imported from a link — check every field.";
const NFT_UNAVAILABLE = "NFT mode is not available on this network yet; the NFT was not imported.";
/** What the create form restores for a decoded link: the draft JSON for `restoreDraft` (so the Muse pair lock and every other
 * sanitising apply), and the notice to show. Where NFT mode is off the NFT is dropped and the other fields still import. */
export function importDraftLink(linked: Partial<LaunchInput>, config: Pick<RuntimeConfig, "mode" | "deploymentChainId" | "nftMode">) {
  const { nft, quoteAddress: _pair, launchFee: _fee, ...fields } = linked;
  const nftAvailable = config.nftMode?.enabled === true;
  return { raw: JSON.stringify(nft && nftAvailable ? { ...fields, nft } : fields), notice: nft && !nftAvailable ? `${IMPORTED} ${NFT_UNAVAILABLE}` : IMPORTED };
}
