import { MAX_IMAGE_FILE_BYTES, MAX_TOKEN_IMAGE_BYTES, TOKEN_IMAGE_ACCEPT, TOKEN_IMAGE_SIZE } from "./token-image";
import { httpsImage } from "./nft-holdings";

export const NFT_IMAGE_ERROR = "We couldn't use this NFT's image. Upload one instead.";

export async function prepareTokenImage(file: File): Promise<string> {
  if (!TOKEN_IMAGE_ACCEPT.split(",").includes(file.type))
    throw new Error("Choose a PNG, JPG, WebP or GIF image.");
  if (!file.size || file.size > MAX_IMAGE_FILE_BYTES)
    throw new Error("Choose an image smaller than 5 MB.");
  let bitmap: ImageBitmap;
  try { bitmap = await createImageBitmap(file); }
  catch { throw new Error("This image could not be read. Choose another image."); }
  return encodeTokenImage(bitmap);
}

/** An anonymous image load is allowed by img-src; fetching the CDN would be refused by connect-src. */
export async function prepareTokenImageFromUrl(url: string): Promise<string> {
  try {
    if (!httpsImage(url)) throw new Error(NFT_IMAGE_ERROR);
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.referrerPolicy = "no-referrer";
    img.src = url;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([img.decode(), new Promise<never>((_, reject) => {
        deadline = setTimeout(() => { img.src = ""; reject(new Error(NFT_IMAGE_ERROR)); }, 20_000);
      })]);
    } finally { clearTimeout(deadline); }
    return encodeTokenImage(await createImageBitmap(img));
  } catch { throw new Error(NFT_IMAGE_ERROR); }
}

function encodeTokenImage(bitmap: ImageBitmap): string {
  try {
    if (!bitmap.width || !bitmap.height || bitmap.width * bitmap.height > 40_000_000)
      throw new Error("Choose an image with fewer than 40 million pixels.");
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Image processing is unavailable in this browser.");
    for (const size of [TOKEN_IMAGE_SIZE, 384, 256]) {
      const scale = Math.min(1, size / Math.max(bitmap.width, bitmap.height));
      canvas.width = Math.max(1, Math.round(bitmap.width * scale));
      canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      for (const quality of [0.85, 0.65, 0.45]) {
        const data = canvas.toDataURL("image/webp", quality);
        if (!data.startsWith("data:image/webp;base64,"))
          throw new Error("This browser cannot prepare the image. Try an updated browser.");
        if (Math.ceil(data.split(",")[1].length * 3 / 4) <= MAX_TOKEN_IMAGE_BYTES)
          return data;
      }
    }
    throw new Error("This image is too detailed to upload. Choose a smaller image.");
  } finally { bitmap.close(); }
}
