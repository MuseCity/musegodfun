# Review info tips and opening price reference plan

Status: Implemented and reviewed, not released (release only on the owner's word). Owner request 2026-10-18 (translated from Chinese): "Put these two lines into info icons at their matching places, shown when the user hovers: 'Not investment advice. musegod.fun does not endorse NFT collections; an unverified collection may imitate another.' and 'The NFT's treasury earns 0.665% of every trade'. Fix the problem 'An independent fresh price reference is unavailable. Review the opening price and minimum received before continuing.'" Branch `claude/review-info-tips`, based on master `6e6cc32` (the launch review trim, `tasks/launch-review-trim-plan.md`).

## Part 1: info tips in the NFT review block

- The NFT disclaimer moves from its own paragraph under the NFT tiles into an info icon on the **Collection** tile (it is about collections and imitations).
- For an NFT coin, the band "The NFT's treasury earns X% of every trade" moves into an info icon on the **Creator fees** tile, which already says the fees go to the NFT's treasury. A plain coin keeps its "You earn X% of every trade" band.
- The icon is a real button. Its text shows while a mouse is over the icon or the text itself, while the icon has keyboard focus, or after a tap (touch screens have no hover) until a second tap or a tap elsewhere. While it shows, the first Escape hides it and does not close the dialog. The text is linked with `aria-describedby`, so screen readers read it, and takes no space while hidden. The NFT step on the form keeps its visible disclaimer.

## Part 2: the opening price reference warning

Observed facts (2026-10-18, read-only `eth_call` through `https://musegod.fun/api/chains/4663/rpc`):
- The warning comes from `independentReference()` in `server/opening-price.ts`. It compares the LI.FI opening price with a Chainlink feed mapped in the immutable buyback oracle `0x768c2a29…` (`assetFeeds`). It returns "unavailable" when the chain is not Robinhood, the asset has no mapped feed, the feed is older than its `maxAge`, the token's oracle is paused, the oracle code differs, or the reads take over 2 seconds.
- `assetFeeds(WETH)` and `assetFeeds(MUSEGOD)` are empty. WETH is the default pair and MUSEGOD the default for Muse coins, so nearly every launch showed the warning.
- The oracle does hold sources for both: its immutable Chainlink ETH/USD feed (`ethUsdFeed`, updated 0.4 h before the read) and `quoteWethToMuse()`, a 30-minute MUSEGOD/WETH Uniswap TWAP.
- Mapped stock feeds stop at the market close: NVDA's feed was 43.6 h old on Sunday against a 24 h `maxAge`, so every mapped stock pair warned all weekend. USDG's feed (24 h heartbeat) was 22.2 h old.
- About 150 Robinhood stocks (`contracts/buyback.config.json` `unsupported`) and every Base asset have no independent feed at all.

Fix (advisory reference only; signing, pricing and the immutable oracle are unchanged):
- WETH: compare with the oracle's ETH/USD feed.
- MUSEGOD: compare with the oracle's MUSEGOD/WETH 30-minute TWAP times ETH/USD (`source: "TWAP"`).
- Mapped stock feeds (those that check the token's `oraclePaused`): a feed older than its `maxAge` is still the last close (`marketClosed: true`, and the divergence message says "last market close") when the market was open for at most `maxAge` since its update, counted over the 24/5 week (Sunday 20:00 to Friday 20:00 New York time, from Robinhood's "Stock feeds update 24/5, following market hours"), and the update is under four days old. A feed that stops while the market is open still warns. US market holidays are not modelled. Other feeds get a one-hour heartbeat grace over `maxAge`.
- No source for the asset (Base, unmapped stocks): no warning. The review's "Opening price reference" row says the price comes from LI.FI buy/sell quotes with no independent feed for that asset. The buy/sell spread check (`opening_spread`) is unchanged.
- A source that exists but cannot be read fresh (stale beyond its window, paused token oracle, changed oracle code, failed or slow reads) still warns. The read limit rises from 2 to 3 seconds.
- After a preview, the review's "Opening price reference" row names the reference and its distance from the opening price.

## Acceptance

- Tests: the info tips (button, text, `aria-describedby`) in the NFT review, no NFT earn band, the plain coin's band kept; `independentReference` for WETH, MUSEGOD, a mapped stock open and closed, an unmapped stock (no warning), a stale or paused feed, a changed oracle code and Base; the review's reference row.
- `docs/SPEC.md` updated; `npm test`, `npm run typecheck`, `npm run build`; codex cross-review accepts.
- Release only on the owner's word. The reference is computed inside a preview (`/launch/prepare`, a POST that saves a plan), and no GET path exposes it, so the server change is verified by tests; a live check needs the owner's own preview or their permission for a test preview. The info tips are checked in the read-only preview and on musegod.fun before a preview.

## Review

- Round 1 on `189d48a`: codex (gpt-6.1-sol, xhigh) 1 P2 + 4 P3; claude reviewer (xhigh) 6 P3, overlapping. P2: the four-day stock window applied on trading days too, hiding a mid-week feed outage as "last market close". P3s: a second tap left the tip visible (sticky touch hover), a hovered tip's Escape closed the dialog, the tip text could not be hovered, the hidden text widened the dialog at 320 px, a hidden tip swallowed Escape, an always-true test assertion, a browser-script exact-text locator, label height and a misplaced docstring.
- `a31a00d` fixed them (the claude reviewer's findings by claude in the same round, then verified by codex): 24/5 open-time aging for stock feeds; state-driven InfoTip with document listeners only while shown. Verified in the read-only preview (mock wallet, writes refused): hover over the text keeps the tip, the first Escape hides it with the dialog open, the second closes the dialog.
- Round 2: codex ACCEPT, one P3 (a committed regression test for historical recovery with the TWAP and a weekend stock), added afterwards. `npm test` 1848/1848, `npm run build` (with typecheck) passed. Reports are in the worktree's ignored `.superpowers/sdd/review-info-tips/`.

