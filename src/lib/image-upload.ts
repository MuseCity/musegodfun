import { MAX_IMAGE_FILE_BYTES, MAX_TOKEN_IMAGE_BYTES, TOKEN_IMAGE_ACCEPT, TOKEN_IMAGE_SIZE } from "./token-image";

export async function prepareTokenImage(file: File): Promise<string> {
  if (!TOKEN_IMAGE_ACCEPT.split(",").includes(file.type))
    throw new Error("Choose a PNG, JPG, WebP or GIF image.");
  if (!file.size || file.size > MAX_IMAGE_FILE_BYTES)
    throw new Error("Choose an image smaller than 5 MB.");
  let bitmap: ImageBitmap;
  try { bitmap = await createImageBitmap(file); }
  catch { throw new Error("This image could not be read. Choose another image."); }
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
