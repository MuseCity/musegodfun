import type { DatabaseSync } from "node:sqlite";

export type PostKeyRecord = { id: string; token: string; issuer: string; name: string; hash: string; prefix: string;
  createdAt: number; expiresAt: number; revokedAt: number | null };
export type PostRecord = { id: string; token: string; keyId: string; text: string; imageIds: string[]; images: { id: string; url: string }[]; videoUrl: string | null;
  createdAt: number; deletedAt: number | null };
export type PostMediaRecord = { id: string; token: string; url: string | null; state: "pending" | "ready" | "failed";
  pendingUntil?: number; leaseId?: string; reservedAt?: number };
export type PostCursor = { createdAt: number; id: string };
export type PostCommand =
  | { action: "keysList"; token: string }
  | { action: "keyGet"; token: string; id: string }
  | { action: "keyCreate"; row: PostKeyRecord }
  | { action: "keyRevoke"; token: string; id: string; now: number }
  | { action: "postsList"; token: string; limit: number; before?: PostCursor }
  | { action: "postCreate"; token: string; keyId: string; post: PostRecord; idempotencyKey: string; requestHash: string; now: number }
  | { action: "postDelete"; token: string; keyId?: string; postId: string; now: number }
  | { action: "mediaGet"; token: string; id: string }
  | { action: "mediaReserve"; token: string; keyId: string; id: string; leaseId: string; now: number }
  | { action: "mediaComplete"; token: string; keyId: string; id: string; leaseId: string; url: string; now: number }
  | { action: "mediaFail"; token: string; id: string; leaseId: string }
  | { action: "mediaRelease"; token: string; id: string; leaseId: string; now: number };
export type PostResult = { key?: PostKeyRecord; keys?: PostKeyRecord[]; posts?: PostRecord[]; post?: PostRecord;
  media?: PostMediaRecord; duplicate?: boolean; deleted?: boolean;
  error?: { code: string; message: string; status: number; retryAfter?: number } };

export const POST_TABLES = ["post_api_keys", "posts", "post_media", "post_rates"] as const;
export const POST_SCHEMA = `
CREATE TABLE IF NOT EXISTS post_api_keys (id TEXT PRIMARY KEY,token TEXT NOT NULL,created_at INTEGER NOT NULL,payload TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS post_api_keys_token ON post_api_keys(token,created_at DESC,id);
CREATE TABLE IF NOT EXISTS posts (id TEXT PRIMARY KEY,token TEXT NOT NULL,created_at INTEGER NOT NULL,idempotency_key TEXT NOT NULL,request_hash TEXT NOT NULL,payload TEXT NOT NULL,UNIQUE(token,idempotency_key));
CREATE INDEX IF NOT EXISTS posts_page ON posts(token,created_at DESC,id DESC);
CREATE TABLE IF NOT EXISTS post_media (token TEXT NOT NULL,id TEXT NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(token,id));
CREATE TABLE IF NOT EXISTS post_rates (key TEXT PRIMARY KEY,count INTEGER NOT NULL,expires_at INTEGER NOT NULL);`;
export const POST_GLOBAL_SCHEMA = "CREATE TABLE IF NOT EXISTS post_global_rates (key TEXT PRIMARY KEY,count INTEGER NOT NULL,expires_at INTEGER NOT NULL)";
const refused = (code: string, message: string, status = 409, retryAfter?: number): PostResult =>
  ({ error: { code, message, status, ...(retryAfter === undefined ? {} : { retryAfter }) } });
const payload = <T>(row: unknown): T | undefined => row ? JSON.parse((row as { payload: string }).payload) as T : undefined;
const MINUTE = 60_000, DAY = 86_400_000;

/** Both SQL backends use these commands. Owner/signature and fresh NFT checks happen in the service; the transaction rechecks key
 * status, token binding, media binding and all durable limits at the write itself. It never accepts an externally supplied key hash. */
export function sqlitePostAction(db: DatabaseSync, globalDb: DatabaseSync, command: PostCommand): PostResult {
  const token = (command.action === "keyCreate" ? command.row.token : command.token).toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(token)) throw new Error("Invalid post token");
  const now = "now" in command ? command.now : command.action === "keyCreate" ? command.row.createdAt : Date.now();
  if (!Number.isSafeInteger(now) || now <= 0) throw new Error("Invalid post time");
  const key = (id: string) => payload<PostKeyRecord>(db.prepare("SELECT payload FROM post_api_keys WHERE token=? AND id=?").get(token, id));
  const media = (id: string) => payload<PostMediaRecord>(db.prepare("SELECT payload FROM post_media WHERE token=? AND id=?").get(token, id));
  const checkKey = (id: string): PostResult | undefined => {
    const row = key(id);
    if (!row || row.revokedAt !== null || row.expiresAt <= now) return refused("POST_KEY_INVALID", "The API key is invalid, expired or revoked.", 401);
  };
  type Charge = { key: string; maximum: number; until: number; global?: boolean };
  const charge = (name: string, window: number, maximum: number, global = false): Charge =>
    ({ key: `${name}:${Math.floor(now / window)}`, maximum, until: (Math.floor(now / window) + 1) * window, global });
  let globalOpen = false;
  const reserve = (charges: Charge[]): PostResult | undefined => {
    if (charges.some(c => c.global) && !globalOpen) { globalDb.exec("BEGIN IMMEDIATE"); globalOpen = true; }
    for (const c of charges) {
      const source = c.global ? globalDb : db, table = c.global ? "post_global_rates" : "post_rates";
      const used = (source.prepare(`SELECT count FROM ${table} WHERE key=?`).get(c.key) as { count: number } | undefined)?.count ?? 0;
      if (used >= c.maximum) return refused("POST_RATE_LIMITED", "The post API limit has been reached. Try again later.", 429, Math.max(1, Math.ceil((c.until - now) / 1000)));
    }
    for (const c of charges) {
      const source = c.global ? globalDb : db, table = c.global ? "post_global_rates" : "post_rates";
      source.prepare(`INSERT INTO ${table} VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET count=count+1`).run(c.key, c.until);
    }
  };
  const keyCharge = (id: string) => charge(`key:${id}`, MINUTE, 10);
  db.exec("BEGIN IMMEDIATE");
  try {
    const run = (): PostResult => {
      switch (command.action) {
        case "keysList": return { keys: (db.prepare("SELECT payload FROM post_api_keys WHERE token=? ORDER BY created_at DESC,id DESC").all(token)).map(r => payload<PostKeyRecord>(r)!) };
        case "keyGet": { const row = key(command.id); return row ? { key: row } : {}; }
        case "keyCreate": {
          const row = command.row;
          if (row.token !== token || !/^[0-9a-f]{64}$/.test(row.hash) || !/^0x[0-9a-fA-F]{40}$/.test(row.issuer) ||
            row.revokedAt !== null || row.expiresAt <= now || row.expiresAt > now + 30 * DAY || !row.id || row.id.length > 100 || row.name.length > 80)
            throw new Error("Invalid post API key record");
          if (db.prepare("SELECT id FROM post_api_keys WHERE id=?").get(row.id)) return refused("POST_KEY_EXISTS", "This key creation was already used. Revoke the key and create a new one.");
          const count = (db.prepare("SELECT count(*) AS n FROM post_api_keys WHERE token=? AND json_extract(payload,'$.revokedAt') IS NULL AND json_extract(payload,'$.expiresAt')>?").get(token, now) as { n: number }).n;
          if (count >= 5) return refused("POST_KEY_LIMIT", "Revoke an existing key before creating another.");
          db.prepare("INSERT INTO post_api_keys VALUES(?,?,?,?)").run(row.id, token, now, JSON.stringify(row)); return { key: row };
        }
        case "keyRevoke": {
          const row = key(command.id); if (!row) return refused("POST_KEY_NOT_FOUND", "The API key was not found.", 404);
          row.revokedAt ??= now;
          db.prepare("UPDATE post_api_keys SET payload=? WHERE token=? AND id=?").run(JSON.stringify(row), token, row.id); return { key: row };
        }
        case "postsList": {
          const limit = Math.max(1, Math.min(50, Math.trunc(command.limit)));
          if (!Number.isFinite(limit)) throw new Error("Invalid post page size");
          const cursor = command.before;
          const rows = cursor ? db.prepare("SELECT payload FROM posts WHERE token=? AND json_extract(payload,'$.deletedAt') IS NULL AND (created_at<? OR (created_at=? AND id<?)) ORDER BY created_at DESC,id DESC LIMIT ?").all(token, cursor.createdAt, cursor.createdAt, cursor.id, limit)
            : db.prepare("SELECT payload FROM posts WHERE token=? AND json_extract(payload,'$.deletedAt') IS NULL ORDER BY created_at DESC,id DESC LIMIT ?").all(token, limit);
          return { posts: rows.map(r => payload<PostRecord>(r)!) };
        }
        case "postCreate": {
          const invalid = checkKey(command.keyId); if (invalid) return invalid;
          const prior = db.prepare("SELECT payload,request_hash FROM posts WHERE token=? AND idempotency_key=?").get(token, command.idempotencyKey) as { payload: string; request_hash: string } | undefined;
          if (prior) return prior.request_hash !== command.requestHash ? refused("POST_IDEMPOTENCY_CONFLICT", "The idempotency key was already used for different content.") : { post: JSON.parse(prior.payload), duplicate: true };
          const row = { ...command.post };
          if (row.token !== token || row.keyId !== command.keyId || row.createdAt !== now || row.deletedAt !== null || !command.idempotencyKey || command.idempotencyKey.length > 200 || !/^[0-9a-f]{64}$/.test(command.requestHash)) throw new Error("Invalid post record");
          if (row.imageIds.some(id => { const item = media(id); return item?.state !== "ready" || !item.url; })) return refused("POST_MEDIA_INVALID", "Each image must be an uploaded image for this token.", 400);
          row.images = row.imageIds.map(id => ({ id, url: media(id)!.url! }));
          const denied = reserve([keyCharge(command.keyId), charge(`posts-minute:${token}`, MINUTE, 2), charge(`posts-day:${token}`, DAY, 60)]); if (denied) return denied;
          db.prepare("INSERT INTO posts VALUES(?,?,?,?,?,?)").run(row.id, token, now, command.idempotencyKey, command.requestHash, JSON.stringify(row)); return { post: row };
        }
        case "postDelete": {
          if (command.keyId) { const invalid = checkKey(command.keyId); if (invalid) return invalid; }
          const row = payload<PostRecord>(db.prepare("SELECT payload FROM posts WHERE token=? AND id=?").get(token, command.postId));
          if (!row) return refused("POST_NOT_FOUND", "The post was not found.", 404);
          if (row.deletedAt !== null) return { post: row, deleted: true, duplicate: true };
          const denied = reserve([...(command.keyId ? [keyCharge(command.keyId)] : []), charge(`delete:${token}`, MINUTE, 30)]); if (denied) return denied;
          row.deletedAt = now; db.prepare("UPDATE posts SET payload=? WHERE token=? AND id=?").run(JSON.stringify(row), token, row.id); return { post: row, deleted: true };
        }
        case "mediaGet": { const row = media(command.id); return row ? { media: row } : {}; }
        case "mediaReserve": {
          const invalid = checkKey(command.keyId); if (invalid) return invalid;
          if (!/^[0-9a-f]{64}$/.test(command.id)) throw new Error("Invalid post media hash");
          const row = media(command.id);
          if (row?.state === "ready") return { media: row, duplicate: true };
          if (row?.state === "pending" && (row.pendingUntil ?? 0) > now) return refused("POST_MEDIA_PENDING", "The image upload is already running. Retry shortly.", 409, Math.max(1, Math.ceil((row.pendingUntil! - now) / 1000)));
          const denied = reserve([keyCharge(command.keyId), charge(`images:${token}`, DAY, 10), charge("images-global", DAY, 50, true)]); if (denied) return denied;
          const next: PostMediaRecord = { id: command.id, token, state: "pending", url: null, leaseId: command.leaseId, pendingUntil: now + 120_000, reservedAt: now };
          db.prepare("INSERT INTO post_media VALUES(?,?,?) ON CONFLICT(token,id) DO UPDATE SET payload=excluded.payload").run(token, command.id, JSON.stringify(next)); return { media: next };
        }
        case "mediaComplete": {
          const invalid = checkKey(command.keyId); if (invalid) return invalid;
          const row = media(command.id);
          if (!row || row.state !== "pending" || row.leaseId !== command.leaseId || (row.pendingUntil ?? 0) <= now) return refused("POST_MEDIA_LEASE", "The image upload lease expired. Retry the upload.");
          const next: PostMediaRecord = { id: row.id, token, state: "ready", url: command.url };
          db.prepare("UPDATE post_media SET payload=? WHERE token=? AND id=?").run(JSON.stringify(next), token, row.id); return { media: next };
        }
        case "mediaFail": {
          const row = media(command.id);
          if (row?.state === "pending" && row.leaseId === command.leaseId) {
            const next: PostMediaRecord = { id: row.id, token, state: "failed", url: null };
            db.prepare("UPDATE post_media SET payload=? WHERE token=? AND id=?").run(JSON.stringify(next), token, row.id); return { media: next };
          }
          return row ? { media: row } : {};
        }
        case "mediaRelease": {
          const row = media(command.id);
          if (row?.state !== "pending" || row.leaseId !== command.leaseId) return row ? { media: row } : {};
          // A refusal known to precede any upload returns this reservation's daily image slots; the per-key minute charge stays.
          if (row.reservedAt !== undefined) {
            const bucket = Math.floor(row.reservedAt / DAY);
            db.prepare("UPDATE post_rates SET count=count-1 WHERE key=? AND count>0").run(`images:${token}:${bucket}`);
            if (!globalOpen) { globalDb.exec("BEGIN IMMEDIATE"); globalOpen = true; }
            globalDb.prepare("UPDATE post_global_rates SET count=count-1 WHERE key=? AND count>0").run(`images-global:${bucket}`);
          }
          const next: PostMediaRecord = { id: row.id, token, state: "failed", url: null };
          db.prepare("UPDATE post_media SET payload=? WHERE token=? AND id=?").run(JSON.stringify(next), token, row.id); return { media: next };
        }
      }
    };
    const result = run();
    if (result.error) { db.exec("ROLLBACK"); if (globalOpen) globalDb.exec("ROLLBACK"); }
    else {
      // The shared image budget commits first. A crash between commits may conservatively spend an extra slot, never exceed the cap.
      if (globalOpen) globalDb.exec("COMMIT");
      db.exec("COMMIT");
    }
    return result;
  } catch (error) {
    if (db.isTransaction) db.exec("ROLLBACK");
    if (globalOpen && globalDb.isTransaction) globalDb.exec("ROLLBACK");
    throw error;
  }
}
