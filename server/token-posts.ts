import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { Buffer } from "node:buffer";
import { getAddress, recoverTypedDataAddress, type Address, type Hex } from "viem";
import { z } from "zod";
import { sameAddress, type TokenRecord } from "../src/lib/config";
import { POST_ID_PATTERN, POST_IMAGES_MAX, POST_KEY_TTL_MS, POST_SIGNATURE_WINDOW_MS, POST_TEXT_MAX,
  postOwnerTypedData, publicPostUrl, type PostApiKey, type PostOwnerAction, type PostOwnerTypedData, type TokenPost } from "../src/lib/token-posts";
import { MAX_TOKEN_IMAGE_BYTES } from "../src/lib/token-image";
import { addressSchema } from "../src/lib/validation";
import type { PostCommand, PostKeyRecord, PostRecord, PostResult } from "./post-store";
import { validateTokenImage } from "./token-images";
import { BudgetUnavailable } from "./runtime-policy";

export class PostError extends Error {
  constructor(readonly code: string, message: string, readonly status = 400, readonly retryAfter?: number) { super(message); this.name = "PostError"; }
}
const idSchema = z.string().regex(POST_ID_PATTERN);
const signatureSchema = z.object({
  signer: addressSchema, signature: z.string().regex(/^0x(?:[0-9a-fA-F]{2}){1,2048}$/), issuedAt: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
});
const keyCreateSchema = signatureSchema.extend({ keyId: idSchema, name: z.string().min(1).max(60).regex(/^[^\x00-\x1f\x7f]+$/) }).strict();
const postCreateSchema = z.object({ text: z.string().default(""), imageIds: z.array(z.string().regex(/^[a-f0-9]{64}$/)).max(POST_IMAGES_MAX).default([]), videoUrl: z.string().max(2_000).default("") }).strict();
const digest = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const publicKey = ({ id, name, prefix, issuer, createdAt, expiresAt, revokedAt }: PostKeyRecord): PostApiKey =>
  ({ id, name, prefix, issuer: getAddress(issuer), createdAt, expiresAt, revokedAt });
const publicPost = ({ id, text, images, videoUrl, createdAt }: PostRecord): TokenPost => ({ id, text, images, videoUrl: videoUrl ?? "", createdAt });

export type TokenPostsDependencies = {
  chainId: 4663 | 8453;
  store: { postAction(command: PostCommand): PostResult | Promise<PostResult> };
  token(address: Address): Promise<TokenRecord>;
  /** Must read current on-chain holder, bypassing ownership caches. Throws on an uncertain RPC result. */
  nftOwner(token: TokenRecord): Promise<Address>;
  verifyContractSignature(signer: Address, typedData: PostOwnerTypedData, signature: Hex): Promise<boolean>;
  uploadImage(body: unknown): Promise<{ image: string }>;
  now?: () => number;
};

export class TokenPosts {
  constructor(private readonly deps: TokenPostsDependencies) {}
  private now() { return (this.deps.now ?? Date.now)(); }
  private async run(command: PostCommand) {
    let result: PostResult;
    try { result = await this.deps.store.postAction(command); }
    catch { throw new PostError("POST_STORE_UNAVAILABLE", "Posts storage is temporarily unavailable. Retry shortly.", 503, 5); }
    if (result.error) throw new PostError(result.error.code, result.error.message, result.error.status, result.error.retryAfter);
    return result;
  }
  private async token(raw: unknown) {
    const address = addressSchema.parse(raw);
    let token: TokenRecord;
    try { token = await this.deps.token(address); }
    catch (error) {
      if (error instanceof Error && error.message === "Platform token not found") throw new PostError("TOKEN_NOT_REGISTERED", error.message, 404);
      throw new PostError("POST_STORE_UNAVAILABLE", "The token could not be confirmed. Retry shortly.", 503, 5);
    }
    if (token.mode === "fork" || (token.deploymentChainId ?? (token.mode === "base" ? 8453 : 4663)) !== this.deps.chainId ||
      token.nft && token.nft.chainId !== this.deps.chainId) throw new PostError("POST_UNAVAILABLE", "Posts are unavailable for this token on this network.", 409);
    return token;
  }
  private async isOwner(token: TokenRecord, signer: Address) {
    if (!token.nft) return !!token.creator && sameAddress(token.creator, signer);
    try { return sameAddress(await this.deps.nftOwner(token), signer); }
    catch { throw new PostError("POST_OWNER_UNAVAILABLE", "The current NFT holder could not be verified. Retry shortly.", 503, 5); }
  }
  private async owner(token: TokenRecord, body: unknown, action: PostOwnerAction, targetId = "", authorization?: string) {
    if (authorization !== undefined) throw new PostError("POST_AUTH_AMBIGUOUS", "Use either an owner signature or an API key, never both.");
    const creation = action === "create-key" ? keyCreateSchema.parse(body) : null;
    const input = creation ?? signatureSchema.strict().parse(body);
    const name = creation?.name ?? "";
    const id = creation?.keyId ?? targetId;
    if (Math.abs(this.now() - input.issuedAt) > POST_SIGNATURE_WINDOW_MS) throw new PostError("POST_SIGNATURE_EXPIRED", "The authorization expired. Reload and sign again.", 409);
    const typedData = postOwnerTypedData(this.deps.chainId, token.address, action, id, name, input.issuedAt);
    const signature = input.signature as Hex;
    const recovered = signature.length === 132 ? await recoverTypedDataAddress({ ...typedData, signature }).catch(() => null) : null;
    let valid = recovered !== null && sameAddress(recovered, input.signer);
    if (!valid) {
      try { valid = await this.deps.verifyContractSignature(input.signer, typedData, signature); }
      catch { throw new PostError("POST_SIGNATURE_UNAVAILABLE", "The signing wallet could not be verified. Retry shortly.", 503, 5); }
    }
    if (!valid) throw new PostError("POST_SIGNATURE_INVALID", "The signature does not match the signing wallet.", 401);
    if (!await this.isOwner(token, input.signer)) throw new PostError("POST_NOT_OWNER", "Only this token's creator or current NFT holder may authorize this action.", 403);
    return { signer: input.signer, id, name };
  }
  private async agent(token: TokenRecord, authorization?: string) {
    const match = /^Bearer (mgp_([0-9a-f-]{36})\.[A-Za-z0-9_-]{43})$/.exec(authorization ?? "");
    if (!match || !POST_ID_PATTERN.test(match[2])) throw new PostError("POST_KEY_INVALID", "Use a valid Posts API key in the Authorization header.", 401);
    const key = (await this.run({ action: "keyGet", token: token.address.toLowerCase(), id: match[2] })).key;
    const hash = digest(match[1]);
    if (!key || !/^[a-f0-9]{64}$/.test(key.hash) || !timingSafeEqual(Buffer.from(key.hash, "hex"), Buffer.from(hash, "hex")) ||
      key.revokedAt !== null || key.expiresAt <= this.now()) throw new PostError("POST_KEY_INVALID", "The API key is invalid, expired or revoked.", 401);
    if (!await this.isOwner(token, getAddress(key.issuer))) {
      await this.run({ action: "keyRevoke", token: token.address.toLowerCase(), id: key.id, now: this.now() });
      throw new PostError("POST_KEY_OWNER_CHANGED", "The API key issuer no longer controls this token. The key was revoked.", 403);
    }
    return key;
  }
  async createKey(raw: unknown, body: unknown, authorization?: string) {
    const token = await this.token(raw), owner = await this.owner(token, body, "create-key", "", authorization), now = this.now();
    const secret = `mgp_${owner.id}.${Buffer.from(randomBytes(32)).toString("base64url")}`;
    const row: PostKeyRecord = { id: owner.id, token: token.address.toLowerCase(), name: owner.name, issuer: owner.signer,
      hash: digest(secret), prefix: `mgp_${owner.id.slice(0, 8)}…`, createdAt: now, expiresAt: now + POST_KEY_TTL_MS, revokedAt: null };
    const result = await this.run({ action: "keyCreate", row });
    if (!result.key) throw new PostError("POST_STORE_UNAVAILABLE", "The key creation could not be confirmed. Check the key list before retrying.", 503, 5);
    return { key: publicKey(result.key), apiKey: secret };
  }
  async listKeys(raw: unknown, body: unknown, authorization?: string) {
    const token = await this.token(raw);
    await this.owner(token, body, "list-keys", "", authorization);
    return { keys: ((await this.run({ action: "keysList", token: token.address.toLowerCase() })).keys ?? []).map(publicKey) };
  }
  async revokeKey(raw: unknown, rawId: unknown, body: unknown, authorization?: string) {
    const token = await this.token(raw), id = idSchema.parse(rawId);
    await this.owner(token, body, "revoke-key", id, authorization);
    await this.run({ action: "keyRevoke", token: token.address.toLowerCase(), id, now: this.now() });
    return { revoked: true };
  }
  async list(raw: unknown, query: unknown) {
    const token = await this.token(raw);
    const { limit, cursor } = z.object({ limit: z.coerce.number().int().min(1).max(50).default(20), cursor: z.string().max(100).optional() }).strict().parse(query);
    let before: { createdAt: number; id: string } | undefined;
    if (cursor) {
      const match = /^(\d{1,16}):([0-9a-f-]{36})$/.exec(cursor);
      if (!match || !POST_ID_PATTERN.test(match[2]) || !Number.isSafeInteger(Number(match[1]))) throw new PostError("POST_CURSOR_INVALID", "The Posts page cursor is invalid.");
      before = { createdAt: Number(match[1]), id: match[2] };
    }
    const rows = (await this.run({ action: "postsList", token: token.address.toLowerCase(), limit, before })).posts ?? [];
    const last = rows.at(-1);
    return { items: rows.map(publicPost), nextCursor: rows.length === limit && last ? `${last.createdAt}:${last.id}` : null };
  }
  async publish(raw: unknown, body: unknown, authorization: string | undefined, idempotency: unknown) {
    const token = await this.token(raw), key = await this.agent(token, authorization);
    const content = postCreateSchema.parse(body);
    content.text = content.text.trim();
    if (Array.from(content.text).length > POST_TEXT_MAX || new Set(content.imageIds).size !== content.imageIds.length)
      throw new PostError("POST_CONTENT_INVALID", "Use up to 5,000 characters and four distinct images.");
    try { content.videoUrl = publicPostUrl(content.videoUrl); } catch (error) { throw new PostError("POST_VIDEO_INVALID", (error as Error).message); }
    if (!content.text && !content.imageIds.length && !content.videoUrl) throw new PostError("POST_CONTENT_EMPTY", "Add text, an image or a video link.");
    const idempotencyKey = z.string().min(1).max(200).regex(/^[A-Za-z0-9._:-]+$/).parse(idempotency);
    const now = this.now();
    const post: PostRecord = { id: randomUUID(), token: token.address.toLowerCase(), keyId: key.id, ...content, images: [], createdAt: now, deletedAt: null };
    const result = await this.run({ action: "postCreate", token: post.token, keyId: key.id, post, idempotencyKey,
      requestHash: digest(JSON.stringify(content)), now });
    if (!result.post) throw new PostError("POST_STORE_UNAVAILABLE", "The post could not be confirmed. Retry with the same Idempotency-Key.", 503, 5);
    return { post: result.post.deletedAt === null ? publicPost(result.post) : { id: result.post.id, deleted: true }, duplicate: result.duplicate === true };
  }
  async delete(raw: unknown, rawId: unknown, body: unknown, authorization?: string) {
    const token = await this.token(raw), postId = idSchema.parse(rawId);
    let keyId: string | undefined;
    if (authorization !== undefined) {
      if (body && typeof body === "object" && Object.keys(body).length) throw new PostError("POST_AUTH_AMBIGUOUS", "API key deletion takes an empty body; do not send an owner signature.");
      keyId = (await this.agent(token, authorization)).id;
    } else await this.owner(token, body, "delete-post", postId);
    await this.run({ action: "postDelete", token: token.address.toLowerCase(), keyId, postId, now: this.now() });
    return { deleted: true };
  }
  async upload(raw: unknown, body: unknown, authorization?: string) {
    const token = await this.token(raw), key = await this.agent(token, authorization);
    const { image } = z.object({ image: z.string().max(4 * Math.ceil(MAX_TOKEN_IMAGE_BYTES / 3) + 23).regex(/^data:image\/webp;base64,[A-Za-z0-9+/]+={0,2}$/) }).strict().parse(body);
    const encoded = image.slice("data:image/webp;base64,".length), bytes = Buffer.from(encoded, "base64");
    if (bytes.toString("base64") !== encoded) throw new PostError("POST_IMAGE_INVALID", "The image encoding is invalid.");
    try { validateTokenImage(bytes); } catch (error) { throw new PostError("POST_IMAGE_INVALID", (error as Error).message); }
    const id = digest(bytes), leaseId = randomUUID(), tokenAddress = token.address.toLowerCase();
    const reserved = await this.run({ action: "mediaReserve", token: tokenAddress, keyId: key.id, id, leaseId, now: this.now() });
    if (reserved.media?.state === "ready" && reserved.media.url) return { id, url: reserved.media.url };
    if (reserved.media?.state !== "pending" || reserved.media.leaseId !== leaseId)
      throw new PostError("POST_STORE_UNAVAILABLE", "The image upload reservation could not be confirmed. Retry shortly.", 503, 5);
    try {
      const uploaded = await this.deps.uploadImage({ image });
      // External pinning and the database cannot be atomic: if authorization changed, the orphan stays unpublished.
      await this.agent(token, authorization);
      await this.run({ action: "mediaComplete", token: tokenAddress, keyId: key.id, id, leaseId, url: uploaded.image, now: this.now() });
      return { id, url: uploaded.image };
    } catch (error) {
      if (error instanceof BudgetUnavailable) {
        // Pinata's shared budget refused before any upload: give the daily slots back and report the real wait as 429.
        await this.run({ action: "mediaRelease", token: tokenAddress, id, leaseId, now: this.now() }).catch(() => {});
        throw error;
      }
      await this.run({ action: "mediaFail", token: tokenAddress, id, leaseId }).catch(() => {});
      if (error instanceof PostError) throw error;
      throw new PostError("POST_IMAGE_UNAVAILABLE", "The image could not be saved. Retry shortly.", 503, 5);
    }
  }
}
