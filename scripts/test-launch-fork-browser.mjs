import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { createPublicClient, http, erc20Abi, decodeEventLog } from 'viem';
import { ROBINHOOD_STOCKS, sameAddress } from '../src/lib/config.ts';
import { CURVE_POLICY } from '../src/lib/launch-curve.ts';
import { launchGuardAbi } from '../src/lib/launch-guard.ts';

const context = JSON.parse(await readFile('.cache/launch-browser-context.json', 'utf8'));
assert(['127.0.0.1', 'localhost'].includes(new URL(context.rpc).hostname));
const client = createPublicClient({ transport: http(context.rpc, { timeout: 120000 }) });
assert.equal(await client.getChainId(), 31337);
const quote = ROBINHOOD_STOCKS.find(asset => asset.symbol === 'WETH');
const probe = createServer();
await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
const port = probe.address().port;
await new Promise(resolve => probe.close(resolve));
const origin = `http://127.0.0.1:${port}`;
await writeFile('.cache/launch-fork-browser-origin.txt', origin);
let rpcId = 0;
async function rpc(method, params = []) {
  const response = await fetch(context.rpc, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }) });
  const body = await response.json();
  if (body.error) throw new Error(body.error.message);
  return body.result;
}
const log = createWriteStream('.cache/launch-fork-browser-server.log');
const server = spawn(process.execPath, ['node_modules/tsx/dist/cli.mjs', 'server/index.ts'], {
  env: { ...process.env, NODE_ENV: 'production', PORT: String(port), CHAIN_MODE: 'fork', FORK_CHAIN_ID: '4663', FORK_RPC_URL: context.rpc,
    PLATFORM_TREASURY: context.treasury, LAUNCH_GUARD_ADDRESS: context.guard, DATA_DIR: context.dataDir,
    SUPABASE_URL: '', SUPABASE_SECRET_KEY: '', ENABLE_MAINNET_TRANSACTIONS: 'false' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
server.stdout.pipe(log); server.stderr.pipe(log);
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const browser = await chromium.launch({ headless: true });
const report = { observedAt: new Date().toISOString(), chainId: 31337, curvePolicy: CURVE_POLICY,
  scope: 'Actual local API, official contracts on isolated fork and local unlocked Anvil test account; no real user wallet, mainnet transaction or publication.',
  guard: context.guard, checks: [], productionPublication: 'not_run' };
let activePage;
try {
  for (let attempt = 0; attempt < 100; attempt++) {
    try { if ((await fetch(origin + '/api/config')).ok) break; } catch {}
    if (attempt === 99) throw new Error('Local acceptance server did not start');
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  console.log('LOCAL FORK BROWSER ' + origin);
  const config = await (await fetch(origin + '/api/config')).json();
  assert.equal(config.chainId, 31337); assert.equal(config.curvePolicy, CURVE_POLICY);
  assert(sameAddress(config.launchGuard, context.guard)); assert.equal(config.writesEnabled, true);
  const assetVerificationStarted = Date.now();
  const verifiedAssets = await (await fetch(origin + '/api/stocks', { signal: AbortSignal.timeout(300000) })).json();
  assert(verifiedAssets.find(asset => sameAddress(asset.address, quote.address))?.verified);
  report.assetVerification = { source: 'actual /api/stocks, warmed before browser navigation',
    count: verifiedAssets.length, verified: verifiedAssets.filter(asset => asset.verified).length,
    elapsedMs: Date.now() - assetVerificationStarted };
  console.log('PASS actual asset verification: ' + report.assetVerification.verified);
  for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
    const mobile = viewport.width < 500;
    const latest = await client.getBlock();
    const now = Math.floor(Date.now() / 1000);
    if (now > Number(latest.timestamp)) await rpc('evm_setNextBlockTimestamp', [now]);
    await rpc('anvil_mine', [1]);
    const browserContext = await browser.newContext({ viewport });
    const sends = []; let plan;
    await browserContext.exposeBinding('__localWalletRequest', async (_source, request) => {
      if (request.method === 'eth_accounts' || request.method === 'eth_requestAccounts') return [context.creator];
      if (request.method === 'eth_chainId') return '0x7a69';
      assert.equal(request.method, 'eth_sendTransaction', 'Local wallet only permits reviewed transaction requests');
      const transaction = request.params[0];
      assert(sameAddress(transaction.from, context.creator)); assert.equal(BigInt(transaction.value || 0), 0n);
      assert(sameAddress(transaction.to, context.guard) || sameAddress(transaction.to, quote.address));
      const hash = await rpc('eth_sendTransaction', [transaction]);
      sends.push({ ...transaction, hash });
      await rpc('anvil_mine', [2]);
      return hash;
    });
    await browserContext.addInitScript(() => {
      const provider = { on() {}, removeListener() {}, request: request => window.__localWalletRequest(request) };
      window.ethereum = provider;
      const announce = () => window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail: {
        info: { uuid: '22222222-3333-4444-8555-666666666666', name: 'Local fork test wallet', rdns: 'fun.musegod.forktest',
          icon: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB' }, provider } }));
      window.addEventListener('eip6963:requestProvider', announce); window.addEventListener('load', announce);
    });
    const page = await browserContext.newPage(); activePage = page;
    page.setDefaultTimeout(120000);
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    page.on('response', async response => {
      if (response.url().endsWith('/api/launch/prepare') && response.ok()) plan = await response.json();
    });
    await page.goto(origin + '/create');
    await page.getByText('Asset details · Contract identity verified', { exact: true }).waitFor();
    await page.getByLabel('Token name', { exact: true }).fill(mobile ? 'Local mobile curve' : 'Local desktop curve');
    await page.getByLabel('Token symbol', { exact: true }).fill(mobile ? 'MOBL' : 'DESK');
    await page.getByLabel('Spend WETH', { exact: true }).fill('0.0001');
    await page.getByRole('button', { name: 'Connect wallet', exact: true }).click();
    const choose = page.getByRole('button', { name: /Local fork test wallet/ });
    if (await choose.count()) await choose.click();
    await page.getByRole('button', { name: 'Review and continue', exact: true }).click();
    console.log('PASS fork browser parameter review: ' + (mobile ? 'mobile' : 'desktop'));
    await page.getByRole('button', { name: 'Preview launch and first buy', exact: true }).click();
    await page.getByRole('button', { name: 'Confirm launch and first buy', exact: true }).waitFor();
    console.log('PASS fork browser preview: ' + (mobile ? 'mobile' : 'desktop'));
    assert(plan?.firstBuy); assert.equal(plan.curvePolicy, CURVE_POLICY);
    const before = await client.readContract({ address: quote.address, abi: erc20Abi, functionName: 'balanceOf', args: [context.creator] });
    const screenshot = `docs/evidence/launch-curve-fork-${mobile ? 'mobile' : 'desktop'}-review.png`;
    await page.screenshot({ path: screenshot, fullPage: true });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.getByRole('button', { name: 'Confirm launch and first buy', exact: true }).click();
    await page.waitForURL('**/token/**');
    assert.equal(sends.length, 2, 'Exact guard approval followed by one protected launch');
    assert(sameAddress(sends[1].to, context.guard)); assert.equal(sends[1].data, plan.transaction.data);
    const receipt = await client.getTransactionReceipt({ hash: sends[1].hash });
    assert.equal(receipt.status, 'success');
    const after = await client.readContract({ address: quote.address, abi: erc20Abi, functionName: 'balanceOf', args: [context.creator] });
    const actualOut = await client.readContract({ address: plan.tokenAddress, abi: erc20Abi, functionName: 'balanceOf', args: [context.creator] });
    const remaining = await client.readContract({ address: quote.address, abi: erc20Abi, functionName: 'allowance', args: [context.creator, context.guard] });
    assert.equal(before - after, BigInt(plan.firstBuy.amountIn));
    assert.equal(actualOut, BigInt(plan.firstBuy.expectedAmountOut));
    assert(actualOut >= BigInt(plan.firstBuy.minAmountOut)); assert.equal(remaining, 0n);
    const guardEvents = receipt.logs.filter(item => sameAddress(item.address, context.guard)).map(item => decodeEventLog({ abi: launchGuardAbi, ...item }));
    assert.equal(guardEvents.length, 1); assert.equal(guardEvents[0].args.amountOut, actualOut);
    await page.reload(); await page.getByRole('heading', { name: plan.draft.name, exact: true }).waitFor();
    assert.deepEqual(errors, []);
    report.checks.push({ viewport, status: 'passed', token: plan.tokenAddress, poolId: plan.poolId, screenshot,
      approvalHash: sends[0].hash, launchHash: sends[1].hash, blockNumber: receipt.blockNumber.toString(),
      amountIn: plan.firstBuy.amountIn, expectedAmountOut: plan.firstBuy.expectedAmountOut,
      minAmountOut: plan.firstBuy.minAmountOut, actualAmountOut: actualOut.toString(), gasUsed: receipt.gasUsed.toString(),
      guardAllowanceAfter: remaining.toString(), reloadRegisteredToken: true });
    console.log(`PASS actual local-fork browser: ${mobile ? 'mobile' : 'desktop'}`);
    await browserContext.close();
  }
  await writeFile('docs/evidence/launch-curve-fork-browser.json', JSON.stringify(report, null, 2) + '\n');
} catch (error) {
  if (activePage && !activePage.isClosed()) {
    await activePage.screenshot({ path: '.cache/launch-fork-browser-failure.png', fullPage: true });
    console.error(await activePage.locator('body').innerText());
  }
  throw error;
} finally {
  await browser.close(); server.kill('SIGTERM'); log.end();
}
