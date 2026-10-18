/** Runs `work` under a deadline: past `ms` its signal aborts with the same "TimeoutError" DOMException as AbortSignal.timeout. Unlike
 * AbortSignal.timeout, the timer is cleared as soon as `work` settles, so read the response body inside `work` to keep it covered; the
 * signal is then aborted, which releases a body an error path left unread. A pending timer keeps a Durable Object from hibernating, and
 * an idle object that cannot hibernate is billed for duration: a 15 s AbortSignal.timeout left by a 0.2 s Supabase request kept each
 * 30 s maintenance alarm billable for about 15 s. */
export async function withDeadline<T>(ms: number, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new DOMException("The operation was aborted due to timeout", "TimeoutError")), ms);
  try { return await work(controller.signal); }
  finally { clearTimeout(timer); controller.abort(); }
}
