import { NFT_IMAGE_ERROR } from "./image-upload";
import { nftPrefill, nftValues, type NftIdentity, type NftPrefill } from "./nft-client";
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
const FIELDS = ["name", "symbol", "image"] as const;

/** Tab-local arbitration shared by manual uploads and NFT prefill. No DOM or React state lives here. A field belongs to the NFT while it
 * holds exactly the value the NFT gave it (`previous`), so ownership is decided by value, never by what was typed in between. */
export function createNftImagePrefill(initial: NftPrefill = {}) {
  let request = 0, manual: number | null = null, previous = { ...initial };
  const pinned = new Map<string, string>();
  function cancel(io: ImageStatus) {
    request++; manual = null; io.setBusy(false); io.setError("");
  }
  function clearNft(io: ImageStatus) { if (manual !== request) cancel(io); }
  return {
    get previous() { return previous; },
    cancel,
    /** The NFT left the draft without the person (its check said no for another account): its image work stops, and its values stay
     * owned, so they return with it or follow the next NFT. */
    clearNft,
    /** The person changed or removed the NFT: its image work stops, and the fields still holding its values are cleared at once, so they
     * never stand for the next NFT while that one is checked, nor for a normal coin. */
    changeNft(io: ImageWork) {
      clearNft(io);
      for (const field of FIELDS) {
        const owned = previous[field];
        delete previous[field];
        if (owned && io.getDraft()[field] === owned) io.apply(field, "");
      }
    },
    /** Typing changes the value, which alone decides ownership; an image typed over also stops the NFT's image work. */
    edit(field: keyof NftIdentity, io: ImageStatus) {
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
      const values = nftValues(nft), owned = { ...previous }, changes = nftPrefill(io.getDraft(), nft, owned);
      // A restored NFT's re-check or first list metadata retains saved ownership and its notice.
      if (restored) for (const field of FIELDS)
        if (owned[field] && io.getDraft()[field] === owned[field]) delete changes[field];
      const manualPending = manual === request;
      if (!manualPending) cancel(io);
      for (const field of ["name", "symbol"] as const) {
        const value = changes[field];
        // A field this NFT leaves alone still records its name and symbol, unless it shows a value the prefill owns: a field equal to
        // them is the NFT's however it got there (a draft saved before ownership was recorded, a draft link, the person typing it back).
        if (value === undefined) {
          if (values[field] && !(previous[field] && io.getDraft()[field] === previous[field])) previous[field] = values[field];
          continue;
        }
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
