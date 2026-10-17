# Stable trade panel: no late "Pay with" row on token pages

Status: Run 1 implemented; full acceptance needs a scope decision and cross-review (2026-10-17). Branch `claude/pay-with-reserve`, based on master `7bdf276`.

## Owner request (2026-10-17, translated)

Do the follow-up "Reserve trade panel Pay-with row before config loads" in this session, with the usual process.

## Facts

- Live QA of release `7bdf276` (build-38996555896-1) measured an intermittent 32 px shift on CLAWGOD at 390 px dark theme: the chart frame top moved 1388 → 1420 px while its height stayed 260 px. In the single-column layout the trade panel sits above the market card.
- `src/App.tsx` (~3048): `ethPayable = side === "buy" && !!pairAsset && ethBuyAvailable(config)`. `ethBuyAvailable` (`src/lib/eth-buy.ts:21`) returns false while `config` is null, so the `<div className="pay-with">` row (~3416) is missing on first paint and appears when the config request resolves.
- Whether ETH payment is offered depends on the deployment chain (Robinhood 4663, including fork mode deployed for 4663), which the token record already carries when the trade panel first renders.

## Goal

The trade panel's layout is final at its first render: no row appears or disappears because the runtime config arrives later, on any viewport.

## Constraints

1. Payment behavior is unchanged once config is known: same availability rule, same defaults (`defaultPayWith`, frozen choice, WETH-pair ETH default), same routes, quotes, approvals and execution. No ETH option is ever offered where it is unavailable once config is known.
2. Decide the row's presence from data available at first render (the token's deployment chain/mode and the pair asset), equivalent to `ethBuyAvailable` for every supported config. If config later contradicts it (an anomalous mismatch), hide the row; document that this is the only remaining shift case.
3. While config is still loading, the row is visible but its buttons are disabled and marked busy, and nothing config-dependent (quotes, Max fee reads, execution) runs earlier than today.
4. Audit every other element above the market card in the narrow layout whose presence depends on asynchronous data (config, balances, wallet, stock status) and stabilize any that can shift the chart; list what you checked. Do not change copy beyond what stabilization requires.
5. No server, contract, wallet, quote-logic or dependency changes. English only.

## Acceptance

1. TDD: failing-first tests showing the row renders (disabled) before config on a Robinhood pair page, stays absent on sell and on chains or pairs without ETH payment, becomes interactive once config loads, and that payment state and defaults after config are identical to before.
2. `npm test`, `npm run build`, `git diff --check`, Han scan.
3. Local read-only preview with the config response artificially delayed by the gateway (about 3 s): CLAWGOD and MV2C at 390 px light and dark and at 1440 px. The chart frame top and the trade panel height are identical at first paint and after the config arrives. Network behavior is unchanged except for the delay.
4. Cross review: claude review → codex fix → claude accept, then codex review → claude fix → codex accept.
5. Local commits only. The release needs the owner's explicit approval, and the post-release check must probe the live layout at 390 px.

## Delivery record

### Run 1 - 2026-10-17

- First local implementation commit includes this previously untracked plan, `src/App.tsx`, `src/styles.css`, and `tests/pay-with-reserve.test.ts`. The exact commit is recorded in `.superpowers/sdd/pay-with/run1-report.md` after commit creation.
- Token deployment metadata reserves the buy-side payment row; the original config-dependent `ethPayable`, defaults, choice freezing, routes, reads, quotes and execution remain unchanged. Buttons are disabled and the row is busy until config arrives. A contradictory config hides the row; this is the remaining config-driven payment-row removal case.
- The quote-verification badge reserves its footprint before stock status. Stock pairs also reserve a 16 px share-equivalent line before multiplier/balance reads, retaining the slot when the default switches to ETH. Hidden reservations are excluded from accessibility output.
- TDD: payment-row/badge tests first failed 4/10; share-slot coverage then failed 1/14 and Robinhood multiplier coverage failed 1/15 before their fixes. Final focused suite: 57/57. Full `npm test`: 1804/1804; `npm run build` (including both typechecks), `git diff --check`, and the changed-file Han scan passed. The existing large-chunk build warning remains.
- Browser: chrome-devtools MCP, plain Vite with `envDir: false`, production GET gateway only, 3000 ms delay exclusively on chain config responses. CLAWGOD and MV2C were measured at 390 px light/dark and 1440 px light against `7bdf276`. All six base panels gained 56 px on config; all six fixed panels retained their initial height, with a disabled/busy row present before config and interactive after it. Config-only chart displacement is zero in all six fixed cases.
- Strict acceptance 3 is **not fully met**: MV2C's independent market-summary hydration moves the chart 291 px at 390 px and 173 px at 1440 px, reproduced on the unfixed base. That presentation belongs to `TokenMarket`, outside the run's allowed trade-panel rendering scope. No market, stream, quote, wallet or server behavior was changed to mask it. A scope decision is required before implementing that additional stabilization; runtime error/read-only/fork/wallet-recovery presentation also remains outside the guest mainnet browser evidence.
- The constraint-4 audit, before/after measurements, screenshots, request audit and test logs are in `.superpowers/sdd/pay-with/run1-report.md` and `evidence/run1/measurements-summary.json`. Final viewport screenshots avoid the temporary scrollbar reflow observed during exploratory full-page captures; raw exploratory evidence is retained separately as `probe-*`.
- Both preview processes stopped; ports 4190/4191 were released. Gateway audits recorded GET only, zero POSTs. No `.env`, push, deployment, wallet connection, signing or funds were used.
- Cross-review remains pending: claude review -> codex fix -> claude acceptance, then the reverse review. `review-state.md` records this handoff. Release and the owner's post-release 390 px check have not run.
