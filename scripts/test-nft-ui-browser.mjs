// NFT mode UI check: the token page NFT card and its treasury actions, the NFT page, Explore's NFT and Muse filters and Rewards'
// "My NFT treasuries", against the built `dist` served on 127.0.0.1. Wallet, API and RPC are mocked in the page; every other request is
// refused, and musegod.org art is a stubbed image, so nothing leaves the machine. Screenshots go to .cache/nft-ui/ (git-ignored).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { decodeAbiParameters, decodeFunctionData, encodeAbiParameters, encodeEventTopics, encodeFunctionData, encodeFunctionResult, erc20Abi, formatUnits,
  getAddress, keccak256, multicall3Abi, parseAbi, parseUnits, toFunctionSelector, toHex } from 'viem';
import { ROBINHOOD_CONTRACTS, ROBINHOOD_STOCKS } from '../src/lib/config.ts';
import { FEE_POLICY } from '../src/lib/fee-policy.ts';
import { MUSES, treasuryFor, vaultFor } from '../src/lib/nft-mode.ts';
import { FIRST_BUY_PAYMENT_CONTRACTS, firstBuyFeeAbi, firstBuyPaymentAbi } from '../src/lib/first-buy-payment.ts';
import { amountWords } from '../src/lib/eth-buy.ts';
import { permit2Abi } from '../src/lib/protocol.ts';
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
const zeroAddress = '0x0000000000000000000000000000000000000000';
const accountAbi = parseAbi(['function execute(address to, uint256 value, bytes data, uint8 operation) payable returns (bytes)', 'function lock(uint256 lockedUntil)']);
const vaultAbi = parseAbi(['function sweep(bytes32[] poolIds, address[] tokens)']);
const selector = { lockedUntil: toFunctionSelector('lockedUntil()'), isLocked: toFunctionSelector('isLocked()'), ownerOf: toFunctionSelector('ownerOf(uint256)'),
  facetAddress: toFunctionSelector('facetAddress(bytes4)'), whitelisted: toFunctionSelector('isContractSelectorWhitelisted(address,bytes4)'),
  allowance: toFunctionSelector('allowance(address,address)'), permit2Allowance: toFunctionSelector('allowance(address,address,address)') };
// Pay with ETH: the pinned LI.FI diamond and facet (its verified runtime is the unit-test fixture), a local swap target and the fee receiver.
const lifi = FIRST_BUY_PAYMENT_CONTRACTS[4663], lifiDex = '0x603206D6105217DD972E4Ab30676A220CA393346';
const lifiRuntime = JSON.parse(readFileSync(new URL('../tests/fixtures/lifi-4663-runtime.json', import.meta.url), 'utf8')).onchainBytecode;
const transferAbi = parseAbi(['event Transfer(address indexed from, address indexed to, uint256 value)']);
const directOut = 4_990n * 10n ** 18n, convertedExtra = 123_456_789n, swapOut = 49n * 10n ** 18n;
const coin = (address, name, symbol, quoteAddress, extra = {}) => ({ address, name, symbol, description: `${name}: a local NFT UI fixture, never deployed.`, image: '',
  quoteAddress, creator: launcher, poolId: keccak256(toHex(address)), transactionHash: '0x' + 'cd'.repeat(32), blockNumber: '16',
  createdAt: Date.now() - 3_600_000, openingCap: '1', mode: 'robinhood', deploymentChainId: 4663, feePolicy: FEE_POLICY, feeTreasury: treasury,
  tradingFeeBps: 100, ...extra });
const museCoin = coin('0x5555555555555555555555555555555555555555', 'Bard of the Muses', 'BARD', musegod, { nft: museNft, nftVerification: { status: 'verified' } });
const poolKeyOf = row => ({ currency0: row.address, currency1: row.quoteAddress, fee: 8388608, tickSpacing: 10, hooks: '0x4e3468951D49f2EEa976eD0D6e75fFCb44a9a544' });
// A LI.FI V3 native swap of `amountIn` ETH into `target` for `account`, the shape the server's verified reader returns.
function lifiQuote(target, amountIn, expectedOut, account) {
  const now = Date.now(), feeAmount = amountIn * 25n / 10_000n, minimumOut = expectedOut * 99n / 100n;
  const swaps = [{ callTo: lifi.feeForwarder, approveTo: lifi.feeForwarder, sendingAssetId: zeroAddress, receivingAssetId: zeroAddress, fromAmount: amountIn,
    requiresDeposit: true, callData: encodeFunctionData({ abi: firstBuyFeeAbi, functionName: 'forwardNativeFees',
      args: [[{ recipient: '0xc06ebbefd94032b85424d51906e2a335efae264b', amount: feeAmount }]] }) },
  { callTo: lifiDex, approveTo: lifiDex, sendingAssetId: zeroAddress, receivingAssetId: target.address, fromAmount: amountIn - feeAmount,
    callData: '0x3f0bde251234', requiresDeposit: false }];
  const transactionId = keccak256(toHex(`eth-buy-${target.symbol}-${now}`));
  return { protocol: 'lifi', id: `fixture-${target.symbol}`, transactionId, integrator: 'musegodfun', tool: 'bitget', chainId: 4663, account,
    fromToken: { chainId: 4663, address: zeroAddress, symbol: 'ETH', decimals: 18 }, toToken: target, amountIn: amountIn.toString(),
    expectedOut: expectedOut.toString(), minimumOut: minimumOut.toString(), slippageBps: 100, quotedAt: now, expiresAt: now + 60_000, serverTime: now,
    router: lifi.diamond, facet: lifi.facet, facetRuntimeHash: lifi.runtimeHash, blockNumber: '16', blockHash,
    transaction: { to: lifi.diamond, value: amountIn.toString(), data: encodeFunctionData({ abi: firstBuyPaymentAbi, functionName: 'swapTokensMultipleV3NativeToERC20',
      args: [transactionId, 'musegodfun', zeroAddress, account, minimumOut, swaps] }) },
    approval: null, feeAmount: feeAmount.toString(), feeUsd: null, gasFeeUsd: null, amountInUsd: null };
}
const v4Quote = (row, amountIn) => ({ token: row.address, side: 'buy', amountIn: amountIn.toString(), amountOut: (amountIn * 2n).toString(), currencyIn: row.quoteAddress,
  poolKey: poolKeyOf(row), slippageBps: 100, quotedAt: Date.now(), expiresAt: Date.now() + 60_000, serverTime: Date.now() });
// A verified coin of a collection outside the allowlist: its badge still warns, because the badge follows the collection, not the status.
const unverifiedCoin = coin('0x6666666666666666666666666666666666666666', 'Gallery Seven', 'GAL7', weth, { nft: { chainId: 4663, contract: collection, tokenId: '7' }, nftVerification: { status: 'verified' } });
const rejectedCoin = coin('0x7777777777777777777777777777777777777777', 'Rejected Frame', 'REJ', weth, { nft: { chainId: 4663, contract: collection, tokenId: '8' }, nftVerification: { status: 'rejected', reason: 'Not an ERC-721 collection' } });
const hiddenCoin = coin('0x8888888888888888888888888888888888888888', 'Hidden Muse coin', 'HIDE', musegod, { nft: { ...museNft, tokenId: '3' }, nftVerification: { status: 'verified' }, hidden: true });
const plainCoin = coin('0x4444444444444444444444444444444444444444', 'Plain stock meme', 'PLAIN', weth);
const catalog = [museCoin, unverifiedCoin, rejectedCoin, hiddenCoin, plainCoin];
// A rejected coin also bound to Muse #1: never listed for the NFT, but it still pays the vault, so the treasury view and the sweep include it.
const rejectedMuseCoin = coin('0x9191919191919191919191919191919191919191', 'Late Bard', 'LATE', weth, { nft: museNft, nftVerification: { status: 'rejected', reason: 'already_launched' } });
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
  undeployed = false, holderless = false, statusFailures = 0, lockFailures = 0, chainHex = '0x1237', nftEnabled = true, ethRoute = 'direct', rejectSends = [],
  musegodHeld = 10n ** 18n, holdSend = -1, walletEvent = null, coinHeld = 10n ** 20n, holdPairBalance = false, unreadableConversion = false } = {}) {
  const context = await browser.newContext({ viewport, colorScheme: theme });
  // `ethRoute`: what /trade/eth-quote answers ('direct' or 'two-step'). `rejectSends`: wallet requests (0-based) the fixture wallet rejects.
  // `musegodHeld`: the wallet's MUSEGOD before any trade. `holdSend`: a wallet request that waits until `state.releaseSend()`.
  // `walletEvent`: { attempt, event, value }: the wallet emits that provider event while handling that request.
  // `coinHeld`: the wallet's balance of every other token. `holdPairBalance`: MUSEGOD balance reads wait for `state.releaseBalance()`.
  // `unreadableConversion`: an ETH → MUSEGOD conversion's receipt carries no MUSEGOD Transfer (its amount cannot be read).
  const state = { sends: [], attempts: 0, rejected: [], treasuryReads: 0, statusAccounts: [], multicalls: [], external: [], stubbed: [], pageErrors: [], statusFailures, lockFailures,
    ethQuotes: [], ethQuoteResponses: [], v4Quotes: [], swapSpends: [], held: null, releaseSend: () => {} };
  const holding = new Promise(resolve => { state.releaseSend = resolve; });
  let balanceReleased = !holdPairBalance;
  const balanceGate = new Promise(resolve => { state.releaseBalance = () => { balanceReleased = true; resolve(); }; });
  state.pairBalanceReads = 0;
  const config = { ...baseConfig, nftMode: { ...baseConfig.nftMode, enabled: nftEnabled, vaultFactory: factoryDeployed ? factory : null } };
  await context.addInitScript(({ account, theme, chainHex }) => {
    localStorage.setItem('musegod.theme', theme);
    if (account) localStorage.setItem('musegod.wallet.v1', 'fun.musegod.localtest');
    window.__walletListeners = {};
    const provider = { on(event, listener) { (window.__walletListeners[event] ||= []).push(listener); }, removeListener() {}, async request({ method, params }) {
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
  await context.exposeBinding('__nftSend', async (source, tx) => {
    const attempt = state.attempts++;
    if (walletEvent?.attempt === attempt) {
      await source.page.evaluate(([event, value]) => (window.__walletListeners[event] || []).forEach(listener => listener(value)), [walletEvent.event, walletEvent.value]);
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    if (rejectSends.includes(attempt)) { state.rejected.push(tx); throw new Error('User rejected the request.'); }
    if (attempt === holdSend) { state.held = tx; await holding; }
    const hash = keccak256(toHex(`nft-ui-send-${state.sends.length}-${tx.data}`));
    state.sends.push({ ...tx, hash });
    // A swap through the trading router spends the MUSEGOD of the latest v4 quote.
    if (tx.to.toLowerCase() === ROBINHOOD_CONTRACTS.router.toLowerCase()) state.swapSpends.push(parseUnits(state.v4Quotes.at(-1).amount, 18));
    return hash;
  });
  // What a confirmed send transferred to the wallet: a LI.FI buy delivers its quote's output token, the trading router delivers the coin.
  const transferLog = (sent, token, value, index) => ({ address: token, topics: encodeEventTopics({ abi: transferAbi, eventName: 'Transfer', args: { from: lifiDex, to: account } }),
    data: encodeAbiParameters([{ type: 'uint256' }], [value]), blockHash, blockNumber: '0x10', transactionHash: sent.hash, transactionIndex: '0x0', logIndex: toHex(index), removed: false });
  const delivered = sent => {
    if (sent.to.toLowerCase() === lifi.diamond.toLowerCase()) {
      const swaps = decodeFunctionData({ abi: firstBuyPaymentAbi, data: sent.data }).args[5];
      const output = swaps[swaps.length - 1].receivingAssetId;
      const quoted = state.ethQuoteResponses.map(r => r.mode === 'direct' ? r.quote : r.conversion).find(q => q.transaction.data === sent.data);
      if (unreadableConversion && output.toLowerCase() === musegod.toLowerCase()) return null;
      return { token: output, value: output.toLowerCase() === musegod.toLowerCase() ? BigInt(quoted.minimumOut) + convertedExtra : directOut };
    }
    if (sent.to.toLowerCase() === ROBINHOOD_CONTRACTS.router.toLowerCase()) return { token: museCoin.address, value: swapOut };
    return null;
  };
  const musegodBalance = () => musegodHeld + state.sends.map(delivered).filter(d => d?.token.toLowerCase() === musegod.toLowerCase()).reduce((sum, d) => sum + d.value, 0n)
    - state.swapSpends.reduce((sum, value) => sum + value, 0n);
  const receipt = sent => {
    const output = delivered(sent);
    return { transactionHash: sent.hash, transactionIndex: '0x0', blockHash, blockNumber: '0x10', from: account, to: sent.to, cumulativeGasUsed: '0xea60',
      gasUsed: '0xea60', contractAddress: null, logs: output ? [transferLog(sent, output.token, output.value, 0)] : [], logsBloom: '0x' + '00'.repeat(256),
      status: '0x1', effectiveGasPrice: '0x1', type: '0x2' };
  };
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
    // balanceOf: 1 MUSEGOD (less than a 5 MUSEGOD buy) plus what LI.FI delivered, plenty of everything else.
    if (data?.startsWith('0x70a08231')) return toHex(to.toLowerCase() === musegod.toLowerCase() ? musegodBalance() : coinHeld, { size: 32 });
    // The LI.FI diamond routes to the pinned facet and whitelists the fixture swap target.
    if (to?.toLowerCase() === lifi.diamond.toLowerCase() && data.startsWith(selector.facetAddress)) return encodeAbiParameters([{ type: 'address' }], [lifi.facet]);
    if (to?.toLowerCase() === lifi.diamond.toLowerCase() && data.startsWith(selector.whitelisted)) return encodeAbiParameters([{ type: 'bool' }], [true]);
    // The wallet already approved Permit2 for MUSEGOD (so no ERC-20 approval); its Permit2 router allowance is empty.
    if (data?.startsWith(selector.allowance)) return encodeAbiParameters([{ type: 'uint256' }], [2n ** 256n - 1n]);
    if (data?.startsWith(selector.permit2Allowance)) return encodeAbiParameters([{ type: 'uint160' }, { type: 'uint48' }, { type: 'uint48' }], [0n, 0, 0]);
    // Anything else is a successful simulation.
    return '0x';
  };
  // A vault or treasury has code once deployed: from the start, or (`undeployed`) after this page sent its deploy or activation.
  const sentTo = target => state.sends.some(sent => sent.to.toLowerCase() === target.toLowerCase());
  const code = address => address.toLowerCase() === lifi.facet.toLowerCase() ? lifiRuntime : address.toLowerCase() === vault.toLowerCase() ? !undeployed || sentTo(factory)
    : address.toLowerCase() === museTreasury.toLowerCase() ? !undeployed || sentTo('0x000000006551c19487814612e58FE06813775758') : false;
  const rpc = item => {
    const result = item.method === 'eth_chainId' ? '0x1237' : item.method === 'eth_blockNumber' ? '0x20'
      : item.method === 'eth_getBlockByNumber' || item.method === 'eth_getBlockByHash' ? block()
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
    if (path === '/api/musegod') return reply({ name: 'MUSEGOD', symbol: 'MUSEGOD', address: getAddress(musegod), image: '', description: 'MUSEGOD fixture for the trade panel smoke.',
      quoteAddress: getAddress(weth), poolAddress: '0x071eE139277688d64B139Af1e44f79a9acf12e53', decimals: 18, totalSupply: (10n ** 27n).toString(),
      tradeEnabled: true, tradeBlockReason: null });
    if (path === '/api/trade/eth-quote') {
      state.ethQuotes.push(payload);
      const row = catalog.find(entry => entry.address.toLowerCase() === payload.token.toLowerCase()), amountIn = parseUnits(payload.amountIn, 18);
      const coinAsset = { chainId: 4663, address: getAddress(row.address), symbol: row.symbol, decimals: 18 };
      const pair = { chainId: 4663, address: getAddress(musegod), symbol: 'MUSEGOD', decimals: 18 };
      const conversion = lifiQuote(pair, amountIn, 25n * 10n ** 18n, payload.account);
      const response = ethRoute === 'direct' ? { mode: 'direct', quote: lifiQuote(coinAsset, amountIn, 5_000n * 10n ** 18n, payload.account), serverTime: Date.now() }
        : { mode: 'two-step', conversion, swapPreview: v4Quote(row, BigInt(conversion.minimumOut)), serverTime: Date.now() };
      state.ethQuoteResponses.push(response);
      return reply(response);
    }
    if (path === '/api/quote') {
      state.v4Quotes.push(payload);
      const row = catalog.find(entry => entry.address.toLowerCase() === payload.address.toLowerCase());
      return reply(v4Quote(row, parseUnits(payload.amount, 18)));
    }
    if (path === '/api/rpc') {
      const pairRead = item => item?.method === 'eth_call' && item.params?.[0]?.to?.toLowerCase() === musegod.toLowerCase() && item.params[0].data?.startsWith('0x70a08231');
      if ((Array.isArray(payload) ? payload : [payload]).some(pairRead)) { state.pairBalanceReads++; if (!balanceReleased) await balanceGate; }
      return reply(Array.isArray(payload) ? payload.map(rpc) : rpc(payload));
    }
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
  // Pay with ETH replaced the separate "Get MUSEGOD with ETH first" panel: one control in the coin's own trade panel.
  await check('pay_with_default', async () => {
    const run = await open(tokenPath), { page } = run, trade = page.locator('#trade'), payWith = trade.getByRole('group', { name: 'Pay with' });
    const pressed = name => payWith.getByRole('button', { name, exact: true, pressed: true });
    const live = trade.locator('.trade-live[role="status"]');
    await page.locator('#nft-card').getByText('Unlocked').waitFor();
    // The wallet holds 1 MUSEGOD: with the field empty it pays MUSEGOD. Typed MUSEGOD stays MUSEGOD, even above the balance.
    await pressed('MUSEGOD').waitFor();
    await trade.getByLabel('Trade input amount').fill('5');
    // The visible hint (with its button) sits under the amount, outside the live region; the region announces it once.
    const hint = trade.locator('.pay-hint.nft-warning');
    await hint.filter({ hasText: 'You hold less than 5 MUSEGOD. Pay with ETH?' }).waitFor();
    assert.equal(await live.locator('.pay-hint, button').count(), 0, 'no button inside the live region');
    const announced = (await live.textContent()).trim();
    assert.equal(announced, 'You hold less than the amount entered in MUSEGOD. Pay with ETH?');
    await trade.getByLabel('Trade input amount').fill('6');
    await hint.filter({ hasText: 'You hold less than 6 MUSEGOD.' }).waitFor();
    assert.equal((await live.textContent()).trim(), announced, 'a keystroke does not change what the live region says');
    assert.equal(await pressed('MUSEGOD').count(), 1, 'a typed amount never changes unit');
    assert.equal(await trade.getByText('You pay MUSEGOD', { exact: true }).count(), 1);
    await trade.getByLabel('Trade input amount').fill('0.5');
    await hint.waitFor({ state: 'detached' });
    assert.equal((await live.textContent()).trim(), '');
    await trade.getByLabel('Trade input amount').fill('5');
    // One tap switches to ETH and clears the field, so the user enters an ETH amount; nothing is converted.
    await hint.getByRole('button', { name: 'Switch to ETH' }).click();
    await pressed('ETH').waitFor();
    assert.equal(await trade.getByLabel('Trade input amount').inputValue(), '');
    await live.locator('.nft-warning', { hasText: 'Amount cleared. Enter it in ETH.' }).waitFor();
    assert.equal(await trade.getByText('You pay ETH', { exact: true }).count(), 1);
    await trade.getByLabel('Trade input amount').fill('0.25');
    assert.equal(await pressed('ETH').count(), 1);
    assert.equal(await live.locator('.nft-warning').count(), 0, 'the note goes once an amount is entered');
    // Switching the unit by hand also empties a typed amount instead of reinterpreting it; picking the current unit does not.
    await payWith.getByRole('button', { name: 'ETH', exact: true }).click();
    assert.equal(await trade.getByLabel('Trade input amount').inputValue(), '0.25');
    await payWith.getByRole('button', { name: 'MUSEGOD', exact: true }).click();
    await pressed('MUSEGOD').waitFor();
    assert.equal(await trade.getByLabel('Trade input amount').inputValue(), '');
    await live.locator('.nft-warning', { hasText: 'Amount cleared. Enter it in MUSEGOD.' }).waitFor();
    await trade.getByLabel('Trade input amount').fill('0.25');
    await payWith.getByRole('button', { name: 'ETH', exact: true }).click();
    assert.equal(await trade.getByRole('button', { name: 'Get quote', exact: true }).count(), 1);
    // No separate MUSEGOD panel, link or status line anywhere on a token page.
    assert.equal(await page.getByRole('heading', { name: /Get MUSEGOD/ }).count(), 0);
    assert.equal(await page.locator('#get-musegod, .trade-status, .trade-column, .musegod-acquire').count(), 0);
    assert.equal(await page.getByRole('link', { name: /Get MUSEGOD/ }).count(), 0);
    assert.equal(await page.getByRole('textbox', { name: /trade input amount/i }).count(), 1, 'one trade panel');
    // R2: a side switch changes the input unit (ETH or MUSEGOD on Buy, BARD on Sell), so it empties a typed amount and says so.
    const sides = trade.getByRole('group', { name: 'Trade side' });
    await trade.getByLabel('Trade input amount').fill('5000');
    await sides.getByRole('button', { name: 'Sell' }).click();
    await payWith.waitFor({ state: 'detached' });
    assert.equal(await trade.getByLabel('Trade input amount').inputValue(), '', '"5000" ETH never becomes "5000" BARD');
    await live.locator('.nft-warning', { hasText: 'Amount cleared. Enter it in BARD.' }).waitFor();
    await trade.getByLabel('Trade input amount').fill('1');
    assert.equal(await live.locator('.nft-warning').count(), 0);
    await sides.getByRole('button', { name: 'Sell' }).click();
    assert.equal(await trade.getByLabel('Trade input amount').inputValue(), '1', 'the same side keeps the amount');
    await sides.getByRole('button', { name: 'Buy' }).click();
    await pressed('ETH').waitFor();
    assert.equal(await trade.getByLabel('Trade input amount').inputValue(), '', '"1" BARD never becomes "1" ETH');
    await live.locator('.nft-warning', { hasText: 'Amount cleared. Enter it in ETH.' }).waitFor();
    await finish(run);
    // A wallet without MUSEGOD pays ETH; a typed ETH amount stays ETH and never shows the MUSEGOD hint.
    const empty = await open(tokenPath, { musegodHeld: 0n }), emptyTrade = empty.page.locator('#trade');
    await empty.page.locator('#nft-card').getByText('Unlocked').waitFor();
    const emptyPay = emptyTrade.getByRole('group', { name: 'Pay with' });
    await emptyPay.getByRole('button', { name: 'ETH', exact: true, pressed: true }).waitFor();
    for (const typed of ['5', '0.5', '0.001']) {
      await emptyTrade.getByLabel('Trade input amount').fill(typed);
      assert.equal(await emptyPay.getByRole('button', { name: 'ETH', exact: true }).getAttribute('aria-pressed'), 'true', typed);
      assert.equal(await emptyTrade.getByText('You pay ETH', { exact: true }).count(), 1, typed);
    }
    assert.equal(await emptyTrade.locator('.trade-live .nft-warning').count(), 0);
    await finish(empty);
    // Ruling: once the field holds an amount, the default never flips, not even when the pair balance first loads.
    // (1) Typed before the balance loads: the pair unit stays when a zero balance arrives; the hint offers ETH, the field keeps "5".
    const early = await open(tokenPath, { musegodHeld: 0n, holdPairBalance: true }), earlyTrade = early.page.locator('#trade');
    const earlyPay = earlyTrade.getByRole('group', { name: 'Pay with' });
    await earlyPay.getByRole('button', { name: 'MUSEGOD', exact: true, pressed: true }).waitFor();
    for (let i = 0; i < 200 && early.state.pairBalanceReads < 1; i++) await early.page.waitForTimeout(25);
    assert(early.state.pairBalanceReads >= 1, 'the MUSEGOD balance read is in flight');
    await earlyTrade.getByLabel('Trade input amount').fill('5');
    early.state.releaseBalance();
    await earlyTrade.locator('.pay-hint', { hasText: 'You hold less than 5 MUSEGOD. Pay with ETH?' }).waitFor();
    assert.equal(await earlyPay.getByRole('button', { name: 'MUSEGOD', exact: true }).getAttribute('aria-pressed'), 'true', 'the unit is unchanged');
    assert.equal(await earlyTrade.getByLabel('Trade input amount').inputValue(), '5');
    assert.equal(await earlyTrade.getByText('Balance: 0', { exact: true }).count(), 1);
    assert.equal((await earlyTrade.locator('.trade-live').textContent()).trim(), 'You hold less than the amount entered in MUSEGOD. Pay with ETH?', 'announced once');
    await finish(early);
    // (2) Typed on Sell, then Buy: the switch empties the field (R2). The empty Buy field then takes its default from the pair
    // balance (1 MUSEGOD: MUSEGOD), never from the Sell-side balance (0 BARD, which would have meant ETH); the note names it.
    const carried = await open(tokenPath, { coinHeld: 0n }), carriedTrade = carried.page.locator('#trade');
    await carried.page.locator('#nft-card').getByText('Unlocked').waitFor();
    await carriedTrade.getByRole('group', { name: 'Trade side' }).getByRole('button', { name: 'Sell' }).click();
    await carriedTrade.getByText('You pay BARD', { exact: true }).waitFor();
    await carriedTrade.getByText('Balance: 0', { exact: true }).waitFor();
    await carriedTrade.getByLabel('Trade input amount').fill('5');
    await carriedTrade.getByRole('group', { name: 'Trade side' }).getByRole('button', { name: 'Buy' }).click();
    const carriedPay = carriedTrade.getByRole('group', { name: 'Pay with' });
    await carriedTrade.getByText('Balance: 1', { exact: true }).waitFor();
    await carriedPay.getByRole('button', { name: 'MUSEGOD', exact: true, pressed: true }).waitFor();
    assert.equal(await carriedTrade.getByLabel('Trade input amount').inputValue(), '');
    await carriedTrade.locator('.trade-live .nft-warning', { hasText: 'Amount cleared. Enter it in MUSEGOD.' }).waitFor();
    await finish(carried);
    // No wallet: the pair asset, so the read-only on-chain quote works; ETH asks for a wallet first.
    const anonymous = await open(tokenPath, { account: null }), anonTrade = anonymous.page.locator('#trade');
    const anonPay = anonTrade.getByRole('group', { name: 'Pay with' });
    await anonPay.getByRole('button', { name: 'MUSEGOD', exact: true, pressed: true }).waitFor();
    await anonTrade.getByLabel('Trade input amount').fill('1');
    await anonTrade.getByRole('button', { name: 'Get on-chain quote' }).click();
    await anonTrade.locator('.trade-box.receive strong', { hasText: '2' }).waitFor();
    await anonPay.getByRole('button', { name: 'ETH', exact: true }).click();
    await anonTrade.locator('.trade-live .nft-warning', { hasText: 'Connect a wallet to pay with ETH.' }).waitFor();
    assert.equal(await anonTrade.getByRole('button', { name: 'Get quote', exact: true }).isDisabled(), true);
    await finish(anonymous);
    // A WETH-paired coin has no selector.
    const plain = await open(`/token/robinhood/${plainCoin.address}`);
    await plain.page.getByRole('heading', { name: 'Trade PLAIN' }).waitFor();
    await plain.page.locator('#trade').getByLabel('Trade input amount').fill('5');
    assert.equal(await plain.page.getByRole('group', { name: 'Pay with' }).count(), 0);
    assert.equal(await plain.page.getByRole('button', { name: 'Get on-chain quote' }).count(), 1);
    await finish(plain);
  });
  // Records every progress text of the coin's trade panel, so the order of the steps can be checked afterwards.
  const recordProgress = page => page.evaluate(() => {
    window.__progress = [];
    new MutationObserver(() => {
      const text = document.querySelector('#trade .trade-live .trade-progress')?.textContent?.trim();
      if (text && window.__progress.at(-1) !== text) window.__progress.push(text);
    }).observe(document.querySelector('#trade'), { subtree: true, childList: true, characterData: true });
  });
  async function ethQuoteFor(page, amount) {
    const trade = page.locator('#trade');
    await trade.getByRole('group', { name: 'Pay with' }).getByRole('button', { name: 'ETH', exact: true }).click();
    await trade.getByLabel('Trade input amount').fill(amount);
    await trade.getByRole('button', { name: 'Get quote', exact: true }).click();
    return trade;
  }
  await check('eth_buy_direct', async () => {
    const run = await open(tokenPath), { page, state } = run;
    await page.locator('#nft-card').getByText('Unlocked').waitFor();
    const trade = await ethQuoteFor(page, '0.001');
    await trade.getByText('One step via LI.FI').waitFor();
    assert.deepEqual(state.ethQuotes, [{ token: museCoin.address, amountIn: '0.001', account: holder, slippageBps: 100 }]);
    assert.equal((await trade.locator('.trade-box.receive strong').textContent()).trim(), '5,000', 'the expected coin amount before confirming');
    assert.equal(await trade.locator('.nft-warning', { hasText: 'No one-step route' }).count(), 0);
    await trade.getByRole('button', { name: 'Buy with ETH' }).click();
    await trade.getByRole('status').filter({ hasText: 'Received 4,990 BARD.' }).waitFor();
    // Exactly one wallet confirmation: the frozen LI.FI transaction, paying the quoted ETH.
    assert.equal(state.sends.length, 1);
    const quote = state.ethQuoteResponses[0].quote;
    assert.equal(state.sends[0].to.toLowerCase(), lifi.diamond.toLowerCase());
    assert.equal(state.sends[0].data, quote.transaction.data);
    assert.equal(BigInt(state.sends[0].value), 10n ** 15n);
    assert.equal(await trade.getByRole('link', { name: 'View transaction' }).getAttribute('href'), `https://robinhoodchain.blockscout.com/tx/${state.sends[0].hash}`);
    const history = await page.evaluate(() => JSON.parse(localStorage.getItem('musegod.transactions.v1') || '[]'));
    assert.deepEqual(history.map(row => [row.action, row.status]), [['swap', 'success']]);
    await finish(run);
  });
  await check('eth_buy_two_step', async () => {
    const run = await open(tokenPath, { ethRoute: 'two-step' }), { page, state } = run;
    await page.locator('#nft-card').getByText('Unlocked').waitFor();
    const trade = await ethQuoteFor(page, '0.02');
    await trade.getByText('Two steps', { exact: true }).waitFor();
    // The disclosure is in the panel's one live region before the first confirmation; the same node later carries progress and the result.
    const disclosure = trade.locator('.trade-live[role="status"] .nft-warning', { hasText: 'No one-step route right now.' });
    assert.equal((await disclosure.textContent()).trim(),
      'No one-step route right now. This buy takes 3 steps (3 or 4 wallet confirmations): ETH → MUSEGOD, then MUSEGOD → BARD.');
    assert.equal(await page.locator('#trade [role="status"].trade-live').count(), 1);
    await page.evaluate(() => { document.querySelector('#trade .trade-live').dataset.fixtureNode = 'same'; });
    await recordProgress(page);
    await trade.getByRole('button', { name: 'Buy with ETH' }).click();
    await trade.getByRole('status').filter({ hasText: 'Received 49 BARD.' }).waitFor();
    // Three confirmations, in order: ETH → MUSEGOD on LI.FI, the Permit2 router approval, then the swap.
    const conversion = state.ethQuoteResponses[0].conversion, received = BigInt(conversion.minimumOut) + convertedExtra;
    assert.deepEqual(state.sends.map(sent => sent.to.toLowerCase()), [lifi.diamond, ROBINHOOD_CONTRACTS.permit2, ROBINHOOD_CONTRACTS.router].map(a => a.toLowerCase()));
    assert.equal(state.sends[0].data, conversion.transaction.data);
    assert.equal(BigInt(state.sends[0].value), 2n * 10n ** 16n);
    // Step 2 uses exactly the MUSEGOD the conversion delivered, never the preview's minimum.
    assert.deepEqual(state.v4Quotes, [{ address: museCoin.address, side: 'buy', amount: formatUnits(received, 18), slippageBps: 100 }]);
    const approval = decodeFunctionData({ abi: permit2Abi, data: state.sends[1].data });
    assert.equal(approval.functionName, 'approve');
    assert.deepEqual(approval.args.slice(0, 3).map(String), [getAddress(musegod), ROBINHOOD_CONTRACTS.router, String(received)]);
    assert(state.sends[2].data.toLowerCase().includes(received.toString(16).padStart(64, '0')), 'the swap spends the exact amount received');
    const progress = await page.evaluate(() => window.__progress);
    const steps = ['Step 1 of 3 · Confirm in your wallet: ETH → MUSEGOD', 'Step 1 of 3 · Waiting for on-chain confirmation',
      'Step 2 of 3 · Approval 1 of 1 · Approve the trading router for MUSEGOD', 'Step 3 of 3 · Confirm in your wallet: MUSEGOD → BARD',
      'Step 3 of 3 · Waiting for on-chain confirmation'];
    let at = -1;
    for (const step of steps) {
      const next = progress.findIndex((text, index) => index > at && text.startsWith(step));
      assert(next > at, `progress "${step}" in order: ${JSON.stringify(progress)}`); at = next;
    }
    assert.equal(await trade.locator('.trade-live[data-fixture-node="same"]', { hasText: 'Received 49 BARD.' }).count(), 1, 'one live region, filled in place');
    // Both transactions are linked.
    assert.equal(await trade.getByRole('link', { name: 'View ETH → MUSEGOD transaction' }).getAttribute('href'), `https://robinhoodchain.blockscout.com/tx/${state.sends[0].hash}`);
    assert.equal(await trade.getByRole('link', { name: 'View MUSEGOD → BARD transaction' }).getAttribute('href'), `https://robinhoodchain.blockscout.com/tx/${state.sends[2].hash}`);
    const history = await page.evaluate(() => JSON.parse(localStorage.getItem('musegod.transactions.v1') || '[]'));
    assert.deepEqual(history.map(row => row.action), ['swap', 'approval', 'swap']);
    await finish(run);
  });
  await check('pair_buy_keeps_its_choice', async () => {
    // Paying with all of the MUSEGOD held (the default): afterwards the wallet holds none, yet the panel keeps MUSEGOD and the result.
    const run = await open(tokenPath), { page, state } = run, trade = page.locator('#trade'), payWith = trade.getByRole('group', { name: 'Pay with' });
    await page.locator('#nft-card').getByText('Unlocked').waitFor();
    await payWith.getByRole('button', { name: 'MUSEGOD', exact: true, pressed: true }).waitFor();
    await trade.getByLabel('Trade input amount').fill('1');
    await trade.getByRole('button', { name: 'Get on-chain quote' }).click();
    await trade.getByRole('button', { name: 'Confirm Buy' }).click();
    await trade.getByText('Transaction confirmed').waitFor();
    assert.deepEqual(state.sends.map(sent => sent.to.toLowerCase()), [ROBINHOOD_CONTRACTS.permit2, ROBINHOOD_CONTRACTS.router].map(a => a.toLowerCase()));
    await trade.getByText('Balance: 0', { exact: true }).waitFor();
    assert.equal(await payWith.getByRole('button', { name: 'MUSEGOD', exact: true }).getAttribute('aria-pressed'), 'true');
    assert.equal(await trade.getByText('Transaction confirmed').count(), 1, 'the result stays on screen');
    assert.equal(await trade.getByText(/You hold less than/).count(), 0, 'no "Pay with ETH?" hint next to a confirmed buy');
    await finish(run);
  });
  await check('eth_buy_two_step_step2_rejected', async () => {
    const run = await open(tokenPath, { ethRoute: 'two-step', rejectSends: [1] }), { page, state } = run;
    await page.locator('#nft-card').getByText('Unlocked').waitFor();
    const trade = await ethQuoteFor(page, '0.02');
    await trade.getByText('Two steps', { exact: true }).waitFor();
    await trade.getByRole('button', { name: 'Buy with ETH' }).click();
    const conversion = state.ethQuoteResponses[0].conversion, received = BigInt(conversion.minimumOut) + convertedExtra;
    const recovery = trade.locator('.trade-live[role="status"] .nft-warning', { hasText: 'You received' });
    await recovery.waitFor();
    assert.equal((await recovery.textContent()).trim(), `You received ${amountWords(received, 18)} MUSEGOD. Buy BARD with MUSEGOD to finish.`);
    // Nothing lost and no retry: the panel now pays MUSEGOD, prefilled with exactly what arrived.
    await trade.getByRole('group', { name: 'Pay with' }).getByRole('button', { name: 'MUSEGOD', exact: true, pressed: true }).waitFor();
    assert.equal(await trade.getByLabel('Trade input amount').inputValue(), formatUnits(received, 18));
    assert.equal(await trade.getByText('You pay MUSEGOD', { exact: true }).count(), 1);
    assert.equal(state.sends.length, 1, 'only the conversion went through');
    assert.equal(state.rejected.length, 1);
    assert.equal(state.rejected[0].to.toLowerCase(), ROBINHOOD_CONTRACTS.permit2.toLowerCase());
    assert.equal(await trade.getByRole('button', { name: 'Get on-chain quote' }).count(), 1);
    // The balances are read again: the MUSEGOD now held covers the prefilled amount, so no "hold less" hint.
    await trade.getByText(`Balance: ${Number(formatUnits(10n ** 18n + received, 18)).toLocaleString('en-US', { maximumFractionDigits: 8 })}`, { exact: true }).waitFor();
    assert.equal(await trade.getByText(/You hold less than/).count(), 0);
    assert.equal(await trade.getByRole('link', { name: 'View ETH → MUSEGOD transaction' }).getAttribute('href'), `https://robinhoodchain.blockscout.com/tx/${state.sends[0].hash}`);
    await finish(run);
  });
  await check('eth_buy_unreadable_conversion', async () => {
    // R1: the conversion confirmed but its MUSEGOD amount cannot be read. The panel pays MUSEGOD and never keeps the ETH number.
    const run = await open(tokenPath, { ethRoute: 'two-step', unreadableConversion: true }), { page, state } = run;
    await page.locator('#nft-card').getByText('Unlocked').waitFor();
    const trade = await ethQuoteFor(page, '0.02');
    await trade.getByText('Two steps', { exact: true }).waitFor();
    await trade.getByRole('button', { name: 'Buy with ETH' }).click();
    const live = trade.locator('.trade-live[role="status"]');
    await live.locator('.nft-warning', { hasText: 'Your ETH → MUSEGOD conversion is confirmed. Buy BARD with MUSEGOD to finish.' }).waitFor();
    await trade.getByRole('group', { name: 'Pay with' }).getByRole('button', { name: 'MUSEGOD', exact: true, pressed: true }).waitFor();
    assert.equal(await trade.getByLabel('Trade input amount').inputValue(), '', '"0.02" ETH never becomes "0.02" MUSEGOD');
    await live.locator('.nft-warning', { hasText: 'Amount cleared. Enter it in MUSEGOD.' }).waitFor();
    assert.equal(state.sends.length, 1, 'no step 2 without a known amount');
    assert.equal(await trade.getByRole('link', { name: 'View ETH → MUSEGOD transaction' }).getAttribute('href'), `https://robinhoodchain.blockscout.com/tx/${state.sends[0].hash}`);
    await finish(run);
  });
  await check('eth_buy_result_stays_on_its_page', async () => {
    // The wallet answers after the user moved to another coin: nothing from that buy lands on the new page.
    const run = await open(tokenPath, { holdSend: 0 }), { page, state } = run;
    await page.locator('#nft-card').getByText('Unlocked').waitFor();
    const trade = await ethQuoteFor(page, '0.001');
    await trade.getByText('One step via LI.FI').waitFor();
    await trade.getByRole('button', { name: 'Buy with ETH' }).click();
    for (let i = 0; i < 200 && !state.held; i++) await page.waitForTimeout(25);
    assert(state.held, 'the wallet holds the request');
    await page.evaluate(path => { history.pushState({}, '', path); window.dispatchEvent(new PopStateEvent('popstate')); }, `/token/robinhood/${plainCoin.address}`);
    await page.getByRole('heading', { name: 'Trade PLAIN' }).waitFor();
    state.releaseSend();
    for (let i = 0; i < 200 && state.sends.length < 1; i++) await page.waitForTimeout(25);
    await page.waitForTimeout(1500);
    const plainTrade = page.locator('#trade');
    assert.equal(await plainTrade.getByText(/Received|Waiting for on-chain|Bought/).count(), 0);
    assert.equal(await plainTrade.getByRole('link', { name: /View .*transaction/ }).count(), 0);
    await plainTrade.getByLabel('Trade input amount').fill('1');
    assert.equal(await plainTrade.getByRole('button', { name: 'Get on-chain quote' }).isEnabled(), true, 'the new page is not busy');
    await finish(run);
  });
  await check('eth_buy_wallet_events_mid_buy', async () => {
    // A wallet event that leaves the account and network as they were keeps the recovery; a real account change drops it.
    for (const [event, value, kept] of [['chainChanged', '0x1237', true], ['accountsChanged', [delegate], false]]) {
      const run = await open(tokenPath, { ethRoute: 'two-step', rejectSends: [1], walletEvent: { attempt: 1, event, value } }), { page, state } = run;
      await page.locator('#nft-card').getByText('Unlocked').waitFor();
      const trade = await ethQuoteFor(page, '0.02');
      await trade.getByText('Two steps', { exact: true }).waitFor();
      await trade.getByRole('button', { name: 'Buy with ETH' }).click();
      for (let i = 0; i < 400 && state.rejected.length < 1; i++) await page.waitForTimeout(25);
      assert.equal(state.rejected.length, 1, event);
      const received = BigInt(state.ethQuoteResponses[0].conversion.minimumOut) + convertedExtra;
      if (kept) {
        await trade.locator('.trade-live .nft-warning', { hasText: `You received ${amountWords(received, 18)} MUSEGOD.` }).waitFor();
        assert.equal(await trade.getByLabel('Trade input amount').inputValue(), formatUnits(received, 18));
        await trade.getByRole('group', { name: 'Pay with' }).getByRole('button', { name: 'MUSEGOD', exact: true, pressed: true }).waitFor();
      } else {
        await page.waitForTimeout(1500);
        assert.equal(await trade.getByText(/You received/).count(), 0, 'nothing from the old account lands on the page');
        assert.equal(await trade.getByLabel('Trade input amount').inputValue(), '0.02');
      }
      await finish(run);
    }
  });
  await check('musegod_page_trade_panel', async () => {
    // The MUSEGOD page keeps its own ETH ↔ MUSEGOD panel, with its original control names and no Pay with control.
    const run = await open(`/token/robinhood/${getAddress(musegod)}`), { page } = run, trade = page.locator('#trade');
    await page.getByRole('heading', { name: 'Trade MUSEGOD', level: 2 }).waitFor();
    assert.equal(await trade.getByText('ETH ↔ MUSEGOD').count(), 1);
    for (const [role, name] of [['group', 'Trade side'], ['textbox', 'Trade input amount'], ['radiogroup', 'Maximum trade slippage']])
      assert.equal(await page.getByRole(role, { name, exact: true }).count(), 1, `${role} ${name}`);
    assert.equal(await page.getByRole('group', { name: 'Pay with' }).count(), 0);
    await trade.getByText('100 ETH').waitFor();
    await trade.getByLabel('Trade input amount').fill('0.01');
    assert.equal(await trade.getByRole('button', { name: 'Get on-chain quote' }).isEnabled(), true);
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
    // A MUSEGOD-paired coin, paying with ETH, with a one-step quote on screen.
    await (await ethQuoteFor(run.page, '0.001')).getByText('One step via LI.FI').waitFor();
    await shoot(run.page, `token-${tag}`); await finish(run);
    // Paying with MUSEGOD, above the 1 MUSEGOD held: the "Pay with ETH?" hint.
    run = await open(tokenPath, { theme, viewport });
    await run.page.locator('#nft-card').getByText('BARD pool').first().waitFor();
    await run.page.locator('#trade').getByRole('group', { name: 'Pay with' }).getByRole('button', { name: 'MUSEGOD', exact: true, pressed: true }).waitFor();
    await run.page.locator('#trade').getByLabel('Trade input amount').fill('5');
    await run.page.locator('#trade .pay-hint').getByRole('button', { name: 'Switch to ETH' }).waitFor();
    await shoot(run.page, `token-hint-${tag}`); await finish(run);
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
