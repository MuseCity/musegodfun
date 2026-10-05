export const MAX_IMAGE_FILE_BYTES = 5 * 1024 * 1024;
export const MAX_TOKEN_IMAGE_BYTES = 40 * 1024;
export const TOKEN_IMAGE_SIZE = 512;
export const TOKEN_IMAGE_ACCEPT = "image/png,image/jpeg,image/webp,image/gif";

// Hosted images keep a public HTTPS metadata URL, including during local checks.
export function tokenImageSource(image: string) {
  const prefix = "https://musegod.fun/api/token-images/";
  return image.startsWith(prefix) && /^[a-f0-9]{64}\.webp$/.test(image.slice(prefix.length))
    ? image.slice("https://musegod.fun".length)
    : image;
}
