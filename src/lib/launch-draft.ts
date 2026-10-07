import { deploymentChain, STOCKS, ROBINHOOD_STOCKS, sameAddress, type RuntimeConfig } from "./config";
import { restoreDraft } from "./validation";
import { firstBuyPaymentAssets } from "./first-buy-payment";

export type FirstBuyDraft = { amount: string; slippageBps: number; payAddress: string; lockDays: 0 | 30 | 90 | 365 };
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
