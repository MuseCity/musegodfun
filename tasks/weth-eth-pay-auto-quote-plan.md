# ETH payment on WETH pairs, automatic quotes and in-field Max

Status: E1–E4 implemented and cross-review accepted (2026-10-16); released with owner approval (see "Release and online acceptance"). Branch `claude/weth-eth-pay-auto-quote`, based on master `ef942a6`.

## Owner request (2026-10-16, translated)

"WETH pairs support paying with ETH. The user should not have to click the get on-chain quote button; the quote is requested automatically after the user enters a buy amount. The amount input gets a small Max button. Same process as before."

## Facts established before this plan

- Ordinary coin trades build one Universal Router `execute` call (`src/lib/protocol.ts` `swapTransaction`: command `0x10` V4_SWAP with actions SWAP_EXACT_IN_SINGLE, SETTLE_ALL, TAKE_ALL) after an ERC-20 approval to Permit2 and a Permit2 approval to the router (`src/lib/wallet.tsx` `trade`). Robinhood router `0x8876789976decbfcbbbe364623c63652db8c0904` uses the newer exact-input struct with `minHopPriceX36`.
- `ethBuyAvailable` (`src/lib/eth-buy.ts`) excludes WETH pairs because the ETH path for other pairs goes through LI.FI (`/trade/eth-quote`). A WETH-pair buyer must hold WETH today.
- Robinhood WETH is `0x0bd7d308f8e1639fab988df18a8011f41eacad73` (`wrappedEther(4663)`). Base has no WETH pairs.
- `/api/quote` is ingress class `workflow` (per-source concurrency 4, total 16) and is neither an "expensive" route nor challenge-gated. `/trade/eth-quote` is expensive (20/min per source) and triggers a Turnstile challenge above 16 risky requests a minute (`server/abuse.ts`).
- Wrapping is 1:1, so an ETH payment on a WETH pair has exactly the WETH quote from `/api/quote`, which needs no wallet.

## Goal

A buyer of a WETH-pair coin pays with ETH in one wallet confirmation; every buyer sees an up-to-date quote without pressing a quote button; Max is one tap inside the amount field and never spends the ETH needed for gas.

## Hard constraints

1. Funds safety for the new ETH-on-WETH-pair path:
   - one transaction to `contractsFor(config).router` on Robinhood (4663) only; the pool's quote currency must equal `wrappedEther(4663)`, otherwise the path is unavailable;
   - `value` equals the quoted `amountIn` exactly; minimum output comes from the quote and slippage exactly as `swapTransaction`; deadline as today (block time + 300 s);
   - no ERC-20 or Permit2 approval in this path;
   - simulate with the same `to`, `data` and `value` before sending; `ensureGas` covers `value` plus gas; never send an expired quote; keep the existing account/chain `live()` guards and progress, hash and receipt handling.
2. No server, contract, fee policy, LI.FI route, Permit2 path (pair payments), sell path or MUSEGOD execution change (E4 changes only the MUSEGOD panel's quoting and Max UI). E1 is Robinhood-only; Base trade execution is unchanged. E2 and E3 are token-page UI behavior and apply on both chains (conductor clarification 2026-10-16: the earlier wording "Base behavior is unchanged" conflicted with E2 "for every pay path" and must not leave Base on the manual quote button).
3. Automatic quotes must be bounded (cost and abuse limits above): debounced, superseded requests ignored, no requests while hidden, idle, busy or invalid, and a cap on automatic refreshes after the last user change.
4. Guests keep a price signal: automatic quotes work without a wallet for pair payments and for ETH on WETH pairs.
5. Everything from `tasks/detail-page-declutter-plan.md` that is not explicitly replaced here stays (presets, notes, fee card tiers, market honesty).
6. Old copy, state, buttons and branches made dead by this change are removed in the same change; the superseded "Get on-chain quote" constraint in the declutter plan gets a dated note.

## Items

### E1 ETH payment on WETH pairs (buy side, Robinhood)

- Pay-with control shows `ETH | WETH` on WETH pairs. The default is ETH for every visitor, guests included; an explicit pick wins as today.
- Quote: the same `/api/quote` request as WETH (amount entered in ETH, 18 decimals). Balance shown is the native ETH balance.
- Execution: a pure builder next to `swapTransaction` (for example `wrapAndSwapTransaction`) returning `{ to, data, value, minOut, currencyOut }`:
  - Universal Router commands `WRAP_ETH` (`0x0b`; recipient `ADDRESS_THIS`, amount = amountIn) then `V4_SWAP` (`0x10`);
  - V4 actions SWAP_EXACT_IN_SINGLE (same struct rules as `swapTransaction`), SETTLE (`0x0b`; currency WETH, amount = amountIn, payerIsUser = false), TAKE_ALL (`0x0f`; coin, minOut);
  - `value` = amountIn.
  Verify every command and action byte and parameter layout against the deployed Robinhood router's version, not from memory; the fork proof below is the authority.
- Wallet: a native-pay trade function (or a branch of `trade`) that skips balance-of-ERC20 and both approvals, checks the native balance, simulates with value, sends with value, and confirms like `trade`.
- Copy: Trading details for this path say the ETH is wrapped to WETH and swapped in one transaction with no approval. The LI.FI note and the router-approval note do not appear for this path.
- Sell side is unchanged (receives WETH).

### E2 Automatic quotes

- Remove the "Get on-chain quote" button for every pay path.
- When the amount parses to a positive value, request a quote 600 ms after the last change of amount, side, pay choice or slippage (1000 ms for the LI.FI ETH path). A newer input supersedes any pending request; superseded responses are ignored (keep the generation pattern).
- No request while the amount is empty, invalid or zero, while a trade is in progress, while pool state is unavailable or invalid, while the document is hidden, or (LI.FI path only) without a connected wallet, as today.
- The receive box shows an updating state while a quote is in flight and keeps showing errors as today. The newest quote failure has its own slot beside any other error: a quote request never replaces or hides behind an error the user has not acted on, and a new quote, an input change, Refresh or starting a trade clears it.
- Expiry: when the current quote expires and the page is visible, refresh automatically; at most 3 automatic refreshes after the last user change (1 for the LI.FI path). After the cap, the quote shows as expired with a small "Refresh quote" control, which is the only manual quote control left. Any user change resets the cap.
- The primary action stays disabled without a fresh quote, as today.
- Copy that tells users to "get a quote" is rewritten for automatic quotes.

### E3 Max inside the amount field

- A small "Max" button inside the pay amount field for buy and sell, shown only when a wallet balance for the input asset is known; the "Max" chip leaves the quick-amount row. Other presets are unchanged.
- ERC-20 input (pair asset or coin): Max = full balance.
- ETH input (WETH-pair native path and LI.FI path): Max = balance minus a gas reserve, reserve = max(0.0002 ETH, 2 × 500,000 gas × current `maxFeePerGas`, falling back to `gasPrice`). If the balance does not exceed the reserve, Max does not fill the field and says there is not enough ETH for network fees.
- Max follows the existing unit rules (switching side or pay choice still clears a typed amount). Confirming is unavailable while an ETH Max awaits network fees, and starting any trade discards a Max result that arrives late, so an active trade keeps its amount, progress and busy state until its own completion.

### E4 MUSEGOD trade panel (added 2026-10-16)

Owner request (translated): "Switch the MUSEGOD panel to automatic quotes too, and release it together."

- `src/components/MusegodTradePanel.tsx` loses its "Get on-chain quote" button and uses the same automatic quote scheduler as token pages (`src/lib/auto-quote.ts`, `src/lib/use-auto-quote.ts`): 600 ms debounce, superseded responses ignored, no requests while hidden, idle, busy, invalid, off the MUSEGOD network (`musegodNetwork`) or before the verification `info` has loaded. Quote previews stay available when `info.tradeEnabled` is false (writes paused or router verification pending), as before E4 and as the page copy promises; only confirming a trade requires `tradeEnabled` (conductor decision 2026-10-16 on C3-1); at most 3 automatic refreshes after the last user change, then the small "Refresh quote" control. `/api/musegod/quote` is ingress class `workflow` (not expensive, not challenge-gated); automatic calls must not trigger implicit retries.
- In-field Max like E3: buy pays native ETH (Max = balance minus the same gas reserve, insufficient case handled); sell pays MUSEGOD (Max = full balance). The quick row keeps 25/50/75% for sell and drops its Max chip. Confirm is disabled while Max awaits fees, and starting a trade discards a late Max result (the X2-1 lesson).
- After a confirmed trade the panel behaves like token pages (one re-quote for the same amount via Refresh semantics, then normal caps).
- Unchanged: MUSEGOD quote verification (block, block hash, router code hash), the SushiSwap execution path and approvals, wallet code, server.
- Copy that refers to a manual quote is updated; `scripts/test-nft-ui-browser.mjs` drops its MUSEGOD manual-button assertion in favor of automatic quote readiness.

## Out of scope

- Receiving ETH when selling on WETH pairs (unwrap); separate request if wanted.
- MUSEGOD's trade execution (E4 changes only its quoting and Max UI); Base trade execution (E1 is Robinhood-only); any server or abuse-limit change.

## Verification and acceptance

1. TDD: pure builder tests decode the generated calldata (commands, each input, action bytes, SETTLE payer flag, value, minOut, deadline) and reject non-WETH pools, non-Robinhood routers and zero/overflow amounts. Auto-quote scheduling (debounce, supersede, caps, hidden/busy/invalid gating, LI.FI timing) is tested with fake timers through an extracted hook or pure scheduler, not by restating the implementation. Max/reserve math is tested including the floor and the insufficient case.
2. Fork proof (authority for E1 calldata): on an anvil fork of Robinhood mainnet, a fresh funded account buys CLAWGOD (`0x7ea969d8c90C92c056949D561960Af2ACCd6E113`) with ETH using the exact transaction from the new builder, after a `/quote`-equivalent quote computed on the fork. Assert success, ETH spent = value + gas, CLAWGOD received ≥ minOut, zero WETH and ETH left in the router, no approvals made, and a revert when minOut is set above the achievable output. Save the evidence (no secrets). Use the repo's fork helpers (`scripts/robinhood-fork.ts`) and a worktree-local `.env.fork` holding only `ALCHEMY_API_KEY`, extracted in-process from the main `.env`, never printed, deleted afterwards. Keep RPC use small (one fork session, no log scans).
3. `npm test`, `npm run build`, `git diff --check`, Han scan.
4. Local read-only preview (same gateway rules as the declutter run; quote POST cap 12): CLAWGOD defaults to ETH for a guest; typing an amount produces exactly one quote request after the pause; the receive box fills without a button; Max is absent for guests; MV2C (COST pair) auto-quotes too; no "Get on-chain quote" anywhere; 1440px and 390px.
5. Cross review: claude review → codex fix → claude accept, then codex review → claude fix → codex accept.
6. Local commits only. Release needs the owner's explicit approval. No real-wallet trade is executed by any agent; after release the owner may run a tiny real ETH buy as a manual check.

## Delivery record

- 2026-10-16 Run 1, builder gate: added decoded-calldata tests and the native WETH builder; the isolated Robinhood fork proved an ETH buy, exact value plus gas accounting, no approvals, zero router dust and the expected high-minimum revert. Source runtime matched the deployed router. E1 wallet/UI and E2-E3 remain in progress. Evidence: `.superpowers/sdd/eth-pay-auto-quote/evidence/fork-proof.json`.

- 2026-10-16 Run 1, E1-E3: added the guarded native wallet path, ETH default for WETH pairs, guest quotes, bounded automatic scheduling and an in-field Max with the specified gas reserve. Updated disclosures and legacy browser selectors; the earlier guest-button constraint is explicitly superseded. Local tests/build and the four light-mode desktop/mobile checks passed; evidence and the per-commit report are in `.superpowers/sdd/eth-pay-auto-quote/`. Builder/fork commit: `02ac13f`; wallet/UI commit: `feat(trade): automate quotes and reserve gas for native Max`. Cross-review and release remain pending; no mainnet transaction, push or deployment.

- 2026-10-16 Run 2, C1-1 through C1-6: verified all six findings and fixed them with failing-first regression coverage. Manual Refresh can challenge while automatic LI.FI requests remain silent and stop after CHALLENGE_REQUIRED, including across input changes. E2-E3 now apply on Base as clarified above; E1 remains Robinhood-only. Extracted payment routing and quote-input derivation with explicit-WETH-pick and network/unit/busy tests. Automatic quotes preserve unacknowledged errors; expiry copy names Refresh; a confirmed trade offers one same-amount manual quote with the user-change refresh budget; market hints describe amount entry. Full tests: 1568 passed; build, diff check and Han scan passed. Chrome DevTools MCP checked CLAWGOD, MV2C and the catalog's hidden Base MUSEGOD/NVDAc token at 1440px light: one successful quote each, 3/8 quote POSTs total, no wallet or transaction. Preview stopped and port freed. Local fix commit: `fix(trade): resolve automatic quote review findings`. Report and evidence: `.superpowers/sdd/eth-pay-auto-quote/run2-report.md` and `evidence/run2/`. Run 1's Base exclusion is superseded by this run; cross-review acceptance and release remain pending.

- 2026-10-16 Run 4 (claude fix), X2-1, C1b-1, C1b-2: verified all three findings and fixed them with failing-first tests (red/green logs and per-mutation results in `.superpowers/sdd/eth-pay-auto-quote/evidence/claude-fix-r2/`). X2-1: the primary button is disabled while Max awaits fees, and starting a pair/native (`execute`) or LI.FI (`executeEth`) trade bumps the panel generation, so a late Max result is dropped; a panel-level regression with deferred fee estimation shows the active trade keeps its amount, progress and busy state on both paths. C1b-1: a stateful panel harness proves an explicit WETH pick pays through Permit2 (`wallet.trade`), and a real-hook test proves automatic refreshes resume after a post-trade Refresh. C1b-2: quote failures now live in their own slot beside any other error (newest wins; cleared by a new quote, input change, Refresh or trade start), and the scheduler clears the manual flag when the debounce starts so Refresh does not show after a trade plus an amount edit. No wrap-and-swap builder, wallet, LI.FI, Permit2, sell, server, contract or `MusegodTradePanel` change. Local fix commit: `fix(trade): keep active trades safe from late Max and tidy quote errors`. Codex acceptance and release remain pending.

### Cross-review closure (2026-10-16)

- Claude review round 1: C1-1–C1-6 (two P1: the manual LI.FI Refresh suppressed the Turnstile challenge; Base stayed on the manual quote button). Codex fixed them in `01efd8b`; claude accepted all six and raised C1b-1/C1b-2 (P3).
- Codex review round 2: X2-1 (P2, a late ETH Max result could clear an active trade's busy state). Claude fixed X2-1, C1b-1 and C1b-2 in `ccf2752`; codex accepted all three, including a replay of the X2-1 scenario and a guest browser recheck.
- Both verdicts are ACCEPT with no open findings (`.superpowers/sdd/eth-pay-auto-quote/review-state.md`). No reviewer found an issue in the E1 calldata, which both sides decoded independently against the deployed router source.
- Conductor rerun on `ccf2752`: `npm test` **1578/1578**, `npm run build`, `git diff --check` and the Han scan pass.
- Since the fork proof commit `02ac13f`, `src/lib/protocol.ts` (the wrap-and-swap builder) and `scripts/test-weth-eth-buy-fork.ts` are unchanged, so the fork proof covers the shipped calldata. The wallet wiring added later is covered by injected-dependency tests.
- Not verified: a real-wallet transaction (no agent signs). After release the owner may run a tiny ETH buy on CLAWGOD as the manual check.
- Local rollback: revert `ccf2752`, `01efd8b`, `dbd22b1`, `02ac13f` (newest first). After a release, the production rollback point is Worker `8172b151` (`ef942a6`).

### Run 6: E4 implementation (2026-10-16)

- Reused the existing automatic quote hook/scheduler, API no-retry option and Max math in the MUSEGOD panel. Added 600 ms guest quotes, network/info/visibility/input/trade gates, superseded-response rejection, three automatic expiry refreshes and explicit Refresh. Quote failures have their own newest-error slot; automatic requests preserve unrelated errors. Confirmation pauses automation until Refresh; an amount edit hides Refresh throughout the next debounce.
- Buy Max reserves native ETH for gas; sell Max fills the full MUSEGOD balance inside the amount field. Sell presets remain 25/50/75%. Fee loading disables confirmation, and the existing trade-start generation discards late Max results. Wallet revision updates refresh balances without clearing an active trade or confirmed receipt; account/network/input changes still reset the panel. Updated the legacy NFT browser fixture to wait for an automatic MUSEGOD quote.
- TDD: all 11 new actual-panel tests failed before implementation, then passed with the real hook, scheduler, API and quote validation plus injected wallet/fees/HTTP/visibility. Full suite: 1589/1589; build, fixture syntax check, diff check and changed-file Han scan pass. Existing large-bundle build warning remains.
- Chrome DevTools MCP checked the Robinhood MUSEGOD page as a guest at 1440px and 390px in light mode. Each settled buy input produced exactly one HTTP 200 quote (605 ms and 602 ms after the final input), filling receive/minimum/expiry. No manual quote button, guest Max or horizontal overflow; sell shows only 25/50/75%. Gateway totals: 2/4 MUSEGOD quote POSTs, zero other quote POSTs, six allowed read-only RPC POSTs, zero forbidden requests. Preview stopped, PID file removed and port 4178 rebound successfully; dependency symlink removed at handoff.
- Local implementation commit: `feat(trade): automate MUSEGOD quotes and add in-field Max`; includes the previously uncommitted E4 plan text. Report and evidence: `.superpowers/sdd/eth-pay-auto-quote/run6-report.md` and `evidence/run6/`. No server, wallet, execution, SushiSwap calldata or verification change; no new fork run, wallet connection, signing, mainnet transaction, push or deployment. E4 cross-review and release remain pending. Local rollback: revert this Run 6 implementation commit to restore parent `0e41028`.

### Run 7: E4 round-3 review fixes (2026-10-16)

- Verified and fixed C3-1, C3-2 and C3-3; none rejected. Automatic MUSEGOD previews and Refresh require loaded verification info rather than `tradeEnabled`, retaining the network, busy, visibility and valid-input gates. Confirmation and execution still require `tradeEnabled`. Included the conductor's existing C3-1 plan amendment above.
- Two failing-first actual-panel regressions cover paused writes and pending router verification: no request before info loads, one request after 600 ms, receive/minimum previews, three bounded expiry refreshes, enabled manual Refresh and no trade execution. The original implementation failed at the missing preview; fixing only automatic dispatch exposed the separately disabled Refresh control. Removed the unreferenced `.trade-quote` rule. Reworded exactly eight authorized client errors to name Refresh, updated the ETH-buy error fixture and strengthened existing MUSEGOD error assertions; all other bytes in those five client libraries are unchanged.
- Verification: targeted tests 45/45, full suite 1591/1591, typechecks/build, diff check and changed-file Han scan pass. Existing large-bundle build warning remains. Report: `.superpowers/sdd/eth-pay-auto-quote/run7-report.md`; red/green and scope evidence: `evidence/run7/`. No visible layout change, so no browser run; no fork rerun because execution and calldata are unchanged. No server, contract, launch-flow message or runtime-permission change; no real wallet, signing, mainnet transaction, push or deployment. Local fix commit: `fix(trade): keep paused MUSEGOD quote previews available`. E4 reviewer acceptance, reverse review and release remain pending. Local rollback: revert this Run 7 commit to restore parent `e993cfa`.

### E4 cross-review closure (2026-10-16)

- Codex implemented E4 in `e993cfa`. Claude review round 3 found C3-1 (P2: automatic MUSEGOD quotes were gated on `tradeEnabled`, hiding previews while writes are paused; caused by the plan wording, corrected by conductor decision), C3-2 and C3-3 (P3). Codex fixed them in `28ace9d`; claude accepted all three, with every one of 8 targeted mutations failing the tests.
- Codex review round 4 of E4: VERDICT ACCEPT with no findings, so no claude fix or codex acceptance step was needed.
- C3-3 changed only message strings. `ethBuyInvalid` is shared with `server/lifi.ts`, so the server's ETH-quote verification error now also says "Refresh the quote"; server code is unchanged.
- Conductor rerun on `28ace9d`: `npm test` **1591/1591**, `npm run build`, `git diff --check` and the Han scan pass. The builder and the fork script are still unchanged since the fork proof commit `02ac13f`; MUSEGOD execution diffs are message strings only.
