# Launch review dialog trim plan

Status: Released 2026-10-18 on the owner's word (see Release below). Approved by the owner on 2026-10-18 (translated from Chinese: "Agreed, implement this trimmed plan."). Branch `claude/eloquent-morse-877b44`, based on master `920219a` plus the record commit `63bed91`: `c65ccd4` (trim) and `1110d31` (review round 1 fixes).

## Background

The owner said the launch review dialog shows too much redundant information. A read-only look at the dialog (plain Vite preview, GET-only proxy to musegod.fun; a plain coin, and a first buy paid in USDG for a WETH pair) and a line-by-line read of `src/App.tsx` found the same facts repeated:

- The signing window five times: the bottom caption, the post-preview caption ("Set using LI.FI… five minutes"), the disclosure's "5-minute wallet window", and the conversion and first-buy expiry timestamps.
- The fee split four or five ways: the earn band's Buyback/Operations/Doppler line, and the disclosure's net distribution, nominal total fee, total allocation equivalents and platform income rows.
- Slippage three times (control, disclosure row, first-buy row); the opening valuation three times; the pair, the first-buy lock, the recipient and "fixed after launch" twice each.
- Two success notices after a preview, plus a three-step progress row whose state the buttons already show.
- Before a preview, the first buy amount appeared only inside the collapsed disclosure ("Launch cost").

## Goal

The dialog states each fact a person needs before signing once, in the place they look for it. Nothing the wallet will sign, no amount, fee, lock, irreversible effect or warning is lost.

## Hard constraints

1. Presentation, plus one client-side check. No change to server routes, plan contents, signing, approvals, fee policy or NFT rules.
2. Must stay: the number of wallet transactions and what is fixed after launch; name, symbol, pair and chain; the trading fee (SPEC: final confirmation shows the selected rate); the creator or NFT-treasury share; the first buy amount and lock; conversion input, guaranteed output, route fee and gas; estimated and minimum tokens, supply share, recipient and the approval amount; the five-minute window; "a completed conversion stays in your wallet"; "if the buy fails, the launch reverts"; every warning, error, expiry and reconfirmation notice; the slippage control.
3. The NFT block stays as it is (`tasks/nft-mode.md` Review): bound NFT, verified or unverified collection, the paid non-refundable $10, the fee rules, the vault and treasury addresses, and the disclaimer.
4. Copy, CSS and branches made dead by the trim are removed in the same change.

## Changes

| Before | After |
|---|---|
| "READY TO LAUNCH" eyebrow, "Permanent after launch" badge | Removed; the intro says what is fixed after launch, now including the pair, and that network gas is paid |
| Quote asset tile | Removed; the identity line reads "$SYM · PAIR pair · Chain" |
| Supply tile, "Doppler + Uniswap v4" | Moved into the disclosure |
| Earn band's Buyback/Operations/Doppler line | Removed from the band; the disclosure keeps one fee split row |
| Disclosure: net distribution, nominal total fee, total allocation equivalents | One "Trading fee split" row |
| Disclosure: initial valuation target, first buy slippage, launch cost | Removed (Opens at tile, slippage control, new First buy tile) |
| — | "First buy" tile: amount, pay asset and lock, or "None"; after a completed conversion, the received paired asset and the payment it came from |
| Progress row (Parameter check › preview › Wallet confirmation) | Removed |
| Preview success message and plan-result notice | One notice (`role="status"`): what passed, and the predicted token address; hidden once the preview or its payment quote expires |
| Post-preview caption "Set using LI.FI…", expiry timestamps, "5-minute wallet window" row | Removed; the bottom caption states the five-minute window once, and the disclosure keeps the LI.FI price reference |
| Conversion card: pay, estimated, minimum, route fee, gas, recipient, expiry, lock, three-sentence hint | Pay → guaranteed output; route fee ("No route fee" for an ETH wrap) and gas; a one-sentence hint |
| First-buy card: spend, approval, slippage, expiry, recipient and a five-sentence hint | Spend with its approval scope ("at least" the guaranteed minimum after a conversion); estimated, minimum, supply share, lock, recipient; a two-sentence hint keeping the fee waiver, the simulation after approval and the joint revert |
| Recipient shown in both cards | Shown once (first-buy card). The preview now refuses a conversion quote whose account is not the connected wallet. |

## Acceptance

- `tests/launch-review.test.ts` renders the real create page in the hook runtime: a plain coin, a first buy paid by conversion, a refused conversion quote for another account, and a Muse NFT coin. It checks each repeated fact appears once and every must-stay fact is present.
- `docs/SPEC.md` describes the review dialog's content.
- `npm test`, `npm run typecheck`, `npm run build` pass; codex (gpt-6.1-sol, xhigh) cross-review accepts.
- `scripts/test-launch-browser.mjs` (not run: playwright is not a dependency) is updated for the removed "Launch cost" review row.
- Release only on the owner's word.

## Review

- Round 1 on `c65ccd4`: codex (gpt-6.1-sol, xhigh) 2 P2 + 1 P3; claude reviewer (xhigh) 1 P2 + 5 P3, overlapping. The first-buy card had lost its fee waiver and simulation sentence; the success notice could sit beside an expired preview; the First buy tile showed the original payment after a completed conversion; a conversion's spend read as the guaranteed minimum; the notice had no `role="status"`; an ETH wrap showed "0 ETH route fee".
- `1110d31` fixed all of them (the claude reviewer's findings were fixed by claude in the same round, then verified by codex) and added tests for the wrap, expiry in a hidden tab and a completed conversion that waits for a changed minimum.
- Round 2: codex ACCEPT, no findings. `npm test` 1828/1828, `npm run build` (with typecheck) passed. Reports are in the worktree's ignored `.superpowers/sdd/launch-review-trim/`.
- Read-only preview (plain Vite, GET-only proxy): the dialog before a preview, at desktop and phone width. A preview needs a POST, so later states are covered by the tests only.

## Release

- 2026-10-18, on the owner's word (translated from Chinese: "Release it: push to master, then check musegod.fun live and delete the merged branch."). Master `6e6cc32` (`c65ccd4` + `1110d31` + `6e6cc32`, with the earlier record `63bed91`); CI run 39128499370, `build-39128499370-1`, Worker version `cc4d1972`; rollback point Worker `23914c13` (`920219a`). `build-info.json` on musegod.fun reports commit `6e6cc32`.
- Frontend only, so no Durable Object probe was needed.
- Live check on musegod.fun (built-in browser, no wallet, a fetch guard refusing every non-GET request): a plain coin shows the new intro, identity line, the three tiles with "First buy: None", one earn line, the eight disclosure rows and one five-minute caption; a 10 USDG first buy shows "10 USDG · no lock", the slippage control and the conversion caption. No write request was made, and the test draft was cleared. States after a preview need a wallet and a POST, so they rest on the tests.

