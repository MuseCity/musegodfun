// NFT mode UI check: the token page NFT card and its treasury actions, the NFT page, Explore's NFT and Muse filters and Rewards'
// "My NFT treasuries", against the built `dist` served on 127.0.0.1. Wallet, API and RPC are mocked in the page; every other request is
// refused, and musegod.org art is a stubbed image, so nothing leaves the machine. Screenshots go to .cache/nft-ui/ (git-ignored).
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { decodeAbiParameters, decodeFunctionData, encodeAbiParameters, encodeFunctionResult, erc20Abi, getAddress, keccak256, multicall3Abi, parseAbi,
  toFunctionSelector, toHex } from 'viem';
import { ROBINHOOD_STOCKS } from '../src/lib/config.ts';
import { FEE_POLICY } from '../src/lib/fee-policy.ts';
import { MUSES, treasuryFor, vaultFor } from '../src/lib/nft-mode.ts';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const origin = process.env.BROWSER_ORIGIN || 'http://127.0.0.1:5191';
assert(['127.0.0.1', 'localhost'].includes(new URL(origin).hostname), 'The NFT UI check must target a local server');

const holder = getAddress('0xaaaa000000000000000000000000000000000001'), delegate = getAddress('0xdddd000000000000000000000000000000000004');
const launcher = '0x2222222222222222222222222222222222222222', treasury = '0x3333333333333333333333333333333333333333';
const factory = getAddress('0xfac7000000000000000000000000000000000001'), collection = '0x9999999999999999999999999999999999999999';
const musegod = ROBINHOOD_STOCKS.find(asset => asset.symbol === 'MUSEGOD').address, weth = ROBINHOOD_STOCKS.find(asset => asset.symbol === 'WETH').address;
const museNft = { chainId: 4663, contract: MUSES.contract, tokenId: '1' };
const vault = vaultFor(museNft, factory), museTreasury = treasuryFor(museNft);
const blockHash = '0x' + 'bb'.repeat(32), blockTime = 1_800_000_000n, multicall3 = '0xca11bde05977b3631167028862be2a173976ca11';
const accountAbi = parseAbi(['function execute(address to, uint256 value, bytes data, uint8 operation) payable returns (bytes)', 'function lock(uint256 lockedUntil)']);
const vaultAbi = parseAbi(['function sweep(bytes32[] poolIds, address[] tokens)']);
const selector = { lockedUntil: toFunctionSelector('lockedUntil()'), isLocked: toFunctionSelector('isLocked()'), ownerOf: toFunctionSelector('ownerOf(uint256)') };
const coin = (address, name, symbol, quoteAddress, extra = {}) => ({ address, name, symbol, description: `${name}: a local NFT UI fixture, never deployed.`, image: '',
  quoteAddress, creator: launcher, poolId: keccak256(toHex(address)), transactionHash: '0x' + 'cd'.repeat(32), blockNumber: '16',
  createdAt: Date.now() - 3_600_000, openingCap: '1', mode: 'robinhood', deploymentChainId: 4663, feePolicy: FEE_POLICY, feeTreasury: treasury,
  tradingFeeBps: 100, ...extra });
const museCoin = coin('0x5555555555555555555555555555555555555555', 'Bard of the Muses', 'BARD', musegod, { nft: museNft, nftVerification: { status: 'verified' } });
// A verified coin of a collection outside the allowlist: its badge still warns, because the badge follows the collection, not the status.
const unverifiedCoin = coin('0x6666666666666666666666666666666666666666', 'Gallery Seven', 'GAL7', weth, { nft: { chainId: 4663, contract: collection, tokenId: '7' }, nftVerification: { status: 'verified' } });
const rejectedCoin = coin('0x7777777777777777777777777777777777777777', 'Rejected Frame', 'REJ', weth, { nft: { chainId: 4663, contract: collection, tokenId: '8' }, nftVerification: { status: 'rejected', reason: 'Not an ERC-721 collection' } });
const hiddenCoin = coin('0x8888888888888888888888888888888888888888', 'Hidden Muse coin', 'HIDE', musegod, { nft: { ...museNft, tokenId: '3' }, nftVerification: { status: 'verified' }, hidden: true });
const plainCoin = coin('0x4444444444444444444444444444444444444444', 'Plain stock meme', 'PLAIN', weth);
const catalog = [museCoin, unverifiedCoin, rejectedCoin, hiddenCoin, plainCoin];
// A rejected coin also bound to Muse #1: never listed for the NFT, but it still pays the vault, so the treasury view and the sweep include it.
const rejectedMuseCoin = coin('0x9191919191919191919191919191919191919191', 'Late Bard', 'LATE', weth, { nft: museNft, nftVerification: { status: 'rejected', reason: 'already_launched' } });
const zeroAddress = '0x0000000000000000000000000000000000000000';
const baseConfig = { mode: 'robinhood', chainId: 4663, deploymentChainId: 4663, treasury, writesEnabled: true, controlRevision: 0, signingPaused: false,
  securityProtocol: 1, blockReason: null, nftMode: { enabled: true, vaultFactory: factory, launchFeeUsd: 10, freeCollections: [`4663:${MUSES.contract.toLowerCase()}`],
    verifiedCollections: [`4663:${MUSES.contract.toLowerCase()}`] } };
// A visible placeholder for the Muse art, so the screenshots show where it sits.
const art = '<svg xmlns="http://www.w3.org/2000/svg" width="480" height="480"><rect width="480" height="480" fill="#8a5cf6"/><circle cx="240" cy="200" r="90" fill="#ffc933"/></svg>';
const report = { scope: 'Local Chromium against vite preview of dist; mocked wallet, API and RPC; no network beyond 127.0.0.1 (musegod.org art stubbed).',
  observedAt: new Date().toISOString(), origin, checks: [], screenshots: [] };
await mkdir('.cache/nft-ui', { recursive: true });
const browser = await chromium.launch({ headless: true });

// `account: null`: an anonymous viewer (no wallet connected). `nftEnabled: false`: NFT mode is off on this network.
async function open(path, { account = holder, owner = holder, locked = false, factoryDeployed = true, theme = 'light', viewport = { width: 1440, height: 1000 },
  undeployed = false, holderless = false, statusFailures = 0, lockFailures = 0, chainHex = '0x1237', nftEnabled = true } = {}) {
  const context = await browser.newContext({ viewport, colorScheme: theme });
  const state = { sends: [], treasuryReads: 0, statusAccounts: [], multicalls: [], external: [], stubbed: [], pageErrors: [], statusFailures, lockFailures };
  const config = { ...baseConfig, nftMode: { ...baseConfig.nftMode, enabled: nftEnabled, vaultFactory: factoryDeployed ? factory : null } };
  await context.addInitScript(({ account, theme, chainHex }) => {
    localStorage.setItem('musegod.theme', theme);
    if (account) localStorage.setItem('musegod.wallet.v1', 'fun.musegod.localtest');
    const provider = { on() {}, removeListener() {}, async request({ method, params }) {
      if (method === 'eth_accounts') return account ? [account] : [];
      if (method === 'eth_requestAccounts') return [account];
      if (method === 'eth_chainId') return chainHex;
      if (method === 'eth_sendTransaction') return window.__nftSend(params[0]);
      throw new Error('Unexpected fixture wallet method ' + method);
    } };
    const announce = () => window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail: { info: { uuid: '11111111-2222-4333-8444-555555555555',
      name: 'Local acceptance wallet', rdns: 'fun.musegod.localtest', icon: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB' }, provider } }));
    window.addEventListener('eip6963:requestProvider', announce); window.addEventListener('load', announce);
  }, { account, theme, chainHex });
  await context.exposeBinding('__nftSend', (_source, tx) => {
    const hash = keccak256(toHex(`nft-ui-send-${state.sends.length}-${tx.data}`));
    state.sends.push({ ...tx, hash });
    return hash;
  });
  const receipt = sent => ({ transactionHash: sent.hash, transactionIndex: '0x0', blockHash, blockNumber: '0x10', from: account, to: sent.to, cumulativeGasUsed: '0xea60',
    gasUsed: '0xea60', contractAddress: null, logs: [], logsBloom: '0x' + '00'.repeat(256), status: '0x1', effectiveGasPrice: '0x1', type: '0x2' });
  const block = () => ({ number: '0x20', hash: blockHash, parentHash: blockHash, timestamp: toHex(blockTime), gasLimit: '0x5f5e100', gasUsed: '0x0', baseFeePerGas: '0x1',
    difficulty: '0x0', totalDifficulty: '0x0', size: '0x0', extraData: '0x', logsBloom: '0x' + '00'.repeat(256), transactions: [], uncles: [], miner: treasury,
    mixHash: blockHash, nonce: '0x0000000000000000', sha3Uncles: blockHash, stateRoot: blockHash, receiptsRoot: blockHash, transactionsRoot: blockHash });
  const call = ({ to, data }) => {
    if (to?.toLowerCase() === multicall3) {
      const [calls] = decodeFunctionData({ abi: multicall3Abi, data }).args;
      state.multicalls.push(calls.map(item => ({ target: item.target, selector: item.callData.slice(0, 10) })));
      const failLock = state.lockFailures > 0 && calls.some(item => item.callData.startsWith(selector.lockedUntil));
      if (failLock) state.lockFailures--;
      return encodeFunctionResult({ abi: multicall3Abi, functionName: 'aggregate3', result: calls.map(({ target, callData }) => {
        const head = callData.slice(0, 10);
        if (failLock) return { success: false, returnData: '0x' };
        if (head === selector.lockedUntil) return { success: true, returnData: encodeAbiParameters([{ type: 'uint256' }], [locked ? blockTime + 7n * 86_400n : 0n]) };
        if (head === selector.isLocked) return { success: true, returnData: encodeAbiParameters([{ type: 'bool' }], [locked]) };
        if (head === selector.ownerOf) {
          const [id] = decodeAbiParameters([{ type: 'uint256' }], `0x${callData.slice(10)}`);
          const owns = target.toLowerCase() === MUSES.contract.toLowerCase() && id === 1n;
          return { success: true, returnData: encodeAbiParameters([{ type: 'address' }], [owns ? owner : launcher]) };
        }
        return { success: false, returnData: '0x' };
      }) });
    }
    // balanceOf: 1 MUSEGOD (less than a 5 MUSEGOD buy), plenty of everything else. Anything else is a successful simulation.
    if (data?.startsWith('0x70a08231')) return toHex(to.toLowerCase() === musegod.toLowerCase() ? 10n ** 18n : 10n ** 20n, { size: 32 });
    return '0x';
  };
  // A vault or treasury has code once deployed: from the start, or (`undeployed`) after this page sent its deploy or activation.
  const sentTo = target => state.sends.some(sent => sent.to.toLowerCase() === target.toLowerCase());
  const code = address => address.toLowerCase() === vault.toLowerCase() ? !undeployed || sentTo(factory)
    : address.toLowerCase() === museTreasury.toLowerCase() ? !undeployed || sentTo('0x000000006551c19487814612e58FE06813775758') : false;
  const rpc = item => {
    const result = item.method === 'eth_chainId' ? '0x1237' : item.method === 'eth_blockNumber' ? '0x20'
      : item.method === 'eth_getBlockByNumber' || item.method === 'eth_getBlockByHash' ? block()
      : item.method === 'eth_getBalance' ? toHex(10n ** 20n) : item.method === 'eth_gasPrice' ? '0x2' : item.method === 'eth_maxPriorityFeePerGas' ? '0x1'
      : item.method === 'eth_feeHistory' ? { oldestBlock: '0x20', baseFeePerGas: ['0x1', '0x1'], gasUsedRatio: [0], reward: [['0x1']] }
      : item.method === 'eth_estimateGas' ? '0xea60' : item.method === 'eth_call' ? call(item.params[0])
      : item.method === 'eth_getTransactionReceipt' ? (state.sends.find(sent => sent.hash === item.params[0]) ? receipt(state.sends.find(sent => sent.hash === item.params[0])) : null)
      : item.method === 'eth_getTransactionByHash' ? null
      : item.method === 'eth_getCode' ? (code(item.params[0]) ? '0x6000' : '0x') : undefined;
    if (result === undefined) throw new Error('Unexpected fixture RPC ' + item.method);
    return { jsonrpc: '2.0', id: item.id, result };
  };
  const treasuryView = () => ({ nft: museNft, vault, vaultDeployed: !undeployed, treasury: museTreasury, treasuryDeployed: !undeployed,
    coins: [museCoin, rejectedMuseCoin].map(row => ({ token: row.address, symbol: row.symbol, poolId: row.poolId, quoteAddress: row.quoteAddress })),
    balances: [{ token: museCoin.address, symbol: 'BARD', amount: (12345n * 10n ** 17n).toString(), vaultAmount: '0' },
      { token: musegod, symbol: 'MUSEGOD', amount: (5678n * 10n ** 16n).toString(), vaultAmount: (10n ** 18n).toString() }],
    pendingFees: [{ token: museCoin.address, lp: { fees0: '0', fees1: (25n * 10n ** 16n).toString() }, trade: { fees0: (4n * 10n ** 18n).toString(), fees1: (75n * 10n ** 16n).toString() },
      poolKey: { currency0: museCoin.address, currency1: musegod } }] });
  await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.hostname === 'musegod.org') { state.stubbed.push(url.href); return route.fulfill({ contentType: 'image/svg+xml', body: art }); }
    if (url.origin !== origin) { state.external.push(url.href); return route.abort(); }
    if (!url.pathname.startsWith('/api/')) return route.continue();
    const reply = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (url.pathname.startsWith('/api/chains/') && !url.pathname.startsWith('/api/chains/4663/')) return reply({ error: 'Only Robinhood is mocked' }, 404);
    const path = url.pathname.replace(/^\/api\/chains\/4663(?=\/)/, '/api'), payload = route.request().method() === 'POST' ? route.request().postDataJSON() : null;
    if (path === '/api/config') return reply(config);
    if (path === '/api/stocks') return reply(ROBINHOOD_STOCKS.map(stock => ({ ...stock, verified: true, blockNumber: '16', totalSupply: '1', multiplierWad: null })));
    if (path === '/api/tokens' && url.searchParams.has('nft')) {
      const [, contract, tokenId] = url.searchParams.get('nft').split(':');
      return reply(catalog.filter(row => row.nft && row.nft.contract.toLowerCase() === contract.toLowerCase() && row.nft.tokenId === tokenId &&
        row.nftVerification?.status !== 'rejected' && !row.hidden).map(({ hidden: _hidden, ...row }) => row));
    }
    if (path === '/api/tokens') return reply({ items: catalog, nextCursor: null });
    const detail = /^\/api\/tokens\/(0x[0-9a-fA-F]{40})$/.exec(path);
    if (detail) {
      const row = catalog.find(entry => entry.address.toLowerCase() === detail[1].toLowerCase());
      return row ? reply({ token: row, state: { status: 2, numeraire: row.quoteAddress, poolKey: { currency0: row.address, currency1: row.quoteAddress, fee: 8388608,
        tickSpacing: 10, hooks: '0x4e3468951D49f2EEa976eD0D6e75fFCb44a9a544' } } }) : reply({ error: 'Platform token not found', code: 'TOKEN_NOT_REGISTERED' }, 404);
    }
    if (path === '/api/nft-treasury') { state.treasuryReads++; return factoryDeployed ? reply(treasuryView()) : reply({ error: 'No vault', code: 'NFT_VAULT_UNAVAILABLE' }, 422); }
    if (path === '/api/nft-status') {
      state.statusAccounts.push(url.searchParams.get('account'));
      if (state.statusFailures > 0 && url.searchParams.get('account')?.toLowerCase() === account.toLowerCase()) {
        state.statusFailures--; return reply({ error: 'The NFT status read failed in this fixture.' }, 500);
      }
      if (holderless) return reply({ erc721: false, owner: null, controls: false, alreadyLaunched: false, free: false });
      const muse = url.searchParams.get('nft').split(':')[1].toLowerCase() === MUSES.contract.toLowerCase();
      return reply({ erc721: true, owner, controls: url.searchParams.get('account') === account, alreadyLaunched: true, free: muse, ...(muse ? { name: 'Bard', agentId: '6592' } : {}) });
    }
    if (path.startsWith('/api/first-buy-lock/')) return reply(null);
    if (path === '/api/rpc') return reply(Array.isArray(payload) ? payload.map(rpc) : rpc(payload));
    return reply({ error: 'Unavailable fixture route' }, 404);
  });
  const page = await context.newPage();
  page.on('pageerror', error => state.pageErrors.push(error.message));
  await page.goto(origin + path);
  return { context, page, state };
}
// NFT_UI_CASES=a,b runs only those checks (and no screenshots), for a focused rerun.
const onlyCases = process.env.NFT_UI_CASES?.split(',');
async function check(name, run) {
  if (onlyCases && !onlyCases.includes(name)) return;
  await run();
  report.checks.push({ name, status: 'passed' });
  console.log('PASS nft-ui', name);
}
async function finish({ context, state }) {
  assert.deepEqual(state.external, [], 'No request may leave 127.0.0.1');
  assert.deepEqual(state.pageErrors, []);
  assert(!state.statusAccounts.some(account => account?.toLowerCase() === zeroAddress), 'no NFT status is read for the zero address');
  await context.close();
}
const noOverflow = page => page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, innerWidth }));
async function shoot(page, name) {
  const size = await noOverflow(page);
  assert(size.scrollWidth <= size.innerWidth, `${name}: horizontal overflow ${size.scrollWidth} > ${size.innerWidth}`);
  const file = `.cache/nft-ui/${name}.png`;
  await page.screenshot({ path: file, fullPage: true, animations: 'disabled' });
  report.screenshots.push({ file, ...size });
}

const tokenPath = `/token/robinhood/${museCoin.address}`, nftPagePath = `/nft/robinhood/${MUSES.contract}/1`;
try {
  await check('holder_actions', async () => {
    const run = await open(tokenPath), { page, state } = run;
    const card = page.locator('#nft-card');
    await card.getByText('Agent #6592 (ERC-8004)').waitFor();
    assert.equal(await card.getByRole('link', { name: /Agent #6592/ }).getAttribute('href'), 'https://musegod.org/muse/1.json');
    assert.equal(await card.locator('img').getAttribute('src'), 'https://musegod.org/muse/art/480/1.jpg');
    await card.getByText('Unlocked').waitFor();
    assert.equal(await card.locator('.nft-warning', { hasText: 'Do not send this NFT to its own treasury: it would be locked forever.' }).count(), 1);
    assert.equal(await card.locator('.nft-warning', { hasText: 'Locking stops withdrawals until the date' }).count(), 1);
    assert.equal(await page.locator('.fee-panel .nft-warning', { hasText: "Creator fees go to the NFT's treasury." }).count(), 1);
    assert.equal(await page.getByRole('button', { name: /^Claim/ }).count(), 0, 'no creator claim on an NFT coin');
    assert.equal(await card.getByLabel('BARD amount to withdraw').inputValue(), '1234.5');
    assert.equal(await card.getByText('BARD pool · MUSEGOD').count(), 1, 'pending fees name the coin pool and the asset');
    assert.equal(await card.locator('.nft-warning', { hasText: 'Only the NFT holder can withdraw deposits.' }).count(), 1);
    // The About card's fee split names the NFT treasury, never a creator.
    assert.equal(await page.locator('.fee-split-legend dt', { hasText: 'NFT treasury' }).count(), 1);
    assert.equal(await page.locator('.fee-split-legend dt', { hasText: 'Creator' }).count(), 0);
    // Withdraw part of the BARD balance to the holder (first, so no refresh after another action resets the typed amount).
    await card.getByLabel('BARD amount to withdraw').fill('1000');
    await card.getByRole('button', { name: 'Withdraw BARD' }).click();
    await card.getByText('Withdraw BARD: confirmed.').waitFor();
    assert.equal(state.sends[0].to.toLowerCase(), museTreasury.toLowerCase());
    const execute = decodeFunctionData({ abi: accountAbi, data: state.sends[0].data });
    assert.equal(execute.args[0].toLowerCase(), museCoin.address.toLowerCase());
    assert.equal(execute.args[1], 0n);
    assert.deepEqual(decodeFunctionData({ abi: erc20Abi, data: execute.args[2] }).args, [holder, 1000n * 10n ** 18n]);
    assert.equal(execute.args[3], 0);
    // Sweep: the vault is deployed, so one call to exactly this NFT's vault for every bound coin's pool and assets, the rejected coin's too.
    await card.getByRole('button', { name: 'Sweep fees to the treasury' }).click();
    await card.getByText('Sweep fees: confirmed.').waitFor();
    assert.equal(state.sends[1].to.toLowerCase(), vault.toLowerCase());
    assert.equal(state.sends[1].value ?? '0x0', '0x0');
    assert.deepEqual(decodeFunctionData({ abi: vaultAbi, data: state.sends[1].data }).args,
      [[museCoin.poolId, rejectedMuseCoin.poolId], [museCoin.address, musegod, rejectedMuseCoin.address, weth]]);
    // Lock for 7 days from the latest block's timestamp.
    await card.getByRole('button', { name: 'Lock for 7 days' }).click();
    await card.getByText('Lock treasury: confirmed.').waitFor();
    assert.equal(state.sends[2].to.toLowerCase(), museTreasury.toLowerCase());
    assert.deepEqual(decodeFunctionData({ abi: accountAbi, data: state.sends[2].data }).args, [blockTime + 7n * 86_400n]);
    // Deposit 2 BARD from the wallet into the treasury.
    await card.getByLabel('Deposit amount').fill('2');
    await card.getByRole('button', { name: 'Deposit', exact: true }).click();
    await card.getByText('Deposit: confirmed.').waitFor();
    assert.equal(state.sends[3].to.toLowerCase(), museCoin.address.toLowerCase());
    assert.deepEqual(decodeFunctionData({ abi: erc20Abi, data: state.sends[3].data }).args, [museTreasury, 2n * 10n ** 18n]);
    assert.equal(state.sends.length, 4);
    const history = await page.evaluate(() => JSON.parse(localStorage.getItem('musegod.transactions.v1') || '[]'));
    assert.deepEqual(history.map(row => row.action), ['treasury', 'treasury', 'treasury', 'treasury']);
    assert(state.stubbed.length >= 1 && state.stubbed.every(url => url === 'https://musegod.org/muse/art/480/1.jpg'), 'only the Muse art is stubbed');
    await finish(run);
  });
  await check('get_musegod_first', async () => {
    const run = await open(tokenPath), { page } = run;
    await page.locator('#nft-card').getByText('Unlocked').waitFor();
    assert.equal(await page.getByRole('heading', { name: 'Get MUSEGOD with ETH first' }).count(), 0);
    await page.locator('#trade').getByLabel('Trade input amount').fill('5');
    await page.getByRole('heading', { name: 'Get MUSEGOD with ETH first' }).waitFor();
    assert.equal(await page.locator('#get-musegod').getByText('ETH ↔ MUSEGOD').count(), 1);
    // The coin's panel says why, politely, right under the amount being typed, and links to the MUSEGOD panel.
    const hint = page.locator('#trade [role="status"].trade-status');
    assert.equal((await hint.textContent()).trim(), 'You hold 1 MUSEGOD. Get MUSEGOD with ETH first');
    assert.equal(await hint.locator('.nft-warning').count(), 1);
    assert.equal(await hint.getByRole('link', { name: 'Get MUSEGOD with ETH first' }).getAttribute('href'), '#get-musegod');
    // Two trade panels, distinct accessible names.
    for (const [role, name] of [['group', 'Trade side'], ['group', 'MUSEGOD trade side'], ['textbox', 'Trade input amount'], ['textbox', 'MUSEGOD trade input amount'],
      ['radiogroup', 'Maximum trade slippage'], ['radiogroup', 'MUSEGOD maximum trade slippage']])
      assert.equal(await page.getByRole(role, { name, exact: true }).count(), 1, `${role} ${name}`);
    await page.locator('#trade').getByLabel('Trade input amount').fill('0.5');
    await page.getByRole('heading', { name: 'Get MUSEGOD with ETH first' }).waitFor({ state: 'detached' });
    assert.equal((await page.locator('#trade .trade-status').textContent()).trim(), '');
    await finish(run);
  });
  await check('delegate_view', async () => {
    const run = await open(tokenPath, { account: delegate }), { page } = run, card = page.locator('#nft-card');
    await card.getByText('Only the NFT holder can withdraw or lock the treasury.').waitFor();
    assert.equal(await card.getByRole('button', { name: 'Withdraw' }).count(), 0);
    assert.equal(await card.getByRole('button', { name: /^Lock for/ }).count(), 0);
    assert.equal(await card.getByRole('button', { name: 'Sweep fees to the treasury' }).isEnabled(), true, 'anyone can sweep');
    await finish(run);
  });
  await check('locked_treasury', async () => {
    const run = await open(tokenPath, { locked: true }), { page } = run, card = page.locator('#nft-card');
    await card.getByText(/Locked until .*Withdraw and Lock open after that date\./).waitFor();
    assert.equal(await card.getByRole('button', { name: 'Withdraw' }).first().isDisabled(), true);
    for (const days of ['1 day', '7 days', '30 days']) assert.equal(await card.getByRole('button', { name: `Lock for ${days}` }).isDisabled(), true);
    await finish(run);
  });
  await check('no_vault_factory', async () => {
    const run = await open(tokenPath, { factoryDeployed: false }), { page, state } = run, card = page.locator('#nft-card');
    await card.getByText('The fee vault is not deployed on this network yet.').waitFor();
    await card.getByText('Agent #6592 (ERC-8004)').waitFor();
    assert.equal(await card.getByRole('button', { name: 'Sweep fees to the treasury' }).count(), 0);
    assert.equal(state.treasuryReads, 0, 'no treasury read without a verified factory');
    await finish(run);
  });
  await check('hidden_coin', async () => {
    const run = await open(`/token/robinhood/${hiddenCoin.address}`), { page } = run, card = page.locator('#nft-card');
    await card.locator('.nft-warning', { hasText: 'Hidden by operator.' }).waitFor();
    await card.getByText('Unlocked').waitFor();
    assert.equal(await card.getByRole('button', { name: 'Sweep fees to the treasury' }).isEnabled(), true, 'actions stay available');
    await finish(run);
  });
  await check('holderless_nft', async () => {
    // A coin whose NFT is not an ERC-721 (or was burned): tokens sent to its treasury could never leave.
    const run = await open(`/token/robinhood/${rejectedCoin.address}`, { holderless: true, undeployed: true }), { page } = run, card = page.locator('#nft-card');
    await card.locator('.nft-warning', { hasText: 'This NFT has no holder, so its treasury cannot be used.' }).waitFor();
    await card.getByText('Treasury balances').waitFor();
    assert.equal(await card.getByRole('heading', { name: 'Deposit to treasury' }).count(), 0);
    assert.equal(await card.getByRole('button', { name: 'Activate treasury' }).count(), 0);
    assert.equal(await card.getByRole('button', { name: 'Deposit', exact: true }).count(), 0);
    await finish(run);
  });
  await check('deployments_outlive_the_server_cache', async () => {
    // The server's view keeps saying "not deployed" (its 15 s cache); after confirmed transactions the card reads the code on-chain.
    const run = await open(tokenPath, { undeployed: true }), { page, state } = run, card = page.locator('#nft-card');
    await card.getByText('The first sweep also deploys the fee vault.', { exact: false }).waitFor();
    await card.getByRole('button', { name: 'Activate treasury' }).click();
    await card.getByText('Activate treasury: confirmed.').waitFor();
    await card.getByRole('button', { name: 'Activate treasury' }).waitFor({ state: 'detached' });
    assert.deepEqual(state.sends.map(sent => sent.to.toLowerCase()), ['0x000000006551c19487814612e58fe06813775758', museTreasury.toLowerCase()]);
    await card.getByText('Unlocked').waitFor();
    await card.getByRole('button', { name: 'Sweep fees to the treasury' }).click();
    await card.getByText('Sweep fees: confirmed.').waitFor();
    assert.deepEqual(state.sends.slice(2).map(sent => sent.to.toLowerCase()), [factory.toLowerCase(), vault.toLowerCase()], 'deploy, then sweep');
    await card.getByText('The first sweep also deploys the fee vault.', { exact: false }).waitFor({ state: 'detached' });
    await card.getByRole('button', { name: 'Sweep fees to the treasury' }).click();
    await card.getByText('Sweep fees: confirmed.').waitFor();
    assert.equal(state.sends.length, 5, 'the second sweep does not deploy again');
    assert.equal(state.sends[4].to.toLowerCase(), vault.toLowerCase());
    assert(state.treasuryReads >= 3 && (await card.getByRole('button', { name: 'Activate treasury' }).count()) === 0);
    await finish(run);
  });
  await check('lock_read_failure', async () => {
    const run = await open(tokenPath, { lockFailures: 1 }), { page } = run, card = page.locator('#nft-card');
    await card.getByText(/The treasury lock could not be read, so Withdraw and Lock stay closed/).waitFor();
    assert.equal(await card.getByRole('button', { name: 'Withdraw BARD' }).isDisabled(), true);
    assert.equal(await card.getByRole('button', { name: 'Lock for 7 days' }).isDisabled(), true);
    await card.getByRole('button', { name: 'Retry' }).click();
    await card.getByText('Unlocked').waitFor();
    assert.equal(await card.getByRole('button', { name: 'Withdraw BARD' }).isEnabled(), true);
    assert.equal(await card.getByRole('button', { name: 'Lock for 7 days' }).isEnabled(), true);
    await finish(run);
  });
  await check('holder_read_failure', async () => {
    const run = await open(tokenPath, { statusFailures: 1 }), { page } = run, card = page.locator('#nft-card');
    await card.getByText(/The NFT holder could not be read: The NFT status read failed in this fixture\./).waitFor();
    assert.equal(await card.getByText('Checking the NFT holder…').count(), 0);
    await card.getByRole('button', { name: 'Retry' }).click();
    await card.getByRole('button', { name: 'Withdraw BARD' }).waitFor();
    assert.equal(await card.getByText(/could not be read/).count(), 0);
    await finish(run);
  });
  await check('wrong_network', async () => {
    const run = await open(tokenPath, { chainHex: '0x1' }), { page } = run, card = page.locator('#nft-card');
    await card.getByText('Switch your wallet to Robinhood Chain to use these actions.').waitFor();
    assert.equal(await card.getByRole('button', { name: 'Sweep fees to the treasury' }).isDisabled(), true);
    await finish(run);
  });
  await check('anonymous_viewer', async () => {
    // No wallet: the card reads no NFT status at all (never for the zero address) and treats the viewer as a non-holder.
    const run = await open(tokenPath, { account: null }), { page, state } = run, card = page.locator('#nft-card');
    await card.getByText('Connect a wallet to check').waitFor();
    await card.getByText('Treasury balances').waitFor();
    assert.equal(await card.getByRole('button', { name: 'Connect wallet' }).count(), 1);
    assert.deepEqual(state.statusAccounts, [], 'no /nft-status read without a wallet');
    assert.equal(await card.getByRole('button', { name: /^Withdraw/ }).count(), 0);
    assert.equal(await card.getByRole('button', { name: /^Lock for/ }).count(), 0);
    await finish(run);
  });
  await check('nft_mode_off', async () => {
    // NFT mode off: the token page's card and the NFT page show one plain notice; no art, no musegod.org image, no NFT read, no action.
    for (const path of [tokenPath, nftPagePath]) {
      const run = await open(path, { nftEnabled: false }), { page, state } = run;
      const notice = page.locator('.nft-warning', { hasText: 'NFT mode is not available on this network.' });
      await notice.waitFor();
      assert.equal(await notice.getAttribute('role'), 'status');
      await page.waitForTimeout(500); // Any read the page would start on mount has started by now.
      assert.deepEqual(state.stubbed, [], 'no musegod.org request');
      assert.equal(await page.locator('img[src*="musegod.org"]').count(), 0);
      assert.deepEqual([state.treasuryReads, state.statusAccounts.length], [0, 0], 'no nft-treasury or nft-status read');
      for (const name of [/^Sweep/, /^Activate/, /^Withdraw/, /^Lock for/, /^Deposit/, /^Copy link/])
        assert.equal(await page.getByRole('button', { name }).count(), 0, String(name));
      if (path === tokenPath) assert.equal(await page.locator('#nft-card').getByText('Agent #6592 (ERC-8004)').count(), 0);
      else assert.equal(await page.getByRole('link', { name: 'Bard of the Muses' }).count(), 0, 'no coin listing while dark');
      await shoot(page, `dark-${path === tokenPath ? 'token' : 'nft-page'}-1440-light`);
      await finish(run);
    }
    const run = await open('/rewards?chainId=4663', { nftEnabled: false }), { page, state } = run;
    await page.getByRole('heading', { name: 'Every good meme earns its moment.' }).waitFor();
    await page.getByRole('heading', { name: 'No launches for this wallet yet' }).waitFor();
    await page.waitForTimeout(500);
    assert.equal(await page.getByRole('heading', { name: /My NFT treasuries/ }).count(), 0);
    assert.equal(state.multicalls.filter(calls => calls.every(item => item.selector === selector.ownerOf)).length, 0, 'no ownerOf scan while dark');
    await finish(run);
  });
  await check('unverified_collection_badge', async () => {
    // The badge follows the collection allowlist: a verified coin of another collection still warns, and the token header names the contract.
    const run = await open(`/token/robinhood/${unverifiedCoin.address}`), { page } = run;
    const header = page.locator('.token-header-meta .nft-badge');
    await header.waitFor();
    assert.equal((await header.textContent()).trim(), 'NFT · unverified collection · 0x9999…9999');
    assert.equal(await header.evaluate(node => node.classList.contains('nft-warning')), true);
    await finish(run);
  });
  await check('nft_page', async () => {
    const run = await open(nftPagePath), { page, state } = run, card = page.locator('#nft-card');
    await page.getByRole('heading', { name: 'Muse #1', level: 1 }).waitFor();
    await page.getByRole('link', { name: 'Bard of the Muses' }).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Copy link for your marketplace listing' }).count(), 1);
    await card.getByText('Unlocked').waitFor();
    // The coins load after the card: the deposit still defaults to the first coin, and a pair asset can be chosen.
    await card.getByLabel('Deposit asset').selectOption({ label: 'MUSEGOD' });
    await card.getByLabel('Deposit amount').fill('3');
    await card.getByRole('button', { name: 'Deposit', exact: true }).click();
    await card.getByText('Deposit: confirmed.').waitFor();
    assert.equal(state.sends[0].to.toLowerCase(), musegod.toLowerCase());
    assert.deepEqual(decodeFunctionData({ abi: erc20Abi, data: state.sends[0].data }).args, [museTreasury, 3n * 10n ** 18n]);
    await finish(run);
  });
  await check('explore_filters', async () => {
    const run = await open('/?chainId=4663'), { page } = run;
    const nftChip = page.getByRole('button', { name: /^NFT coins/ }), museChip = page.getByRole('button', { name: /^Muse coins/ });
    await nftChip.waitFor();
    assert.equal((await nftChip.textContent()).trim(), 'NFT coins 2');
    assert.equal((await museChip.textContent()).trim(), 'Muse coins 1');
    assert.equal(await page.getByText('Hidden Muse coin').count(), 0);
    await nftChip.click();
    await page.getByRole('link', { name: 'Plain stock meme' }).waitFor({ state: 'detached' });
    assert.deepEqual(await page.locator('.filter-chip[aria-pressed="true"]').allTextContents(), ['NFT coins 2']);
    await page.getByRole('link', { name: 'Gallery Seven' }).waitFor();
    const galleryBadges = await page.locator('.nft-badge', { hasText: 'unverified collection' }).allTextContents();
    assert(galleryBadges.length > 0 && galleryBadges.every(text => text.trim() === 'NFT · unverified collection'), `the Explore badge stays short: ${galleryBadges}`);
    assert.equal(await page.getByText(/^NFT #7$/).count(), 0, 'a verified coin of an unlisted collection never shows a plain NFT badge');
    assert.equal(await page.getByRole('link', { name: 'Rejected Frame' }).count(), 0);
    assert.equal(await page.getByRole('link', { name: 'Plain stock meme' }).count(), 0);
    await museChip.click();
    await page.getByRole('link', { name: 'Gallery Seven' }).waitFor({ state: 'detached' });
    assert.deepEqual(await page.locator('.filter-chip[aria-pressed="true"]').allTextContents(), ['Muse coins 1']);
    assert.equal(await page.getByRole('link', { name: 'Bard of the Muses' }).count(), 1);
    await finish(run);
  });
  await check('rewards_my_nft_treasuries', async () => {
    const run = await open('/rewards?chainId=4663'), { page, state } = run;
    await page.getByRole('heading', { name: /My NFT treasuries/ }).waitFor();
    await page.getByRole('link', { name: 'Muse #1' }).waitFor();
    assert.equal(await page.getByRole('link', { name: 'Muse #1' }).getAttribute('href'), nftPagePath);
    const ownerReads = state.multicalls.filter(calls => calls.every(item => item.selector === selector.ownerOf));
    assert.equal(ownerReads.length, 1, 'one ownerOf multicall');
    assert.equal(ownerReads[0].length, 2, 'one ownerOf per listed NFT coin (the rejected and the hidden coin are not scanned)');
    await finish(run);
  });
  // Screenshots: the token page of a Muse coin, the NFT page, and Explore filtered to NFT and Muse coins; 1440 and 390 px, light and dark.
  if (!onlyCases) for (const theme of ['light', 'dark']) for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
    const tag = `${viewport.width}-${theme}`;
    let run = await open(tokenPath, { theme, viewport });
    await run.page.locator('#nft-card').getByText('Unlocked').waitFor();
    await run.page.locator('#nft-card').getByText('BARD pool').first().waitFor();
    await shoot(run.page, `token-${tag}`); await finish(run);
    run = await open(nftPagePath, { theme, viewport });
    await run.page.getByRole('link', { name: 'Bard of the Muses' }).waitFor();
    await run.page.locator('#nft-card').getByText('Unlocked').waitFor();
    await shoot(run.page, `nft-page-${tag}`); await finish(run);
    run = await open('/?chainId=4663', { theme, viewport });
    await run.page.getByRole('button', { name: /^NFT coins/ }).click();
    await run.page.locator('.filter-chip[aria-pressed="true"]', { hasText: 'NFT coins' }).waitFor();
    await run.page.getByRole('link', { name: 'Plain stock meme' }).waitFor({ state: 'detached' });
    await shoot(run.page, `explore-nft-${tag}`);
    await run.page.getByRole('button', { name: /^Muse coins/ }).click();
    await run.page.locator('.filter-chip[aria-pressed="true"]', { hasText: 'Muse coins' }).waitFor();
    await run.page.getByRole('link', { name: 'Gallery Seven' }).waitFor({ state: 'detached' });
    await shoot(run.page, `explore-muse-${tag}`); await finish(run);
  }
  if (!onlyCases) {
    report.checks.push({ name: 'screenshots_no_overflow', status: 'passed', count: report.screenshots.length });
    console.log('PASS nft-ui screenshots', report.screenshots.length);
  }
} finally {
  await writeFile('.cache/nft-ui/report.json', JSON.stringify(report, null, 2));
  await browser.close();
}
