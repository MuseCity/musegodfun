// Run against a local Vite preview of dist. API data is a fixture; external requests are blocked.
// Exercises the real browser dialog, keyboard focus and Tab order without a wallet or transactions.
import assert from 'node:assert/strict';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const origin = process.env.BROWSER_ORIGIN || 'http://127.0.0.1:5191';
assert(['127.0.0.1', 'localhost'].includes(new URL(origin).hostname), 'The help focus check must target a local server');
const browser = await chromium.launch({ headless: true });
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  await context.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== origin) return route.abort();
    if (!url.pathname.startsWith('/api/')) return route.continue();
    const body = url.pathname.endsWith('/config')
      ? { mode: 'robinhood', chainId: 4663, deploymentChainId: 4663, treasury: null, writesEnabled: false, blockReason: null }
      : url.pathname.endsWith('/tokens') ? { items: [], nextCursor: null }
      : url.pathname.endsWith('/stocks') ? [] : null;
    return route.fulfill({ status: body === null ? 404 : 200, json: body ?? { error: 'Unavailable in the local focus fixture' } });
  });
  const page = await context.newPage();
  page.on('pageerror', (error) => errors.push(error.message));
  // A role locator stops matching as soon as close() hides the dialog, before its queued close event.
  // Use the DOM node so the checks wait for React to actually unmount it and finish restoring focus.
  const dialog = page.locator('dialog[aria-labelledby="help-title"]');
  const close = page.getByRole('button', { name: 'Close help', exact: true });
  const gotIt = page.getByRole('button', { name: 'Got it', exact: true });
  async function focused(locator, label) {
    assert(await locator.evaluate((node) => node === document.activeElement), label);
  }
  const entries = [
    ['/rewards?chainId=4663', '.sidebar-help'],
    ['/rewards?chainId=4663', '.footer-links button'],
    ['/?chainId=4663', '.how-card button'],
  ];
  let checks = 0;
  for (const [path, selector] of entries) {
    await page.goto(`${origin}${path}`);
    const trigger = page.locator(selector);
    await trigger.waitFor({ state: 'visible' });
    // Measure the existing next Tab stop before opening, rather than assuming a fixed page layout.
    await trigger.focus();
    await page.keyboard.press('Tab');
    const next = await page.evaluateHandle(() => document.activeElement);
    for (const exit of ['Escape', 'Close help', 'Got it']) {
      // The second opening must capture the same entrance again after a complete close/unmount.
      for (let repeat = 0; repeat < 2; repeat++) {
        await trigger.focus();
        await page.keyboard.press('Enter');
        await dialog.waitFor({ state: 'visible' });
        await focused(close, `${selector}: initial focus is Close help`);
        if (exit === 'Escape') await page.keyboard.press('Escape');
        else {
          if (exit === 'Got it') {
            await page.keyboard.press('Tab');
            await focused(gotIt, `${selector}: Tab reaches Got it`);
          }
          await page.keyboard.press('Enter');
        }
        await dialog.waitFor({ state: 'detached' });
        await focused(trigger, `${selector}: ${exit} restores the actual opener (repeat ${repeat + 1})`);
        await page.keyboard.press('Tab');
        assert(await next.evaluate((node) => node === document.activeElement), `${selector}: ${exit} preserves the next Tab stop: expected ${await next.evaluate((node) => node?.outerHTML)}, got ${await page.evaluate(() => document.activeElement?.outerHTML)}`);
        checks++;
      }
    }
    await next.dispose();
  }
  // Change entrances without a reload; a stale saved opener must never win.
  await page.goto(`${origin}/rewards?chainId=4663`);
  for (const selector of ['.sidebar-help', '.footer-links button', '.sidebar-help']) {
    const trigger = page.locator(selector);
    await trigger.focus();
    await page.keyboard.press('Enter');
    await dialog.waitFor({ state: 'visible' });
    await page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'detached' });
    await focused(trigger, `switching entrances restores ${selector}`);
    checks++;
  }
  // A pointer need not focus its button (e.g. Safari). Save the click entrance, not activeElement.
  const pointerTrigger = page.locator('.footer-links button');
  await page.locator('.brand').focus();
  await pointerTrigger.evaluate((node) => node.click());
  await dialog.waitFor({ state: 'visible' });
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'detached' });
  await focused(pointerTrigger, 'a click without focus still restores the actual opener');
  checks++;
  // A removed entrance must not be focused or prevent closing the dialog.
  await page.goto(`${origin}/?chainId=4663`);
  await page.locator('.how-card button').focus();
  await page.keyboard.press('Enter');
  await dialog.waitFor({ state: 'visible' });
  await page.evaluate(() => {
    history.pushState({}, '', '/rewards?chainId=4663');
    window.dispatchEvent(new PopStateEvent('popstate'));
  });
  await page.locator('.how-card').waitFor({ state: 'detached' });
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'detached' });
  checks++;
  assert.deepEqual(errors, [], 'no browser runtime errors');
  console.log(`Passed ${checks} help focus checks in local Chromium (fixture API; no wallet or external requests).`);
} finally {
  await browser.close();
}
