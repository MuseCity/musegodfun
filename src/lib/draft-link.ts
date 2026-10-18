import { deploymentChain, type RuntimeConfig } from "./config";
import { LAUNCH_FIELD_MESSAGES, LAUNCH_IDENTITY_FIELDS, launchSchema, type LaunchInput } from "./validation";

// An agent hands its holder a prefilled create page: `/create?chainId=4663#draft=<base64url JSON>`. The fragment never reaches a
// server. It prefills the identity fields (step one), the NFT and an optional trading fee (a step-two field), and the holder reviews
// and signs everything in their own wallet. The pairing asset and the launch fee are never part of a link: the form picks the pair
// (MUSEGOD by default for a Muse; the holder can choose another) and the fee is paid in the holder's wallet.
const MAX = 4096;
const PREFIX = "#draft=";
const FIELDS = ["name", "symbol", "description", "image", "website", "twitter", "telegram", "tradingFeeBps", "nft"] as const;
const NFT_PARTS = ["chainId", "contract", "tokenId"];
const FORM_MESSAGES: ReadonlySet<string> = new Set(Object.values(LAUNCH_FIELD_MESSAGES));
// An error never repeats anything the link contained: no key, no value, no library message. It names a known field (or a known part
// of `nft`), and gives either one of the form's own fixed messages or a sentence written here.
const refused = (reason: string) => ({ error: `This draft link was not imported: ${reason}` });

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
  if (version !== 1) return refused('"v" must be 1.');
  if (Object.keys(fields).some((key) => !(FIELDS as readonly string[]).includes(key))) return refused("it has an unknown field.");
  const draft: Record<string, unknown> = {};
  for (const key of FIELDS) {
    if (fields[key] === undefined) continue;
    const field = launchSchema.shape[key].safeParse(fields[key]);
    if (!field.success) {
      const issue = field.error.issues[0];
      const part = key === "nft" && NFT_PARTS.includes(String(issue?.path[0])) ? `.${String(issue.path[0])}` : "";
      if (issue && FORM_MESSAGES.has(issue.message)) return refused(`"${key}${part}": ${issue.message}`);
      return refused(`"${key}${part}" is ${issue?.code === "too_big" ? "too long" : "not valid"}.`);
    }
    draft[key] = field.data;
  }
  return { draft: draft as Partial<LaunchInput> };
}

const IMPORTED = "Imported from a link — check every field.";
const NFT_UNAVAILABLE = "NFT mode is not available on this network yet; the NFT was not imported.";
const NFT_OTHER_NETWORK = "The NFT is on a different network than this page; the NFT was not imported.";
export const SAVED_LAUNCHES_NOTE = "Your previous draft is under Saved launches.";
/** What the create form restores for a decoded link: the draft JSON for `restoreDraft` (so the Muse default pair and every other
 * sanitising apply), and the notice to show. The NFT is dropped, and the other fields still import, where NFT mode is off or when
 * the NFT is on another network than the page. `previousSaved` says the form's earlier draft was saved first. */
export function importDraftLink(linked: Partial<LaunchInput>, config: Pick<RuntimeConfig, "mode" | "deploymentChainId" | "nftMode">, previousSaved = false) {
  const { nft, quoteAddress: _pair, launchFee: _fee, ...fields } = linked;
  const nftNote = !nft ? "" : config.nftMode?.enabled !== true ? NFT_UNAVAILABLE : nft.chainId !== deploymentChain(config) ? NFT_OTHER_NETWORK : "";
  return {
    raw: JSON.stringify(nft && !nftNote ? { ...fields, nft } : fields),
    notice: [IMPORTED, nftNote, previousSaved ? SAVED_LAUNCHES_NOTE : ""].filter(Boolean).join(" "),
  };
}

/** A draft nobody has touched (blank identity, step one, no NFT, no fee): a link imports into it without saving anything first. */
export function isPristineDraft(draft: LaunchInput, step: number): boolean {
  return step <= 1 && !draft.nft && !draft.launchFee &&
    LAUNCH_IDENTITY_FIELDS.every((field) => !String((draft as Record<string, unknown>)[field] ?? "").trim());
}
