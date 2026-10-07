import type { LaunchPlan } from "../src/lib/launch-plan";

// The canonical transaction data is retained once. Old full payloads remain readable.
export function packPlan(plan: LaunchPlan): unknown {
  if (!plan.transaction) return plan;
  const copy = structuredClone(plan) as any;
  delete copy.data;
  if (copy.prepared?.transaction?.data === plan.transaction.data) delete copy.prepared.transaction.data;
  return { storageVersion: 2, plan: copy };
}
export function unpackPlan(payload: any): LaunchPlan {
  if (payload?.storageVersion !== 2) return payload as LaunchPlan;
  const copy = structuredClone(payload.plan);
  copy.data = copy.transaction.data;
  if (copy.prepared?.transaction && !copy.prepared.transaction.data) copy.prepared.transaction.data = copy.transaction.data;
  return copy as LaunchPlan;
}
