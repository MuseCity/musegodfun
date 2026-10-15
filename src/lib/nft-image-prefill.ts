import { NFT_IMAGE_ERROR } from "./image-upload";
import { nftPrefill, type NftIdentity, type NftPrefill } from "./nft-client";
import { errorMessage } from "./validation";

type ImageWork = {
  getDraft: () => NftIdentity;
  apply: (field: keyof NftIdentity, value: string) => void;
  setBusy: (busy: boolean) => void;
  setError: (error: string) => void;
  convertUrl: (url: string) => Promise<string>;
  convertFile: (file: File) => Promise<string>;
  pin: (image: string, interactive: boolean) => Promise<string>;
};
type ImageStatus = Pick<ImageWork, "setBusy" | "setError">;

/** Tab-local arbitration shared by manual uploads and NFT prefill. No DOM or React state lives here. */
export function createNftImagePrefill(initial: NftPrefill = {}) {
  let request = 0, manual: number | null = null, previous = { ...initial };
  const pinned = new Map<string, string>();
  function cancel(io: ImageStatus) {
    request++; manual = null; io.setBusy(false); io.setError("");
  }
  return {
    get previous() { return previous; },
    cancel,
    clearNft(io: ImageStatus) { if (manual !== request) cancel(io); },
    edit(field: keyof NftIdentity, io: ImageStatus) {
      delete previous[field];
      if (field === "image") cancel(io);
    },
    replace(owned: NftPrefill, io: ImageStatus) { cancel(io); previous = { ...owned }; },
    async upload(file: File, io: ImageWork) {
      const current = ++request;
      manual = current; io.setBusy(true); io.setError("");
      try {
        const image = await io.convertFile(file);
        if (current !== request) return;
        const url = await io.pin(image, true);
        if (current !== request) return;
        delete previous.image;
        io.apply("image", url);
        return true;
      } catch (error) {
        if (current === request) io.setError(errorMessage(error));
      } finally {
        if (current === request) io.setBusy(false);
        if (manual === current) manual = null;
      }
    },
    async prefill(nft: { name?: string; image?: string }, io: ImageWork, restored = false) {
      const owned = { ...previous }, changes = nftPrefill(io.getDraft(), nft, owned);
      // A restored NFT has no list metadata. Its re-check must retain saved ownership and its notice.
      if (restored) for (const field of ["name", "symbol", "image"] as const)
        if (owned[field] && io.getDraft()[field] === owned[field]) delete changes[field];
      const manualPending = manual === request;
      if (!manualPending) cancel(io);
      for (const field of ["name", "symbol"] as const) {
        const value = changes[field];
        if (value === undefined) continue;
        if (value) previous[field] = value;
        else delete previous[field];
        io.apply(field, value);
      }
      if (manualPending || changes.image === undefined) return;
      delete previous.image;
      io.apply("image", "");
      if (!changes.image) return;
      const current = ++request, source = changes.image;
      io.setBusy(true);
      try {
        let url = pinned.get(source);
        if (!url) {
          const image = await io.convertUrl(source);
          if (current !== request) return;
          url = await io.pin(image, false);
          pinned.set(source, url);
        }
        if (current !== request) return;
        if (nftPrefill(io.getDraft(), { image: url }, owned).image !== undefined) {
          previous.image = url;
          io.apply("image", url);
        }
      } catch {
        if (current === request) io.setError(NFT_IMAGE_ERROR);
      } finally {
        if (current === request) io.setBusy(false);
      }
    },
  };
}
