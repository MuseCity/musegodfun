import { MAX_TOKEN_IMAGE_BYTES } from "../src/lib/token-image";
import { TOKEN_IMAGE_BUCKET } from "../server/token-images";

const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SECRET_KEY;
if (!url || !key) throw new Error("Server-side Supabase configuration is required");
const headers = { apikey: key, ...(key.startsWith("eyJ") ? { Authorization: `Bearer ${key}` } : {}), "content-type": "application/json" };
const endpoint = `${url}/storage/v1/bucket`;
const existing = await fetch(`${endpoint}/${TOKEN_IMAGE_BUCKET}`, { headers, signal: AbortSignal.timeout(15_000) });
const details = await existing.json() as { public?: boolean; file_size_limit?: number; allowed_mime_types?: string[]; error?: string; message?: string };
if (!existing.ok) {
  if (existing.status !== 404 && !(existing.status === 400 && /bucket not found/i.test(details.error || details.message || "")))
    throw new Error(`Unable to inspect token image storage (${existing.status})`);
  const created = await fetch(endpoint, {
    method: "POST", headers, signal: AbortSignal.timeout(15_000),
    body: JSON.stringify({ id: TOKEN_IMAGE_BUCKET, name: TOKEN_IMAGE_BUCKET, public: false,
      file_size_limit: MAX_TOKEN_IMAGE_BYTES, allowed_mime_types: ["image/webp"] }),
  });
  if (!created.ok) throw new Error(`Unable to create token image storage (${created.status})`);
}
const readback = await fetch(`${endpoint}/${TOKEN_IMAGE_BUCKET}`, { headers, signal: AbortSignal.timeout(15_000) });
const bucket = await readback.json() as typeof details;
if (!readback.ok || bucket.public !== false || bucket.file_size_limit !== MAX_TOKEN_IMAGE_BYTES ||
    bucket.allowed_mime_types?.length !== 1 || bucket.allowed_mime_types[0] !== "image/webp")
  throw new Error("Token image bucket settings do not match. Existing settings were not changed.");
console.log(JSON.stringify({ bucket: TOKEN_IMAGE_BUCKET, public: false, maxBytes: MAX_TOKEN_IMAGE_BYTES, mime: "image/webp", verified: true }));
