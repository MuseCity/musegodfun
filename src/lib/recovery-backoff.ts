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
/** A success, or a manual retry the user started, clears the record's backoff. */
export function clearRecoveryBackoff(key: string) { waiting.delete(key); }
