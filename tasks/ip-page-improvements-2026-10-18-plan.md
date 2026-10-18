# IP page improvements, 2026-10-18 — spec and plan

Source: the owner pasted the 2026-10-18 daily improvement report (four items on the redesigned token IP page, translated from Chinese). Base: master `3b1f1fd`. Items 1–3 are code inferences from the report, not reproduced in production; item 4 was measured on the live site (about 1180×757 desktop window).

## 1. Profile read failure never restores replaced launch links

Problem: `tokenDetail` turned any profile read failure into `null`, and the page then fell back to the launch links. An owner who replaced or cleared a launch link (A → B or A → empty) could see A again during a storage error.

Change:
- The server distinguishes three answers for a page view: a definitive answer (a saved profile, or none saved), a **stale** answer (the store read failed or missed the deadline, and the service still holds its last answer for this coin, with the time it was confirmed), and **unavailable** (no answer is known).
- `GET /api/tokens/:address` adds `profileStatus: "stale" | "unavailable"` (omitted when definitive) and `profileCheckedAt` (stale only). A stale answer is the service's own last confirmed read or save. A save with an unknown write outcome invalidates that answer and prevents an earlier in-flight read from restoring it; until a new read confirms the stored profile, the response is unavailable.
- The page shows no social links while the profile is unavailable, never the launch links; the Channels card says the links are temporarily unavailable and the page retries on its own. A stale answer renders with "Links last confirmed HH:MM". Opening the editor requires a definitive answer. A non-definitive refresh locks an open editor until it is closed, even if a definitive answer later arrives; typed links remain and an already pending save can finish and report its result. Losing ownership still closes the editor.

Acceptance: with A replaced by B (or cleared) and the store read failing, the response never lets A render; a cached B is served as stale; with no cache the links are hidden and Edit profile is not offered.

## 2. The profile read respects the page deadline

Problem: the Muse read shared the pool state read's deadline, but the profile read waited for the store request's own 15 s limit and held the whole page.

Change: the profile read races the same deadline as the pool state read (`TOKEN_STATE_DEADLINE_MS`, 8 s from the start of the request). A read that misses it answers stale or unavailable; it keeps running and fills the service's memory cache for another view while that instance stays resident. The client retries a non-definitive profile by refreshing the detail, with backoff (15 s, 30 s, 60 s, then every 120 s) unless the pool state retry already runs every 15 s.

Production limitation: both the stale answer and the post-deadline cache fill live only in the service's memory, which a hibernated Durable Object discards. A failed read on a quiet coin therefore usually answers unavailable. A store slower than the 8 s deadline can keep answering unavailable across retries until it speeds up, because hibernation may discard each late fill before the next refresh. Links show as unavailable rather than showing a wrong link. No persistence is added.

Acceptance: a profile read that never settles does not delay the detail past the deadline; once the read finishes, the next detail carries the profile only if the same service instance remains resident. Node tests verify this instance-local behavior, not production convergence across hibernation.

## 3. Pool quote keeps a refresh and its read time

Problem: after "Get pool quote" succeeded the button disappeared and the price had no time or expiry, so it could sit next to the venues indefinitely.

Change: the result shows "Read at HH:MM:SS"; after 60 s it is labelled expired; the button stays as "Refresh pool quote" (manual only, no automatic polling). A failed refresh keeps the previous figure with its original read time, labelled not current, plus the error.

Acceptance: quote A, then refresh to B shows B with a new time; a failed refresh never shows A as a new quote.

## 4. Tabs right under the hero, and the selected tab in the URL

Problem: at a 1180 px desktop window the content column is about 853–868 px (248 px sidebar, 32 px gutters), below the 900 px two-column threshold, so the trade and beneficiary cards stacked first and the tabs started near y = 1375. Switching tabs did not change the URL.

Change:
- DOM order becomes hero → main (tabs and panels) → aside (trade card, beneficiary card), so reading and keyboard order match the layout in both modes (the old CSS `order` swap is removed).
- Two columns from a content width of 820 px (main 480 px basis, aside 320 px), which covers desktop windows from 1132 px, or 1147 px with a 15 px classic scrollbar.
- In the stacked layout (phones, tablets, narrow desktop windows) the tabs follow the hero; a "Trade" button in the hero, shown only while stacked, scrolls to and focuses the trade card. This supersedes acceptance item 9 of `tasks/token-ip-detail-plan.md` ("the aside stacks above the tabs").
- The selected tab is `?tab=activity` or `?tab=onchain` (Overview has no parameter), written with `history.replaceState` (tab switches do not add history entries) and read on load and on `popstate`. The chain-less token redirect keeps the query and hash.

Acceptance: at 1180×757 the tabs are in the first viewport; opening a copied `?tab=activity` or `?tab=onchain` link shows that panel; Tab key order follows the visual order.

## 5. Verification

- `npm test`, `npm run typecheck`, `npm run build`.
- New tests: service profile answers (failure with and without cache, a read that never settles, cache fill after a late read); page rendering for unavailable and stale profiles; pool quote refresh, failure and read time; tab parsing, URL writes and DOM order.
- Read-only preview against production data (desktop 1180, phone 390). After release: live QA through codex in Chrome, read-only.

## 6. Review

Claude implements; codex (gpt-6.1-sol, xhigh) reviews; findings are fixed and re-accepted.

## 7. Status, 2026-10-18

Released on the owner's "Release now" as `c1aad4a`: CI run 39088312763, `build-39088312763-1`, Worker version `6f126af3` on both domains (deployed 02:00:29Z). Rollback point: Worker `38a0bf93` (`build-39083527095-1`, `3b1f1fd`). Both chain Durable Objects restarted after the deploy (`/readyz` `maintenance.since` 02:01:40Z on Base and 02:01:48Z on Robinhood), so no immediate-mode redeploy was needed.

Live QA (codex in Chrome, read-only, 10:03–10:05 UTC+8) passed all checks on MVADER (Robinhood) and MUSEGOD (Base): at 1180×757 two columns with the tabs at y = 431 (MVADER) and 521 (MUSEGOD, below the operator-hidden notice), the hero Trade button hidden and no horizontal scroll; DOM and Tab-key order hero → tabs → trade card; `?tab=` written on clicks without adding history entries, and a chain-less `?tab=onchain` link opened On-chain; at 375×812 the hero Trade button jumped to and focused the trade card; Channels showed the saved or launch links with no unavailable or stale notice; the pool quote showed its read time and "Refresh pool quote", and a refresh updated the time; no product console errors (only the known Cloudflare Insights CSP block). Evidence (report and screenshots) is archived outside the repo in `.superpowers/archive/musegod-ip-page-improvements-71906f/`.

| Item | State | Evidence |
|---|---|---|
| 1 No launch-link fallback on a failed profile read | Met in Node tests | `tests/token-profile.test.ts` (unavailable, stale with time, confirmed or unknown-outcome saves overtaking a shared read or a pending view, fresh and expired views after a commit-then-throw); `tests/token-ip-page.test.ts` (unavailable hides links and Edit buttons, stale note with and without links, open editor stays mounted and locked until closed, pending signature completes) |
| 2 Profile read within the page deadline | Met in Node tests; production limitation below | Service test in one resident instance: an unfinished read answers by the deadline, two views share one store read, the late read fills that instance's memory cache, zero live timers after fast and past-deadline profile reads; page test with the real resource hook: backoff 15/30/60/120/120 s, and repeated failed refreshes keep the 15 s state retry |
| 3 Pool quote refresh and read time | Met | Page test: A → expired after 60 s → refresh to B with a new time → failed refresh keeps B marked not current, also while a retry is pending |
| 4 Tabs under the hero, tab in the URL | Met | Page tests (DOM order, hero Trade jump, `?tab=` load, writes and `popstate` mounting a previously unvisited Activity panel); prior read-only preview against production data: at 1180×757 the content is 853 px, two columns, tabs at y ≈ 431; at 375 px the hero Trade button jumps to and focuses the trade card; a chain-less `?tab=onchain` link opens On-chain; no horizontal scroll |
| Suite | Met | After the last fix pass: `npm test` 1796/1796, `npm run typecheck`, `npm run build` |

Production evidence boundary: the stale answer and post-deadline cache fill are service memory, discarded by Durable Object hibernation. The Node tests do not simulate that lifecycle. In production a failed read on a quiet coin usually answers unavailable, and reads slower than the 8 s deadline can keep doing so until the store speeds up. These cases hide links instead of showing wrong ones; the tests do not establish convergence across hibernation.

Review: codex round 1 (gpt-6.1-sol, xhigh) raised 7 findings (four P2: overtaken shared read, `popstate`, open editor after a non-definitive refresh, retries stopping after identical errors; three P3: pending retry hid the failed-quote label, stale note missing without links, scrollbar arithmetic in the docs). Claude fixed all seven with tests. Codex's accept pass accepted six and raised one more P2 (a save made on the page suppressed later stale or unavailable answers); the page now shows the newer of its own save and the served profile by signature time while the server's status governs editing, and codex accepted that in a second pass (`VERDICT: ACCEPT`). A fresh Claude reviewer then raised four more (one P2: a save whose store write committed but whose response was lost left the pre-save answer cached; three P3: the Durable Object hibernation limit, the editor unmounting mid-signature, two tests that could not fail). Codex fixed them as directed (cache invalidation on an unknown write outcome, a documented limitation instead of persistence, a latched editor lock, stricter tests) and Claude accepted the fixes after rerunning the suite. The pool quote itself was not exercised in the preview (the read-only proxy refuses POST); it is covered by unit tests.
