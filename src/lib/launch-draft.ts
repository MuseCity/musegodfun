import { deploymentChain, STOCKS, ROBINHOOD_STOCKS, sameAddress, type RuntimeConfig } from "./config";
import { launchSchema, restoreDraft } from "./validation";
import { firstBuyPaymentAssets } from "./first-buy-payment";
import { isPristineDraft } from "./draft-link";
import { savedNftMode, type NftIdentity, type NftPrefill } from "./nft-client";
import type { LaunchInput } from "./validation";

/** Only exact, nonempty applied values retain ownership; old drafts and links carry none. */
export function matchingNftPrefill(draft: NftIdentity, saved: NftPrefill = {}): NftPrefill {
  const owned: NftPrefill = {};
  for (const field of ["name", "symbol", "image"] as const)
    if (typeof saved[field] === "string" && saved[field] && saved[field] === draft[field]) owned[field] = saved[field];
  return owned;
}
export function savedNftPrefill(raw: string | null, draft: NftIdentity): NftPrefill {
  try { return matchingNftPrefill(draft, JSON.parse(raw || "null")?.nftPrefill ?? {}); }
  catch { return {}; }
}
/** Shared by autosave and its loaded basis, so another tab's adoption never echoes a format change. */
export function launchDraftPayload(draft: LaunchInput, firstBuy: FirstBuyDraft, intentId: string, step: LaunchStep,
  nftMode: boolean, prefill: NftPrefill = {}): string {
  return JSON.stringify({ ...draft, firstBuy, intentId, step, nftMode, nftPrefill: matchingNftPrefill(draft, prefill) });
}

export type FirstBuyDraft = { amount: string; slippageBps: number; payAddress: string; lockDays: 0 | 30 | 90 | 365 };
/** 0: the NFT step (NFT mode only); 1: Identity; 2: Economics (tasks/nft-mode-wallet-picker.md §3.3). */
export type LaunchStep = 0 | 1 | 2;
// The form step is saved with the draft so a reload resumes where the creator left off. A saved 1 or 2 is restored exactly, in both modes,
// so two tabs never move each other's step; a draft with no saved step (a draft link) in NFT mode opens on the NFT step.
export function launchDraftStep(raw: string | null): LaunchStep {
  try {
    const step = JSON.parse(raw || "null")?.step;
    if (step === 1 || step === 2) return step;
    return savedNftMode(raw) ? 0 : 1;
  } catch { return 1; }
}
/** The wizard's steps in order; NFT mode starts with the NFT step. */
export function launchSteps(nftMode: boolean): { step: LaunchStep; label: "NFT" | "Identity" | "Economics" }[] {
  return [...(nftMode ? [{ step: 0 as const, label: "NFT" as const }] : []), { step: 1, label: "Identity" }, { step: 2, label: "Economics" }];
}
/** The heading that takes focus when a step opens. */
export function stepHeadingId(step: LaunchStep): "nft-heading" | "identity-heading" | "quote-heading" {
  return step === 0 ? "nft-heading" : step === 1 ? "identity-heading" : "quote-heading";
}
// Connecting a new wallet migrates an anonymous draft under a new intent ID.
// Reset that copy only when its complete launch input still matches the launch.
export function resetLaunchedDraftStep(raw: string | null, launchedRaw: string, config: RuntimeConfig): string | null {
  try {
    const saved = JSON.parse(raw || "null"), launched = JSON.parse(launchedRaw);
    if (!saved || Array.isArray(saved) || saved.step !== 2 || typeof launched?.intentId !== "string") return raw;
    if (saved.intentId !== launched.intentId) {
      if (!sameAddress(saved.quoteAddress, launched.quoteAddress)) return raw;
      const input = (value: string) => {
        const parsed = launchSchema.safeParse(restoreDraft(value, config));
        if (!parsed.success) return null;
        const firstBuy = firstBuyDraft(config, value);
        return JSON.stringify({ ...parsed.data, firstBuy: { ...firstBuy, amount: firstBuy.amount || "0", payAddress: firstBuy.payAddress.toLowerCase() } });
      };
      const savedInput = input(raw!);
      if (savedInput === null || savedInput !== input(launchedRaw)) return raw;
    }
    return JSON.stringify({ ...saved, step: savedNftMode(raw) ? 0 : 1 });
  } catch { return raw; }
}
/** A saved or autosaved draft with nothing in it, by the create form's "untouched" rule (`isPristineDraft`, which also counts a paid
 * launch fee). A missing or unreadable draft is blank too. */
export function isBlankDraft(raw: string | null, config?: Pick<RuntimeConfig, "mode" | "deploymentChainId">): boolean {
  let launchFee: unknown;
  try { launchFee = JSON.parse(raw || "null")?.launchFee; } catch { /* Unreadable: nothing to keep. */ }
  return !launchFee && isPristineDraft(restoreDraft(raw, config), launchDraftStep(raw));
}
/** What a tab last synced with its intent's stored draft: `raw`, the stored draft it last read or wrote (null: there was none), and
 * `payload`, what its form held right after that (the payload it wrote, or its form right after loading `raw`; absent when the form was
 * kept rather than loaded, or cleared). */
export type DraftBasis = { raw: string | null; payload?: string };
/** What a tab does with its draft (`payload`) when the intent's stored draft is `stored`, at its autosave or when another tab saves.
 * `basis` is undefined when the tab never read the intent's draft. `holding`: a review, payment or submission is in progress, so the
 * form must not change under it.
 * - "write": nothing is stored; or the stored draft is the one this tab last synced and the form has edits since; or the stored draft
 *   changed and the form has real local edits (that are not a blank form over a named draft). When two tabs with real local edits save
 *   the same intent, the last one to write wins, over another tab's edit or "Clear draft".
 * - "unchanged": the stored draft is the one this tab last synced and the form has no edits since. Nothing is written, so a tab never
 *   echoes a draft it only loaded (an echo could cross another tab's newer save).
 * - "adopt": the stored draft changed since this tab last synced and this tab must not write over it. Either the form has no local edits,
 *   so it follows the newer draft, a cleared one included (a stale tab never undoes another tab's "Clear draft"); or this tab's draft is
 *   blank and the stored one is not (another tab saved a named draft after this tab loaded). The tab takes the stored draft.
 * - "hold": it would adopt, but the form holds what the stored draft cannot carry: NFT mode with no NFT chosen yet (the NFT step's typed,
 *   unconfirmed input; NFT mode alone is not a draft, so it never writes over a named one), an NFT the stored draft lacks while it is in
 *   NFT mode (another tab's step dropped it), or `holding`. It neither writes nor adopts.
 * localStorage has no cross-tab compare-and-set. Another tab's write can still land between this read and this tab's write, and a write
 * from another tab reaches this one only after a short propagation delay. The window for a lost draft shrank from the 250 ms autosave
 * delay to that gap; it is not zero. */
export function draftAutosave(stored: string | null, payload: string, basis: DraftBasis | undefined,
  config?: Pick<RuntimeConfig, "mode" | "deploymentChainId">, holding = false): "write" | "unchanged" | "adopt" | "hold" {
  const unedited = basis?.payload !== undefined && payload === basis.payload;
  if (stored === null) return "write";
  if (basis && stored === basis.raw) return unedited ? "unchanged" : "write";
  if (!unedited && (!isBlankDraft(payload, config) || isBlankDraft(stored, config))) return "write";
  const ours = nftState(payload), theirs = nftState(stored);
  return holding || ours === "pending" || ours === "chosen" && theirs === "pending" ? "hold" : "adopt";
}
// NFT mode with no NFT yet ("pending"), an NFT chosen, or neither.
function nftState(raw: string): "pending" | "chosen" | "none" {
  try { const saved = JSON.parse(raw); return saved?.nft ? "chosen" : saved?.nftMode === true ? "pending" : "none"; } catch { return "none"; }
}
export function launchDraftKey(config: RuntimeConfig) {
  return `musegod.launch.draft.${config.chainId}${config.mode === "fork" ? `.${deploymentChain(config)}` : ""}`;
}
export function savedLaunchDraft(config: RuntimeConfig | null) {
  if (!config) return null;
  try {
    const key = launchDraftKey(config);
    if (config.mode !== "fork") {
      const old = localStorage.getItem("musegod.launch.draft");
      if (old) {
        const value = JSON.parse(old);
        const matches = [...STOCKS, ...ROBINHOOD_STOCKS].filter((a) => typeof value?.quoteAddress === "string" && sameAddress(a.address, value.quoteAddress));
        const chain = matches.length === 1 ? matches[0].chainId : 4663;
        const destination = `musegod.launch.draft.${chain}`;
        if (!localStorage.getItem(destination)) localStorage.setItem(destination, JSON.stringify({ ...value,
          ...(matches.length !== 1 ? { firstBuy: { amount: "0", slippageBps: 100, lockDays: 0 } } : {}) }));
        localStorage.removeItem("musegod.launch.draft");
      }
    }
    return localStorage.getItem(key);
  } catch { return null; }
}
export function firstBuyDraft(config: RuntimeConfig | null, rawOverride?: string | null): FirstBuyDraft {
  const raw = rawOverride === undefined ? savedLaunchDraft(config) : rawOverride;
  const draft = restoreDraft(raw, config ?? undefined);
  let saved: Partial<FirstBuyDraft> | null = null;
  let savedPair: unknown;
  try {
    const value = JSON.parse(raw || "null");
    saved = value?.firstBuy;
    savedPair = value?.quoteAddress;
  } catch { /* Use safe defaults. */ }
  if (config && typeof savedPair === "string" && !sameAddress(savedPair, draft.quoteAddress))
    return { amount: "0", slippageBps: 100, payAddress: draft.quoteAddress, lockDays: 0 };
  const lockDays = saved && [0, 30, 90, 365].includes(saved.lockDays ?? -1) ? saved.lockDays! : 0;
  const payAddress = typeof saved?.payAddress === "string" ? saved.payAddress : draft.quoteAddress;
  if (config && !firstBuyPaymentAssets(deploymentChain(config), draft.quoteAddress).some((asset) => sameAddress(asset.address, payAddress)))
    return { amount: "0", slippageBps: 100, payAddress: draft.quoteAddress, lockDays: 0 };
  return { amount: typeof saved?.amount === "string" && /^\d{0,21}(?:\.\d{0,18})?$/.test(saved.amount) ? saved.amount : "0",
    slippageBps: [50, 100, 200, 500].includes(saved?.slippageBps ?? -1) ? saved!.slippageBps! : 100,
    payAddress, lockDays };
}
