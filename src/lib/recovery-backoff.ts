import { ApiError } from "./api";

// Background registration polling runs every 15 seconds. A record whose check
// keeps failing waits longer each time, and always at least as long as the
// server asked, so unrecoverable rows cannot crowd out new registrations.
export const RECOVERY_POLL_MS = 15_000;
export const RECOVERY_MAX_BACKOFF_MS = 600_000;
export type RecoveryBackoff = { failures: number; nextAt: number };
const waiting = new Map<string, RecoveryBackoff>();

export function nextRecoveryAttempt(previous: RecoveryBackoff | undefined, error: unknown, now: number): RecoveryBackoff {
  const failures = (previous?.failures ?? 0) + 1;
  const backoff = Math.min(RECOVERY_MAX_BACKOFF_MS, RECOVERY_POLL_MS * 2 ** Math.min(failures - 1, 16));
  const requested = error instanceof ApiError && error.retryAfter ? error.retryAfter * 1000 : 0;
  return { failures, nextAt: now + Math.max(backoff, requested) };
}
export const recoveryKey = (chainId: number, hash: string) => `${chainId}:${hash.toLowerCase()}`;
/** Whether the background loop should check this record now. */
export function recoveryDue(key: string, now = Date.now()) { return (waiting.get(key)?.nextAt ?? 0) <= now; }
export function recordRecoveryFailure(key: string, error: unknown, now = Date.now()) { waiting.set(key, nextRecoveryAttempt(waiting.get(key), error, now)); }
export function clearRecoveryBackoff(key: string) { waiting.delete(key); }
/** Holds a record at least until the wait a server asked for, without
 * counting another failure. */
export function recordServerWait(key: string, error: unknown, now = Date.now()) {
  if (!(error instanceof ApiError) || !error.retryAfter) return;
  const current = waiting.get(key);
  waiting.set(key, { failures: current?.failures ?? 0, nextAt: Math.max(current?.nextAt ?? 0, now + error.retryAfter * 1000) });
}
/** Runs one check of a record and settles its backoff: a check that
 * completes clears it, even when the transaction is still pending. A failed
 * background check extends it; a failed manual one (for example while the
 * transaction is still unmined) adds only a wait the server asked for. */
export async function settleRecovery(key: string, check: () => Promise<void>, manual = false) {
  try { await check(); } catch (error) {
    if (manual) recordServerWait(key, error); else recordRecoveryFailure(key, error);
    throw error;
  }
  clearRecoveryBackoff(key);
}
/** A best-effort request made alongside a record's check. Its failures are
 * ignored, except a wait the server asked for, which applies to the record. */
export async function bestEffort(request: () => Promise<unknown>) {
  try { await request(); } catch (error) { if (error instanceof ApiError && error.retryAfter) throw error; }
}
