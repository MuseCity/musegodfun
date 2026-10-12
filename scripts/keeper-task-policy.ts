// These are keeper gas protections, independent of user transaction limits and
// the Vault's WETH budget. A resolved revert isolates only its own task.
export const KEEPER_TASK_RETRY_POLICY = {
  initialBackoffMs: 120_000, maximumBackoffMs: 3_600_000,
  attemptWindowMs: 3_600_000, maximumRevertsPerWindow: 3,
  // Per task, not keeper-wide: once a task's reverted gas in the rolling
  // window reaches this, that task stops until the window rolls.
  gasWindowMs: 86_400_000, maximumFailedGasWei: 10n ** 15n,
  // Worst-case cost of one signed attempt (buffered gas limit × gas price).
  // Separate from failure history, so an unaffordable attempt says so itself;
  // a task's failed gas in one window stays below maximumFailedGasWei + this.
  maximumAttemptGasWei: 2n * 10n ** 15n, gasRetryMs: 60_000,
} as const;
