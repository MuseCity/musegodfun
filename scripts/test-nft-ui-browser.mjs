// NFT mode UI check: the token page NFT card and its treasury actions, the NFT page, Explore's NFT and Muse filters and Rewards'
// "My NFT treasuries", against the built `dist` served on 127.0.0.1. Wallet, API and RPC are mocked in the page; every other request is
// refused, and musegod.org art is a stubbed image, so nothing leaves the machine. Screenshots go to .cache/nft-ui/ (git-ignored).
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { decodeAbiParameters, decodeFunctionData, encodeAbiParameters, encodeEventTopics, encodeFunctionData, encodeFunctionResult, erc20Abi, formatUnits,
  getAddress, keccak256, multicall3Abi, parseAbi, parseUnits, toFunctionSelector, toHex } from 'viem';
import { ROBINHOOD_CONTRACTS, ROBINHOOD_STOCKS } from '../src/lib/config.ts';
import { FEE_POLICY } from '../src/lib/fee-policy.ts';
import { MUSES, TOKENBOUND_V3_IMPLEMENTATION, treasuryFor, vaultFor } from '../src/lib/nft-mode.ts';
import { permit2Abi } from '../src/lib/protocol.ts';
import { MUSEGOD } from '../src/lib/musegod.ts';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const origin = process.env.BROWSER_ORIGIN || 'http://127.0.0.1:5191';
assert(['127.0.0.1', 'localhost'].includes(new URL(origin).hostname), 'The NFT UI check must target a local server');
// BROWSER_WALLET_SEND=wallet_sendTransaction: the fixture wallet refuses eth_sendTransaction as unsupported (-32004), so viem resends
// through wallet_sendTransaction (and a reused wallet client then sends there directly), validated exactly like eth_sendTransaction.
const walletSend = process.env.BROWSER_WALLET_SEND || 'eth_sendTransaction';
assert(['eth_sendTransaction', 'wallet_sendTransaction'].includes(walletSend), 'BROWSER_WALLET_SEND must name a transaction send method');

const holder = getAddress('0xaaaa000000000000000000000000000000000001'), delegate = getAddress('0xdddd000000000000000000000000000000000004');
const launcher = '0x2222222222222222222222222222222222222222', treasury = '0x3333333333333333333333333333333333333333';
const factory = getAddress('0xfac7000000000000000000000000000000000001'), collection = '0x9999999999999999999999999999999999999999';
const musegod = ROBINHOOD_STOCKS.find(asset => asset.symbol === 'MUSEGOD').address, weth = ROBINHOOD_STOCKS.find(asset => asset.symbol === 'WETH').address;
const museNft = { chainId: 4663, contract: MUSES.contract, tokenId: '1' };
const vault = vaultFor(museNft, factory), museTreasury = treasuryFor(museNft);
const blockHash = '0x' + 'bb'.repeat(32), blockTime = 1_800_000_000n, multicall3 = '0xca11bde05977b3631167028862be2a173976ca11';
const zeroAddress = '0x0000000000000000000000000000000000000000';
const accountAbi = parseAbi(['function execute(address to, uint256 value, bytes data, uint8 operation) payable returns (bytes)', 'function lock(uint256 lockedUntil)',
  'function initialize(address implementation)']);
const initializeData = encodeFunctionData({ abi: accountAbi, functionName: 'initialize', args: [TOKENBOUND_V3_IMPLEMENTATION] });
const vaultAbi = parseAbi(['function sweep(bytes32[] poolIds, address[] tokens)']);
const selector = { lockedUntil: toFunctionSelector('lockedUntil()'), isLocked: toFunctionSelector('isLocked()'), ownerOf: toFunctionSelector('ownerOf(uint256)'),
  facetAddress: toFunctionSelector('facetAddress(bytes4)'), whitelisted: toFunctionSelector('isContractSelectorWhitelisted(address,bytes4)'),
  allowance: toFunctionSelector('allowance(address,address)'), permit2Allowance: toFunctionSelector('allowance(address,address,address)') };
const coin = (address, name, symbol, quoteAddress, extra = {}) => ({ address, name, symbol, description: `${name}: a local NFT UI fixture, never deployed.`, image: '',
  quoteAddress, creator: launcher, poolId: keccak256(toHex(address)), transactionHash: '0x' + 'cd'.repeat(32), blockNumber: '16',
  createdAt: Date.now() - 3_600_000, openingCap: '1', mode: 'robinhood', deploymentChainId: 4663, feePolicy: FEE_POLICY, feeTreasury: treasury,
  tradingFeeBps: 100, ...extra });
const museCoin = coin('0x5555555555555555555555555555555555555555', 'Bard of the Muses', 'BARD', musegod, { nft: museNft, nftVerification: { status: 'verified' } });
const poolKeyOf = row => ({ currency0: row.address, currency1: row.quoteAddress, fee: 8388608, tickSpacing: 10, hooks: '0x4e3468951D49f2EEa976eD0D6e75fFCb44a9a544' });
const v4Quote = (row, amountIn) => ({ token: row.address, side: 'buy', amountIn: amountIn.toString(), amountOut: (amountIn * 2n).toString(), currencyIn: row.quoteAddress,
  poolKey: poolKeyOf(row), slippageBps: 100, quotedAt: Date.now(), expiresAt: Date.now() + 60_000, serverTime: Date.now() });
// A verified coin of a collection outside the allowlist: its badge still warns, because the badge follows the collection, not the status.
const unverifiedCoin = coin('0x6666666666666666666666666666666666666666', 'Gallery Seven', 'GAL7', weth, { nft: { chainId: 4663, contract: collection, tokenId: '7' }, nftVerification: { status: 'verified' } });
const rejectedCoin = coin('0x7777777777777777777777777777777777777777', 'Rejected Frame', 'REJ', weth, { nft: { chainId: 4663, contract: collection, tokenId: '8' }, nftVerification: { status: 'rejected', reason: 'Not an ERC-721 collection' } });
const hiddenCoin = coin('0x8888888888888888888888888888888888888888', 'Hidden Muse coin', 'HIDE', musegod, { nft: { ...museNft, tokenId: '3' }, nftVerification: { status: 'verified' }, hidden: true });
const plainCoin = coin('0x4444444444444444444444444444444444444444', 'Plain stock meme', 'PLAIN', weth);
const catalog = [museCoin, unverifiedCoin, rejectedCoin, hiddenCoin, plainCoin];
// A rejected coin also bound to Muse #1: never listed for the NFT, but it still pays the vault and is swept when it has pending fees.
const rejectedMuseCoin = coin('0x9191919191919191919191919191919191919191', 'Late Bard', 'LATE', weth, { nft: museNft, nftVerification: { status: 'rejected', reason: 'already_launched' } });
const baseConfig = { mode: 'robinhood', chainId: 4663, deploymentChainId: 4663, treasury, writesEnabled: true, controlRevision: 0, signingPaused: false,
  securityProtocol: 1, blockReason: null, nftMode: { enabled: true, vaultFactory: factory, launchFeeUsd: 10, freeCollections: [`4663:${MUSES.contract.toLowerCase()}`],
    verifiedCollections: [`4663:${MUSES.contract.toLowerCase()}`] } };
// A visible placeholder for the Muse art, so the screenshots show where it sits.
const art = '<svg xmlns="http://www.w3.org/2000/svg" width="480" height="480"><rect width="480" height="480" fill="#8a5cf6"/><circle cx="240" cy="200" r="90" fill="#ffc933"/></svg>';
const report = { scope: 'Local Chromium against vite preview of dist; mocked wallet, API and RPC; no network beyond 127.0.0.1 (musegod.org art stubbed).',
  observedAt: new Date().toISOString(), origin, walletSend, checks: [], screenshots: [] };
await mkdir('.cache/nft-ui', { recursive: true });
const browser = await chromium.launch({ headless: true });

// `account: null`: an anonymous viewer (no wallet connected). `nftEnabled: false`: NFT mode is off on this network.
async function open(path, { account = holder, owner = holder, locked = false, factoryDeployed = true, theme = 'light', viewport = { width: 1440, height: 1000 },
  undeployed = false, uninitialized = false, holderless = false, statusFailures = 0, lockFailures = 0, chainHex = '0x1237', nftEnabled = true,
  musegodHeld = 10n ** 18n, coinHeld = 10n ** 20n,
  onchain = true, pendingCoins = [museCoin], vaultHeld = 10n ** 18n } = {}) {
  const context = await browser.newContext({ viewport, colorScheme: theme });
  // `musegodHeld`: the wallet's MUSEGOD. `coinHeld`: the wallet's balance of every other token.
  // `uninitialized`: the treasury account was created but its initialize never confirmed: it has code, its lock cannot be read until this
  // page sends initialize, and the server's view keeps saying so (its cache).
  // `pendingCoins`: bound pools with nonzero pending fees. `vaultHeld`: MUSEGOD already sitting in the fee vault.
  const state = { sends: [], attempts: 0, refusedSends: 0, treasuryReads: 0, statusAccounts: [], multicalls: [], external: [], stubbed: [], pageErrors: [], statusFailures, lockFailures,
    poolQuotes: [], musegodQuotes: [] };
  const config = { ...baseConfig, nftMode: { ...baseConfig.nftMode, enabled: nftEnabled, vaultFactory: factoryDeployed ? factory : null } };
  await context.addInitScript(({ account, theme, chainHex, walletSend }) => {
    localStorage.setItem('musegod.theme', theme);
    if (account) localStorage.setItem('musegod.wallet.v1', 'fun.musegod.localtest');
    window.__walletListeners = {};
    const provider = { on(event, listener) { (window.__walletListeners[event] ||= []).push(listener); }, removeListener() {}, async request({ method, params }) {
      if (method === 'eth_accounts') return account ? [account] : [];
      if (method === 'eth_requestAccounts') return [account];
      if (method === 'eth_chainId') return chainHex;
      if (method === 'eth_sendTransaction' && walletSend !== method) {
        await window.__nftRefusedSend(); throw Object.assign(new Error('Method not supported'), { code: -32004 });
      }
      if (method === walletSend) {
        // An error crosses the binding as plain data, so its EIP-1193 code survives.
        const result = await window.__nftSend(params[0]);
        if (result && typeof result === 'object') throw Object.assign(new Error(result.fail.message), { code: result.fail.code });
        return result;
      }
      throw new Error('Unexpected fixture wallet method ' + method);
    } };
    const announce = () => window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail: { info: { uuid: '11111111-2222-4333-8444-555555555555',
      name: 'Local acceptance wallet', rdns: 'fun.musegod.localtest', icon: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB' }, provider } }));
    window.addEventListener('eip6963:requestProvider', announce); window.addEventListener('load', announce);
  }, { account, theme, chainHex, walletSend });
  await context.exposeBinding('__nftRefusedSend', () => { state.refusedSends++; });
  await context.exposeBinding('__nftSend', async (_source, tx) => {
    state.attempts++;
    const hash = keccak256(toHex(`nft-ui-send-${state.sends.length}-${tx.data}`));
    state.sends.push({ ...tx, hash });
    return hash;
  });
  // The fixture sends (NFT vault and treasury actions) transfer nothing to the wallet: their receipts carry no logs.
  const receipt = sent => {
    return { transactionHash: sent.hash, transactionIndex: '0x0', blockHash, blockNumber: '0x10', from: account, to: sent.to, cumulativeGasUsed: '0xea60',
      gasUsed: '0xea60', contractAddress: null, logs: [], logsBloom: '0x' + '00'.repeat(256),
      status: '0x1', effectiveGasPrice: '0x1', type: '0x2' };
  };
  // Every send is mined in block 16 at its own nonce (its index); a full block 16 lists them, as the nonce search reads it.
  const minedTransaction = (sent, nonce) => ({ hash: sent.hash, from: account, to: sent.to, input: sent.data, value: sent.value ?? '0x0', nonce: toHex(nonce),
    gas: '0xea60', gasPrice: '0x1', blockHash, blockNumber: '0x10', transactionIndex: toHex(nonce), type: '0x0', v: '0x1b', r: '0x1', s: '0x1', chainId: '0x1237' });
  const block = (number = '0x20', full = false) => ({ number: '0x20', hash: blockHash, parentHash: blockHash, timestamp: toHex(blockTime), gasLimit: '0x5f5e100', gasUsed: '0x0', baseFeePerGas: '0x1',
    difficulty: '0x0', totalDifficulty: '0x0', size: '0x0', extraData: '0x', logsBloom: '0x' + '00'.repeat(256),
    transactions: full && number === '0x10' ? state.sends.map(minedTransaction) : [], uncles: [], miner: treasury,
    mixHash: blockHash, nonce: '0x0000000000000000', sha3Uncles: blockHash, stateRoot: blockHash, receiptsRoot: blockHash, transactionsRoot: blockHash });
  const call = ({ to, data }) => {
    if (to?.toLowerCase() === multicall3) {
      const [calls] = decodeFunctionData({ abi: multicall3Abi, data }).args;
      state.multicalls.push(calls.map(item => ({ target: item.target, selector: item.callData.slice(0, 10) })));
      const lockRead = calls.some(item => item.callData.startsWith(selector.lockedUntil));
      const failLock = lockRead && (state.lockFailures > 0 || uninitialized && !initializedNow());
      if (failLock && state.lockFailures > 0) state.lockFailures--;
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
    // balanceOf: the wallet's MUSEGOD and plenty of everything else.
    if (data?.startsWith('0x70a08231')) return toHex(to.toLowerCase() === musegod.toLowerCase() ? musegodHeld : coinHeld, { size: 32 });
    // The wallet already approved Permit2 for MUSEGOD (so no ERC-20 approval); its Permit2 router allowance is empty.
    if (data?.startsWith(selector.allowance)) return encodeAbiParameters([{ type: 'uint256' }], [2n ** 256n - 1n]);
    if (data?.startsWith(selector.permit2Allowance)) return encodeAbiParameters([{ type: 'uint160' }, { type: 'uint48' }, { type: 'uint48' }], [0n, 0, 0]);
    // Anything else is a successful simulation.
    return '0x';
  };
  // A vault or treasury has code once deployed: from the start, or (`undeployed`) after this page sent its deploy or activation.
  const sentTo = target => state.sends.some(sent => sent.to.toLowerCase() === target.toLowerCase());
  const initializedNow = () => state.sends.some(sent => sent.to.toLowerCase() === museTreasury.toLowerCase() && sent.data === initializeData);
  const code = address => address.toLowerCase() === vault.toLowerCase() ? !undeployed || sentTo(factory)
    : address.toLowerCase() === museTreasury.toLowerCase() ? !undeployed || sentTo('0x000000006551c19487814612e58FE06813775758') : false;
  const rpc = item => {
    const result = item.method === 'eth_chainId' ? '0x1237' : item.method === 'eth_blockNumber' ? '0x20'
      : item.method === 'eth_getBlockByNumber' ? block(item.params?.[0], item.params?.[1] === true) : item.method === 'eth_getBlockByHash' ? block()
      : item.method === 'eth_getTransactionCount' ? toHex(['pending', 'latest'].includes(item.params[1]) || BigInt(item.params[1]) >= 16n ? state.sends.length : 0)
      : item.method === 'eth_getBalance' ? toHex(10n ** 20n) : item.method === 'eth_gasPrice' ? '0x2' : item.method === 'eth_maxPriorityFeePerGas' ? '0x1'
      : item.method === 'eth_feeHistory' ? { oldestBlock: '0x20', baseFeePerGas: ['0x1', '0x1'], gasUsedRatio: [0], reward: [['0x1']] }
      : item.method === 'eth_estimateGas' ? '0xea60' : item.method === 'eth_call' ? call(item.params[0])
      : item.method === 'eth_getTransactionReceipt' ? (state.sends.find(sent => sent.hash === item.params[0]) ? receipt(state.sends.find(sent => sent.hash === item.params[0])) : null)
      : item.method === 'eth_getTransactionByHash' ? null
      : item.method === 'eth_getCode' ? (typeof code(item.params[0]) === 'string' ? code(item.params[0]) : code(item.params[0]) ? '0x6000' : '0x') : undefined;
    if (result === undefined) throw new Error('Unexpected fixture RPC ' + item.method);
    return { jsonrpc: '2.0', id: item.id, result };
  };
  const treasuryView = () => ({ nft: museNft, vault, vaultDeployed: !undeployed, treasury: museTreasury, treasuryDeployed: !undeployed,
    treasuryInitialized: !undeployed && !uninitialized,
    coins: [museCoin, rejectedMuseCoin].map(row => ({ token: row.address, symbol: row.symbol, poolId: row.poolId, quoteAddress: row.quoteAddress })),
    balances: [{ token: museCoin.address, symbol: 'BARD', amount: (12345n * 10n ** 17n).toString(), vaultAmount: '0' },
      { token: musegod, symbol: 'MUSEGOD', amount: (5678n * 10n ** 16n).toString(), vaultAmount: vaultHeld.toString() }],
    pendingFees: pendingCoins.map(row => ({ token: row.address, lp: { fees0: '0', fees1: (25n * 10n ** 16n).toString() },
      trade: { fees0: (4n * 10n ** 18n).toString(), fees1: (75n * 10n ** 16n).toString() },
      poolKey: { currency0: row.address, currency1: row.quoteAddress } })) });
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
    if (path === '/api/musegod') return reply({ name: 'MUSEGOD', symbol: 'MUSEGOD', address: getAddress(musegod), image: '', description: 'MUSEGOD fixture for the trade panel smoke.',
      quoteAddress: getAddress(weth), poolAddress: '0x071eE139277688d64B139Af1e44f79a9acf12e53', decimals: 18, totalSupply: (10n ** 27n).toString(),
      tradeEnabled: true, tradeBlockReason: null });
    if (path === '/api/musegod/quote') {
      state.musegodQuotes.push(payload);
      const now = Date.now(), amountOut = 10n ** 19n;
      return reply({ protocol: 'sushi-v3', chainId: 4663, deploymentChainId: 4663, token: MUSEGOD.token, poolAddress: MUSEGOD.pool,
        side: payload.side, amountIn: parseUnits(payload.amount, 18).toString(), amountOut: amountOut.toString(),
        minAmountOut: (amountOut * BigInt(10_000 - payload.slippageBps) / 10_000n).toString(), slippageBps: payload.slippageBps,
        quotedAt: now, expiresAt: now + 60_000, serverTime: now, blockNumber: '16', blockHash });
    }
    if (path === '/api/quote') {
      state.poolQuotes.push(payload);
      const row = catalog.find(entry => entry.address.toLowerCase() === payload.address.toLowerCase());
      return reply(v4Quote(row, parseUnits(payload.amount, 18)));
    }
    if (path === '/api/rpc') {
      return reply(Array.isArray(payload) ? payload.map(rpc) : rpc(payload));
    }
    return reply({ error: 'Unavailable fixture route' }, 404);
  });
  const page = await context.newPage();
  page.on('pageerror', error => state.pageErrors.push(error.message));
  await page.goto(origin + path);
  // A launch coin's NFT card lives in the token page's On-chain tab (tasks/token-ip-detail-plan.md §3); MUSEGOD's own page has no tabs.
  if (onchain && path.startsWith('/token/') && !path.toLowerCase().includes(musegod.toLowerCase())) await page.getByRole('tab', { name: 'On-chain' }).click();
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
  // Each wallet client's first send was refused on eth_sendTransaction; the accepted ones all came through wallet_sendTransaction.
  if (walletSend !== 'eth_sendTransaction') assert(state.attempts === 0 || state.refusedSends > 0, 'sends went through the wallet_sendTransaction fallback');
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
    // Sweep: only BARD has pending fees; the rejected coin's bound pool and currencies are excluded.
    await card.getByRole('button', { name: 'Sweep fees to the treasury' }).click();
    await card.getByText('Sweep fees: confirmed.').waitFor();
    assert.equal(state.sends.length, 2, 'one withdrawal followed by one sweep');
    assert.equal(state.sends[1].to.toLowerCase(), vault.toLowerCase());
    assert.equal(state.sends[1].value ?? '0x0', '0x0');
    assert.deepEqual(decodeFunctionData({ abi: vaultAbi, data: state.sends[1].data }).args,
      [[museCoin.poolId], [museCoin.address, musegod]]);
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
  await check('sweep_rejected_pending', async () => {
    const run = await open(tokenPath, { pendingCoins: [museCoin, rejectedMuseCoin] }), { page, state } = run, card = page.locator('#nft-card');
    await card.getByText('Unlocked').waitFor();
    await card.getByText('LATE pool · WETH').waitFor();
    await card.getByRole('button', { name: 'Sweep fees to the treasury' }).click();
    await card.getByText('Sweep fees: confirmed.').waitFor();
    assert.equal(state.sends.length, 1, 'both pending pools fit in one sweep confirmation');
    assert.equal(state.sends[0].to.toLowerCase(), vault.toLowerCase());
    assert.equal(state.sends[0].value ?? '0x0', '0x0');
    const sweep = decodeFunctionData({ abi: vaultAbi, data: state.sends[0].data });
    assert.equal(sweep.functionName, 'sweep');
    assert(sweep.args[0].length <= 5, 'at most five pools in a sweep chunk');
    assert.deepEqual(sweep.args, [[museCoin.poolId, rejectedMuseCoin.poolId], [museCoin.address, musegod, rejectedMuseCoin.address, weth]]);
    await finish(run);
  });
  await check('sweep_empty_disabled', async () => {
    const run = await open(tokenPath, { pendingCoins: [], vaultHeld: 0n }), { page, state } = run, card = page.locator('#nft-card');
    await card.getByText('Unlocked').waitFor();
    assert.equal(await card.getByRole('button', { name: 'Withdraw BARD', exact: true }).isEnabled(), true, 'holder actions are ready');
    assert.equal(await card.getByText('Fees waiting to be swept', { exact: true }).count(), 0);
    assert.equal(await card.getByRole('button', { name: 'Sweep fees to the treasury' }).isDisabled(), true, 'no pending fees or vault balances');
    assert.equal(state.attempts, 0, 'no wallet confirmation requested');
    assert.deepEqual(state.sends, []);
    await finish(run);
  });
  await check('musegod_page_trade_panel', async () => {
    // The MUSEGOD page uses automatic ETH ↔ MUSEGOD quotes and in-field Max, without a Pay with control.
    const run = await open(`/token/robinhood/${getAddress(musegod)}`), { page } = run, trade = page.locator('#trade');
    await page.getByRole('heading', { name: 'Trade MUSEGOD', level: 2 }).waitFor();
    assert.equal(await trade.getByText('ETH ↔ MUSEGOD').count(), 1);
    for (const [role, name] of [['group', 'Trade side'], ['textbox', 'Trade input amount'], ['radiogroup', 'Maximum trade slippage']])
      assert.equal(await page.getByRole(role, { name, exact: true }).count(), 1, `${role} ${name}`);
    assert.equal(await page.getByRole('group', { name: 'Pay with' }).count(), 0);
    await trade.getByText('100 ETH').waitFor();
    await trade.getByLabel('Trade input amount').fill('0.01');
    await trade.locator('.quote-summary').waitFor();
    await trade.getByRole('button', { name: 'Confirm Buy' }).waitFor();
    assert.equal(await trade.getByRole('button', { name: 'Confirm Buy' }).isEnabled(), true);
    assert.equal(await trade.getByRole('button', { name: 'Get on-chain quote' }).count(), 0);
    assert.equal(run.state.musegodQuotes.length, 1, 'one automatic MUSEGOD quote after settled input');
    assert.equal(await trade.locator('.trade-amount-field .trade-max').count(), 1);
    await trade.getByRole('button', { name: 'Sell', exact: true }).click();
    assert.equal(await trade.getByLabel('Trade input amount').inputValue(), '');
    assert.deepEqual(await trade.locator('.quick-amounts button').allTextContents(), ['25%', '50%', '75%']);
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
    const run = await open(`/token/robinhood/${hiddenCoin.address}`, { onchain: false }), { page } = run, card = page.locator('#nft-card');
    await page.locator('.notice', { hasText: 'Hidden by operator.' }).waitFor();
    assert.equal(await page.getByRole('tab', { name: 'Overview' }).getAttribute('aria-selected'), 'true');
    await page.getByRole('tab', { name: 'On-chain' }).click();
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
  await check('treasury_finish_activation', async () => {
    // The account was created but its initialize never confirmed: only "Finish activation" is offered, and it sends initialize alone.
    const run = await open(tokenPath, { uninitialized: true }), { page, state } = run, card = page.locator('#nft-card');
    const lockReads = () => state.multicalls.filter(calls => calls.some(item => item.selector === selector.lockedUntil)).length;
    const finishActivation = card.getByRole('button', { name: 'Finish activation', exact: true });
    await finishActivation.waitFor();
    await card.getByText('Activation not finished', { exact: true }).waitFor();
    await card.getByText('The treasury account exists, but its activation did not finish', { exact: false }).waitFor();
    assert.equal(await card.getByRole('button', { name: 'Activate treasury' }).count(), 0, 'the account is never created again');
    for (const name of [/^Withdraw/, /^Lock for/]) assert.equal(await card.getByRole('button', { name }).count(), 0, `${name} waits for the activation`);
    assert.equal(await card.getByText(/treasury lock could not be read/).count(), 0, 'no lock error for an account that cannot answer yet');
    assert.equal(lockReads(), 0, 'the lock is not read before the activation');
    await finishActivation.click();
    await card.getByText('Finish activation: confirmed.').waitFor();
    assert.equal(state.sends.length, 1, 'one wallet confirmation');
    assert.equal(state.sends[0].to.toLowerCase(), museTreasury.toLowerCase());
    assert.equal(state.sends[0].data, initializeData, 'exactly initialize(Tokenbound V3)');
    assert.equal(BigInt(state.sends[0].value ?? '0x0'), 0n);
    // The server still reports the old view for 15 s; the confirmed initialize is the activation.
    await finishActivation.waitFor({ state: 'detached' });
    await card.getByText('Unlocked').waitFor();
    await card.getByRole('button', { name: 'Withdraw BARD' }).waitFor();
    assert.equal(await card.getByRole('button', { name: 'Lock for 7 days' }).isEnabled(), true);
    assert(lockReads() >= 1);
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
    // Finish the hero's owner read, then scope this failure to the card's first read on its first visit.
    const run = await open(tokenPath, { onchain: false }), { page, state } = run, card = page.locator('#nft-card');
    await page.locator('.token-hero-links').getByRole('button', { name: 'Edit profile', exact: true }).waitFor();
    state.statusFailures = 1;
    await page.getByRole('tab', { name: 'On-chain' }).click();
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
    const header = page.locator('.token-hero-title .nft-badge');
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
    // A MUSEGOD-paired coin trades on its venues: the trade card links to Doppler.
    await run.page.locator('#trade').getByRole('link', { name: /Trade on Doppler/ }).waitFor();
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
