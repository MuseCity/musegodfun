// Run against a local Vite preview of dist. API responses and elapsed time are controlled.
import assert from 'node:assert/strict';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const origin = new URL(process.env.BROWSER_ORIGIN || 'http://127.0.0.1:5191');
assert(['127.0.0.1', 'localhost'].includes(origin.hostname), 'The config recovery check must target a local server');

const address = '0x808C07de6dB60091b44D2Ed0e0f19FC2644A884a';
const path = `/token/robinhood/${address}`;
const api = '/api/chains/4663';
const now = Date.now();
const token = {
  address, name: 'Phial', symbol: 'PHIAL', description: 'Local fixture', image: '',
  quoteAddress: '0x6330d8c3178a418788df01a47479c0ce7ccf450b', creator: null,
  poolId: `0x${'1'.repeat(64)}`, transactionHash: null, blockNumber: null, createdAt: now,
  openingCap: '1.666666', mode: 'robinhood', deploymentChainId: 4663,
};
const config = { chainId: 4663, deploymentChainId: 4663, mode: 'robinhood', treasury: null, writesEnabled: false, blockReason: null };
const unavailable = 'Fixture network configuration unavailable';
let acceptingConfig = false, documentRequests = 0;
const configStatuses = [], quoteRequests = [], errors = [];

const browser = await chromium.launch({ headless: true });
try {
  const context = await browser.newContext({ serviceWorkers: 'block' });
  await context.routeWebSocket('**/*', (route) => route.close());
  await context.route('**/*', (route) => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin !== origin.origin) return route.abort();
    if (request.isNavigationRequest() && url.pathname === path) documentRequests++;
    if (!url.pathname.startsWith('/api/')) return route.continue();
    if (url.pathname === `${api}/quote` && request.method() === 'POST') {
      quoteRequests.push(request.postDataJSON());
      return route.fulfill({ json: { amountOut: '2000000000000000000' } });
    }
    if (request.method() !== 'GET') {
      errors.push(`Unexpected ${request.method()} ${url.pathname}`);
      return route.abort();
    }
    if (url.pathname === `${api}/config`) {
      const status = acceptingConfig ? 200 : 503;
      configStatuses.push(status);
      return acceptingConfig ? route.fulfill({ json: config })
        : route.fulfill({ status, headers: { 'retry-after': '0' }, json: { error: unavailable } });
    }
    if (url.pathname === `${api}/stocks`) return route.fulfill({ json: [] });
    if (url.pathname === `${api}/tokens`) return route.fulfill({ json: { items: [], nextCursor: null } });
    if (url.pathname === `${api}/tokens/${address}`) return route.fulfill({ json: { token, state: { poolKey: {} } } });
    if (url.pathname === `${api}/tokens/${address}/market/summary`) return route.fulfill({ json: {
      status: 'unavailable', reason: 'not_indexed', priceUsd: null, priceQuote: null, periods: {}, fetchedAt: new Date(now).toISOString(),
    } });
    return route.fulfill({ status: 404, json: { error: 'Not part of the local Phial fixture' } });
  });

  const page = await context.newPage();
  page.on('pageerror', (error) => errors.push(error.message));
  await page.clock.install({ time: new Date(now) });
  await page.goto(new URL(path, origin).href);
  const trade = page.getByRole('region', { name: 'Trade $PHIAL' });
  const configError = page.getByText(unavailable, { exact: true });
  await trade.waitFor({ state: 'visible' });
  await configError.waitFor({ state: 'visible' });
  assert.deepEqual(configStatuses, [503, 503, 503], 'the initial request and both built-in retries fail');
  assert.deepEqual(quoteRequests, [], 'the pool quote waits for configuration');
  assert.equal(await trade.getByText('Waiting for network configuration…', { exact: true }).isVisible(), true, 'the quote displays its waiting state');

  acceptingConfig = true;
  await page.clock.runFor(30_000);
  await trade.getByText('average for a 1-unit buy with 1 COIN', { exact: false }).waitFor({ state: 'visible', timeout: 5000 });
  assert.match(await trade.innerText(), /Average price: ≈ 0\.5 COIN per PHIAL/);
  assert.deepEqual(configStatuses, [503, 503, 503, 200], 'the open page fetches configuration again');
  assert.deepEqual(quoteRequests, [{ address, side: 'buy', amount: '1', slippageBps: 100 }], 'the recovered pool simulation uses 1 COIN');
  assert.equal(await configError.count(), 0, 'the configuration error clears after recovery');
  assert.equal(documentRequests, 1, 'the original document remains open');
  assert.equal(await page.getByRole('button', { name: 'Connect wallet', exact: true }).isVisible(), true);
  assert.deepEqual(errors, [], 'no browser runtime errors or unexpected API mutations');
  console.log('Passed Phial configuration recovery after three HTTP 503 responses in local Chromium.');
} finally {
  await browser.close();
}
