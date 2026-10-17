import { getAddress, isAddress, recoverTypedDataAddress, type Address, type Hex } from "viem";
import { sameAddress, type TokenRecord } from "../src/lib/config";
import { isCanonicalProfileLinks, parseProfileLinks, profileTypedData, ProfileLinkError, PROFILE_SIGNATURE_WINDOW_MS,
  type ProfileTypedData, type TokenProfile } from "../src/lib/token-profile";

/** A refused profile save; `status` is the HTTP status the route answers with. */
export class ProfileError extends Error {
  constructor(readonly code: string, message: string, readonly status = 400) { super(message); this.name = "ProfileError"; }
}
export type ProfileStore = {
  snapshot(key: string): { at: number; data: unknown } | null | Promise<{ at: number; data: unknown } | null>;
  /** Writes only when no profile is stored or the stored one was signed before `issuedAt`; returns whether it wrote. */
  saveProfileSnapshot(key: string, data: unknown, issuedAt: number): boolean | Promise<boolean>;
};
/** Profiles live in `snapshots` under this prefix; cleanup in both stores keeps them (migration 20261017120000_profile_snapshots.sql). */
export const PROFILE_KEY_PREFIX = "profile:";
export const profileKey = (address: Address) => `${PROFILE_KEY_PREFIX}${address.toLowerCase()}`;

/** A stored profile, or null when there is none or the row does not have the exact saved shape (a tampered row never renders). */
export async function readTokenProfile(store: ProfileStore, address: Address): Promise<TokenProfile | null> {
  const row = await store.snapshot(profileKey(address));
  const data = row?.data as Partial<TokenProfile> | undefined;
  if (!data || typeof data !== "object" || !isCanonicalProfileLinks(data.links) || typeof data.signer !== "string" || !isAddress(data.signer, { strict: false }) ||
    !Number.isSafeInteger(data.issuedAt) || !Number.isSafeInteger(data.savedAt)) return null;
  return { links: { ...data.links }, signer: getAddress(data.signer), issuedAt: data.issuedAt!, savedAt: data.savedAt! };
}

export type ProfileSaveRequest = { links: unknown; issuedAt: unknown; signer: unknown; signature: unknown };
export type ProfileDependencies = {
  store: ProfileStore;
  /** The coin's own chain (the EIP-712 domain chain). */
  chainId: number;
  now?: () => number;
  /** Verifies a signature that local recovery did not attribute to `signer` (a contract wallet: ERC-1271 or ERC-6492). Optional: without
   * it only EOA signatures are accepted. */
  verifyContractSignature?: (signer: Address, typedData: ProfileTypedData, signature: Hex) => Promise<boolean>;
  /** The profile owner rule for this coin (tasks/token-ip-detail-plan.md §2). */
  isOwner: (token: TokenRecord, signer: Address) => Promise<boolean>;
};

function parseRequest(body: unknown): { request: ProfileSaveRequest; signer: Address; signature: Hex; issuedAt: number } {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new ProfileError("PROFILE_INVALID", "Send the profile as a JSON object.");
  const request = body as ProfileSaveRequest;
  const extra = Object.keys(body).filter((key) => !["links", "issuedAt", "signer", "signature"].includes(key));
  if (extra.length) throw new ProfileError("PROFILE_INVALID", `Unknown field: ${extra[0].slice(0, 40)}.`);
  if (typeof request.signer !== "string" || !isAddress(request.signer, { strict: false })) throw new ProfileError("PROFILE_INVALID", "The signer is not a valid address.");
  // Whole bytes, at most 2 KiB so a request stays small: a 65-byte ECDSA signature, or a contract wallet's of any length (ERC-1271/6492,
  // e.g. a 64-byte EIP-2098 one), which only the contract-wallet check can accept.
  if (typeof request.signature !== "string" || !/^0x(?:[0-9a-fA-F]{2}){1,2048}$/.test(request.signature))
    throw new ProfileError("PROFILE_INVALID", "The signature is not valid.");
  if (typeof request.issuedAt !== "number" || !Number.isSafeInteger(request.issuedAt) || request.issuedAt <= 0)
    throw new ProfileError("PROFILE_INVALID", "The signature time is not valid.");
  return { request, signer: getAddress(request.signer), signature: request.signature as Hex, issuedAt: request.issuedAt };
}

/** Saves a coin's social links after checking the request, its freshness, its signature and that the signer owns the profile. Nothing
 * is written on any refusal. The newest signature wins: a save must be signed after the one stored, so a captured request cannot be
 * replayed over a later change. The early check spares the signature and owner reads; the conditional write decides, so overlapping
 * saves (in one runtime or several) cannot put an older signature back. */
export async function saveTokenProfile(token: TokenRecord, body: unknown, deps: ProfileDependencies): Promise<TokenProfile> {
  if (token.mode === "fork") throw new ProfileError("PROFILE_UNAVAILABLE", "Local fork coins have no editable profile.", 409);
  const { request, signer, signature, issuedAt } = parseRequest(body);
  let links;
  try { links = parseProfileLinks(request.links); }
  catch (error) { throw new ProfileError("PROFILE_INVALID", error instanceof ProfileLinkError ? error.message : "The profile links are not valid."); }
  const now = (deps.now ?? Date.now)();
  if (Math.abs(now - issuedAt) > PROFILE_SIGNATURE_WINDOW_MS) throw new ProfileError("PROFILE_EXPIRED", "The signature time could not be verified. Your device clock may be wrong; reload to sync with the server before saving again.", 409);
  const stored = await readTokenProfile(deps.store, token.address);
  if (stored && issuedAt <= stored.issuedAt) throw new ProfileError("PROFILE_STALE", "A newer profile was already saved. Reload and try again.", 409);
  const typedData = profileTypedData(deps.chainId, token.address, links, issuedAt);
  let recovered: Address | null = null;
  // `signature.length === 132` is a 65-byte ECDSA signature; anything else can only be a contract wallet's.
  if (signature.length === 132) recovered = await recoverTypedDataAddress({ ...typedData, signature }).catch(() => null);
  const valid = recovered ? sameAddress(recovered, signer) : false;
  if (!valid && !(deps.verifyContractSignature && await deps.verifyContractSignature(signer, typedData, signature)))
    throw new ProfileError("PROFILE_SIGNATURE", "The signature does not match the signing wallet.", 401);
  if (!await deps.isOwner(token, signer)) throw new ProfileError("PROFILE_NOT_OWNER", "Only this coin's owner can edit its profile.", 403);
  const profile: TokenProfile = { links, signer, issuedAt, savedAt: now };
  if (!await deps.store.saveProfileSnapshot(profileKey(token.address), profile, issuedAt))
    throw new ProfileError("PROFILE_STALE", "A newer profile was already saved. Reload and try again.", 409);
  return profile;
}

/** Route 1 (a plain meme): the creator recorded at launch. Routes 2–3 (an NFT coin): the NFT's holder or delegate, read by the caller. */
export function creatorOwnsProfile(token: Pick<TokenRecord, "creator" | "nft">, signer: Address): boolean | null {
  if (token.nft) return null;
  return !!token.creator && sameAddress(token.creator, signer);
}
