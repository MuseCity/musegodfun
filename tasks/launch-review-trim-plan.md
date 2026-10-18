# Launch review dialog trim plan

Status: Approved by the owner on 2026-10-18 (translated from Chinese: "Agreed, implement this trimmed plan."). Branch `claude/eloquent-morse-877b44`, based on master `920219a` plus the record commit `63bed91`.

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
| — | "First buy" tile: amount, pay asset and lock, or "None" |
| Progress row (Parameter check › preview › Wallet confirmation) | Removed |
| Preview success message and plan-result notice | One notice: what passed, and the predicted token address |
| Post-preview caption "Set using LI.FI…", expiry timestamps, "5-minute wallet window" row | Removed; the bottom caption states the five-minute window once, and the disclosure keeps the LI.FI price reference |
| Conversion card: pay, estimated, minimum, route fee, gas, recipient, expiry, lock, three-sentence hint | Pay → guaranteed output; route fee and gas; a one-sentence hint |
| First-buy card: spend, approval, slippage, expiry, recipient and a five-sentence hint | Spend with its approval scope; estimated, minimum, supply share, lock, recipient; a one-sentence hint |
| Recipient shown in both cards | Shown once (first-buy card). The preview now refuses a conversion quote whose account is not the connected wallet. |

## Acceptance

- `tests/launch-review.test.ts` renders the real create page in the hook runtime: a plain coin, a first buy paid by conversion, a refused conversion quote for another account, and a Muse NFT coin. It checks each repeated fact appears once and every must-stay fact is present.
- `docs/SPEC.md` describes the review dialog's content.
- `npm test`, `npm run typecheck`, `npm run build` pass; codex (gpt-6.1-sol, xhigh) cross-review accepts.
- `scripts/test-launch-browser.mjs` (not run: playwright is not a dependency) is updated for the removed "Launch cost" review row.
- Release only on the owner's word.
