import assert from 'node:assert/strict';
import { writeFile, mkdir } from 'node:fs/promises';
import { DopplerSDK, computePoolId, airlockAbi } from '@whetstone-research/doppler-sdk/evm';
import { createPublicClient, http, decodeFunctionData, encodeAbiParameters, encodeEventTopics, encodeFunctionData, erc20Abi, keccak256, parseUnits, toHex, zeroAddress } from 'viem';
import { ROBINHOOD_STOCKS, ROBINHOOD_CONTRACTS, ROBINHOOD_BUNDLER, SUPPLY } from '../src/lib/config.ts';
import { CURVE_POLICY } from '../src/lib/launch-curve.ts';
import { syntheticOpeningValuation } from '../tests/fixtures.ts';
import { FEE_POLICY } from '../src/lib/fee-policy.ts';
import { launchGuardAbi } from '../src/lib/launch-guard.ts';
import { buildLaunch } from '../src/lib/protocol.ts';
import { serializePrepared } from '../src/lib/launch-plan.ts';
import { createDirectWrapQuote, firstBuyPaymentAssets, firstBuyPaymentInput, firstBuyReceiptOutput, wrapAbi } from '../src/lib/first-buy-payment.ts';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const origin = process.env.BROWSER_ORIGIN || 'http://127.0.0.1:5191';
assert(['127.0.0.1', 'localhost'].includes(new URL(origin).hostname), 'Browser acceptance must target a local server');
const creator = '0x1111111111111111111111111111111111111111', treasury = '0x2222222222222222222222222222222222222222';
const guard = '0x3333333333333333333333333333333333333333', token = '0x4444444444444444444444444444444444444444';
const quote = ROBINHOOD_STOCKS.find(x => x.symbol === 'WETH');
const contracts = ROBINHOOD_CONTRACTS;
const blockHash = '0x' + 'bb'.repeat(32), out = 543327925691014316198420n;
const wrapRuntime = '0x60006000'; // Local identity fixture, never a deployed-runtime claim.
const delayedImage = 'https://example.com/delayed-config.png';
const plainModes = new Set(['plain', 'idle_plain', 'unknown_send', 'unknown_fetch', 'launch_timeout', 'launch_marker_race', 'token_detail_pending', 'token_detail_error', 'token_detail_state_unavailable', 'token_detail_unregistered_backup', 'token_detail_invalid_pool', 'token_detail_unverified_opening', 'history_track_backoff']);
const quoteClockModes = new Set(['wrap_near_expiry', 'idle_review', 'hidden_review', 'idle_plain', 'history_track_backoff']);
const tokenLookupModes = new Set(['token_detail_pending', 'token_detail_error', 'token_detail_state_unavailable', 'token_detail_unregistered_backup', 'token_detail_invalid_pool', 'token_detail_unverified_opening']);
const timeoutModes = new Set(['approval_timeout', 'payment_timeout', 'launch_timeout', 'approval_timeout_reject']);
const recoveryRaceModes = new Set(['payment_marker_race', 'launch_marker_race', 'payment_status_race', 'payment_submit_race', 'payment_submit_record_race']);
const sdk = new DopplerSDK({ chainId: 4663, publicClient: createPublicClient({ transport: http('http://127.0.0.1:1') }) });
const config = { mode: 'fork', chainId: 31337, deploymentChainId: 4663, treasury, writesEnabled: true, blockReason: null, curvePolicy: CURVE_POLICY, launchGuard: guard, launchLockAvailable: false };
const report = { scope: 'Local Chromium UI with injected mock wallet/API/RPC and reference-price fixtures, scoped to Robinhood fork and No lock. Cross-tab checks use separate browser pages sharing one origin and storage. No real-wallet, conversion or chain settlement proof.', observedAt: new Date().toISOString(), origin, checks: [], screenshots: [], productionPublication: 'not_run' };
const browser = await chromium.launch({ headless: true });
let activePage;
await mkdir('.cache', { recursive: true });
async function waitForFixture(predicate, label) {
  const deadline = Date.now() + 30_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${label}`);
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}
function preparedPlan(draft, buy, run, options = {}, creator = '0x1111111111111111111111111111111111111111', expected = out) {
  const now = Date.now(), openingValuation = syntheticOpeningValuation(draft.quoteAddress, '3000',
    { chainId: 4663, quotedAt: now, sourceUpdatedAt: now, blockNumber: '16', blockHash });
  const params = sdk.factory.encodeCreateMulticurveParams(buildLaunch(sdk, draft, creator, treasury, treasury, openingValuation, keccak256(toHex(options.intentId || `browser-${run}`)), 4663));
  assert.equal(buy?.lockDays ?? 0, 0, 'This fixture only covers No lock');
  const amountIn = parseUnits(buy?.amount || '0', quote.decimals);
  const poolKey = { currency0: token, currency1: draft.quoteAddress, fee: 8388608, tickSpacing: 10, hooks: contracts.initializer };
  const poolId = computePoolId(poolKey), deadline = Math.floor((now + 300000) / 1000);
  const freshMinimum = expected * BigInt(10000 - (buy?.slippageBps || 100)) / 10000n;
  const acceptedMinimum = BigInt((options.reconfirmPrice ? options.reconfirmedMinimumOut : options.acceptedMinAmountOut) ?? freshMinimum);
  const min = freshMinimum > acceptedMinimum ? freshMinimum : acceptedMinimum;
  const transaction = amountIn ? { to: guard, data: encodeFunctionData({ abi: launchGuardAbi, functionName: 'createAndBuy', args: [params, amountIn, min, BigInt(deadline)] }), value: 0n }
    : { to: contracts.airlock, data: encodeFunctionData({ abi: airlockAbi, functionName: 'create', args: [params] }), value: 0n };
  const approvalTransaction = amountIn ? { to: draft.quoteAddress, data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [guard, amountIn] }), value: 0n } : undefined;
  const prepared = { chainId: 4663, account: creator, airlock: contracts.airlock, createParams: params, prediction: { tokenAddress: token, poolOrHookAddress: token, governanceAddress: treasury, timelockAddress: treasury, poolKey, poolId, tokenIsCurrency0: true }, transaction, approvalTransaction,
    devBuy: amountIn ? { exactAmountIn: amountIn, recipient: creator, vesting: { permissionlessClaim: false, cliffDuration: 0n, vestingDuration: 0n }, bundler: ROBINHOOD_BUNDLER, simulatedAmountOut: expected } : undefined, gasEstimate: { status: 'unavailable' } };
  return { id: keccak256(transaction.data), creator, data: transaction.data, tokenAddress: token, poolId, draft, preparedAt: now, finalizedAt: now, signingExpiresAt: now + 300000, serverTime: now, validityVersion: 2, intentId: options.intentId, gas: null, openingValuation, feePolicy: FEE_POLICY, feeTreasury: treasury, curvePolicy: CURVE_POLICY, prepared: serializePrepared(prepared), transaction: { ...transaction, value: '0' },
    requiresReconfirmation: !!amountIn && expected < min,
    firstBuy: amountIn ? { amount: buy.amount, amountIn: amountIn.toString(), expectedAmountOut: expected.toString(), minAmountOut: min.toString(), acceptedMinAmountOut: acceptedMinimum.toString(), slippageBps: buy.slippageBps, lockDays: 0, deadline, recipient: creator, quoteAddress: draft.quoteAddress, guard, bundler: ROBINHOOD_BUNDLER } : undefined,
    approval: amountIn ? { token: draft.quoteAddress, spender: guard, amount: amountIn.toString(), required: true, transaction: { ...approvalTransaction, value: '0' } } : undefined };
}
function block() { return { number: '0x20', hash: blockHash, parentHash: blockHash, timestamp: toHex(Math.floor(Date.now()/1000)), gasLimit: '0x5f5e100', gasUsed: '0x0', baseFeePerGas: '0x1', difficulty: '0x0', totalDifficulty: '0x0', size: '0x0', extraData: '0x', logsBloom: '0x'+'00'.repeat(256), transactions: [] }; }
function depositLogs(sent) {
  return [{ address: quote.address, topics: encodeEventTopics({ abi: wrapAbi, eventName: 'Deposit', args: { dst: creator } }),
    data: encodeAbiParameters([{ type: 'uint256' }], [BigInt(sent.value)]), logIndex: '0x0', transactionIndex: '0x0',
    transactionHash: sent.hash, blockNumber: '0x10', blockHash, removed: false }];
}
async function casePage(mode, viewport = { width: 1440, height: 1000 }) {
  const wrapping = ['wrap_flow', 'wrap_near_expiry', 'idle_review', 'hidden_review', 'wrap_price_change', 'payment_timeout', 'payment_marker_race', 'payment_status_race', 'payment_submit_race', 'payment_submit_record_race', 'wrap_late_launch_recovery'].includes(mode);
  const context = await browser.newContext({ viewport });
  const state = { mode, allowance: 0n, sends: [], plans: 0, expired: false, receipts: mode !== 'pending', plan: null, successful: false,
    changed: false, refreshes: 0, byData: new Map(), releaseApproval: null, wrapping, paymentQuote: null,
    prepareRequests: [], validationRequests: [], paymentVerifications: 0, businessConfirmations: 0, wrapped: false, head: 32n,
    approvalCanonical: mode !== 'approval_pending', configurationReleased: mode !== 'delayed_config', releaseConfiguration: [],
    unresolvedRequests: new Map(), holdVerification: ['payment_submit_race', 'payment_submit_record_race'].includes(mode), releaseVerification: null,
    holdRegistration: false, releaseRegistration: null, priceRequests: 0, paymentQuoteRequests: [], releaseDetail: null, detailRequested: false,
    trackRequests: 0, trackedHash: null, trackedReceipt: false };
  if (mode === 'delayed_config') await context.route(delayedImage, route => route.fulfill({ contentType: 'image/png',
    body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jS1sAAAAASUVORK5CYII=', 'base64') }));
  await context.addInitScript(({ creator, treasury, mode }) => {
    const listeners = new Map();
    let selectedAccount = creator, selectedChain = '0x7a69';
    const provider = { on(name, fn) { const list = listeners.get(name) || []; list.push(fn); listeners.set(name,list); }, removeListener(name, fn) { listeners.set(name,(listeners.get(name)||[]).filter(x=>x!==fn)); },
      async request(request) {
        if (request.method === 'eth_accounts' || request.method === 'eth_requestAccounts') return [selectedAccount];
        if (request.method === 'eth_chainId') return selectedChain;
        if (request.method === 'eth_sendTransaction') {
          const result = await window.__testSend(request.params[0]);
          if (result.reject) { const error = new Error('User rejected the request'); error.code = 4001; throw error; }
          if (result.changeAccount) { selectedAccount = treasury; for (const fn of listeners.get('accountsChanged') || []) fn([selectedAccount]); }
          if (result.changeChain) { selectedChain = '0x1'; for (const fn of listeners.get('chainChanged') || []) fn(selectedChain); }
          if (result.changeAccount || result.changeChain) await window.__testChanged();
          if (result.unknown) { const error = new Error('Wallet disconnected before returning the transaction hash'); error.code = 4900; throw error; }
          if (result.fetchFailure) throw new Error('Failed to fetch');
          return result.hash;
        }
        throw new Error('Unexpected local fixture wallet method ' + request.method);
      } };
    window.ethereum = provider;
    const announce = () => window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail: { info: { uuid: '11111111-2222-4333-8444-555555555555', name: 'Local acceptance wallet', rdns: 'fun.musegod.localtest', icon: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB' }, provider } }));
    window.addEventListener('eip6963:requestProvider', announce); window.addEventListener('load', announce);
    if (mode === 'pending') { const native = window.setTimeout; window.setTimeout = (fn, ms, ...args) => native(fn, ms === 120000 ? 700 : ms, ...args); }
    // Only the wallet-response timer is shortened. Quotes, lease renewals and
    // receipt-confirmation timers keep their ordinary semantics in this fixture.
    if (mode.includes('_timeout') || mode === 'wrap_late_launch_recovery') { const native = window.setTimeout; window.setTimeout = (fn, ms, ...args) => native(fn, ms === 300000 ? 300 : ms, ...args); }
  }, { creator, treasury, mode });
  await context.exposeBinding('__testChanged', () => { state.changed = true; });
  await context.exposeBinding('__testSend', async (_source, tx) => {
    const wrap = tx.to.toLowerCase() === quote.address.toLowerCase() && tx.data === encodeFunctionData({ abi: wrapAbi, functionName: 'deposit' });
    const approval = tx.to.toLowerCase() === quote.address.toLowerCase() && tx.data.startsWith('0x095ea7b3');
    if (approval && mode === 'reject_approval') return { reject: true };
    const hash = keccak256(toHex(`browser-send-${mode}-${state.sends.length}`)); state.sends.push({ ...tx, hash, approval, wrap });
    if (wrap) { assert(wrapping); assert.equal(BigInt(tx.value), BigInt(state.paymentQuote.amountIn)); state.wrapped = true; }
    if (approval) { state.allowance = BigInt(state.plan.firstBuy.amountIn); if (mode === 'expiry') state.expired = true; }
    if (approval && mode === 'two_tabs' && state.sends.length === 1) await new Promise(resolve => { state.releaseApproval = resolve; });
    if (mode === 'wrap_late_launch_recovery' && state.sends.length === 3 && !approval && !wrap ||
      mode === 'approval_timeout_reject' && approval || state.sends.length === 1 && (
      mode === 'approval_timeout' && approval || mode === 'payment_timeout' && wrap || mode === 'launch_timeout' && !approval && !wrap)) {
      const result = await new Promise(resolve => state.unresolvedRequests.set(hash, resolve));
      state.unresolvedRequests.delete(hash);
      return result.reject ? { reject: true } : { hash };
    }
    return { hash, changeAccount: approval && mode === 'account_change', changeChain: approval && mode === 'network_change',
      unknown: !approval && ['unknown_send', 'payment_marker_race', 'launch_marker_race'].includes(mode) && state.sends.length === 1 || approval && mode === 'approval_unknown' && state.sends.length === 1,
      fetchFailure: mode === 'unknown_fetch' && tx.data === state.sends[0].data };
  });
  await context.route('**/api/**', async route => {
    const url = new URL(route.request().url()); const payload = route.request().method() === 'POST' ? route.request().postDataJSON() : null;
    const reply = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    // Execution is always local 31337; only its reviewed Robinhood deployment scope exists.
    if (url.pathname.startsWith('/api/chains') && !/^\/api\/chains\/4663(?:\/|$)/.test(url.pathname))
      return reply({ error: 'The requested network is unavailable in this local fork fixture' }, 404);
    const path = url.pathname.replace(/^\/api\/chains\/4663(?=\/|$)/, '/api');
    if (path === '/api/config') {
      if (!state.configurationReleased) await new Promise(resolve => state.releaseConfiguration.push(resolve));
      return reply(mode === 'stale_page' ? { ...config, curvePolicy: 'old-curve-v1' } : config);
    }
    if (path === '/api/stocks') return reply(ROBINHOOD_STOCKS.map(x=>({ ...x, verified: true, blockNumber: '16', totalSupply: '1000000000000000000000000', multiplierWad: null })));
    if (path === '/api/tokens') return reply(mode.startsWith('token_detail_') ? Array.from({length:50},(_,index)=>({
      ...state.plan?.draft, address:'0x'+(index+1000).toString(16).padStart(40,'0'), creator, mode:'fork', deploymentChainId:4663, createdAt:index,
      quoteAddress:quote.address })) : []);
    if (path === '/api/first-buy/prices') {
      state.priceRequests++;
      const pairedAsset = url.searchParams.get('pairedAsset');
      if (!pairedAsset || pairedAsset.toLowerCase() !== quote.address.toLowerCase())
        return reply({ error: 'This reference-price fixture only covers paired WETH' }, 400);
      const now = Date.now();
      return reply({ chainId: 4663, quotedAt: now, expiresAt: now + 60000, referenceOnly: true,
        assets: firstBuyPaymentAssets(4663, quote.address).map(asset => ({ ...asset,
          priceUsd: asset.symbol === 'USDG' ? '1' : '3000' })) });
    }
    if (path === '/api/first-buy/quote' && wrapping) {
      assert.equal(payload.fromToken.toLowerCase(), zeroAddress); assert.equal(payload.toToken.toLowerCase(), quote.address.toLowerCase());
      const normalized = firstBuyPaymentInput(4663,payload); // Same schema semantics as the real HTTP endpoint.
      state.paymentQuoteRequests.push(structuredClone(payload));
      state.paymentQuote = createDirectWrapQuote(4663, normalized.account, normalized.amountIn, wrapRuntime, { number: 16n, hash: blockHash });
      if (mode === 'wrap_near_expiry' && state.paymentQuoteRequests.length === 1) state.paymentQuote.slippageBps = 1;
      return reply(state.paymentQuote);
    }
    if (path === '/api/first-buy/verify' && wrapping) {
      const sent = state.sends.find(row => row.hash === payload.hash); assert(sent?.wrap, 'Payment recovery must reference the wrapped transaction');
      assert.equal(sent.to.toLowerCase(), payload.quote.transaction.to.toLowerCase());
      assert.equal(sent.data, payload.quote.transaction.data); assert.equal(BigInt(sent.value), BigInt(payload.quote.transaction.value));
      const actualOutput = firstBuyReceiptOutput(payload.quote, depositLogs(sent)).toString();
      state.paymentVerifications++;
      if (mode === 'payment_status_race' && state.paymentVerifications === 1)
        return reply({ status: 'pending', hash: sent.hash });
      if (state.holdVerification) await new Promise(resolve => { state.releaseVerification = resolve; });
      return reply({ status: 'success', hash: sent.hash, actualOutput, pairedAsset: quote.address, account: creator, blockNumber: '16', blockHash });
    }
    if (path === '/api/launch/prepare') { assert.equal(payload.expectedCurvePolicy, CURVE_POLICY); state.plans++; state.expired=false;
      state.prepareRequests.push(structuredClone(payload));
      if (payload.options?.previousPlanId) state.refreshes++;
      const expected = mode === 'wrap_price_change' && state.wrapped ? out * 97n / 100n : out;
      try { state.plan=preparedPlan(payload.draft,payload.firstBuy,state.plans,payload.options,payload.creator,expected); }
      catch (error) { if (error?.name === 'ZodError') return reply({ error: error.message },400); throw error; }
      state.byData.set(state.plan.data,state.plan); return reply(state.plan); }
    if (path === '/api/launch/validate') { state.validationRequests.push(structuredClone(payload)); const plan = state.byData.get(payload.data); assert(plan, 'Validation must reference a prepared fixture plan');
      return state.expired || plan.requiresReconfirmation ? reply({ error: 'The opening valuation expired or price is below the accepted minimum.' },400) : reply({ valid: true, feePolicy: FEE_POLICY, curvePolicy: CURVE_POLICY, planId:plan.id, intentId:plan.intentId, validityVersion:2, signingExpiresAt:plan.signingExpiresAt }); }
    if (path === '/api/launch/simulate') { const plan = state.byData.get(payload.data); assert(plan, 'Simulation must reference a prepared fixture plan');
      return mode === 'simulation_failure' ? reply({ error: 'Transaction simulation failed. The transaction was not submitted.' },400) : reply({ valid: true, gas: '5000000', amountOut: plan.firstBuy?.expectedAmountOut || null, simulatedAt: Date.now() }); }
    if (path === '/api/launch/track') {
      if (mode !== 'history_track_backoff') return reply({ status:'pending' },202);
      state.trackRequests++;
      return route.fulfill({ status:429, contentType:'application/json', headers:{ 'retry-after':'60' },
        body:JSON.stringify({ error:'Service capacity is temporarily limited.', code:'CAPACITY_LIMITED' }) });
    }
    if (path === '/api/launch/register') { if (!state.receipts) return reply({ error:'receipt pending' },400); state.successful=true;
      const sent=state.sends.find(row=>row.hash===payload.hash), plan=sent && state.byData.get(sent.data); assert(plan, 'Registration must reference a submitted launch');
      if (state.holdRegistration) await new Promise(resolve => { state.releaseRegistration = resolve; });
      return reply({ ...plan.draft, address:token, creator:plan.creator, poolId:plan.poolId, transactionHash:payload.hash, blockNumber:'16', createdAt:Date.now(), mode:'fork', deploymentChainId:4663, openingCap:'1.666666', openingValuation:plan.openingValuation, curvePolicy:CURVE_POLICY, feePolicy:FEE_POLICY, feeTreasury:treasury }); }
    if (path === '/api/rpc') {
      const one = item => {
        let result;
        if (item.method === 'eth_chainId') result='0x7a69';
        else if (item.method === 'eth_blockNumber') result=toHex(state.head);
        else if (item.method === 'eth_getBlockByNumber' || item.method === 'eth_getBlockByHash') {
          result=block(); if (!state.approvalCanonical && item.params[0] === '0x10') result.hash='0x'+'cc'.repeat(32);
        }
        else if (item.method === 'eth_getBalance') result=toHex(10n**20n);
        else if (item.method === 'eth_gasPrice') result='0x2';
        else if (item.method === 'eth_maxPriorityFeePerGas') result='0x1';
        else if (item.method === 'eth_feeHistory') {
          const count = Number(BigInt(item.params[0]));
          assert(count > 0 && count <= 1024, 'Unexpected fixture fee-history block count');
          result={ oldestBlock: '0x20', baseFeePerGas: Array(count + 1).fill('0x1'),
            gasUsedRatio: Array(count).fill(0), reward: Array.from({ length: count }, () => Array(item.params[2]?.length ?? 0).fill('0x1')) };
        }
        else if (item.method === 'eth_estimateGas') result='0xea60';
        else if (item.method === 'eth_call') { const data=item.params[0].data;
          const balance = wrapping && item.params[0].to?.toLowerCase() === quote.address.toLowerCase() ? state.wrapped ? BigInt(state.paymentQuote.amountIn) : 0n : 10n**20n;
          result=toHex(data.startsWith('0xdd62ed3e') ? state.allowance : balance,{size:32}); }
        else if (item.method === 'eth_getTransactionCount') result=toHex(state.sends.length);
        else if (item.method === 'eth_getCode') result=wrapping && item.params[0].toLowerCase() === quote.address.toLowerCase() ? wrapRuntime : '0x';
        else if (item.method === 'eth_getTransactionReceipt' && state.trackedHash && item.params[0] === state.trackedHash)
          result=state.trackedReceipt ? { transactionHash:state.trackedHash, transactionIndex:'0x0', blockHash, blockNumber:'0x10', from:creator, to:contracts.airlock, cumulativeGasUsed:'0xea60', gasUsed:'0xea60', contractAddress:null, logs:[], logsBloom:'0x'+'00'.repeat(256), status:'0x1', effectiveGasPrice:'0x1', type:'0x2' } : null;
        else if (item.method === 'eth_getTransactionReceipt') { const sent=state.sends.find(x=>x.hash===item.params[0]); result=!sent || (!sent.approval&&!state.receipts) ? null : { transactionHash:sent.hash, transactionIndex:'0x0', blockHash, blockNumber:'0x10', from:creator, to:sent.to, cumulativeGasUsed:'0xea60', gasUsed:'0xea60', contractAddress:null, logs:sent.wrap ? depositLogs(sent) : [], logsBloom:'0x'+'00'.repeat(256), status:'0x1', effectiveGasPrice:'0x1', type:'0x2' }; }
        else if (item.method === 'eth_getTransactionByHash') { const sent=state.sends.find(x=>x.hash===item.params[0]); result=sent ? { hash:sent.hash, from:creator, to:sent.to, input:sent.data, value:sent.value ?? '0x0', nonce:toHex(state.sends.indexOf(sent)), gas:'0xea60', gasPrice:'0x1', blockHash, blockNumber:'0x10', transactionIndex:'0x0', type:'0x0', v:'0x1b', r:'0x1', s:'0x1' } : null; }
        else throw new Error('Unexpected fixture RPC '+item.method);
        return { jsonrpc:'2.0',id:item.id,result };
      }; return reply(Array.isArray(payload)?payload.map(one):one(payload));
    }
    if (path.startsWith('/api/tokens/')) {
      if (mode.startsWith('token_detail_') && path === `/api/tokens/${token}`) {
        state.detailRequested = true;
        if (mode === 'token_detail_error') return reply({error:'Token detail RPC temporarily unavailable'},400);
        if (mode === 'token_detail_unregistered_backup') return reply({error:'Platform token not found',code:'TOKEN_NOT_REGISTERED'},404);
        if (mode === 'token_detail_unverified_opening') return reply({ token:{ ...state.plan?.draft,address:token,creator,poolId:state.plan?.poolId,quoteAddress:quote.address,mode:'fork',deploymentChainId:4663,openingCap:'1.666666',openingValuation:state.plan?.openingValuation,curvePolicy:CURVE_POLICY,feePolicy:FEE_POLICY,openingValuationUnverified:true },state:{status:2,numeraire:quote.address,poolKey:{currency0:token,currency1:quote.address,fee:8388608,tickSpacing:10,hooks:contracts.initializer}} });
        if (mode === 'token_detail_invalid_pool') return reply({ token:{ ...state.plan?.draft,address:token,creator,poolId:state.plan?.poolId,quoteAddress:quote.address,mode:'fork',deploymentChainId:4663,openingCap:'1.666666',openingValuation:state.plan?.openingValuation,curvePolicy:CURVE_POLICY,feePolicy:FEE_POLICY },state:null,stateError:'The pool identity or locked state is invalid',stateInvalid:true });
        if (mode === 'token_detail_state_unavailable') return reply({ token:{ ...state.plan?.draft,address:token,creator,poolId:state.plan?.poolId,quoteAddress:quote.address,mode:'fork',deploymentChainId:4663,openingCap:'1.666666',openingValuation:state.plan?.openingValuation,curvePolicy:CURVE_POLICY,feePolicy:FEE_POLICY },state:null,stateError:'RPC request timed out' });
        await new Promise(resolve => {state.releaseDetail=resolve;});
      }
      return reply({ token:{ ...state.plan?.draft,address:token,creator,poolId:state.plan?.poolId,quoteAddress:quote.address,mode:'fork',deploymentChainId:4663,openingCap:'1.666666',openingValuation:state.plan?.openingValuation,curvePolicy:CURVE_POLICY,feePolicy:FEE_POLICY },state:{status:2,numeraire:quote.address,poolKey:{currency0:token,currency1:quote.address,fee:8388608,tickSpacing:10,hooks:contracts.initializer}} });
    }
    if (path.includes('/fees')) return reply({ lp:{amount0:'0',amount1:'0'},trade:{amount0:'0',amount1:'0'} });
    return reply({ error:'Unavailable fixture route' },404);
  });
  const page = await context.newPage(); activePage = page; const pageErrors=[]; page.on('pageerror',e=>pageErrors.push(e.message));
  if (quoteClockModes.has(mode)) await page.clock.install({time:new Date()});
  await page.goto(origin+'/create?chainId=4663'); await page.getByLabel('Token name',{exact:true}).fill(('Browser '+mode).slice(0, 32));
  await page.getByLabel('Token symbol',{exact:true}).fill('BROWSE');
  if (mode === 'delayed_config') {
    await waitForFixture(() => state.releaseConfiguration.length > 0, 'initial configuration request');
    await page.getByLabel('Image URL', { exact: true }).fill(delayedImage);
    await page.getByLabel('Description', { exact: true }).fill('Draft entered while network checks are loading.');
  }
  await page.getByRole('button',{name:'Continue',exact:true}).click();
  await page.getByLabel('Pay with',{exact:true}).selectOption(wrapping ? zeroAddress : quote.address);
  await page.getByLabel(`First buy amount in ${wrapping ? 'ETH' : 'WETH'}`,{exact:true}).fill(plainModes.has(mode)?'0':'0.001');
  if (!plainModes.has(mode)) await page.getByRole('button',{name:'No lock',exact:true}).click();
  if (mode === 'delayed_config') {
    assert.equal(await page.getByRole('button', { name: 'Review and continue', exact: true }).isDisabled(), true);
    assert.equal(state.plans, 0); assert.equal(state.sends.length, 0);
  }
  await page.getByRole('button',{name:'Connect wallet',exact:true}).click();
  const choose=page.getByRole('button',{name:/Local acceptance wallet/}); if (await choose.count()) await choose.click();
  if (mode === 'delayed_config') {
    assert.equal(await page.getByRole('button', { name: 'Review and continue', exact: true }).isDisabled(), true,
      'Connecting a wallet must not bypass the pending configuration gate');
    state.configurationReleased = true;
    state.releaseConfiguration.splice(0).forEach(resolve => resolve());
    await page.waitForFunction(() => [...document.querySelectorAll('button')]
      .some(button => button.textContent.trim() === 'Review and continue' && !button.disabled));
    assert.equal(await page.getByLabel('Token name', { exact: true }).inputValue(), 'Browser delayed_config');
    assert.equal(await page.getByLabel('Token symbol', { exact: true }).inputValue(), 'BROWSE');
    assert.equal(await page.getByLabel('Image URL', { exact: true }).inputValue(), delayedImage);
    assert.equal(await page.getByLabel('Description', { exact: true }).inputValue(), 'Draft entered while network checks are loading.');
    assert.equal(await page.getByLabel('Pay with', { exact: true }).inputValue(), quote.address);
    assert.equal(await page.getByLabel('First buy amount in WETH', { exact: true }).inputValue(), '0.001');
    assert.equal(await page.getByRole('button', { name: 'No lock', exact: true }).getAttribute('aria-pressed'), 'true');
    state.delayedConfigDraftPreserved = true;
  }
  // Precondition for the post-launch check: the draft is autosaved on the economics step.
  if (mode === 'success') await page.waitForFunction(() => Object.keys(localStorage)
    .some(key => key.startsWith('musegod.launch.draft.') && JSON.parse(localStorage.getItem(key) || 'null')?.step === 2));
  await page.getByRole('button',{name:'Review and continue',exact:true}).click();
  if (mode === 'stale_page') return { context,page,state,pageErrors };
  await page.getByRole('button',{name:wrapping ? /Wrap ETH and launch/ : plainModes.has(mode)?/Confirm launch · Sign in wallet/:/Confirm launch and first buy/,exact:true}).waitFor();
  return { context,page,state,pageErrors };
}
async function submissionFor(page, intentId) {
  return page.evaluate(intentId => {
    const keys = Object.keys(localStorage).filter(key => key.startsWith('musegod.launch.submission.') &&
      localStorage.getItem(key) && (!intentId || key.endsWith('.' + intentId)));
    if (keys.length !== 1) throw new Error('Expected exactly one matching submission marker, found ' + keys.length);
    const key = keys[0];
    return { key, intentId: key.split('.').at(-1), value: JSON.parse(localStorage.getItem(key)) };
  }, intentId);
}
async function quietReview(page, state) {
  const originalMinimum = state.plan.firstBuy.minAmountOut;
  if (state.mode === 'hidden_review') await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable:true, value:'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  if (state.mode === 'idle_review') {
    await page.clock.runFor(61_000);
    await waitForFixture(() => state.plans === 2, 'one recent-activity quote refresh');
    await page.clock.runFor(62_000);
  } else await page.clock.runFor(123_000);
  // Allow the render caused by the idle timer to finish, then count real API
  // calls for another three minutes. No prepare, payment or reference poll.
  await page.clock.runFor(500);
  const before = { plans:state.plans, quotes:state.paymentQuoteRequests.length, prices:state.priceRequests };
  await page.clock.runFor(180_000);
  assert.deepEqual({plans:state.plans,quotes:state.paymentQuoteRequests.length,prices:state.priceRequests},before);
  assert.equal(state.sends.length,0); assert.equal(state.plan.firstBuy.minAmountOut,originalMinimum);
  assert.equal(await page.getByRole('button',{name:'Wrap ETH and launch',exact:true}).isEnabled(),true);
  if (state.mode === 'hidden_review') {
    assert.equal(state.plans,1); assert.equal(state.paymentQuoteRequests.length,1);
    await page.evaluate(() => {
      Object.defineProperty(document,'visibilityState',{configurable:true,value:'visible'});
      document.dispatchEvent(new Event('visibilitychange'));
    });
  }
  state.quietBackground = true;
}
async function tokenLookup(page, state) {
  if (state.mode === 'token_detail_unregistered_backup')
    await page.evaluate(({ token, creator }) => localStorage.setItem('musegod.transactions.v1', JSON.stringify([{ hash:'0x'+'ab'.repeat(32),
      chainId:31337, deploymentChainId:4663, account:creator, action:'launch', status:'success', at:Date.now(), tokenAddress:token, intentId:'browser-sent-intent' }])), { token, creator });
  await page.goto(`${origin}/token/robinhood/${token}`);
  await waitForFixture(() => state.detailRequested, 'single token detail request');
  assert.equal(await page.getByText('Token not found',{exact:true}).count(),0,
    'A partial catalog is never proof that an older token does not exist');
  if (state.mode === 'token_detail_unregistered_backup') {
    await page.getByText(/This launch is not registered yet/).waitFor();
  } else if (state.mode === 'token_detail_unverified_opening') {
    await page.getByRole('heading',{name:state.plan.draft.name,exact:true}).waitFor();
    await page.getByText(/Not verified by the platform/).waitFor();
  } else if (state.mode === 'token_detail_invalid_pool') {
    await page.getByRole('heading',{name:state.plan.draft.name,exact:true}).waitFor();
    await page.getByText(/does not match this listing/).waitFor();
    assert.equal(await page.getByText(/Retrying automatically/).count(),0,'An integrity failure is not presented as a transient outage');
    await page.getByLabel('Trade input amount',{exact:true}).fill('1');
    assert.equal(await page.getByRole('button',{name:'Get on-chain quote',exact:true}).isEnabled(),false);
  } else if (state.mode === 'token_detail_state_unavailable') {
    await page.getByRole('heading',{name:state.plan.draft.name,exact:true}).waitFor();
    await page.getByText(/On-chain pool state is unavailable/).waitFor();
    await page.getByLabel('Trade input amount',{exact:true}).fill('1');
    assert.equal(await page.getByRole('button',{name:'Get on-chain quote',exact:true}).isEnabled(),false,
      'Quotes stay paused until live pool state is verified');
  } else if (state.mode === 'token_detail_error') {
    await page.getByText('Token detail RPC temporarily unavailable',{exact:true}).waitFor();
  } else {
    assert.equal(await page.getByRole('heading',{name:state.plan.draft.name,exact:true}).count(),0);
    await waitForFixture(() => !!state.releaseDetail,'held token detail response');
    state.releaseDetail();
    await page.getByRole('heading',{name:state.plan.draft.name,exact:true}).waitFor();
  }
  assert.equal(state.sends.length,0); state.singleTokenLookup = true;
}
async function historyTrackBackoff(page, state) {
  // A launch sent earlier from this browser is still unconfirmed, and the
  // server answers its queueing request with Retry-After: 60.
  state.trackedHash = '0x' + 'ab'.repeat(32);
  await page.evaluate(({ hash, creator, planId }) => {
    localStorage.setItem('musegod.transactions.v1', JSON.stringify([{ hash, chainId:31337, deploymentChainId:4663, account:creator,
      action:'launch', status:'pending', at:Date.now(), planId }]));
    window.dispatchEvent(new Event('musegod:transactions'));
  }, { hash: state.trackedHash, creator, planId: state.plan.id });
  await page.clock.runFor(15_000);
  await waitForFixture(() => state.trackRequests === 1, 'first background queueing request');
  await page.clock.runFor(44_000);
  assert.equal(state.trackRequests, 1, 'Retry-After 60 holds the record past the 15 second polls');
  await page.clock.runFor(32_000);
  await waitForFixture(() => state.trackRequests === 2, 'queueing retried once the server wait passed');
  // A manual check that finds the launch still confirming clears the wait.
  state.trackedReceipt = true; state.head = 16n;
  await page.getByRole('button',{name:'Back to edit',exact:true}).first().click();
  await page.getByRole('button', { name: /^Wallet transaction history/ }).click();
  const check = page.locator('.transaction-history').getByRole('button', { name: 'Check again', exact: true });
  await check.click();
  await page.waitForFunction(() => [...document.querySelectorAll('.transaction-history button')]
    .some(button => button.textContent.trim() === 'Check again' && !button.disabled));
  assert.equal(await page.locator('.transaction-history [role=alert]').count(), 0, 'The manual check completed as still pending');
  await page.clock.runFor(15_000);
  await waitForFixture(() => state.trackRequests === 3, 'background polling resumed on the next poll after a manual check');
  assert.equal(state.sends.length, 0); state.historyBackoff = true;
}
async function quietPlainReview(page, state) {
  await page.clock.runFor(301_000);
  assert.equal(state.plans,1); assert.equal(state.sends.length,0);
  const prices=state.priceRequests;
  await page.clock.runFor(180_000);
  assert.equal(state.plans,1); assert.equal(state.priceRequests,prices);
  assert.equal(await page.getByRole('button',{name:'Confirm launch · Sign in wallet',exact:true}).isEnabled(),true);
  state.quietBackground=true;
}
async function assertLateHashSaved(page, marker, sent, action) {
  await page.waitForFunction(({ key, intentId, hash, action }) => {
    const marker = JSON.parse(localStorage.getItem(key) || 'null');
    const history = JSON.parse(localStorage.getItem('musegod.transactions.v1') || '[]');
    return marker?.hash === hash && history.some(row => row.hash === hash && row.intentId === intentId && row.action === action && row.status === 'success');
  }, { key: marker.key, intentId: marker.intentId, hash: sent.hash, action });
}
async function lateFundedLaunchRecovery(page, state) {
  await page.getByText(/wallet request is still unresolved/i).first().waitFor();
  await page.getByRole('button', { name: 'Back to edit', exact: true }).first().click();
  assert.deepEqual(state.sends.map(sent => sent.wrap ? 'wrap' : sent.approval ? 'approval' : 'launch'), ['wrap', 'approval', 'launch']);
  const marker = await submissionFor(page), launch = state.sends[2], plans = state.plans;
  assert.equal(marker.value.kind, 'launch'); assert.equal(marker.value.hash, undefined);
  assert.equal(marker.value.planId, state.plan.id);
  const paymentStorageKey = marker.key.replace('musegod.launch.submission.', 'musegod.launch.payment.');
  const paymentRaw = await page.evaluate(key => localStorage.getItem(key), paymentStorageKey);
  const payment = JSON.parse(paymentRaw);
  assert.equal(payment.hash, state.sends[0].hash);
  assert.equal(payment.intentId, marker.intentId);
  assert.equal(payment.actualOutput, state.paymentQuote.minimumOut);
  assert.equal(payment.launchHash, undefined, 'The timed-out launch must not run its payment-binding callback');
  assert(state.unresolvedRequests.has(launch.hash));
  state.unresolvedRequests.get(launch.hash)({});
  await assertLateHashSaved(page, marker, launch, 'launch');
  assert.equal(await page.evaluate(key => localStorage.getItem(key), paymentStorageKey), paymentRaw,
    'A late launch hash only records the original request, leaving payment reconciliation for recovery');
  assert.equal(state.sends.length, 3); assert.equal(state.plans, plans); assert.equal(state.successful, false);
  assert.equal(new URL(page.url()).pathname, '/create');
  assert.equal(await page.getByLabel('Transaction hash from your wallet').inputValue(), '',
    'Recovery must use the stored late hash without requiring a manual hash');
  await page.getByRole('button', { name: 'Recover pending launch', exact: true }).click();
  await page.waitForURL('**/token/**');
  assert.equal(await page.evaluate(key => localStorage.getItem(key), paymentStorageKey), null,
    'Canonical recovery must consume the earlier payment proved to fund this launch');
  assert.equal(await page.evaluate(key => localStorage.getItem(key), marker.key), null);
  assert.equal(state.sends.length, 3, 'Recovering a late funded launch must not send another transaction');
  assert.equal(state.plans, plans); assert.equal(state.successful, true);
  assert.equal(state.unresolvedRequests.size, 0);
  state.lateFundedPaymentConsumed = true;
}
async function recoveryRaceCase(context, page, state) {
  const paymentStatus = state.mode === 'payment_status_race', paymentRecordOnly = state.mode === 'payment_submit_record_race';
  const paymentSubmit = state.mode === 'payment_submit_race' || paymentRecordOnly;
  if (paymentSubmit) await waitForFixture(() => !!state.releaseVerification, 'the original payment verification response');
  else if (paymentStatus) await page.getByText('Check the submitted payment status before continuing.', { exact: true }).waitFor();
  else await page.getByLabel('Transaction hash from your wallet').waitFor();
  // Keep the original submission's dialog and generation untouched until its
  // response arrives, so the normal-pay case proves storage ownership alone.
  if (!paymentSubmit) await page.getByRole('button', { name: 'Back to edit', exact: true }).first().click();
  const marker = await submissionFor(page), sent = state.sends[0], plans = state.plans;
  assert.equal(state.sends.length, 1);
  const paymentStorageKey = marker.key.replace('musegod.launch.submission.', 'musegod.launch.payment.');
  const pendingStorageKey = marker.key.replace('musegod.launch.submission.', 'musegod.launch.pending.');
  const paymentRaw = await page.evaluate(key => localStorage.getItem(key), paymentStorageKey);
  if (paymentStatus || paymentSubmit) assert(paymentRaw, 'The first conversion must retain its actual payment attempt');
  else {
    assert.equal(marker.value.hash, undefined, 'The unknown wallet result must require recovery');
    await page.getByLabel('Transaction hash from your wallet').fill(sent.hash);
  }
  const recoveringLaunch = state.mode === 'launch_marker_race';
  state.holdVerification = !recoveringLaunch;
  state.holdRegistration = recoveringLaunch;
  const recoveryButton = paymentStatus ? 'Check payment status' : 'Recover pending launch';
  if (!paymentSubmit) await page.getByRole('button', { name: recoveryButton, exact: true }).click();
  await waitForFixture(() => recoveringLaunch ? !!state.releaseRegistration : !!state.releaseVerification,
    'the old recovery response waiting for a concurrent storage change');
  if (!paymentSubmit) assert.equal(await page.getByRole('button', { name: recoveryButton, exact: true }).isDisabled(), true);
  // A second same-origin page models another tab committing a newer operation
  // for this exact intent. Its hash is storage-only fixture data, never a send.
  const replacementHash = keccak256(toHex('newer-storage-only-' + state.mode));
  let replacement;
  if (paymentStatus || paymentRecordOnly) {
    replacement = [[paymentStorageKey, JSON.stringify({ ...JSON.parse(paymentRaw), launchHash: replacementHash })]];
  } else {
    replacement = [[marker.key, JSON.stringify({ ...marker.value, hash: replacementHash, at: marker.value.at + 1 })]];
    replacement.push(recoveringLaunch ? [pendingStorageKey, replacementHash] : [paymentStorageKey,
      JSON.stringify({ ...(paymentRaw ? JSON.parse(paymentRaw) : { quote: marker.value.quote, hash: sent.hash,
        actualOutput: null, intentId: marker.intentId }), launchHash: replacementHash })]);
  }
  const writer = await context.newPage();
  const storageUrl = origin + '/__launch-storage-race';
  await writer.route(storageUrl, route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Local storage race fixture</title>' }));
  await writer.goto(storageUrl);
  await writer.evaluate(entries => { for (const [key, value] of entries) localStorage.setItem(key, value); }, replacement);
  if (paymentRecordOnly) assert.deepEqual(await submissionFor(page), marker,
    'The payment-only race must leave the original submission marker unchanged');
  if (recoveringLaunch) { state.holdRegistration = false; state.releaseRegistration(); }
  else { state.holdVerification = false; state.releaseVerification(); }
  if (paymentSubmit) {
    await page.getByText(/The saved payment(?: request)? changed\./).first().waitFor();
    await page.getByRole('button', { name: 'Back to edit', exact: true }).first().click();
    assert.equal(state.paymentVerifications, 1, 'The race must stop the first payment verification before any funded-launch work');
  } else await page.waitForFunction(label => [...document.querySelectorAll('button')]
    .some(button => button.textContent.trim() === label && !button.disabled), recoveryButton);
  assert.deepEqual(await page.evaluate(entries => entries.map(([key]) => [key, localStorage.getItem(key)]), replacement), replacement,
    'An old recovery response must preserve the newer records byte for byte');
  assert.equal(new URL(page.url()).pathname, '/create', 'An outdated recovery must not navigate to a token');
  assert.equal(state.sends.length, 1, 'Recovery and concurrent storage writes must never send another wallet request');
  assert.equal(state.plans, plans, 'An outdated recovery must not prepare or continue a launch');
  assert.equal(await page.getByLabel('Token name', { exact: true }).inputValue(), ('Browser ' + state.mode).slice(0, 32));
  if (!recoveringLaunch) assert.equal(state.successful, false);
  state.concurrentRecordsPreserved = replacement.length;
  await writer.close();
}
async function timeoutCase(page, state) {
  await page.getByText(/wallet request is still unresolved/i).first().waitFor();
  await page.getByRole('button', { name: 'Back to edit', exact: true }).first().click();
  const another = page.getByRole('button', { name: 'Create another token', exact: true });
  assert.equal(await another.isEnabled(), true, 'A timed-out wallet request must release the current form');
  assert.equal(state.sends.length, 1, 'A hanging wallet request must never be retried');
  const marker = await submissionFor(page);
  const old = state.sends[0], oldPlans = state.plans;
  assert.equal(marker.value.hash, undefined);
  assert(state.unresolvedRequests.has(old.hash));
  if (old.approval) assert.equal(marker.value.kind, 'approval');
  else if (old.wrap) assert.equal(marker.value.kind, 'payment');
  await another.click();
  const name = ('New draft after ' + state.mode).slice(0, 32);
  await page.getByLabel('Token name', { exact: true }).fill(name);
  await page.getByLabel('Token symbol', { exact: true }).fill('LATE');
  await page.getByLabel('Description', { exact: true }).fill('Keep this independent draft unchanged.');
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.getByLabel('Pay with', { exact: true }).selectOption(quote.address);
  await page.getByLabel('First buy amount in WETH', { exact: true }).fill('0.002');
  await page.getByRole('button', { name: 'No lock', exact: true }).click();
  const currentIntentKey = `musegod.launch.intent.31337.4663.${creator.toLowerCase()}`;
  const newIntent = await page.evaluate(key => localStorage.getItem(key), currentIntentKey);
  assert(newIntent); assert.notEqual(newIntent, marker.intentId);
  const draftUnchanged = async () => {
    assert.equal(await page.getByLabel('Token name', { exact: true }).inputValue(), name);
    assert.equal(await page.getByLabel('Token symbol', { exact: true }).inputValue(), 'LATE');
    assert.equal(await page.getByLabel('Description', { exact: true }).inputValue(), 'Keep this independent draft unchanged.');
    assert.equal(await page.getByLabel('First buy amount in WETH', { exact: true }).inputValue(), '0.002');
    assert.equal(await page.evaluate(key => localStorage.getItem(key), currentIntentKey), newIntent);
    assert.equal(new URL(page.url()).pathname, '/create');
  };
  if (state.mode === 'approval_timeout_reject') {
    // Keep a genuine second intent unresolved while the old provider request
    // rejects. Clearing the old marker must not unlock the newer request.
    await page.getByRole('button', { name: 'Review and continue', exact: true }).click();
    await page.getByRole('button', { name: 'Confirm launch and first buy', exact: true }).click();
    await page.getByText(/wallet request is still unresolved/i).first().waitFor();
    await page.getByRole('button', { name: 'Back to edit', exact: true }).first().click();
    const newer = await submissionFor(page, newIntent);
    assert.equal(state.sends.length, 2); assert.equal(newer.value.kind, 'approval');
    state.unresolvedRequests.get(old.hash)({ reject: true });
    await page.waitForFunction(key => localStorage.getItem(key) === null, marker.key);
    assert.deepEqual(await submissionFor(page, newIntent), newer, 'A late 4001 may only clear its own request marker');
    assert.equal(await page.getByRole('button', { name: 'Review and continue', exact: true }).isDisabled(), true);
    assert.equal(state.sends.length, 2); await draftUnchanged();
    state.unresolvedRequests.get(state.sends[1].hash)({});
    await assertLateHashSaved(page, newer, state.sends[1], 'approval');
    assert.equal(await page.evaluate(key => localStorage.getItem(key), marker.key), null);
    const history = await page.evaluate(() => JSON.parse(localStorage.getItem('musegod.transactions.v1') || '[]'));
    assert(!history.some(row => row.hash === old.hash), 'A rejected request has no returned hash to record');
    state.lateRejectionIsolated = true;
  } else {
    state.unresolvedRequests.get(old.hash)({});
    await assertLateHashSaved(page, marker, old, old.approval ? 'approval' : old.wrap ? 'swap' : 'launch');
    assert.equal(state.sends.length, 1, 'A late wallet hash must never continue approval, conversion or launch');
    assert.equal(state.plans, oldPlans, 'A late wallet hash must not prepare a funded launch');
    assert.equal(await page.getByRole('button', { name: 'Review and continue', exact: true }).isEnabled(), true);
  }
  await draftUnchanged();
  assert.equal(state.successful, false, 'A late hash must not register or navigate to a token');
  assert.equal(state.paymentVerifications, 0, 'A late payment hash is recorded for recovery without continuing the payment flow');
  assert.equal(state.unresolvedRequests.size, 0);
  state.lateHashIntentPreserved = true;
}
try {
  for (const mode of (process.env.BROWSER_CASES?.split(',') || ['success','plain','duplicate','stale_page','reject_approval','expiry','account_change','network_change','simulation_failure','two_tabs','unknown_send','approval_unknown','approval_pending','wrap_flow','wrap_price_change','delayed_config','unknown_fetch','approval_timeout','payment_timeout','launch_timeout','approval_timeout_reject','payment_marker_race','launch_marker_race','payment_status_race','payment_submit_race','payment_submit_record_race','wrap_late_launch_recovery','wrap_near_expiry','idle_review','hidden_review','idle_plain','token_detail_pending','token_detail_error','token_detail_state_unavailable','token_detail_unregistered_backup','token_detail_invalid_pool','token_detail_unverified_opening','history_track_backoff'])) {
    const {context,page,state,pageErrors}=await casePage(mode);
    const plain = plainModes.has(mode);
    if (mode === 'success') {
      await page.screenshot({path:'.cache/launch-scoped-browser-desktop-review.png',fullPage:true});
      report.screenshots.push('.cache/launch-scoped-browser-desktop-review.png');
    }
    if (tokenLookupModes.has(mode)) await tokenLookup(page,state);
    else if (mode === 'history_track_backoff') await historyTrackBackoff(page,state);
    else if (mode === 'stale_page') {
      await page.getByText(/curve policy has changed/).waitFor(); assert.equal(state.plans,0); assert.equal(state.sends.length,0);
    }
    else if (state.wrapping) {
      await page.getByRole('region', { name: 'Payment conversion review' }).waitFor();
      await page.getByRole('region', { name: 'First buy preview' }).waitFor();
      assert.equal(state.sends.length, 0); assert.equal(state.prepareRequests.length, 1);
      assert.equal(parseUnits(state.prepareRequests[0].firstBuy.amount, 18).toString(), state.paymentQuote.minimumOut,
        'The reviewed token floor must be prepared from the guaranteed paired-asset output before any payment');
      state.reviewedMinimum = state.plan.firstBuy.minAmountOut;
      if (mode === 'wrap_near_expiry') {
        assert.equal(state.paymentQuote.slippageBps,1);
        await page.clock.runFor(46_000);
      }
      if (mode === 'idle_review' || mode === 'hidden_review') await quietReview(page,state);
      state.businessConfirmations++;
      await page.getByRole('button', { name: 'Wrap ETH and launch', exact: true }).click();
    }
    else if (mode === 'duplicate') await page.getByRole('button',{name:'Confirm launch and first buy',exact:true}).evaluate(button => { button.click(); button.click(); });
    else {
      if (mode === 'idle_plain') await quietPlainReview(page,state);
      state.businessConfirmations++;
      await page.getByRole('button',{name:plain?/Confirm launch · Sign in wallet/:/Confirm launch and first buy/,exact:true}).click();
    }
    if (tokenLookupModes.has(mode) || mode === 'history_track_backoff') { /* Read-only lookups, no signing. */ }
    else if (mode === 'wrap_late_launch_recovery') await lateFundedLaunchRecovery(page, state);
    else if (recoveryRaceModes.has(mode)) await recoveryRaceCase(context, page, state);
    else if (timeoutModes.has(mode)) await timeoutCase(page, state);
    else if (state.wrapping) {
      if (mode === 'wrap_price_change') {
        const accept = page.getByRole('button', { name: 'Accept updated minimum', exact: true });
        await accept.waitFor();
        await page.getByText('Payment received. Review the changed token minimum before launching.', { exact: true }).waitFor();
        assert.equal(state.sends.length, 1, 'A worse funded quote must stop after wrapping, before guard approval or launch');
        assert.equal(state.sends[0].wrap, true); assert.equal(state.plan.requiresReconfirmation, true);
        assert.equal(state.plan.firstBuy.minAmountOut, state.reviewedMinimum);
        assert.equal(await accept.count(), 1); assert.equal(state.successful, false);
        await page.screenshot({ path: '.cache/launch-wrap-price-change.png', fullPage: true });
        report.screenshots.push('.cache/launch-wrap-price-change.png');
        state.businessConfirmations++; await accept.click();
      }
      await page.waitForURL('**/token/**');
      assert.equal(state.sends.length, 3); assert.deepEqual(state.sends.map(tx => tx.wrap ? 'wrap' : tx.approval ? 'approval' : 'launch'), ['wrap','approval','launch']);
      assert.equal(state.successful, true); assert(state.paymentVerifications >= 2);
      assert.equal(state.prepareRequests.find(request=>request.paymentRecovery)?.options.acceptedMinAmountOut,state.reviewedMinimum,
        'The first funded plan must preserve the original business confirmation, before any explicit price reconfirmation');
      const approval = decodeFunctionData({ abi: erc20Abi, data: state.sends[1].data });
      const launch = decodeFunctionData({ abi: launchGuardAbi, data: state.sends[2].data });
      assert.deepEqual(approval.args, [guard, BigInt(state.paymentQuote.amountIn)]);
      assert.equal(launch.args[1], BigInt(state.paymentQuote.amountIn));
      if (mode !== 'wrap_price_change') assert.equal(launch.args[2], BigInt(state.reviewedMinimum));
      else {
        const reconfirmed = state.prepareRequests.find(request => request.options?.reconfirmPrice);
        assert(reconfirmed); assert.equal(launch.args[2], BigInt(reconfirmed.options.reconfirmedMinimumOut));
        assert(launch.args[2] < BigInt(state.reviewedMinimum));
      }
      assert.equal(state.businessConfirmations, mode === 'wrap_price_change' ? 2 : 1);
      if (mode === 'wrap_near_expiry') {
        assert.equal(state.paymentQuoteRequests.length,2);
        assert.equal(state.paymentQuoteRequests[1].slippageBps,100);
        assert.equal(state.paymentQuote.minimumOut,state.paymentQuote.amountIn);
      }
    }
    else if (mode==='success'||mode==='plain'||mode==='idle_plain'||mode==='duplicate'||mode==='expiry'||mode==='delayed_config') {
      await page.waitForURL('**/token/**'); assert.equal(state.sends.length,plain?1:2); assert.equal(state.successful,true);
      if (mode === 'success') {
        const launchedSteps = await page.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith('musegod.launch.draft.'))
          .map(key => JSON.parse(localStorage.getItem(key) || 'null')?.step));
        assert(launchedSteps.length && launchedSteps.every(step => step === 1), 'A launched draft must reopen on the identity step');
      }
      if (mode === 'idle_plain') {assert.equal(state.plans,2);assert.equal(state.businessConfirmations,1);}
      if (mode === 'delayed_config') {
        assert.equal(state.businessConfirmations, 1);
        assert(state.prepareRequests.every(request => request.draft.name === 'Browser delayed_config' &&
          request.draft.image === delayedImage && request.firstBuy.amount === '0.001' && request.firstBuy.lockDays === 0));
      }
    }
    else if (mode==='reject_approval') { await page.getByText(/cancelled the wallet request|User rejected the request/).first().waitFor(); assert.equal(state.sends.length,0); }
    else if (mode==='account_change'||mode==='network_change') {
      // A broad /network.*changed/ text locator also matches the untouched form
      // ("on this network ... cannot be changed") before the approval is sent.
      // Wait for the actual injected event and the old flow's post-approval
      // refresh instead, then verify that only the approval reached the wallet.
      await waitForFixture(() => state.changed && state.refreshes > 0,'wallet change and post-approval refresh');
      if (mode==='account_change') assert.equal(await page.evaluate(async () => (await window.ethereum.request({method:'eth_accounts'}))[0]),treasury);
      else await page.getByRole('button',{name:/Switch wallet to Robinhood Chain local fork/}).waitFor();
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true)))));
      assert.equal(state.sends.length,1); assert.equal(state.sends[0].approval,true); assert.equal(state.successful,false);
    }
    else if (mode==='simulation_failure') { await page.getByText(/Transaction simulation failed/).waitFor(); assert.equal(state.sends.length,1); }
    else if (mode==='two_tabs') {
      await waitForFixture(() => !!state.releaseApproval,'first tab holding the approval request');
      const second=await context.newPage(); activePage=second; second.on('pageerror',e=>pageErrors.push(e.message));
      await second.goto(origin+'/create?chainId=4663');
      await second.waitForFunction(() => !!localStorage.getItem('musegod.wallet.v1'));
      await second.getByLabel('Transaction hash from your wallet').waitFor();
      assert.equal(await second.getByRole('button',{name:'Review and continue',exact:true}).isDisabled(),true);
      assert(await second.evaluate(() => Object.keys(localStorage).some(key => key.startsWith('musegod.launch.submission.') &&
        JSON.parse(localStorage.getItem(key) || 'null')?.kind === 'approval')),
        'The in-flight approval must be visible to another tab before the wallet returns its hash');
      assert.equal(state.sends.length,1,'The second tab must not send another approval or launch for the locked intent');
      state.releaseApproval(); state.releaseApproval=null;
      await page.waitForURL('**/token/**'); assert.equal(state.sends.length,2); assert.equal(state.sends.filter(row=>!row.approval).length,1);
    }
    else if (mode==='unknown_send'||mode==='unknown_fetch') {
      await page.getByLabel('Transaction hash from your wallet').waitFor();
      const marker=await page.evaluate(() => Object.keys(localStorage).find(key=>key.startsWith('musegod.launch.submission.') && localStorage.getItem(key)));
      assert(marker,'An unknown wallet result must retain its intent-specific submission marker');
      assert.equal(state.sends.length,1);
      const second=await context.newPage(); activePage=second; second.on('pageerror',e=>pageErrors.push(e.message));
      await second.goto(origin+'/create?chainId=4663');
      await second.getByRole('button',{name:'Create another token',exact:true}).waitFor();
      assert.equal(await second.getByRole('button',{name:'Review and continue',exact:true}).isDisabled(),true);
      assert.equal(state.sends.length,1,'Reloading the same intent in another tab must not resend an unknown transaction');
      await second.getByRole('button',{name:'Create another token',exact:true}).click();
      await second.getByLabel('Token name',{exact:true}).fill('Independent intent');
      await second.getByLabel('Token symbol',{exact:true}).fill('NEXT');
      await second.getByRole('button',{name:'Continue',exact:true}).click();
      await second.getByRole('button',{name:'Review and continue',exact:true}).click();
      await second.getByRole('button',{name:'Confirm launch · Sign in wallet',exact:true}).click();
      await second.waitForURL('**/token/**'); assert.equal(state.sends.length,2); assert.equal(state.successful,true);
      assert(await second.evaluate(key=>!!localStorage.getItem(key),marker),'Completing the independent intent must preserve the older unknown result');
      const intents=state.sends.map(row=>state.byData.get(row.data)?.intentId);
      assert(intents.every(Boolean)); assert.notEqual(intents[0],intents[1]);
    }
    else if (mode==='approval_pending') {
      await page.getByLabel('Transaction hash from your wallet').waitFor();
      const marker=await page.evaluate(() => {
        const key=Object.keys(localStorage).find(key=>key.startsWith('musegod.launch.submission.') && localStorage.getItem(key));
        return { key,value:JSON.parse(localStorage.getItem(key)),history:JSON.parse(localStorage.getItem('musegod.transactions.v1')) };
      });
      assert.equal(marker.value.kind,'approval'); assert.equal(marker.value.hash,state.sends[0].hash);
      assert(marker.history.some(row=>row.hash===marker.value.hash && row.action==='approval' && row.intentId===marker.value.intentId));
      assert.equal(state.sends.length,1);
      await page.getByRole('button',{name:'Back to edit',exact:true}).first().click();
      assert.equal(await page.getByLabel('Transaction hash from your wallet').inputValue(),'');
      await page.getByRole('button',{name:'Recover pending launch',exact:true}).click();
      await page.getByText(/The approval is still confirming/).waitFor();
      assert(await page.evaluate(key=>!!localStorage.getItem(key),marker.key));
      state.approvalCanonical=true;
      await page.getByRole('button',{name:'Recover pending launch',exact:true}).click();
      await page.getByText('Approval confirmed. Your draft is saved; continue when you are ready.',{exact:true}).waitFor();
      assert.equal(await page.evaluate(key=>localStorage.getItem(key),marker.key),null);
      assert.equal(state.sends.length,1,'Checking a known hash never resends the approval');
    }
    else if (mode==='approval_unknown') {
      await page.getByLabel('Transaction hash from your wallet').waitFor();
      const marker = await page.evaluate(() => {
        const key = Object.keys(localStorage).find(key => key.startsWith('musegod.launch.submission.') && localStorage.getItem(key));
        return { key, value: JSON.parse(localStorage.getItem(key)) };
      });
      assert.equal(marker.value.kind,'approval'); assert.equal(marker.value.hash,undefined);
      assert.equal(marker.value.transaction.to.toLowerCase(),quote.address.toLowerCase());
      assert.equal(marker.value.transaction.data,state.sends[0].data); assert.equal(marker.value.transaction.value,'0');
      assert.equal(marker.value.planId,state.plan.id); assert.equal(state.sends.length,1);
      await page.getByRole('button',{name:'Back to edit',exact:true}).first().click();
      const second=await context.newPage(); activePage=second; second.on('pageerror',e=>pageErrors.push(e.message));
      await second.goto(origin+'/create?chainId=4663');
      await second.getByRole('button',{name:'Create another token',exact:true}).waitFor();
      assert.equal(await second.getByRole('button',{name:'Review and continue',exact:true}).isDisabled(),true);
      await second.getByRole('button',{name:'Create another token',exact:true}).click();
      await second.getByLabel('Token name',{exact:true}).fill('Independent approval intent');
      await second.getByLabel('Token symbol',{exact:true}).fill('NEXT');
      await second.getByRole('button',{name:'Continue',exact:true}).click();
      await second.getByRole('button',{name:'Review and continue',exact:true}).click();
      await second.getByRole('button',{name:'Confirm launch · Sign in wallet',exact:true}).click();
      await second.waitForURL('**/token/**'); assert.equal(state.sends.length,2);
      assert(await second.evaluate(key=>!!localStorage.getItem(key),marker.key),'The independent intent must preserve the unknown approval');
      // A wallet-supplied hash must match the exact approval, not a separately
      // successful launch. One-block receipts must not release the intent.
      activePage=page;
      await page.getByLabel('Transaction hash from your wallet').fill(state.sends[1].hash);
      await page.getByRole('button',{name:'Recover pending launch',exact:true}).click();
      await page.getByText(/does not match your saved approval/).waitFor();
      assert(await page.evaluate(key=>!!localStorage.getItem(key),marker.key));
      state.head=16n;
      await page.getByLabel('Transaction hash from your wallet').fill(state.sends[0].hash);
      await page.getByRole('button',{name:'Recover pending launch',exact:true}).click();
      await page.getByText(/The approval is still confirming/).waitFor();
      assert(await page.evaluate(key=>!!localStorage.getItem(key),marker.key));
      assert.equal(state.sends.length,2);
      state.head=32n;
      await page.getByRole('button',{name:'Recover pending launch',exact:true}).click();
      await page.getByText('Approval confirmed. Your draft is saved; continue when you are ready.',{exact:true}).waitFor();
      assert.equal(await page.evaluate(key=>localStorage.getItem(key),marker.key),null);
      assert.equal(await page.getByLabel('Token name',{exact:true}).inputValue(),'Browser approval_unknown');
      const history=await page.evaluate(()=>JSON.parse(localStorage.getItem('musegod.transactions.v1')));
      assert(history.some(row=>row.hash===state.sends[0].hash && row.action==='approval' && row.intentId===marker.value.intentId && row.status==='success'));
      assert.equal(state.sends.length,2,'Recovery only clears the proven marker and must not replay an approval or launch');
    }
    else if (mode==='pending') { await page.getByText(/still pending/).first().waitFor(); const plans=state.plans;
      await page.reload(); await page.getByRole('button',{name:'Recover pending launch'}).waitFor();
      assert.equal(await page.getByRole('button',{name:'Review and continue',exact:true}).isDisabled(),true);
      await page.getByText(/already submitted/).waitFor(); assert.equal(state.plans,plans);
      state.receipts=true; await page.getByRole('button',{name:'Recover pending launch'}).click(); await page.waitForURL('**/token/**'); assert.equal(state.plans,plans); }
    assert.equal(await page.getByRole('heading', {name:'Quick verification'}).isVisible(),false);
    if (state.successful && ['success','plain','wrap_flow','wrap_near_expiry','idle_review','hidden_review'].includes(mode)) {
      assert.equal(state.validationRequests.filter(request=>request.signing===true).length,state.sends.filter(sent=>!sent.wrap).length,
        'Only actual launch/approval wallet handoffs protect the frozen launch plan');
      assert(state.validationRequests.some(request=>request.signing!==true),'Unsigned simulation/preflight checks do not permanently protect previews');
    }
    assert.deepEqual(pageErrors,[]); report.checks.push({mode,viewport:'desktop',walletCalls:state.sends.length,plans:state.plans,
      ...(state.wrapping ? { businessConfirmations: state.businessConfirmations, paymentVerifications: state.paymentVerifications, reviewedMinimum: state.reviewedMinimum } : {}),
      ...(mode === 'delayed_config' ? { delayedConfigDraftPreserved: state.delayedConfigDraftPreserved, businessConfirmations: state.businessConfirmations } : {}),
      ...(timeoutModes.has(mode) ? { lateHashIntentPreserved: state.lateHashIntentPreserved,
        ...(state.lateRejectionIsolated ? { lateRejectionIsolated: true } : {}) } : {}),
      ...(recoveryRaceModes.has(mode) ? { concurrentRecordsPreserved: state.concurrentRecordsPreserved } : {}),
      ...(mode === 'wrap_late_launch_recovery' ? { lateFundedPaymentConsumed: state.lateFundedPaymentConsumed } : {}),
      ...(state.quietBackground ? { idleOrHiddenPollingStopped:true, continuedWithOneConfirmation:true } : {}),
      ...(state.singleTokenLookup ? { partialCatalogDidNotHideToken:true } : {}),
      ...(state.historyBackoff ? { trackRetryAfterHonoured:true, manualPendingCheckClearedBackoff:true } : {}),
      status:'passed'}); console.log('PASS browser: '+mode); await context.close();
  }
  const { context,page,state,pageErrors }=await casePage('success',{width:390,height:844});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  await page.screenshot({path:'.cache/launch-scoped-browser-mobile-review.png',fullPage:true}); report.screenshots.push('.cache/launch-scoped-browser-mobile-review.png');
  await page.getByRole('button',{name:'Confirm launch and first buy',exact:true}).click(); await page.waitForURL('**/token/**'); assert.equal(state.sends.length,2); assert.deepEqual(pageErrors,[]);
  report.checks.push({mode:'success',viewport:'mobile 390x844',walletCalls:2,status:'passed'}); await context.close();
  await writeFile('.cache/launch-scoped-browser.json',JSON.stringify(report,null,2)+'\n');
} catch (error) {
  if (activePage && !activePage.isClosed()) {
    await activePage.screenshot({ path: '.cache/launch-scoped-browser-failure.png', fullPage: true });
    console.error(await activePage.locator('body').innerText());
  }
  throw error;
} finally { await browser.close(); }
