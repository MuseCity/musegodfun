import assert from 'node:assert/strict';
import { writeFile, mkdir } from 'node:fs/promises';
import { DopplerSDK, computePoolId, airlockAbi } from '@whetstone-research/doppler-sdk/evm';
import { createPublicClient, http, encodeFunctionData, erc20Abi, keccak256, toHex } from 'viem';
import { ROBINHOOD_STOCKS, ROBINHOOD_CONTRACTS, ROBINHOOD_BUNDLER, SUPPLY } from '../src/lib/config.ts';
import { CURVE_POLICY } from '../src/lib/launch-curve.ts';
import { OPENING_POLICY } from '../src/lib/opening-valuation.ts';
import { FEE_POLICY } from '../src/lib/fee-policy.ts';
import { launchGuardAbi } from '../src/lib/launch-guard.ts';
import { buildLaunch } from '../src/lib/protocol.ts';
import { serializePrepared } from '../src/lib/launch-plan.ts';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const origin = process.env.BROWSER_ORIGIN || 'http://127.0.0.1:5191';
assert(['127.0.0.1', 'localhost'].includes(new URL(origin).hostname), 'Browser acceptance must target a local server');
const creator = '0x1111111111111111111111111111111111111111', treasury = '0x2222222222222222222222222222222222222222';
const guard = '0x3333333333333333333333333333333333333333', token = '0x4444444444444444444444444444444444444444';
const quote = ROBINHOOD_STOCKS.find(x => x.symbol === 'WETH');
const contracts = ROBINHOOD_CONTRACTS;
const blockHash = '0x' + 'bb'.repeat(32), out = 543327925691014316198420n;
const sdk = new DopplerSDK({ chainId: 4663, publicClient: createPublicClient({ transport: http('http://127.0.0.1:1') }) });
const config = { mode: 'fork', chainId: 31337, deploymentChainId: 4663, treasury, writesEnabled: true, blockReason: null, curvePolicy: CURVE_POLICY, launchGuard: guard };
const report = { scope: 'Local browser UI with explicitly injected wallet/API/RPC fixtures. No real-wallet or chain settlement proof.', observedAt: new Date().toISOString(), origin, checks: [], screenshots: [], productionPublication: 'not_run' };
const browser = await chromium.launch({ headless: true });
let activePage;
await mkdir('docs/evidence', { recursive: true });
function preparedPlan(draft, buy, run) {
  const now = Date.now(), openingValuation = { policy: OPENING_POLICY, marketCapUsd: 5000, chainId: 4663, quoteAddress: draft.quoteAddress, quotePriceUsd: '3000', quotedAt: now, expiresAt: now + 300000, source: 'Chainlink', blockNumber: '16', blockHash, sourceUpdatedAt: now - 1000, feed: treasury };
  const params = sdk.factory.encodeCreateMulticurveParams(buildLaunch(sdk, draft, creator, treasury, treasury, openingValuation, keccak256(toHex(`browser-${run}`)), 4663));
  const amountIn = BigInt(Math.round(Number(buy?.amount || '0') * 1e18));
  const poolKey = { currency0: token, currency1: draft.quoteAddress, fee: 8388608, tickSpacing: 10, hooks: contracts.initializer };
  const poolId = computePoolId(poolKey), deadline = Math.floor(openingValuation.expiresAt / 1000);
  const min = out * BigInt(10000 - (buy?.slippageBps || 100)) / 10000n;
  const transaction = amountIn ? { to: guard, data: encodeFunctionData({ abi: launchGuardAbi, functionName: 'createAndBuy', args: [params, amountIn, min, BigInt(deadline)] }), value: 0n }
    : { to: contracts.airlock, data: encodeFunctionData({ abi: airlockAbi, functionName: 'create', args: [params] }), value: 0n };
  const approvalTransaction = amountIn ? { to: draft.quoteAddress, data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [guard, amountIn] }), value: 0n } : undefined;
  const prepared = { chainId: 4663, account: creator, airlock: contracts.airlock, createParams: params, prediction: { tokenAddress: token, poolOrHookAddress: token, governanceAddress: treasury, timelockAddress: treasury, poolKey, poolId, tokenIsCurrency0: true }, transaction, approvalTransaction,
    devBuy: amountIn ? { exactAmountIn: amountIn, recipient: creator, vesting: { permissionlessClaim: false, cliffDuration: 0n, vestingDuration: 0n }, bundler: ROBINHOOD_BUNDLER, simulatedAmountOut: out } : undefined, gasEstimate: { status: 'unavailable' } };
  return { id: keccak256(transaction.data), creator, data: transaction.data, tokenAddress: token, poolId, draft, preparedAt: now, gas: null, openingValuation, feePolicy: FEE_POLICY, feeTreasury: treasury, curvePolicy: CURVE_POLICY, prepared: serializePrepared(prepared), transaction: { ...transaction, value: '0' },
    firstBuy: amountIn ? { amount: buy.amount, amountIn: amountIn.toString(), expectedAmountOut: out.toString(), minAmountOut: min.toString(), slippageBps: buy.slippageBps, deadline, recipient: creator, quoteAddress: draft.quoteAddress, guard, bundler: ROBINHOOD_BUNDLER } : undefined,
    approval: amountIn ? { token: draft.quoteAddress, spender: guard, amount: amountIn.toString(), required: true, transaction: { ...approvalTransaction, value: '0' } } : undefined };
}
function block() { return { number: '0x20', hash: blockHash, parentHash: blockHash, timestamp: toHex(Math.floor(Date.now()/1000)), gasLimit: '0x5f5e100', gasUsed: '0x0', baseFeePerGas: '0x1', difficulty: '0x0', totalDifficulty: '0x0', size: '0x0', extraData: '0x', logsBloom: '0x'+'00'.repeat(256), transactions: [] }; }
async function casePage(mode, viewport = { width: 1440, height: 1000 }) {
  const context = await browser.newContext({ viewport });
  const state = { mode, allowance: 0n, sends: [], plans: 0, expired: false, receipts: mode !== 'pending', plan: null, successful: false };
  await context.addInitScript(({ creator, treasury, mode }) => {
    const listeners = new Map();
    const provider = { on(name, fn) { const list = listeners.get(name) || []; list.push(fn); listeners.set(name,list); }, removeListener(name, fn) { listeners.set(name,(listeners.get(name)||[]).filter(x=>x!==fn)); },
      async request(request) {
        if (request.method === 'eth_accounts' || request.method === 'eth_requestAccounts') return [creator];
        if (request.method === 'eth_chainId') return '0x7a69';
        if (request.method === 'eth_sendTransaction') {
          const result = await window.__testSend(request.params[0]);
          if (result.reject) { const error = new Error('User rejected the request'); error.code = 4001; throw error; }
          if (result.changeAccount) for (const fn of listeners.get('accountsChanged') || []) fn([treasury]);
          if (result.changeChain) for (const fn of listeners.get('chainChanged') || []) fn('0x1');
          return result.hash;
        }
        throw new Error('Unexpected local fixture wallet method ' + request.method);
      } };
    window.ethereum = provider;
    const announce = () => window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail: { info: { uuid: '11111111-2222-4333-8444-555555555555', name: 'Local acceptance wallet', rdns: 'fun.musegod.localtest', icon: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB' }, provider } }));
    window.addEventListener('eip6963:requestProvider', announce); window.addEventListener('load', announce);
    if (mode === 'pending') { const native = window.setTimeout; window.setTimeout = (fn, ms, ...args) => native(fn, ms === 120000 ? 700 : ms, ...args); }
  }, { creator, treasury, mode });
  await context.exposeBinding('__testSend', async (_source, tx) => {
    const approval = tx.to.toLowerCase() === quote.address.toLowerCase();
    if (approval && mode === 'reject_approval') return { reject: true };
    const hash = keccak256(toHex(`browser-send-${mode}-${state.sends.length}`)); state.sends.push({ ...tx, hash, approval });
    if (approval) { state.allowance = BigInt(state.plan.firstBuy.amountIn); if (mode === 'expiry') state.expired = true; }
    return { hash, changeAccount: approval && mode === 'account_change', changeChain: approval && mode === 'network_change' };
  });
  await context.route('**/api/**', async route => {
    const url = new URL(route.request().url()); const path = url.pathname; const payload = route.request().method() === 'POST' ? route.request().postDataJSON() : null;
    const reply = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (path === '/api/config') return reply(mode === 'stale_page' ? { ...config, curvePolicy: 'old-curve-v1' } : config);
    if (path === '/api/stocks') return reply(ROBINHOOD_STOCKS.map(x=>({ ...x, verified: true, blockNumber: '16', totalSupply: '1000000000000000000000000', multiplierWad: null })));
    if (path === '/api/tokens') return reply([]);
    if (path === '/api/launch/prepare') { assert.equal(payload.expectedCurvePolicy, CURVE_POLICY); state.plans++; state.expired=false; state.plan=preparedPlan(payload.draft,payload.firstBuy,state.plans); return reply(state.plan); }
    if (path === '/api/launch/validate') return state.expired ? reply({ error: 'The opening valuation price expired. Run a new simulation.' },400) : reply({ valid: true, feePolicy: FEE_POLICY, curvePolicy: CURVE_POLICY });
    if (path === '/api/launch/simulate') return mode === 'simulation_failure' ? reply({ error: 'Transaction simulation failed. The transaction was not submitted.' },400) : reply({ valid: true, gas: '5000000', amountOut: state.plan.firstBuy?.expectedAmountOut || null, simulatedAt: Date.now() });
    if (path === '/api/launch/track') return reply({ status:'pending' },202);
    if (path === '/api/launch/register') { if (!state.receipts) return reply({ error:'receipt pending' },400); state.successful=true; return reply({ ...state.plan.draft, address:token, creator, poolId:state.plan.poolId, transactionHash:payload.hash, blockNumber:'16', createdAt:Date.now(), mode:'fork', deploymentChainId:4663, openingCap:'1.666666', openingValuation:state.plan.openingValuation, curvePolicy:CURVE_POLICY, feePolicy:FEE_POLICY, feeTreasury:treasury }); }
    if (path === '/api/rpc') {
      const one = item => {
        let result;
        if (item.method === 'eth_chainId') result='0x7a69';
        else if (item.method === 'eth_blockNumber') result='0x20';
        else if (item.method === 'eth_getBlockByNumber' || item.method === 'eth_getBlockByHash') result=block();
        else if (item.method === 'eth_getBalance') result=toHex(10n**20n);
        else if (item.method === 'eth_estimateGas') result='0xea60';
        else if (item.method === 'eth_call') { const data=item.params[0].data; result=toHex(data.startsWith('0xdd62ed3e') ? state.allowance : 10n**20n,{size:32}); }
        else if (item.method === 'eth_getTransactionCount') result=toHex(state.sends.length);
        else if (item.method === 'eth_getCode') result='0x';
        else if (item.method === 'eth_getTransactionReceipt') { const sent=state.sends.find(x=>x.hash===item.params[0]); result=!sent || (!sent.approval&&!state.receipts) ? null : { transactionHash:sent.hash, transactionIndex:'0x0', blockHash, blockNumber:'0x10', from:creator, to:sent.to, cumulativeGasUsed:'0xea60', gasUsed:'0xea60', contractAddress:null, logs:[], logsBloom:'0x'+'00'.repeat(256), status:'0x1', effectiveGasPrice:'0x1', type:'0x2' }; }
        else if (item.method === 'eth_getTransactionByHash') { const sent=state.sends.find(x=>x.hash===item.params[0]); result=sent ? { hash:sent.hash, from:creator, to:sent.to, input:sent.data, value:'0x0', nonce:'0x0', gas:'0xea60', gasPrice:'0x1', blockHash, blockNumber:'0x10', transactionIndex:'0x0', type:'0x0', v:'0x1b', r:'0x1', s:'0x1' } : null; }
        else throw new Error('Unexpected fixture RPC '+item.method);
        return { jsonrpc:'2.0',id:item.id,result };
      }; return reply(Array.isArray(payload)?payload.map(one):one(payload));
    }
    if (path.startsWith('/api/tokens/')) return reply({ token:{ ...state.plan?.draft,address:token,creator,poolId:state.plan?.poolId,quoteAddress:quote.address,mode:'fork',deploymentChainId:4663,openingCap:'1.666666',openingValuation:state.plan?.openingValuation,curvePolicy:CURVE_POLICY,feePolicy:FEE_POLICY },state:{status:2,numeraire:quote.address,poolKey:{currency0:token,currency1:quote.address,fee:8388608,tickSpacing:10,hooks:contracts.initializer}} });
    if (path.includes('/fees')) return reply({ lp:{amount0:'0',amount1:'0'},trade:{amount0:'0',amount1:'0'} });
    return reply({ error:'Unavailable fixture route' },404);
  });
  const page = await context.newPage(); activePage = page; const pageErrors=[]; page.on('pageerror',e=>pageErrors.push(e.message));
  await page.goto(origin+'/create'); await page.getByLabel('Token name',{exact:true}).fill('Browser '+mode);
  await page.getByLabel('Token symbol',{exact:true}).fill('BROWSE'); await page.getByLabel('Spend WETH',{exact:true}).fill(mode==='plain'?'0':'0.001');
  await page.getByRole('button',{name:'Connect wallet',exact:true}).click();
  const choose=page.getByRole('button',{name:/Local acceptance wallet/}); if (await choose.count()) await choose.click();
  await page.getByRole('button',{name:'Review and continue',exact:true}).click();
  await page.getByRole('button',{name:mode==='plain'?'Simulate launch':'Preview launch and first buy',exact:true}).click();
  if (mode === 'stale_page') return { context,page,state,pageErrors };
  await page.getByRole('button',{name:mode==='plain'?/Confirm launch · Sign in wallet/:/Confirm launch and first buy/,exact:true}).waitFor();
  return { context,page,state,pageErrors };
}
try {
  for (const mode of (process.env.BROWSER_CASES?.split(',') || ['success','plain','duplicate','stale_page','reject_approval','expiry','account_change','network_change','simulation_failure','pending'])) {
    const {context,page,state,pageErrors}=await casePage(mode);
    if (mode === 'success') {
      await page.screenshot({path:'docs/evidence/launch-curve-desktop-review.png',fullPage:true});
      report.screenshots.push('launch-curve-desktop-review.png');
    }
    if (mode === 'stale_page') {
      await page.getByText(/curve policy has changed/).waitFor(); assert.equal(state.plans,0); assert.equal(state.sends.length,0);
    }
    else if (mode === 'duplicate') await page.getByRole('button',{name:'Confirm launch and first buy',exact:true}).evaluate(button => { button.click(); button.click(); });
    else await page.getByRole('button',{name:mode==='plain'?/Confirm launch · Sign in wallet/:/Confirm launch and first buy/,exact:true}).click();
    if (mode==='success'||mode==='plain'||mode==='duplicate') { await page.waitForURL('**/token/**'); assert.equal(state.sends.length,mode==='plain'?1:2); assert.equal(state.successful,true); }
    else if (mode==='reject_approval') { await page.getByText(/cancelled the wallet request|User rejected the request/).first().waitFor(); assert.equal(state.sends.length,0); }
    else if (mode==='expiry') { await page.getByText(/price expired/).waitFor(); assert.equal(state.sends.length,1); }
    else if (mode==='account_change'||mode==='network_change') { await page.getByText(/draft or wallet has changed|wallet has changed|network.*changed/i).first().waitFor(); assert.equal(state.sends.length,1); }
    else if (mode==='simulation_failure') { await page.getByText(/Transaction simulation failed/).waitFor(); assert.equal(state.sends.length,1); }
    else if (mode==='pending') { await page.getByText(/still pending/).first().waitFor(); const plans=state.plans;
      await page.reload(); await page.getByRole('button',{name:'Recover pending launch'}).waitFor();
      assert.equal(await page.getByRole('button',{name:'Review and continue',exact:true}).isDisabled(),true);
      await page.getByText(/already submitted/).waitFor(); assert.equal(state.plans,plans);
      state.receipts=true; await page.getByRole('button',{name:'Recover pending launch'}).click(); await page.waitForURL('**/token/**'); assert.equal(state.plans,plans); }
    assert.deepEqual(pageErrors,[]); report.checks.push({mode,viewport:'desktop',walletCalls:state.sends.length,plans:state.plans,status:'passed'}); console.log('PASS browser: '+mode); await context.close();
  }
  const { context,page,state,pageErrors }=await casePage('success',{width:390,height:844});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  await page.screenshot({path:'docs/evidence/launch-curve-mobile-review.png',fullPage:true}); report.screenshots.push('launch-curve-mobile-review.png');
  await page.getByRole('button',{name:'Confirm launch and first buy',exact:true}).click(); await page.waitForURL('**/token/**'); assert.equal(state.sends.length,2); assert.deepEqual(pageErrors,[]);
  report.checks.push({mode:'success',viewport:'mobile 390x844',walletCalls:2,status:'passed'}); await context.close();
  await writeFile('docs/evidence/launch-curve-browser.json',JSON.stringify(report,null,2)+'\n');
} catch (error) {
  if (activePage && !activePage.isClosed()) {
    await activePage.screenshot({ path: '.cache/launch-browser-failure.png', fullPage: true });
    console.error(await activePage.locator('body').innerText());
  }
  throw error;
} finally { await browser.close(); }
