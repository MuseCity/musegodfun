import { deploymentChain, STOCKS, ROBINHOOD_STOCKS, sameAddress, type RuntimeConfig } from "./config";
import { launchSchema, restoreDraft } from "./validation";
import { firstBuyPaymentAssets } from "./first-buy-payment";

export type FirstBuyDraft = { amount: string; slippageBps: number; payAddress: string; lockDays: 0 | 30 | 90 | 365 };
export type LaunchStep = 1 | 2;
// The form step is saved with the draft so a reload resumes where the creator left off.
export function launchDraftStep(raw: string | null): LaunchStep {
  try { return JSON.parse(raw || "null")?.step === 2 ? 2 : 1; } catch { return 1; }
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
    return JSON.stringify({ ...saved, step: 1 });
  } catch { return raw; }
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
