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

## Follow-up: pair badge text, contract copy, NFT badge height

Owner request 2026-10-19 after the first release (translated from Chinese): "'Verified quote asset: Coinbase' should become 'Paired with COIN', and the 'COIN pair' below should go. Right of 'by 0xc8b1…056b' add a copy icon that copies on click. 'Muse #610' sits noticeably higher than 'Liquidity locked'." Asked what the icon copies, the owner chose the token contract address.

Change (`b621092`):
- The pair badge reads `Paired with <symbol>` and is the hero's only mention of the pair. It is green with a check mark and the hover title "Verified quote asset: <name> (<symbol>)" once `/stocks` reports the asset verified and the pool passes the on-chain check, and a plain sunken chip otherwise (loading, unverified, invalid pool), so the pair never disappears. The visually hidden "Verified quote asset:" prefix is gone, so assistive technology reads the visible text.
- "<symbol> pair" leaves the overline (`<chain> · launched <date>`) and the NFT coin's meta line (`launched <date>`). The trade card's "<symbol> pair" pill is unchanged.
- `CopyContractButton` (`src/components/TokenHero.tsx`): a 24 px icon button right of the creator that copies the coin's contract address, shows a check for two seconds, and shows "Copy failed. Copy the address from the On-chain tab." when the clipboard refuses or is missing.
- On the title line the NFT badge is centred and 24 px tall with 10 px padding, matching `.chip.sm`; the unverified-collection warning variant keeps its own padding.

Verification:
- `tests/token-ip-page.test.ts`: the overline and hero have no "WETH pair"; the copy button follows the creator link with the contract in its title; the pair badge is plain before the status loads, unverified or invalid, and green for verified coins and NFT coins; the copy button copies the address, clears its confirmation after two seconds (mocked timers), and reports a rejected or missing clipboard.
- `npm run typecheck` passed; `npm test` 1866/1866.
- Read-only preview against production data: on Phial the three badges measure 24 px with the same top, and the meta row stays 16 px tall; MuseVader (a non-NFT coin) reads "Robinhood Chain · Launched Oct 13, 2026" with "Paired with MUSEGOD"; the 375 px layout wraps cleanly. The preview pane denies `clipboard-write` to every page (the live Fomo copy button fails there too), so the success path was checked with an in-page stand-in clipboard: it received `0x808C07de6dB60091b44D2Ed0e0f19FC2644A884a`, the icon became a check and the label returned after two seconds.

Release:

- 2026-10-19, on the owner's word: "Release b621092 to production: push to master, verify the live page, record the release and clean up the branch." Master fast-forwarded `4d7729b` → `b621092` (carrying the first release record `8726857`); CI run 39199789294, `build-39199789294-1`, Worker version `7edc6d12`, deployed 04:32:54 UTC; rollback point Worker `ce1c832a` (`4d7729b`). `build-info.json` on musegod.fun reports commit `b621092`. Frontend only, so no Durable Object probe.
- Live check on musegod.fun (built-in browser, no wallet) on the Phial page: overline "Muse #610 · Phial · Robinhood Chain", badges "Paired with COIN" (green, check), "Liquidity locked" and "Muse #610" all 24 px with the same top, no "COIN pair" and no agent badge in the hero; the meta reads "by 0xc8b1…056b", the copy button (title "Copy contract address 0x808C07de6dB60091b44D2Ed0e0f19FC2644A884a"), "launched Oct 19, 2026" and the fee. A real clipboard write could not be exercised in the built-in browser, which denies `clipboard-write`.

## Correction: the contract address is the hero's first line

Owner correction 2026-10-19 after the second release (translated from Chinese): "That was wrong: no copy icon after 'by 0xc8b1…056b'. Change the top line 'Muse #610 · Phial · Robinhood Chain' to the token contract address, followed by a copy icon."

Change (`fa8a3df`):
- `HeroContract` (`src/components/TokenHero.tsx`, replacing `CopyContractButton`) renders the hero's first line for every coin: the contract address in mono at full contrast, then the copy icon. On a narrow line the address shortens from the middle (the part before the last four characters ellipsizes), so the button never wraps; the DOM, the title and the copy always carry the full address. A refused clipboard now says "Copy failed. Select the address and copy it manually."
- The creator in the meta line has no copy button. The launch date, previously in the overline for coins without an NFT, is in the meta line for every coin.
- The old overline content leaves the hero: the chain label (`chainLabel` removed) and, for an NFT coin, "Muse #<id> · <name>". The Muse name stays in About and the On-chain NFT rows; the "Muse #<id>" badge stays on the title line.

Verification:
- `tests/token-ip-page.test.ts`: the identity column starts with the contract line and its copy button; the hero has no chain, pair or Muse-name text; the meta line is "by <creator>" then "launched <date>" with no button; the NFT coin's first line is its contract and About still names "Muse #931 · Jubilee"; the copy test now targets `HeroContract`.
- `npm run typecheck` passed; `npm test` 1866/1866.
- Read-only preview against production data: at desktop width Phial's first line is the full `0x808C07de6dB60091b44D2Ed0e0f19FC2644A884a` with the icon, and the hero has one copy button; with a stand-in clipboard one click copied the full address and showed a check. At 375 px the line stays one 16 px row, the address ellipsizes in the middle ending "884a", and the page has no horizontal overflow.

Release:

- 2026-10-19, on the owner's word: "Release fa8a3df to production: push to master, verify the live page, record the release and clean up the branch." Master fast-forwarded `b621092` → `fa8a3df` (carrying the second release record `0e83076`); CI run 39203140278, `build-39203140278-1`, Worker version `e955610d`, deployed 05:13:48 UTC; rollback point Worker `7edc6d12` (`b621092`). `build-info.json` on musegod.fun reports commit `fa8a3df`. Frontend only, so no Durable Object probe.
- Live check on musegod.fun (built-in browser, no wallet) on the Phial page: the identity column starts with the contract line `0x808C07de6dB60091b44D2Ed0e0f19FC2644A884a` and its copy icon, the hero has exactly one copy button and none in the meta line, the meta reads "by 0xc8b1…056b", "launched Oct 19, 2026" and the fee, the old "Muse #610 · Phial · Robinhood Chain" line is gone, and About still says "Whoever holds Muse #610 · Phial". A real clipboard write could not be exercised in the built-in browser, which denies `clipboard-write`.
