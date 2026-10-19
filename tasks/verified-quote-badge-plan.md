# Verified quote badge plan

Status: Released 2026-10-19 on the owner's word (see Release below). Owner request 2026-10-19 (translated from Chinese), looking at the Phial coin page `/token/robinhood/0x808C07de6dB60091b44D2Ed0e0f19FC2644A884a`: "Verified quote asset can show the paired asset's name directly; 'ERC-8004 agent #7201' can go."

## Change

- The token hero's verified badge shows the paired asset's name with its check mark (for example "Coinbase" for a COIN pair). The meaning stays available: the badge's `title` is "Verified quote asset: <name> (<symbol>)" and screen readers hear a visually hidden "Verified quote asset:" prefix. It still appears only when `/stocks` reports the asset as verified and the pool passes the on-chain check.
- The hero no longer has an `ERC-8004 agent #<id>` badge. The agent id stays in the Agent identity card on Overview (Agent ID, identity registry, ERC-8217 binding, controller).
- `docs/SPEC.md` (token page, Hero) describes the new badges.

## Verification

- `tests/token-ip-page.test.ts`: a new test checks that the badge names the asset only once the status says verified, and never for an unverified asset or a pool that fails the on-chain check; the NFT agent test checks that the hero has no agent badge while the Agent identity card keeps `#<id>`. Both fail on the previous code.
- `npm run typecheck` passed; `npm test` 1865/1865.
- Read-only preview against production data (GET and chain RPC reads only): the Phial hero shows "✓ Coinbase", "Liquidity locked" and "Muse #610" on one line at desktop width, with no agent badge; the Agent identity card still shows `#7201`; the 375 px layout wraps cleanly.

## Release

- 2026-10-19, on the owner's word: "Release 4d7729b to production: merge into master, push, then verify the live page and record the release." Master fast-forwarded `e20c019` → `4d7729b` (carrying the earlier plain-launch release record `342f89c`); CI run 39195788965, `build-39195788965-1`, Worker version `ce1c832a`, deployed 03:43:41 UTC; rollback point Worker `0b118a25` (`e20c019`). `build-info.json` on musegod.fun reports commit `4d7729b`.
- Frontend-only change, so no Durable Object behavior probe. `/api/chains/{4663,8453}/readyz` report `ready` with `maintenance.since` 03:44:31 and 03:44:40 UTC.
- Live check on musegod.fun (built-in browser, no wallet) on the Phial page: the hero shows "✓ Coinbase" with the title "Verified quote asset: Coinbase (COIN)", no `ERC-8004 agent` badge, and the Agent identity card still shows Agent ID `#7201`.
