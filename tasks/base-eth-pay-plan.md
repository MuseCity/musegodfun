# Base parity, part 1: "Pay with ETH" coin buys on Base

Status: done locally (2026-10-17): implemented by codex, cross-reviewed to convergence and committed on branch `claude/base-eth-pay`, based on local master `49d54aa` (released `fc3c531` plus its docs record). Not released; not fork-verified on Base. Development by codex (`gpt-6.1-sol`, reasoning `xhigh`); claude writes the spec, drives the tasks, reviews every diff and runs verification and the cross review. Local commits only; the release is the owner's master push.

## Owner request (2026-10-17, translated)

Close the one trading-level gap between Base and Robinhood Chain: coin buys paid with native ETH. NFT mode on Base was asked for and then withdrawn for now; it is out of scope. Fork evidence is skipped this round (no `.env.fork`); the owner runs fork gates before a release if wanted.

## Facts (master `49d54aa`)

- Robinhood coin buys offer ETH in three routes: `native` wrap-and-swap through the Universal Router for a WETH pair, `lifi` (direct ETH → coin, or two steps ETH → pair → coin) for other pairs, `permit2` otherwise. The lock to chain 4663 is `ETH_BUY_CHAIN` in `src/lib/first-buy-payment.ts:187` and its users: `ethBuyCoin`, `assertEthBuyQuote`, `ethBuyAvailable` and the conversion check in `src/lib/eth-buy.ts`, `useEthBuyRecord`, `quoteEthBuy` in `server/eth-buy.ts`; plus `tradeRoute` (`src/lib/token-trade.ts`), `wrapAndSwapTransaction` (`src/lib/protocol.ts:389-403`) and `executeWethEthTrade` (`src/lib/weth-eth-trade.ts:13`).
- Base already has the pieces: `CONTRACTS.router` (Universal Router `0x6ff5…b43`), `permit2`, `poolManager`, `quoter`; `wrappedEther(8453)` = `0x4200…0006`; the per-chain LI.FI reader with the Base diamond whitelist checks is live for Base first-buy ETH payments. The Universal Router command bytes (`0x0b10`; actions `0x060b0f`) are the same contract family on both chains and are Sourcify-bound by the Robinhood fork test.
- `/api/trade/eth-quote` already passes the runtime's deployment chain. Tests pinning the old behavior: `tests/eth-buy.test.ts` (Base refused), `tests/weth-eth-trade.test.ts` (Base config refused), `tests/token-trade.test.ts` (Base = permit2 only), `tests/pay-with-reserve.test.ts` ("Base and Base forks never reserve an ETH payment row").
- Live Base lists one hidden B20-paired coin and no WETH-paired coin, so the feature becomes visible on future Base launches; the LI.FI two-step route is what a buyer would hit first.

## Goal

A Base coin page offers exactly Robinhood's "Pay with ETH" buy: the same three routes, the same quote strictness, the same wallet guards, the same two-step recovery record and the same row and copy, naming the chain correctly. Robinhood behavior is unchanged; fork mode stays excluded.

## Constraints

1. Replace the single-chain constant with `ETH_BUY_CHAINS = [4663, 8453]` and a guard; every caller compares the quote's chain with the page's deployment chain, so a 4663 quote is never accepted on an 8453 page and vice versa. Reserved addresses for the coin check come from that chain's registry and stable list (Robinhood stocks reserved on 4663, Base `STOCKS` on 8453).
2. `wrapAndSwapTransaction` accepts 4663 and 8453 with the router of `contractsFor` for that chain and `wrappedEther(chainId)` as the input; `executeWethEthTrade` requires a non-fork config whose wallet chain equals its deployment chain.
3. `quoteEthBuy` refuses only when the chain is not an ETH-buy chain or the runtime has no LI.FI configuration; `ETH_BUY_NOT_NEEDED` uses the chain's WETH.
4. Copy names the chain through `networkName(config)`; no "Robinhood" left in chain-neutral ETH-buy strings. Reuse `contractsFor`, `deploymentChain`, `networkName`, `wrappedEther`, `FIRST_BUY_PAYMENT_CONTRACTS`, `STABLE_ASSETS`, `assertLifiSwap`, the LI.FI executor and `executeEthBuy`; no new dependencies.
5. No change to quotes, slippage presets, fee policy, rate limits, signing controls, NFT mode or fork scripts. English only in committed files.

## Acceptance

1. TDD: tests fail first, then pass: Base server quotes (direct, two-step, `ETH_BUY_NOT_NEEDED` for a WETH pair, the HTTP matrix on 8453 with the Base diamond whitelist mocked), a 4663 quote refused on an 8453 page, `executeWethEthTrade` on Base (builder called with `CONTRACTS` and 8453; fork and wrong wallet chain refused), `tradeRoute` on Base (`native`/`lifi`/`permit2`), Base pair pages reserving the row (forks never), and `wrapAndSwapTransaction` on 8453 (router, value, WETH, identical bytes; wrong router or input refused). Existing Robinhood cases unchanged.
2. `npm test`, `npm run build`, `git diff --check`, Han scan pass.
3. Docs: `docs/SPEC.md` and `README.md` describe ETH buys on both chains. `public/skill.md` is the agent skill for NFT-mode launches (Robinhood only) and does not describe coin trading, so it is unchanged; `tests/skill-doc.test.ts` stays green. Release smoke gets the Base ETH-quote probe only if a Robinhood one exists (none does, so `scripts/release.ts` is unchanged).
4. Cross review: codex review → claude fix → codex accept, then claude review → codex fix → claude accept.
5. Read-only preview: a Base coin page renders the "Pay with" row for a buy and sends its quote to `/api/chains/8453/trade/eth-quote`.
6. Not verified this round: Base fork wrap-and-swap or LI.FI execution (owner's pre-release gate), real-wallet buys.

## Delivery record

### Run 1 (2026-10-17): codex implementation under claude review

- codex task 1 (gpt-6.1-sol, xhigh), tests first: 19 of 99 targeted tests failed before the implementation (Base refusals, routes, the payment row, the record hook, cross-chain checks) and all passed after it. `ETH_BUY_CHAIN` became `ETH_BUY_CHAINS` with `isEthBuyChain`; `ethBuyCoin`/`assertEthBuyQuote` take the page's chain and reserve that chain's payment contracts, WETH, stables and stock list; `assertEthBuyResponse`/`assertConversion` bind quotes to the page chain; `tradeRoute`, `wrapAndSwapTransaction` (router of `contractsFor` for the chain, chain WETH, identical command bytes), `executeWethEthTrade`, `useEthBuyRecord` and `quoteEthBuy` accept both chains; the wallet adapter's `lifiTrade` and the token page's asset objects no longer hard-code 4663. Robinhood mainnet behavior is unchanged; Robinhood local forks no longer show the ETH payment row (they never could execute it).
- codex task 2: `docs/SPEC.md` (Pay with ETH on both chains, chain-bound quotes, forks excluded, unverified items) and `README.md`; `scripts/release.ts` unchanged (no Robinhood ETH-quote smoke exists). Its edit to `public/skill.md` was reverted by claude: that file is the NFT-launch agent skill (Robinhood only) and does not describe coin trading.
- Claude review of task 1: design matches the spec; the extra `wallet.tsx` chain binding is a welcome defense; test expectations (`pay-with-reserve`, `robinhood-router`, `token-trade-panel`) are sound.
- Read-only preview (plain Vite, GET-only proxy to production): `/token/base/0x79eA…E670` renders the "Pay with" row (ETH / NVDAc) once config loads, selecting ETH and typing an amount shows the LI.FI route hint and the connect-wallet quote hint; no quote is sent without a wallet, as on Robinhood.

### Cross review

- codex review 1: P1, fork exclusion covered only the client (the server quoted for fork runtimes and the record hook keyed forks); P2, `public/skill.md` documentation. Claude fix: `quoteEthBuy` takes the runtime `mode` and refuses forks before any token or LI.FI read; the hook keys on `ethBuyAvailable(config)`; the HTTP fixture now builds mainnet runtimes for the success matrix plus fork-runtime cases proving 422 `ETH_BUY_UNAVAILABLE` on both chains without reaching LI.FI; the hook test proves a fork config has no record and its guard rejects. P2 declined for the scope reason above.
- codex acceptance: ACCEPT, with one P3 (this spec's docs item had listed `public/skill.md` unconditionally); the item is now conditional.
- Claude reverse review: no P0/P1/P2; one P3, inconsistent "unavailable" copy. codex fixer: the hook and the server now name the network through `networkName` ("… unavailable on Base.", "… on Robinhood Chain local fork.", with "this network" as the hook's null-config fallback); tests adjusted. Claude acceptance: 134/134 targeted tests, `npm run typecheck`, `git diff --check` and the Han scan pass. The cross review has converged.
- Final verification: `npm test` 1871/1871, `npm run build` (both typechecks and Vite; the existing chunk-size warning remains), `git diff --check` and the changed-file Han scan pass. Committed locally; not pushed.
