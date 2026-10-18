# Durable Object idle duration, 2026-10-18: clear fetch deadline timers

Status: released 2026-10-18 on the owner's approval, fast-forwarded to master from branch `claude/fervent-lamport-3e9549` (based on `608ff14`; rollback point Worker `9072c850`). Cross-reviewed (codex review → claude fix → codex accept). The before/after duration comparison below is measured after release.

## Problem

The account's "Durable Objects daily operation limit 90% reached" alert is about daily Durable Object duration on the Workers Free plan (13,000 GB-s per day). At 100%, Durable Object calls fail for the rest of the UTC day, which takes the whole API down. Requests (11k of 100k per day), SQLite rows read (70k of 5M) and rows written (23k of 100k) are far below their limits.

## Evidence (2026-10-18, Cloudflare GraphQL `durableObjectsPeriodicGroups`)

- 2026-10-17: the two chain Durable Objects (`robinhood-mainnet`, `base-mainnet`, class `LaunchpadRuntime`) were active 99,884 s ≈ 12,486 GB-s (96% of the limit) with only 103 s of CPU. Usage has been above 90% since 2026-10-14 and rising.
- Active share stays at 51–65% in every hour regardless of traffic (≈300 requests/h → 57%, 1,364/h → 62%). The quiet Base object is active ≈15.2 s of every 30 s alarm cycle, while the alarm handler itself takes ≈0.6 s (`maintenance` on `/api/chains/{id}/readyz`).

## Cause

`SupabaseStore.request` passed `AbortSignal.timeout(15000)` on every request. That timer stays pending for 15 s after a 0.2 s answer. Cloudflare's lifecycle documentation lists "no `setTimeout`/`setInterval` scheduled callbacks" as a condition for hibernation and bills an object that is "idle in-memory and non-hibernateable". Each 30 s alarm makes Supabase calls, so each cycle stayed billable for ≈15 s (0.6 s handler + ≈15 s pending timer ≈ the measured 15.2 s). The same pattern was on every outbound fetch the API makes inside the Durable Object.

## Change

- `server/deadline.ts` `withDeadline(ms, work)`: an `AbortController` plus a `setTimeout` that is cleared in `finally` as soon as `work` settles; on expiry the signal aborts with the same `TimeoutError` DOMException as `AbortSignal.timeout`, and after `work` settles the signal is aborted to release a body an error path left unread. Each call site reads its response body inside `work`, so the deadline still covers the body.
- Replaced every `AbortSignal.timeout` in `server/` (all of it runs inside the Durable Object on Cloudflare): Supabase store (15 s), Turnstile check (10 s), LI.FI display price (3 s), CoinGecko/GeckoTerminal market (15 s), Bankr MUSEGOD market (15 s), NFT holdings (8 s), Pinata upload (15 s), buyback data (15 s), KyberSwap route and build (15 s each), Relay status (10 s), fork/non-production RPC (30 s). Deadlines, error messages and error mapping are unchanged.
- Other timers on Durable Object paths were already cleared in `finally` (LI.FI payment reader, Notify client and reconciliation, swap block verification, opening price, Base buyback RPC, body reads, preview queue, prepare-slot renewal); viem's HTTP transport clears its own timeout.
- Known, unchanged boundary: a few request paths race an RPC read against a short deadline and answer without it (token detail state and Muse profile, first-buy lock metadata in `server/service.ts`). The losing RPC keeps running under the transport's own timeout (25 s in `server/service.ts`) until it settles, so a slow RPC can still keep the object active after such a request. The idle alarm path has no such race.
- Tests: `tests/fetch-deadline.test.ts` replaces the global timers with a ledger and proves the deadline is armed with the original length, is still live while the body is read, leaves no live timer after a successful, an HTTP-failed and a transport-failed request, and still ends a request that stalls before the headers or during the body with `TimeoutError`; a source guard fails if `AbortSignal.timeout(` returns to `server/` or `worker/`. `tests/nft-holdings-server.test.ts` now fires the deadline through the timer instead of mocking `AbortSignal.timeout`.
- The 30 s idle alarm interval is unchanged.

## Release steps (owner approval required)

1. Record the live Worker version as the rollback point (`wrangler deployments list`; the last recorded release is Worker `9072c850`).
2. Release through the normal master push / CI path.
3. Durable Objects can keep old code after a CI release, and this change has no API-visible behavior to probe. Redeploy the same version right after the release from the main checkout (`npx wrangler versions deploy <version>@100% --durable-objects-code-update-mode immediate -y`), or at the latest when the first full hour below still shows the old active share.

## How to confirm the effect

Rerun the GraphQL query used for the 2026-10-18 analysis (account `4b68bb6b6c38892162610027f25fbb0d`), hourly for the first hours after release and daily for the first full UTC day:

```graphql
query DurableObjectDuration($account: String!, $since: Time!, $until: Time!) {
  viewer {
    accounts(filter: { accountTag: $account }) {
      durableObjectsPeriodicGroups(limit: 1000, filter: { datetimeHour_geq: $since, datetimeHour_lt: $until }, orderBy: [datetimeHour_ASC]) {
        dimensions { datetimeHour objectId }
        sum { activeTime cpuTime }
      }
    }
  }
}
```

- `activeTime` and `cpuTime` are in microseconds: active seconds = sum(`activeTime`) ÷ 1,000,000 (CPU seconds likewise).
- Active share per hour = active seconds of both objects ÷ (2 × 3,600 s). GB-s = active seconds × 0.125 GB. The daily limit equals 104,000 active seconds across both objects.
- Before: ≈57% active share, ≈12,486 GB-s per day. Expected after: a few percent. The alarm floor is ≈0.6 s per 30 s per object (≈2%, ≈3,500 active seconds ≈ 430 GB-s per day for both), plus request handling time.
- The quiet Base object is the cleanest signal: it should fall from ≈15.2 s to about 1 s of every 30 s cycle.

## If the share does not fall

1. Confirm both objects run the new code (redeploy the same version with `--durable-objects-code-update-mode immediate`) and measure one more full hour.
2. If the Base object still shows ≈15 s per cycle, something else keeps the object non-hibernatable after the alarm; compare the per-cycle active time with the `launchpad_maintenance` phase times before changing anything.
3. The next lever is a longer idle alarm interval (30 s today). Report the measured numbers to the owner; do not change the interval without the owner's decision.
4. Independent safety net, the owner's choice: the Workers Paid plan ($5/month) has no daily Durable Object limits.
