# Pre-Task-13 fixes — implementation plan

Owner request (2026-10-14, translated from Chinese): "Finish the 3 task cards first, then start Task 13."

These three issues were already on master. They were found while reviewing NFT mode and must be fixed before the Task 13 release.

The branch is `fix/pre-task13`, cut from master `ca61e57`.

## Global constraints

- Never read, load or print the real `.env`. Fork scripts load only `.env.fork` (`ALCHEMY_API_KEY`), through `node --env-file=.env.fork`.
- Never run `npm run dev`, because it writes the production database.
- No push, no merge, no mainnet transactions, no contract changes.
- Test first. Run `npm test` before every commit.
- Browser suites:
  - serve the built `dist` statically on 127.0.0.1:5191;
  - load Playwright via `PLAYWRIGHT_MODULE`;
  - run each suite alone.
- Fork runs share the production Alchemy key:
  - one fork per run, no parallel forks;
  - bounded `getLogs`;
  - stop on HTTP 429.

---

### Task A: close the `wallet_sendTransaction` signing-guard bypass

**Problem.** `src/lib/wallet.tsx` `signer()` wraps the EIP-1193 provider. At around line 443 it runs `validate()` (the client-side transaction allowlist) only for methods that match `/^(eth_sendTransaction|eth_sign|personal_sign|eth_signTypedData)/` or equal `wallet_sendCalls`. It calls `beforeSend` (the launch-fee "sending" record) only for `eth_sendTransaction`.

viem 2.56.8 `sendTransaction` (`node_modules/viem/_esm/actions/wallet/sendTransaction.js:118-150`) falls back to `wallet_sendTransaction` when `eth_sendTransaction` fails with `InvalidInputRpcError`, `InvalidParamsRpcError`, `MethodNotFoundRpcError` or `MethodNotSupportedRpcError`. It then caches that choice per client. On that path:
- `validate()` is skipped, so the allowlist is bypassed for every flow without a `guardRequest`;
- `beforeSend` is skipped, so a launch-fee payment can broadcast with no record, reopening the double-charge window.

**Fix.** Replace the regex with an explicit, fail-closed method policy:
- **Broadcast or sign:** `eth_sendTransaction`, `wallet_sendTransaction`, `eth_signTransaction`, `eth_sendRawTransaction`, `wallet_sendCalls`, `eth_sign`, `personal_sign`, and every `eth_signTypedData*`. These run `validate()` first.
- **`beforeSend`:** runs for every method that broadcasts a single transaction: `eth_sendTransaction` and `wallet_sendTransaction`.
- **Batched calls:** decide whether `wallet_sendCalls` should be refused outright. Check whether any flow uses it; if none does, refuse it.
- **Raw transactions:** `eth_sendRawTransaction` with a pre-signed payload cannot be validated by our allowlist. Refuse it unless a flow needs it.
- **Read and wallet-management methods** pass through unchanged: `eth_chainId`, `eth_accounts`, `eth_requestAccounts`, `eth_call`, `eth_estimateGas`, `eth_getTransactionCount`, `eth_blockNumber`, `eth_getBlockByNumber`, `wallet_switchEthereumChain`, `wallet_addEthereumChain`, and so on. List them explicitly.
- **Any other `eth_sign*`, `wallet_send*` or `*_signTransaction` method** not on either list is refused, so the policy fails closed.
- **Guard functions** that only accept `eth_sendTransaction` (the buyback guard around `wallet.tsx:162`) must accept `wallet_sendTransaction` with identical validation. Otherwise the fallback would break those flows instead of securing them. Check every `guardRequest` implementation.

**Tests** (`tests/wallet-signing-guard.test.ts`, or the existing wallet test file):
- each broadcast or sign method passes through `validate()`;
- a disallowed transaction is rejected on the `wallet_sendTransaction` path;
- `beforeSend` runs on both send methods;
- an unknown signing-like method is refused;
- read methods pass;
- a viem-level test drives `sendTransaction` against a custom transport whose `eth_sendTransaction` throws `MethodNotSupportedRpcError`, and asserts the fallback is validated and recorded.

**Commit:** `fix(wallet): validate and record every transaction-sending method, including wallet_sendTransaction`

---

### Task B: stop a second tab from overwriting a named draft with a blank one

**Problem.** The create page autosaves the draft about 250 ms after a change (`src/App.tsx` around lines 1350-1367) into intent-scoped localStorage (`launchIntentStorageKey(config, account, intentId, "draft")`). A second tab opened on `/create` before the first tab's write loads a blank draft for the same intent. Its own autosave can then replace the stored named draft with that blank draft. The `two_tabs` browser case hit this intermittently; the NFT branch masked it with a `waitForFunction` sync in `scripts/test-launch-browser.mjs` (around line 932).

**Fix.** Autosave must never replace a stored non-blank draft of the same intent with a blank draft that this tab did not load from storage.
- Track what this tab loaded: a revision, or the loaded payload.
- Before writing, re-read storage.
- If the stored draft is non-blank and this tab's draft is blank and was never loaded from it, do not write. Adopt the stored draft instead. Use the `storage` event for cross-tab freshness if that is the cleaner design.
- Also cover two non-blank tabs editing the same intent: the last writer wins today, which is acceptable, but document it.
- Reuse the existing `isPristineDraft` from `src/lib/draft-link.ts` for "blank".

**Tests:**
- unit tests of the write decision;
- remove the `waitForFunction` masking in `two_tabs`, add a browser case that opens two tabs inside the autosave window, and assert the named draft survives;
- run the case at least 10 times in a row to show it is stable.

**Commit:** `fix(create): never overwrite a stored named draft with a blank draft from another tab`

---

### Task C: repair `test:robinhood-fork` after the fee-engine cutover

**Problem.** `npm run test:robinhood-fork` (`scripts/test-robinhood-fork.ts`, via `scripts/run.ts`) has failed since the 2026-10-08 fee-engine cutover (`8d88123`). `server/service.ts` (around line 675) refuses Robinhood launches without a fee engine, and the script's fork runtime has none. The script also depends on LI.FI for the opening valuation.

**Fix:**
- Give the fork runtime the deployed fee engine through the production discovery and verification path (`feeEngineCandidate`, `verifyFeeEngine` in `server/service.ts`).
- Update the share expectations for the engine fee policy (`ENGINE_FEE_POLICY` in `src/lib/fee-policy.ts`).
- Replace the LI.FI opening valuation with a synthetic one on the fork, as `scripts/test-nft-launch-fork.ts` does.
- Load only `.env.fork`:
  - change the npm script to `node --env-file=.env.fork --import tsx scripts/test-robinhood-fork.ts`, so it never loads the real `.env`;
  - supply any other env as throwaway values generated in-process.
- Keep the per-field `assert.equal` repair from the NFT branch.
- Write evidence to `docs/evidence/robinhood-fork.json` with no secrets, or update the file it already writes.

**Run:** `npm run test:robinhood-fork`. Expected: PASS on a local Anvil fork, with one fork.

**Commit:** `test: repair the Robinhood launch fork test for the fee engine`

---

## Done when
- All three tasks are reviewed.
- `npm test`, `npm run build`, both browser suites, `test:robinhood-fork`, `test:nft-launch-fork` and `test:nft-vault-fork` all pass.
- The branch is fast-forwarded into local master (not pushed).
- `tasks/nft-mode.md` §11 no longer lists `test:robinhood-fork` as a known failure.
