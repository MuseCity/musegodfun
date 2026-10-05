import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { MAX_TOKEN_IMAGE_BYTES, TOKEN_IMAGE_SIZE } from "../src/lib/token-image";

export const TOKEN_IMAGE_BUCKET = "token-images";
export const tokenImageKey = z.string().regex(/^[a-f0-9]{64}\.webp$/, "Invalid token image address");
const uploadSchema = z.object({
  image: z.string().max(4 * Math.ceil(MAX_TOKEN_IMAGE_BYTES / 3) + 23)
    .regex(/^data:image\/webp;base64,[A-Za-z0-9+/]+={0,2}$/, "Upload a prepared WebP image"),
}).strict();

export function validateTokenImage(bytes: Uint8Array) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const text = (start: number, end: number) => new TextDecoder().decode(bytes.subarray(start, end));
  const uint24 = (at: number) => bytes[at] | (bytes[at + 1] << 8) | (bytes[at + 2] << 16);
  if (bytes.length < 20 || bytes.length > MAX_TOKEN_IMAGE_BYTES ||
      text(0, 4) !== "RIFF" || view.getUint32(4, true) !== bytes.length - 8 || text(8, 12) !== "WEBP")
    throw new Error("The uploaded file is not a supported WebP image.");
  let width = 0, height = 0, frame = false;
  for (let at = 12; at < bytes.length;) {
    if (at + 8 > bytes.length) throw new Error("The uploaded image is incomplete.");
    const type = text(at, at + 4), size = view.getUint32(at + 4, true), start = at + 8;
    if (start + size + (size % 2) > bytes.length) throw new Error("The uploaded image is incomplete.");
    if (type === "VP8X" && size === 10) {
      if (at !== 12) throw new Error("The uploaded image header is invalid.");
      if (bytes[start] & 2) throw new Error("Upload a still image.");
      width = uint24(start + 4) + 1;
      height = uint24(start + 7) + 1;
    } else if (type === "VP8 " && size >= 10 && bytes[start + 3] === 0x9d && bytes[start + 4] === 1 && bytes[start + 5] === 0x2a) {
      const frameWidth = view.getUint16(start + 6, true) & 0x3fff, frameHeight = view.getUint16(start + 8, true) & 0x3fff;
      if (width && (width !== frameWidth || height !== frameHeight)) throw new Error("The uploaded image dimensions do not match.");
      width = frameWidth;
      height = frameHeight;
      frame = true;
    } else if (type === "VP8L" && size >= 5 && bytes[start] === 0x2f) {
      const bits = view.getUint32(start + 1, true);
      const frameWidth = (bits & 0x3fff) + 1, frameHeight = ((bits >>> 14) & 0x3fff) + 1;
      if (width && (width !== frameWidth || height !== frameHeight)) throw new Error("The uploaded image dimensions do not match.");
      width = frameWidth;
      height = frameHeight;
      frame = true;
    }
    at = start + size + (size % 2);
  }
  if (!frame || width < 1 || height < 1 || width > TOKEN_IMAGE_SIZE || height > TOKEN_IMAGE_SIZE)
    throw new Error("The uploaded image must be no larger than 512 × 512 pixels.");
}

export class TokenImages {
  constructor(private readonly directory: string, private readonly url?: string, private readonly key?: string) {
    if (url && (!/^https:\/\/[a-z0-9]+\.supabase\.co$/.test(url) || !key))
      throw new Error("Invalid token image storage configuration");
  }
  private headers() {
    return {
      apikey: this.key!,
      ...(this.key!.startsWith("eyJ") ? { Authorization: `Bearer ${this.key}` } : {}),
    };
  }
  async get(rawKey: string): Promise<Uint8Array | null> {
    const key = tokenImageKey.parse(rawKey);
    if (this.url) {
      const response = await fetch(`${this.url}/storage/v1/object/${TOKEN_IMAGE_BUCKET}/${key}`, {
        headers: this.headers(), signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) {
        const error = await response.json().catch(() => ({})) as { code?: string; statusCode?: string | number };
        if (response.status === 404 || error.code === "NoSuchKey" || Number(error.statusCode) === 404) return null;
        throw new Error("Image storage is unavailable. Try again later.");
      }
      return Buffer.from(await response.arrayBuffer());
    }
    try { return await readFile(join(this.directory, key)); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }
  async upload(body: unknown): Promise<{ image: string }> {
    const input = uploadSchema.parse(body), encoded = input.image.slice("data:image/webp;base64,".length);
    const bytes = Buffer.from(encoded, "base64");
    if (bytes.toString("base64") !== encoded) throw new Error("The uploaded image encoding is invalid.");
    validateTokenImage(bytes);
    const key = `${createHash("sha256").update(bytes).digest("hex")}.webp`;
    if (this.url) {
      const response = await fetch(`${this.url}/storage/v1/object/${TOKEN_IMAGE_BUCKET}/${key}`, {
        method: "POST", headers: { ...this.headers(), "content-type": "image/webp", "x-upsert": "false" },
        body: new Uint8Array(bytes).buffer, signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) {
        // A content hash identifies immutable bytes; repeated uploads are safe.
        const saved = [400, 409].includes(response.status) ? await this.get(key) : null;
        if (!saved || createHash("sha256").update(saved).digest("hex") !== key.slice(0, -5))
          throw new Error("The image could not be saved. Try uploading again.");
      }
    } else {
      await mkdir(this.directory, { recursive: true });
      try { await writeFile(join(this.directory, key), bytes, { flag: "wx" }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    }
    return { image: `https://musegod.fun/api/token-images/${key}` };
  }
}
