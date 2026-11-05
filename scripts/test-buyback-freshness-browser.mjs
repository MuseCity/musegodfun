// Local browser regression only: fixed API fixtures, simulated time, no wallet or external reads.
import assert from 'node:assert/strict';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const origin = process.env.BROWSER_ORIGIN || 'http://127.0.0.1:5191';
assert(['127.0.0.1', 'localhost'].includes(new URL(origin).hostname), 'The freshness check must target a local server');
const startedAt = Date.parse('2026-11-02T08:00:00.000Z');
const address = (value) => `0x${value.repeat(40)}`;
const baseSummary = {
  chainId: 4663, scope: 'shared_robinhood', available: true,
  checkedAt: startedAt - 9000, blockNumber: '200', treasury: address('1'), vault: address('2'),
  tokenAddress: address('3'), burnAddress: address('4'), treasuryWeth: '0', vaultWeth: '0',
  vaultSpentWeth: '0', vaultMuseToDead: '0', deadTotalMuse: '100000000000000000000',
  totalSupply: '1000000000000000000000',
};
const baseEngine = {
  available: true, reason: null, checkedAt: startedAt - 5000, blockNumber: '100',
  engine: address('5'), swapper: address('6'), executor: address('7'), vault: address('2'),
  operationsTreasury: address('1'), automationReceiver: address('8'), automationTreasury: address('9'),
  wethForwarder: address('a'), assetOracle: address('b'), sourceDeployed: true,
  sourceWeth: '0', sourceAllowance: '0', sourceForwarded: '0', sourceAvailable: '0',
  swapperWeth: '0', directBurned: null, convertedWeth: null, vaultWeth: '0', vaultAvailable: '0',
  vaultSpent: '0', assets: [], feedProposals: [], burns: [], burnScanFrom: null,
  pools: [
    { address: address('c'), poolId: `0x${'1'.repeat(64)}`, symbol: 'MV2C',
      claimable: [{ address: address('d'), symbol: 'COST', decimals: 18, lp: null, hook: '0',
        lpError: 'LP preview unavailable: runtime request budget exceeded. No zero balance is assumed.' },
      { address: address('c'), symbol: 'MV2C', decimals: 18, lp: null, hook: '0',
        lpError: 'LP preview unavailable: runtime request budget exceeded. No zero balance is assumed.' }] },
    { address: address('e'), poolId: `0x${'2'.repeat(64)}`, symbol: 'WHOLE', claimable: null,
      claimableError: 'Pool state unavailable: RPC timeout. No zero balance is assumed.' },
  ],
};
const config = { mode: 'robinhood', chainId: 4663, deploymentChainId: 4663,
  treasury: address('1'), writesEnabled: false, blockReason: null, feeEngine: address('5') };
const reads = { price: 0, engine: 0, summary: 0 };
let unavailableSummary = false;
const browser = await chromium.launch({ headless: true });
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  await context.route('**/*', async (route) => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin !== origin) return route.abort();
    if (!url.pathname.startsWith('/api/')) return route.continue();
    assert.equal(request.method(), 'GET', 'the check must never submit an API mutation');
    let body, status = 200;
    if (url.pathname.endsWith('/config')) body = config;
    else if (url.pathname.endsWith('/tokens')) body = { items: [], nextCursor: null };
    else if (url.pathname.endsWith('/stocks')) body = [];
    else if (url.pathname.endsWith('/musegod/market/summary')) {
      const read = ++reads.price;
      if (read === 3) { status = 500; body = { error: 'Price fixture temporarily unavailable' }; }
      else body = { status: 'fresh', source: 'Bankr', priceUsd: read === 1 ? 2 : read === 2 ? 3 : 4,
        fetchedAt: new Date(read === 1 ? startedAt - 7000 : read === 2 ? startedAt + 30000 : startedAt + 90000).toISOString(),
        fdvUsd: null, marketCapUsd: null, liquidityUsd: null, periods: {} };
    } else if (url.pathname.endsWith('/buyback/engine')) {
      const read = ++reads.engine;
      if (read === 2) { status = 500; body = { error: 'Engine fixture temporarily unavailable' }; }
      else body = read === 1 ? baseEngine : { ...baseEngine, checkedAt: startedAt + 240000, blockNumber: '102',
        pools: baseEngine.pools.map((pool, index) => index ? pool : { ...pool,
          claimable: pool.claimable.map(({ lpError, ...asset }, assetIndex) => ({ ...asset, lp: assetIndex ? '2000000000000000000' : '1000000000000000000' })) }) };
    } else if (url.pathname.endsWith('/buyback/summary')) {
      const read = ++reads.summary;
      if (unavailableSummary) body = { ...baseSummary, available: false, checkedAt: startedAt,
        blockNumber: null, deadTotalMuse: null, totalSupply: null, error: 'Unavailable totals fixture' };
      else if (read === 3) { status = 500; body = { error: 'Totals fixture temporarily unavailable' }; }
      // The second response intentionally reuses the same cached source sample.
      else body = read < 4 ? baseSummary : { ...baseSummary, checkedAt: startedAt + 900000,
        blockNumber: '203', deadTotalMuse: '200000000000000000000' };
    } else { status = 404; body = { error: 'Not part of the local freshness fixture' }; }
    return route.fulfill({ status, json: body });
  });
  const page = await context.newPage();
  page.on('pageerror', (error) => errors.push(error.message));
  const pendingRequests = new Set();
  page.on('request', (request) => { if (new URL(request.url()).pathname.startsWith('/api/')) pendingRequests.add(request); });
  page.on('requestfinished', (request) => pendingRequests.delete(request));
  page.on('requestfailed', (request) => pendingRequests.delete(request));
  await page.clock.install({ time: new Date(startedAt) });
  await page.goto(`${origin}/buyback?chainId=4663`);
  const hero = page.locator('.burn-hero'), engine = page.locator('.engine-activity');
  const price = page.locator('.burn-stats > div').nth(1);
  const totalsTime = hero.locator('.burn-total time');
  const priceTime = price.locator('time');
  const engineTime = engine.locator('time');
  const delayedEngine = engine.getByText('Buyback engine updates are delayed.', { exact: false });
  const delayedTotals = hero.getByText('Robinhood buyback totals are delayed.', { exact: false });
  let checks = 0;
  async function textIncludes(locator, value, label) {
    await locator.filter({ hasText: value }).waitFor({ state: 'visible' });
    assert.match(await locator.innerText(), value, label); checks++;
  }
  async function timestamp(locator, expected, label) {
    await locator.waitFor({ state: 'visible' });
    assert.equal(await locator.getAttribute('datetime'), new Date(expected).toISOString(), label); checks++;
  }
  async function advance(ms, expected) {
    // Let each HTTP response finish before the next virtual interval; advancing minutes in one
    // synchronous jump would intentionally exercise the overlap guard instead of normal polling.
    for (let remaining = ms; remaining > 0; remaining -= 30000) {
      await page.clock.runFor(Math.min(remaining, 30000));
      const until = Date.now() + 5000;
      while (pendingRequests.size && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 10));
      assert.equal(pendingRequests.size, 0, 'local fixture requests complete before the next interval');
      await page.evaluate(() => Promise.resolve());
    }
    for (const [key, count] of Object.entries(expected)) assert.equal(reads[key], count, `${key} polling count`);
  }
  await textIncludes(hero.locator('.burn-caption'), /block 200/, 'totals source block');
  await textIncludes(engine, /Balances at block 100/, 'engine source block');
  await timestamp(totalsTime, baseSummary.checkedAt, 'totals source sample time');
  await timestamp(priceTime, startedAt - 7000, 'price source sample time');
  await timestamp(engineTime, baseEngine.checkedAt, 'engine source sample time');
  await textIncludes(price, /at \$2 per MUSEGOD/, 'initial price');
  const partialPool = page.locator('.stage-item').filter({ hasText: 'MV2C' });
  await textIncludes(partialPool, /COST LP Unavailable · Hook 0/, 'unavailable LP and genuine zero Hook stay distinct');
  await textIncludes(partialPool, /MV2C LP Unavailable · Hook 0/, 'both failed LP currencies retain their healthy Hook side');
  await textIncludes(partialPool, /LP preview unavailable: runtime request budget exceeded/, 'LP request-budget failure cause');
  await textIncludes(partialPool, /Some pending amounts are unavailable; no zero balance is assumed/, 'partial preview warning');
  for (const name of ['Collect', 'Sync received']) {
    assert.equal(await partialPool.getByRole('button', { name, exact: true }).isDisabled(), true, `${name} remains disabled without a wallet`); checks++;
  }
  await textIncludes(page.locator('.stage-item').filter({ hasText: 'WHOLE' }), /Pending amounts unavailable; no zero balance is assumed\. Pool state unavailable: RPC timeout/, 'whole preview failure cause');

  await advance(30000, { price: 2, engine: 1, summary: 1 });
  await textIncludes(price, /at \$3 per MUSEGOD/, '30-second price update');
  await timestamp(priceTime, startedAt + 30000, 'new price sample time');
  await advance(30000, { price: 3, engine: 1, summary: 1 });
  await textIncludes(price, /at \$3 per MUSEGOD · previous snapshot/, 'failed price poll retains the prior price and labels it');
  await timestamp(priceTime, startedAt + 30000, 'failure does not advance price sample time');
  await advance(30000, { price: 4, engine: 1, summary: 1 });
  await textIncludes(price, /at \$4 per MUSEGOD/, 'price recovers on the next poll');
  assert.doesNotMatch(await price.innerText(), /previous snapshot/, 'price recovery clears stale marker'); checks++;

  await advance(30000, { price: 5, engine: 2, summary: 1 });
  await delayedEngine.waitFor({ state: 'visible' });
  await textIncludes(engine, /Balances at block 100/, 'failed engine poll retains the prior block');
  await textIncludes(engine, /delayed; previous values/, 'failed engine poll labels retained values');
  await timestamp(engineTime, baseEngine.checkedAt, 'failure does not advance engine sample time');
  await textIncludes(partialPool, /COST LP Unavailable · Hook 0/, 'failed refresh retains the healthy COST Hook side');
  await textIncludes(partialPool, /MV2C LP Unavailable · Hook 0/, 'failed refresh retains the healthy MV2C Hook side');
  await advance(120000, { price: 9, engine: 3, summary: 1 });
  await textIncludes(engine, /Balances at block 102/, 'engine recovers on the next poll');
  await delayedEngine.waitFor({ state: 'detached' });
  await timestamp(engineTime, startedAt + 240000, 'recovered engine sample time');
  await textIncludes(partialPool, /COST LP 1 · Hook 0/, 'automatic retry restores the COST LP amount and preserves true Hook zero');
  await textIncludes(partialPool, /MV2C LP 2 · Hook 0/, 'automatic retry restores the MV2C LP amount and preserves true Hook zero');
  assert.doesNotMatch(await partialPool.innerText(), /Unavailable|unavailable|runtime request budget exceeded/, 'recovered fee previews clear failure diagnostics'); checks++;
  for (const name of ['Collect', 'Sync received']) {
    assert.equal(await partialPool.getByRole('button', { name, exact: true }).isDisabled(), true, `${name} remains disabled without a wallet after recovery`); checks++;
  }

  await advance(60000, { price: 11, engine: 3, summary: 2 });
  await timestamp(totalsTime, baseSummary.checkedAt, 'cached totals keep their original sample time');
  await textIncludes(hero.locator('.burn-caption'), /block 200/, 'cached totals keep their original block');
  await advance(300000, { price: 21, engine: 6, summary: 3 });
  await delayedTotals.waitFor({ state: 'visible' });
  await textIncludes(hero.locator('.burn-total'), /delayed; previous values/, 'failed totals poll labels retained values');
  await textIncludes(hero.locator('.burn-caption'), /block 200/, 'failed totals poll retains the prior block');
  await timestamp(totalsTime, baseSummary.checkedAt, 'failure does not advance totals sample time');
  await advance(300000, { price: 31, engine: 8, summary: 4 });
  await textIncludes(hero.locator('.burn-caption'), /block 203/, 'totals recover on the next poll');
  await delayedTotals.waitFor({ state: 'detached' });
  await timestamp(totalsTime, startedAt + 900000, 'recovered totals sample time');
  assert.doesNotMatch(await hero.locator('.burn-total').innerText(), /delayed; previous values/, 'totals recovery clears stale marker'); checks++;
  unavailableSummary = true;
  const unavailablePage = await context.newPage();
  unavailablePage.on('pageerror', (error) => errors.push(error.message));
  await unavailablePage.clock.install({ time: new Date(startedAt) });
  await unavailablePage.goto(`${origin}/buyback?chainId=4663`);
  const unavailableTotals = unavailablePage.locator('.burn-total');
  await unavailableTotals.getByText('The dead-address balance could not be read.', { exact: false }).waitFor({ state: 'visible' });
  assert.equal(await unavailableTotals.locator('time').count(), 0, 'a failed first read is not presented as a source sample'); checks++;
  assert.doesNotMatch(await unavailableTotals.innerText(), /Totals snapshot/, 'no snapshot label without a successful block read'); checks++;
  await unavailablePage.close();
  assert.deepEqual(errors, [], 'no browser runtime errors');
  console.log(`Passed ${checks} buyback freshness checks in local Chromium (${JSON.stringify(reads)}; fixture API and simulated time; no wallet or external requests).`);
} finally {
  await browser.close();
}
