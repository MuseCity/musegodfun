# One-click plain launch plan

Status: Implemented, in review; not released (the owner asked to see the change before releasing). Owner request 2026-10-19, relayed by the IP-page session (translated from Chinese): "for a launch with no first buy and no payment conversion, merge Simulate launch into Confirm launch so one click prepares, checks and opens the wallet; keep the separate preview for first buys and conversions; drop the predicted token address from the success banner." Branch `claude/plain-launch-one-click`, based on master `b9a0302`.

## Why it is safe

Confirm already checks everything before the wallet prompt. `wallet.launch` (`src/lib/wallet.tsx`) calls `/launch/validate`, may prepare a refreshed plan, runs `publicClient.call` and `estimateGas`, and `/launch/simulate` on the frozen data. For a plain launch the separate preview only added a click and the predicted token address.

## Changes (`src/App.tsx`)

- A launch without a first buy (a conversion always has one) shows one "Confirm launch · Sign in wallet" button. `confirmLaunch()` reuses a plan the wallet declined while more than 90 seconds of its signing window remain (so the wallet layer never refreshes it with its own prepare), otherwise prepares one with `simulate()`, then runs `launch(plan)`. A ref guard makes two clicks in one moment prepare once. Every existing guard stays: the generation and request checks, the intent lock, pending launch and payment recovery, the signing window, NFT refusals, errors shown in the review.
- A fresh plan with warnings stops before the wallet so they can be read; the next click reuses it. The review now shows the plan's own warnings (`plan.warnings`: the asset's and the opening price's; older plans fall back to the opening price's).
- A plain launch that failed without sending anything drops its plan, so the next click prepares a new one; a declined wallet prompt keeps it. Its errors say "Confirm again." instead of naming a preview.
- `simulate()` refuses while a sent launch is unresolved (`submissionUnknown` or the intent's submission marker), so no plan replaces the frozen backup recovery compares with; the plain Confirm is disabled meanwhile.
- Cost: opening the review no longer prepares a plain launch, an expired plain plan is never refreshed in the background, and the plain prepare opts out of the API helper's automatic 429/503 retries, so `/launch/prepare` (an expensive "workflow" ingress route) is asked at most once per click. Before, every plain review opened with a prepare and refreshed it while open.
- While it works the button reads "Preparing your launch…", then "Waiting for confirmation…"; it is disabled without the platform treasury, with writes off, on the wrong chain, or with a submitted launch.
- First buys and conversions keep their preview: it is prepared when the review opens and refreshed when it expires; its notice reads "First buy quoted" or "Payment and first buy quoted", without the predicted token address. The expired-preview notice and the LI.FI retry buttons ("Retry preview", "Choose another payment asset", "Use existing …", "Launch without a first buy") apply only to them.
- The bottom caption reads "The launch must be confirmed in your wallet within five minutes of being prepared." for a plain launch (the deadline is fixed when the plan is prepared, so a reused plan has less) and keeps "…once the preview is ready." for a first buy. The opening price reference row before a plan says "when your launch is prepared". The form's side hint no longer names a separate simulate step.
- Saved launches are unchanged: `simulate()` still saves the frozen plan before the wallet opens, and resuming an intent clears any plan.

## Acceptance

- `tests/launch-one-click.test.ts`: opening prepares nothing; one click prepares once and opens the wallet with that plan; a cancelled wallet reuses it; an expired plan is not refreshed in the background and the next click prepares again; a failed prepare opens no wallet and shows no first-buy retry buttons; Confirm is disabled with writes off or without a treasury. Mutation checks: removing either prepare gate fails the first test.
- `tests/launch-review.test.ts` updated: plain and Muse reviews prepare nothing on open; first-buy notices without the address.
- `scripts/test-launch-browser.mjs` (not runnable: Playwright is not a dependency) updated where plain and NFT cases waited for a prepare on opening.
- `docs/SPEC.md` updated; `npm test`, `npm run typecheck`, `npm run build`; codex cross-review accepts; the owner sees the change before any release.
