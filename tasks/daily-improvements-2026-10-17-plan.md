# Daily improvements, 2026-10-17: live resync, stale-snapshot guard, home market status, empty-state recovery, maintenance metrics

Status: done locally (2026-10-17): implemented, cross-reviewed to convergence (codex review → claude fix → codex accept; claude review → codex fix → claude accept) and committed on the branch. Not released: the release is the owner's master push, and the maintenance-cost comparison with the Cloudflare usage dashboard needs one quota cycle after that release. Branch `claude/musegod-daily-improvements-3367cd`, based on master `5a9d1cd`.

## Owner request (2026-10-17, translated)

Act on today's improvement report, which was checked against code `01637b7` and the live site:

1. Priority: after a stream reconnect, catch up on trades missed while disconnected. Ordinary launch pages only refresh every 15 minutes; a reconnect updates the connection status without a snapshot. Call the existing rate-limited recovery on reconnect and on return to the foreground, never one REST read per push.
2. Priority: an older recovery snapshot must not erase a newer push. The recovery result replaces everything once the page is still mounted and the chart interval is unchanged; a trade pushed while the request was in flight can disappear or the chart can step back. Add a request version with a snapshot watermark, or buffer the pushes received during the recovery and replay them; chain reorganizations stay on their own path.
3. Home list: separate "requested" from "has usable market data". MuseVader and CLAWGOD show dashes next to "CoinGecko Fetched"; only the detail page says there is no price and that the provider has paused updates. Show "no price yet / updates paused" states on the list and keep the time of the last request apart from the time of the last successful data.
4. With no results, help the user get the list back first. After "New in 24h 0" the empty state's main action is "Create your meme". Make "show all / clear filters" the primary action and keep creation secondary; one action restores results after search, quote-asset and quick-filter combinations, with sensible keyboard focus.
5. Locate the Durable Object duration cost before reducing it. The Cloudflare account received another daily Durable Objects duration alert at 90%; the quota reset at 08:00 Beijing time today, so the alert is not the current usage. The maintenance alarm runs on a fixed interval, but which namespace and which phase cost the most is unconfirmed. Add per-phase timing, idle-run and processed-work counts that can be aligned with the platform's usage; consider idle backoff only with evidence.

Out of scope today: mobile, screen readers, wallet transactions, end-to-end push behavior in production, and the actual quota after the reset.

## Facts

- `src/lib/swap-live.ts`: one socket per tab. `createSwapConnection` disconnects while hidden, reconnects when visible or after a failure with capped backoff, and publishes `{connected, receiving, receivedAt}`. The server never replays past pushes to a new socket (`worker/index.ts` `stream`/`broadcast`), so trades broadcast while a tab had no socket are not delivered later.
- `src/components/SwapLive.tsx`: the only consumer. It clears the live projection when the status is not connected and applies pushes with `applySwapPush`. `createGapRefresh` (5-10 s jitter, at most once every 30 s per tab) is requested only for server `reorg`/`gap` signals. The recovery work reads summary, candles and trades and publishes them when the component is still mounted and the interval is unchanged; nothing compares the snapshot with pushes received meanwhile.
- `src/components/TokenMarket.tsx`: launch pages re-read REST every 15 minutes while visible; the MUSEGOD page every 15 seconds and on visibility/focus changes.
- Production (2026-10-17 06:38 UTC, read-only GET): MVADER and CLAWGOD `/market/summaries` rows are `source: CoinGecko, status: fresh` with every value `null` and no reason. MVADER candles carry `reason: backoff` (GeckoTerminal), which the detail chart renders as "The price provider is temporarily pausing updates." MV2C has real zeros (`volume: 0`, `change: 0`) beside a price. The summaries endpoint also returns `summary: null` rows with `reason`/`causes` when the provider request itself fails.
- `src/components/TokenCard.tsx` `CardMarketStatus`: any non-unavailable snapshot renders `{source} · Fetched HH:MM`, whether or not it holds a value. Unavailable rows render the error with no time. `src/lib/market.ts` `marketStatusMessage` maps every reason except `source_not_provided`/`not_indexed` to "Market data unavailable".
- `src/App.tsx` `Explore`: the empty state with active filters says "No matching tokens" and offers only the `/create` link (class `secondary`). Filters live in component state (`search`, `filter`, `quick`); quick filters are buttons in a `role="group"`.
- `worker/index.ts` `alarm()` runs every 30 s per chain Durable Object: `store.cleanup()` (a Supabase RPC in production), `service.reconcile(60_000)` (returns early with no pending launches), `swaps.reconcile(origin)` (Notify reconciliation, normally a store read), `swaps.maintain()` (prune up to 500 rows and verify up to 10 pending blocks within 10 s). Nothing records durations or work counts; `/readyz` exposes only `swapStream` status. Node (`server/index.ts`) runs the same upkeep every 30 s without an alarm.

## Goal

A token page that reconnects shows every trade broadcast while it was away without a request storm, a recovery never hides a newer trade or counts its volume twice, the home list names the state of a row's market data honestly, an empty filtered list is one action away from the full list, and each maintenance run leaves an auditable per-phase cost record.

## Design and constraints

### 1. Resync on reconnect and foreground

- `createSwapConnection` publishes `resumed: true` on the `open` of any socket that follows a failed attempt, a closed socket or a hidden-tab disconnect; the first clean connection publishes `resumed: false`. `LiveStatus` gains the optional field; nothing else about connection handling changes.
- `SwapLive` requests the existing gap recovery when a status arrives with `connected && resumed`. Return to the foreground is a reconnect (hidden tabs disconnect), so it needs no separate handler. Pushes never trigger REST; the 30-second tab-wide gate and the 5-10 s jitter bound repeated hide/show cycles to at most one recovery per 30 s.
- MUSEGOD keeps its own 15-second and visibility refresh; the resumed recovery is redundant there but bounded.

### 2. Stale snapshot guard

- `SwapLive` keeps a replay buffer per recovery: from the moment the recovery work starts until its responses are applied, every applied push (not `reorg`/`gap`, which only re-request recovery) is appended. When the responses arrive, the snapshot is composed with `applySwapPush` for each buffered message in order, then published. `applySwapPush` already dedupes rows by hash and log index and keeps a candle watermark, so a trade already in the snapshot is neither re-added nor re-counted.
- A recovery whose REST read fails publishes nothing and drops its buffer; the next signal requests again. The interval check stays. Reorganizations are not replayed: a reorg message during a recovery requests a further recovery after the gate.

### 3. Home list market status

- `src/lib/market.ts`: `summaryHasValues(summary)` (any of price quote, price USD, market cap, FDV, liquidity, 24h volume is non-null; zero counts) shared by `TokenMarket` and `CardMarketStatus`; `marketPaused(reason)` for `backoff`, `rate_limited`, `quota_exhausted`; `marketStatusMessage` returns "Provider updates paused. Try again later." for those reasons.
- `CardMarketStatus` states, list and grid: values + fresh `{source} · Fetched HH:MM`; values + stale `{source} · Previous snapshot · HH:MM` (unchanged); no values + fresh `{source} · No market price yet · Checked HH:MM`; no values + stale `{source} · No market price yet · Previous check HH:MM`; no snapshot `{error} · Checked HH:MM` where the client records `checkedAt` on unavailable rows (`CardMarketState.checkedAt`). "Fetched" is reserved for a snapshot that holds values; "Checked" is the time of a request that returned none.
- The detail price row already says "No market price yet" for an empty fresh summary; its warning paragraph shows the shared reason text, so list and detail agree for the four cases: missing, paused, stale, real zero (a zero shows `$0` / `0.00%` under "Fetched").
- Trending and the 24h-volume sort already require a non-null volume; unchanged.

### 4. Empty-state recovery

- With active filters, the empty state offers a primary button "Show all launches" that clears search, quote-asset filter and quick filter in one click and moves keyboard focus to the "All launches" chip, which is now pressed. "Create your meme" stays as the secondary link. Without active filters the empty state is unchanged.

### 5. Maintenance metrics

- `worker/index.ts` `alarm()` times each phase (`cleanup`, `launches`, `webhooks`, `finality`) with wall-clock deltas and records outcome and work: `launches` from `service.reconcile` (`{pending, processed}`), `webhooks` from `swaps.reconcile` (per kind `fresh` / `checked`), `finality` from `swaps.maintain` (`{pruned, blocks, verified, reorgs}`). `SwapStore.prune` returns the number of removed rows. A run with no pending launches, no remote Notify work, no pruned rows and no verified block is idle.
- Each run logs one line `{"event":"launchpad_maintenance", chainId, ms, idle, phases}` (Cloudflare invocation logs are enabled in `wrangler.jsonc`). The Durable Object also accumulates runs, idle runs, cumulative milliseconds and work per phase since the isolate started, plus the last run, and passes a reader into `createApp`; `/readyz` includes it as `maintenance` when present (the Node server has no alarm and omits it, so existing readiness assertions are unchanged).
- No interval change today. Alignment method for the owner: compare `maintenance.ms` per day (runs × mean ms) against the dashboard's Durable Objects duration (GB-s ÷ 0.125 GB); the remainder is request-driven time plus the platform's post-event keepalive, which this instrumentation cannot see from inside the handler.

### General

- Frontend and Worker only; no contract, wallet, quote or database change. English only in committed files.
- Tests first (node:test). `npm test`, `npm run build`, `git diff --check`, Han scan of changed tracked files.
- Cross review: codex review → claude fix → codex accept, then claude review → codex fix → claude accept.
- Local commits only; the release is the owner's master push.

## Acceptance

1. `createSwapConnection`: the first open publishes `resumed: false`; an open after a close, an error, a failed attempt or a hidden/visible cycle publishes `resumed: true`.
2. `SwapLive`: a `connected && resumed` status requests the recovery; a plain `connected` status does not; pushes still cause zero REST reads.
3. `SwapLive`: a push received while the recovery is in flight stays visible after a snapshot that lacks it is applied; a push already contained in the snapshot adds no trade row and no candle volume; a reorg during a recovery is not replayed.
4. `CardMarketStatus` and the Explore rows render the five states above; a fresh empty summary never says "Fetched"; a real zero says `$0` under "Fetched"; a paused unavailable row says "Provider updates paused" with a "Checked" time. `marketStatusMessage` keeps its existing results for other reasons.
5. `Explore`: with a quick filter, search or quote-asset filter active and no match, the primary action "Show all launches" precedes the create link, and one activation clears all three and restores the list; without active filters the create link is the only action.
6. `alarm()` logs one maintenance line with four phases, marks an empty run idle, keeps the existing phase order and failure isolation (`swap-run2b`, `swap-run2c`), and `/readyz` carries `maintenance` only when a reader is configured.
7. `npm test`, `npm run build`, `git diff --check` and the Han scan pass; the cross review converges.

## Delivery record

### Run 1 (claude implementer, 2026-10-17)

- Item 1: `createSwapConnection` publishes `resumed` on every open that follows a failure, a close, a hidden-tab disconnect or a mount in a hidden tab (the first clean open publishes `resumed: false`, and the flag resets when the last subscriber leaves). `SwapLive` requests the existing gated recovery from the status callback when `connected && resumed`; pushes still cause zero REST reads.
- Item 2: `SnapshotMeta.watermark` records the newest own trade applied to each section (set by `meta()` and the secondary-price branch of `mergeSummary`, never moving backwards); `applySwapPush` filters push rows per section against that watermark, so a replayed or late row at or below it is neither re-added, repriced nor counted twice. `SwapLive` buffers pushes per in-flight recovery and replays them over the returned snapshot; a recovery publishes nothing once a reorg arrived after it started (`generation`) or a later recovery already published (`sequence`/`published`); reorg and gap signals still request the gated follow-up.
- Item 3: `summaryHasValues`, `marketPaused` and the paused message live in `src/lib/market.ts` and are shared by `TokenMarket` and `CardMarketStatus`. List rows and cards say `Fetched` only for a snapshot with a value (real zeros included), `No market price yet · Checked HH:MM` for an empty fresh snapshot, `No market price yet · Previous check HH:MM` for an empty stale one, and the shared reason text with `Checked HH:MM` (client `checkedAt`) when a request returned no snapshot.
- Item 4: the Explore empty state with active filters shows a primary `Show all launches` button before the secondary `Create your meme` link; one activation clears search, quote-asset filter and quick filter and moves focus to the pressed `All launches` chip.
- Item 5: the Worker alarm times `cleanup`, `launches`, `webhooks` and `finality` with outcome and work counts (`service.reconcile` returns pending/processed, `swaps.reconcile` per-kind `fresh`/`checked`, `swaps.maintain` pruned/blocks/verified/reorgs, `SwapStore.prune` returns the removed count), logs one `launchpad_maintenance` line per run and exposes lifetime totals as `maintenance` on `/readyz` through a `createApp` reader (Node omits it). Phase order, failure isolation and alarm rescheduling are unchanged; the interval is unchanged.
- Docs: Spec paragraphs on market snapshots and Durable Object maintenance, README readiness line, this plan and a pointer in `tasks/todo.md`.
- TDD: every new test failed before its implementation (resumed status; recovery request and replay; card states and check times; Explore empty-state interaction via the hooks runtime; alarm metrics, swap maintenance counts, Notify outcomes and readiness). Full suite 1847/1847 after the codex round-1 fixes (an earlier run showed 18 failures in keeper-wrapper and NFT-vault build tests caused only by the worktree having no `node_modules`; `npm ci` in the worktree resolved them). `npm run build`, `git diff --check` and the Han scan pass; the existing Vite chunk-size warning remains.
- Read-only preview (plain Vite with GET-only `/api` and WebSocket proxying to production, no server process): the Explore empty state after `New in 24h` shows the primary action, one activation restores all four rows and focuses the pressed `All launches` chip; MVADER and CLAWGOD rows read `CoinGecko · No market price yet · Checked HH:MM`, MV2C reads `CoinGecko · Fetched HH:MM`; on the MV2C page the stream socket connects through the proxy and a simulated hidden/visible cycle triggered exactly one summary/candles/trades recovery. Not verified: a real missed trade during the cycle, mobile, screen readers, production.

### Cross review

- Codex review 1 (gpt-6.1-sol, xhigh): two P1 findings, both confirmed and fixed by claude. (1) Replaying a buffered push the snapshot already held let `mergeSummary`/`mergeTrades` overwrite newer USD-priced values and let an earlier same-block log overwrite a later one; fixed with the per-section watermark. (2) A reorg during an in-flight recovery did not invalidate its buffer; first fixed by emptying buffers, which codex's acceptance round rejected (a pre-reorg snapshot could still publish late and valid pushes were dropped), then fixed with the recovery generation and sequence guards above, with tests for a late pre-reorg snapshot and out-of-order completion.
- Codex acceptance round 2: ACCEPT (no remaining or new findings; the pre-reorg, out-of-order and gap orderings verified; 16/16 related tests).
- Claude reverse review: no P0/P1; two P3 items (a synchronous initial `resumed` status at subscribe time can request one redundant gated recovery; `MaintenanceMetrics.report()` returns the live phase objects by reference) handed to the codex fixer.
- Codex fixer: `SwapLive` ignores the synchronous initial status for the resume decision (`ready` flag set after subscribing) with a test that the same status delivered later still requests a recovery; `report()` returns copied phase totals with a test that mutating a report leaves the next one unchanged. No new top-level import in `worker/index.ts`.
- Claude acceptance: both fixes verified by reading the diff and rerunning the seven related test files (52/52), `npm run typecheck`, `git diff --check` and the Han scan. ACCEPT; the cross review has converged.
- Final verification after the fixer round: `npm test` 1849/1849, `npm run build` (both typechecks and Vite; entry 1,129.08 kB / 331.29 kB gzip, the existing chunk-size warning remains), `git diff --check` and the changed-file Han scan pass. Committed locally on the branch; not pushed.
