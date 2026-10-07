import { AsyncLocalStorage } from "node:async_hooks";

export const SECURITY_PROTOCOL = 1;
export type RuntimeControl = { paused: boolean; revision: number; updatedAt: number; reason: string };
export const defaultRuntimeControl = (): RuntimeControl => ({ paused: true, revision: 0, updatedAt: 0, reason: "Awaiting runtime activation" });
export type BudgetName = "lifi" | "pinata" | "prepare";
export type BudgetResult = { allowed: boolean; retryAfter: number };
export const BUDGETS: Record<BudgetName, { windows: readonly [number, number][]; reserve: number }> = {
  // Shared across both chains. Keep headroom below the default provider tier.
  lifi: { windows: [[60_000, 80], [7_200_000, 9_600]], reserve: 0.2 },
  pinata: { windows: [[86_400_000, 100]], reserve: 0 },
  prepare: { windows: [[60_000, 40], [86_400_000, 2_000]], reserve: 0.2 },
};
const priority = new AsyncLocalStorage<boolean>();
export const recoveryBudget = () => priority.getStore() === true;
// Only the verified-receipt API path may enter this context. Never a user flag.
export const withRecoveryBudget = <T>(verified: boolean, fn: () => Promise<T>) => priority.run(verified, fn);
export class BudgetUnavailable extends Error {
  constructor(readonly retryAfter = 60) { super("Service capacity is temporarily limited. Try again shortly."); }
}
