import { verifyBuybackActivation, type BuybackActivation, type GovernorControlProof } from "./buyback-activation";
import { decodeEventLog, decodeFunctionData, encodeFunctionData, erc20Abi, getAddress, keccak256, parseAbi, type Address, type Hex, type PublicClient, type TransactionReceipt } from "viem";
import deployment from "../contracts/artifacts/buyback-v2-deployment.json";
import buybackConfig from "../contracts/buyback.config.json";
import { BUYBACK_WETH, LEGACY_FEE_ENGINE, buybackVaultAbi, assetFeedOracleAbi, buybackExecutorAbi, engineTransaction, feeEngineAbi, wethForwarderAbi, type BuybackEngineStatus, type FeedProposalStatus, type EngineAssetStatus, type EngineConversionQuote, type EngineClaimPreview } from "../src/lib/buyback-engine";
import { assetsFor, deploymentChain, listedTokens, sameAddress, type RuntimeConfig, type TokenRecord } from "../src/lib/config";
import { ENGINE_FEE_POLICY, MUSEGOD_BUYBACK } from "../src/lib/fee-policy";

export type BuybackDeployment = {
  schemaVersion: number; chainId: number; status: string;
  contracts: Record<"oracle" | "swapper" | "engine" | "executor" | "forwarder", { address: string | null; runtimeHash: string | null; blockNumber?: string }> & Partial<Record<"assetOracle" | "vault", { address: string | null; runtimeHash: string | null }>>;
  constants: { weth: string; muse: string; initializer: string; rehype: string; router: string; swapRouter: string; swapperFactory: string; beneficiary: string; museWethPool: string; ethUsdFeed: string; treasury: string; automation: string | null; automationTreasury: string | null };
  activation?: BuybackActivation | Record<string, unknown>;
  governance?: { controlProof: GovernorControlProof | string; [key: string]: unknown };
  assetFeedDescriptions?: Record<string, { description: string; descriptionHash: string }>;
  automation?: { status: string; account: string | null; network: number; outputToken: string; allocationBps: number; recipient: string };
};
const swapperAbi = parseAbi([
  "function owner() view returns(address)", "function paused() view returns(bool)",
  "function beneficiary() view returns(address)", "function tokenToBeneficiary() view returns(address)",
  "function oracle() view returns(address)", "function defaultScaledOfferFactor() view returns(uint32)",
  "function getPairScaledOfferFactors((address base,address quote)[] pairs) view returns(uint32[])",
]);
const oracleAbi = parseAbi([
  "function quoteToWeth(address token,uint256 amount) view returns(uint256)",
  "function weth() view returns(address)", "function musegod() view returns(address)",
  "function museWethPool() view returns(address)", "function ethUsdFeed() view returns(address)",
  "function TWAP_SECONDS() view returns(uint32)", "function ethMaxAge() view returns(uint32)",
  "function assetFeeds(address) view returns(address feed,uint32 maxAge,uint8 tokenDecimals,uint8 feedDecimals,bool checkOraclePaused)",
]);
type EngineClient = Pick<PublicClient, "getChainId" | "getBlockNumber" | "getCode" | "readContract" | "getLogs" | "getTransactionReceipt"> & {
  getBlock: (parameters: { blockNumber: bigint }) => Promise<{ timestamp: bigint; hash?: Hex | null }>;
  call: (parameters: { account: Address; to: Address; data: Hex; value: bigint }) => Promise<unknown>;
};
const flashAbi = parseAbi(["event Flash(address indexed beneficiary,address indexed trader,((address base,address quote) quotePair,uint128 baseAmount,bytes data)[] quoteParams,address tokenToBeneficiary,uint256[] amountsToBeneficiary,uint256 excessToBeneficiary)"]);
export function verifiedFlashBurn(receipt: Pick<TransactionReceipt, "status" | "logs">, swapper: Address): bigint {
  if (receipt.status !== "success") return 0n;
  const required = new Map<string, bigint>();
  let excess = 0n;
  for (const log of receipt.logs) {
    if (!sameAddress(log.address, swapper)) continue;
    try {
      const event = decodeEventLog({ abi: flashAbi, data: log.data, topics: log.topics, strict: true }).args;
      if (!sameAddress(event.beneficiary, MUSEGOD_BUYBACK.burnAddress) || !sameAddress(event.tokenToBeneficiary, MUSEGOD_BUYBACK.tokenAddress) ||
        event.quoteParams.length !== event.amountsToBeneficiary.length || event.quoteParams.length === 0 ||
        event.quoteParams.some((param) => !sameAddress(param.quotePair.base, BUYBACK_WETH) || !sameAddress(param.quotePair.quote, MUSEGOD_BUYBACK.tokenAddress))) continue;
      const trader = event.trader.toLowerCase();
      required.set(trader, (required.get(trader) ?? 0n) + event.amountsToBeneficiary.reduce((sum, amount) => sum + amount, 0n));
      excess += event.excessToBeneficiary;
    } catch { /* Other Swapper events are not buyback evidence. */ }
  }
  if (!required.size) return 0n;
  const received = new Map<string, bigint>();
  for (const log of receipt.logs) {
    if (!sameAddress(log.address, MUSEGOD_BUYBACK.tokenAddress)) continue;
    try {
      const event = decodeEventLog({ abi: erc20Abi, data: log.data, topics: log.topics, strict: true });
      if (event.eventName === "Transfer" && sameAddress(event.args.to, MUSEGOD_BUYBACK.burnAddress)) {
        const from = event.args.from.toLowerCase();
        received.set(from, (received.get(from) ?? 0n) + event.args.value);
      }
    } catch { /* A Flash without actual token receipts cannot count as a burn. */ }
  }
  let verified = 0n;
  for (const [trader, amount] of required) if ((received.get(trader) ?? 0n) >= amount) verified += amount;
  if ((received.get(swapper.toLowerCase()) ?? 0n) >= excess) verified += excess;
  return verified;
}
const kyberAbi = parseAbi(["function swap((address callTarget,address approveTarget,bytes targetData,(address srcToken,address dstToken,address[] srcReceivers,uint256[] srcAmounts,address[] feeReceivers,uint256[] feeAmounts,address dstReceiver,uint256 amount,uint256 minReturnAmount,uint256 flags,bytes permit) desc,bytes clientData) execution) payable returns(uint256 returnAmount,uint256 gasUsed)"]);
export function assertConversionRoute(data: Hex, expected: { token: Address; amount: bigint; engine: Address; executor: Address; minimum: bigint }) {
  const decoded = decodeFunctionData({ abi: kyberAbi, data });
  const route = decoded.args[0], desc = route.desc;
  if (encodeFunctionData({ abi: kyberAbi, functionName: "swap", args: decoded.args }).toLowerCase() !== data.toLowerCase() ||
    !sameAddress(route.callTarget, expected.executor) || route.approveTarget !== "0x0000000000000000000000000000000000000000" ||
    !sameAddress(desc.srcToken, expected.token) || !sameAddress(desc.dstToken, BUYBACK_WETH) || !sameAddress(desc.dstReceiver, expected.engine) ||
    desc.amount !== expected.amount || desc.minReturnAmount < expected.minimum || desc.flags !== 512n ||
    desc.feeReceivers.length !== 0 || desc.feeAmounts.length !== 0 || desc.permit !== "0x" ||
    desc.srcReceivers.length !== 1 || !sameAddress(desc.srcReceivers[0], expected.executor) || desc.srcAmounts.length !== 1 || desc.srcAmounts[0] !== expected.amount)
    throw new Error("The conversion route does not match the fixed engine inputs, receiver or price floor");
}
export function conversionSlippageBps(quoted: bigint, minimum: bigint): number {
  if (minimum <= 0n || quoted < minimum) throw new Error("The route cannot satisfy the on-chain reference-price floor");
  // This is headroom above the fixed 99% Oracle floor, not extra permitted
  // loss below that floor. API route estimates may exceed executable prices.
  return Number((quoted - minimum) * 10_000n / quoted);
}
async function kyberResponse(response: Response): Promise<Record<string, unknown>> {
  if (!response.ok) throw new Error("A conversion route is temporarily unavailable. Fees remain in the engine.");
  const content = await response.text();
  if (content.length > 1_048_576) throw new Error("The conversion route response exceeds the size limit");
  const body = JSON.parse(content) as { code?: number; data?: Record<string, unknown> };
  if (body.code !== 0 || !body.data || typeof body.data !== "object") throw new Error("No usable conversion route is available. Fees remain in the engine.");
  return body.data;
}
export async function verifyFeeEngineRuntime(client: EngineClient, candidate: Address, manifest: BuybackDeployment = deployment) {
  if (!["deployed_verified", "deployed_runtime_verified"].includes(manifest.status) || manifest.schemaVersion !== 2 || sameAddress(candidate, LEGACY_FEE_ENGINE) || !manifest.contracts.assetOracle?.address || !manifest.contracts.vault?.address || manifest.chainId !== 4663 ||
    !manifest.contracts.engine.address || !sameAddress(candidate, manifest.contracts.engine.address))
    throw new Error("The fee engine deployment has not been verified");
  const addresses = Object.fromEntries(Object.entries(manifest.contracts).map(([name, value]) => {
    if (!value.address || !value.runtimeHash || !/^0x[0-9a-fA-F]{64}$/.test(value.runtimeHash)) throw new Error("The fee engine deployment manifest is incomplete");
    return [name, getAddress(value.address)];
  })) as Record<"oracle" | "swapper" | "engine" | "executor" | "forwarder" | "assetOracle" | "vault", Address>;
  const constant = manifest.constants;
  const identities = [constant.treasury, constant.automation, constant.automationTreasury, ...Object.values(addresses)];
  if (identities.some((address) => !address || sameAddress(address, "0x0000000000000000000000000000000000000000")) ||
    new Set(identities.map((address) => address?.toLowerCase())).size !== identities.length)
    throw new Error("Independent operations, Splits Automation, source treasury and forwarding contracts must be configured");
  const automation = manifest.automation;
  if (!automation || automation.status !== "configured" || !automation.account || !sameAddress(automation.account, constant.automation!) ||
    automation.network !== 4663 || !sameAddress(automation.outputToken, constant.weth) || automation.allocationBps !== 10_000 ||
    !sameAddress(automation.recipient, constant.automationTreasury!))
    throw new Error("Awaiting Splits Automation rule configuration for WETH and the fixed source treasury");
  if (Object.entries(buybackConfig.constants).some(([name, expected]) => typeof expected !== "string" || !sameAddress(constant[name as keyof typeof constant] ?? "", expected)))
    throw new Error("The buyback deployment targets a different asset, beneficiary or Automation account");
  const blockNumber = await client.getBlockNumber({ cacheTime: 0 });
  const code = await Promise.all(Object.entries(addresses).map(async ([name, address]) => {
    const runtime = await client.getCode({ address, blockNumber });
    if (!runtime || runtime === "0x" || keccak256(runtime).toLowerCase() !== manifest.contracts[name as keyof typeof addresses]!.runtimeHash!.toLowerCase())
      throw new Error("The fee engine runtime does not match the verified deployment");
    return runtime;
  }));
  if (code.length !== 7) throw new Error("The fee engine contract graph is incomplete");
  const automationCode = await client.getCode({ address: getAddress(constant.automation!), blockNumber });
  if (!automationCode || automationCode === "0x") throw new Error("The Splits Automation receiver is not a contract account");
  const expectedEngine = { initializer: constant.initializer, rehype: constant.rehype, oracle: addresses.oracle, assetOracle: addresses.assetOracle, settlementVault: addresses.vault, swapper: addresses.swapper, weth: constant.weth, muse: constant.muse, router: constant.router, automation: constant.automation! } as const;
  await Promise.all(Object.entries(expectedEngine).map(async ([functionName, expected]) => {
    const actual = await client.readContract({ address: addresses.engine, abi: feeEngineAbi, functionName: functionName as keyof typeof expectedEngine, blockNumber });
    if (!sameAddress(String(actual), expected)) throw new Error("The fee engine immutable dependencies do not match");
  }));
  const expectedExecutor = { swapper: addresses.swapper, weth: constant.weth, musegod: constant.muse, router: constant.swapRouter } as const;
  await Promise.all(Object.entries(expectedExecutor).map(async ([functionName, expected]) => {
    const actual = await client.readContract({ address: addresses.executor, abi: buybackExecutorAbi, functionName: functionName as keyof typeof expectedExecutor, blockNumber });
    if (!sameAddress(String(actual), expected)) throw new Error("The buyback executor immutable dependencies do not match");
  }));
  const expectedForwarder = { source: constant.automationTreasury!, weth: constant.weth, swapper: addresses.swapper, vault: addresses.vault } as const;
  await Promise.all(Object.entries(expectedForwarder).map(async ([functionName, expected]) => {
    const actual = await client.readContract({ address: addresses.forwarder, abi: wethForwarderAbi, functionName: functionName as keyof typeof expectedForwarder, blockNumber });
    if (!sameAddress(String(actual), expected)) throw new Error("The fixed WETH forwarder dependencies do not match");
  }));
  const expectedVault = { weth: constant.weth, musegod: constant.muse, oracle: addresses.oracle, swapper: addresses.swapper, executor: addresses.executor, pool: constant.museWethPool } as const;
  await Promise.all(Object.entries(expectedVault).map(async ([name, expected]) => {
    const value = await client.readContract({ address: addresses.vault, abi: buybackVaultAbi, functionName: name as keyof typeof expectedVault, blockNumber });
    if (!sameAddress(value, expected)) throw new Error("The budget vault immutable graph changed");
  }));
  const [cap, seconds, deviation, governor, delay, assetWeth, oldAllowance] = await Promise.all([
    client.readContract({ address: addresses.vault, abi: buybackVaultAbi, functionName: "WINDOW_CAP", blockNumber }),
    client.readContract({ address: addresses.vault, abi: buybackVaultAbi, functionName: "WINDOW_SECONDS", blockNumber }),
    client.readContract({ address: addresses.vault, abi: buybackVaultAbi, functionName: "MAX_DEVIATION_BPS", blockNumber }),
    client.readContract({ address: addresses.assetOracle, abi: assetFeedOracleAbi, functionName: "governor", blockNumber }),
    client.readContract({ address: addresses.assetOracle, abi: assetFeedOracleAbi, functionName: "FEED_CHANGE_DELAY", blockNumber }),
    client.readContract({ address: addresses.assetOracle, abi: assetFeedOracleAbi, functionName: "weth", blockNumber }),
    client.readContract({ address: getAddress(constant.weth), abi: erc20Abi, functionName: "allowance", args: [getAddress(constant.automationTreasury!), getAddress("0x3B6d01e627Fe6e06C831E0f9f57aC976a88309Ff")], blockNumber }),
  ]);
  if (cap !== 10n ** 16n || seconds !== 300n || deviation !== 200n || delay !== 604800n || !sameAddress(governor, constant.treasury) || !sameAddress(assetWeth, constant.weth))
    throw new Error("The rolling buyback budget or feed governance does not match the approved policy");
  if (oldAllowance !== 0n) throw new Error("The legacy WETH Forwarder allowance must be revoked before activating the budget vault");
  const expectedOracle = { weth: constant.weth, musegod: constant.muse, museWethPool: constant.museWethPool, ethUsdFeed: constant.ethUsdFeed } as const;
  await Promise.all(Object.entries(expectedOracle).map(async ([functionName, expected]) => {
    const actual = await client.readContract({ address: addresses.oracle, abi: oracleAbi, functionName: functionName as keyof typeof expectedOracle, blockNumber });
    if (!sameAddress(String(actual), expected)) throw new Error("The fixed buyback oracle dependencies do not match");
  }));
  const [twap, maxAge] = await Promise.all([
    client.readContract({ address: addresses.oracle, abi: oracleAbi, functionName: "TWAP_SECONDS", blockNumber }),
    client.readContract({ address: addresses.oracle, abi: oracleAbi, functionName: "ethMaxAge", blockNumber }),
  ]);
  if (twap !== buybackConfig.twapSeconds || maxAge !== buybackConfig.ethMaxAge) throw new Error("The buyback oracle periods do not match");
  const [owner, paused, beneficiary, output, oracle, factor, overrides, routerHash, actualRouter, routerExecutor, executorHash] = await Promise.all([
    client.readContract({ address: addresses.swapper, abi: swapperAbi, functionName: "owner", blockNumber }),
    client.readContract({ address: addresses.swapper, abi: swapperAbi, functionName: "paused", blockNumber }),
    client.readContract({ address: addresses.swapper, abi: swapperAbi, functionName: "beneficiary", blockNumber }),
    client.readContract({ address: addresses.swapper, abi: swapperAbi, functionName: "tokenToBeneficiary", blockNumber }),
    client.readContract({ address: addresses.swapper, abi: swapperAbi, functionName: "oracle", blockNumber }),
    client.readContract({ address: addresses.swapper, abi: swapperAbi, functionName: "defaultScaledOfferFactor", blockNumber }),
    client.readContract({ address: addresses.swapper, abi: swapperAbi, functionName: "getPairScaledOfferFactors", args: [[{ base: getAddress(constant.weth), quote: getAddress(constant.muse) }]], blockNumber }),
    client.readContract({ address: addresses.engine, abi: feeEngineAbi, functionName: "routerCodeHash", blockNumber }),
    client.getCode({ address: getAddress(constant.router), blockNumber }),
    client.readContract({ address: addresses.engine, abi: feeEngineAbi, functionName: "routerExecutor", blockNumber }),
    client.readContract({ address: addresses.engine, abi: feeEngineAbi, functionName: "routerExecutorCodeHash", blockNumber }),
  ]);
  const actualExecutor = await client.getCode({ address: routerExecutor, blockNumber });
  if (owner !== "0x0000000000000000000000000000000000000000" || paused || !sameAddress(beneficiary, constant.beneficiary) ||
    !sameAddress(output, constant.muse) || !sameAddress(oracle, addresses.oracle) || factor !== 985000 || overrides.length !== 1 || overrides[0] !== 0 ||
    !sameAddress(routerExecutor, buybackConfig.constants.routerExecutor) ||
    routerHash !== buybackConfig.expectedRuntimeHashes.router || executorHash !== buybackConfig.expectedRuntimeHashes.routerExecutor ||
    !actualRouter || keccak256(actualRouter) !== routerHash || !actualExecutor || keccak256(actualExecutor) !== executorHash)
    throw new Error("The fixed buyback configuration or router runtime has changed");
  const allAssets = assetsFor({ mode: "robinhood" });
  for (let i = 0; i < buybackConfig.feeds.length; i += 12) await Promise.all(buybackConfig.feeds.slice(i, i + 12).map(async (expected) => {
    const actual = await client.readContract({ address: addresses.oracle, abi: oracleAbi, functionName: "assetFeeds", args: [getAddress(expected.token)], blockNumber });
    const asset = allAssets.find((token) => sameAddress(token.address, expected.token));
    if (!asset || !sameAddress(actual[0], expected.feed) || actual[1] !== expected.maxAge || actual[2] !== asset.decimals || actual[4] !== expected.checkOraclePaused)
      throw new Error("The fixed asset-feed mapping does not match the reviewed buyback configuration");
  }));
  const feedProposals: FeedProposalStatus[] = [];
  const fixedAssets = [{ token: constant.weth, maxAge: buybackConfig.ethMaxAge, checkOraclePaused: false }, ...buybackConfig.feeds];
  for (let i = 0; i < fixedAssets.length; i += 8) await Promise.all(fixedAssets.slice(i, i + 8).map(async (expected) => {
    const token = getAddress(expected.token);
    const [[feed, age, decimals, feedDecimals, checkPause], label, proposal] = await Promise.all([
      client.readContract({ address: addresses.assetOracle, abi: assetFeedOracleAbi, functionName: "assetFeeds", args: [token], blockNumber }),
      client.readContract({ address: addresses.assetOracle, abi: assetFeedOracleAbi, functionName: "descriptionHash", args: [token], blockNumber }),
      client.readContract({ address: addresses.assetOracle, abi: assetFeedOracleAbi, functionName: "proposals", args: [token], blockNumber }),
    ]);
    const expectedDecimals = sameAddress(token, constant.weth) ? 18 : allAssets.find((a) => sameAddress(a.address, token))?.decimals;
    const pinnedLabel = manifest.assetFeedDescriptions?.[token.toLowerCase()];
    if (feed === "0x0000000000000000000000000000000000000000" || age !== expected.maxAge || decimals !== expectedDecimals || feedDecimals !== 8 || checkPause !== expected.checkOraclePaused || !pinnedLabel || pinnedLabel.descriptionHash !== keccak256(new TextEncoder().encode(pinnedLabel.description)) || label !== pinnedLabel.descriptionHash)
      throw new Error(`The fixed fee-asset classification or feed safety settings changed for ${token}`);
    if (proposal[0] !== "0x0000000000000000000000000000000000000000") feedProposals.push({ token, symbol: sameAddress(token, constant.weth) ? "ETH/USD" : allAssets.find((a) => sameAddress(a.address, token))?.symbol ?? token, currentFeed: feed, proposedFeed: proposal[0], executableAt: String(proposal[1]) });
  }));
  feedProposals.sort((a, b) => a.symbol.localeCompare(b.symbol));
  const graph = { ...addresses, feedProposals, operationsTreasury: getAddress(constant.treasury), automationReceiver: getAddress(constant.automation!), automationTreasury: getAddress(constant.automationTreasury!), blockNumber };
  const source = await readSourceWethStatus(client, graph);
  if (BigInt(source.sourceAllowance) === 2n ** 256n - 1n) throw new Error("The new WETH Forwarder requires a finite allowance");
  return { ...graph, ...source };
}

export async function verifyFeeEngine(client: EngineClient, candidate: Address, manifest: BuybackDeployment = deployment) {
  if (manifest.status !== "deployed_verified") throw new Error("The fee engine deployment has not been verified");
  const graph = await verifyFeeEngineRuntime(client, candidate, manifest);
  const activation = await verifyBuybackActivation(client, manifest, graph.blockNumber);
  return { ...graph, activation };
}

export async function readSourceWethStatus(client: Pick<EngineClient, "getCode" | "readContract">, graph: { forwarder: Address; automationTreasury: Address; blockNumber: bigint }) {
  const [code, balance, allowance, forwarded] = await Promise.all([
    client.getCode({ address: graph.automationTreasury, blockNumber: graph.blockNumber }),
    client.readContract({ address: BUYBACK_WETH, abi: erc20Abi, functionName: "balanceOf", args: [graph.automationTreasury], blockNumber: graph.blockNumber }),
    client.readContract({ address: BUYBACK_WETH, abi: erc20Abi, functionName: "allowance", args: [graph.automationTreasury, graph.forwarder], blockNumber: graph.blockNumber }),
    client.readContract({ address: graph.forwarder, abi: wethForwarderAbi, functionName: "totalForwarded", blockNumber: graph.blockNumber }),
  ]);
  const sourceDeployed = !!code && code !== "0x";
  return { sourceDeployed, sourceWeth: String(balance), sourceAllowance: String(allowance), sourceForwarded: String(forwarded),
    sourceAvailable: String(sourceDeployed && allowance < 2n ** 256n - 1n ? balance < allowance ? balance : allowance : 0n) };
}

export async function readFeeAssetStatus(client: Pick<EngineClient, "readContract">, graph: { engine: Address; oracle: Address; assetOracle?: Address; blockNumber: bigint }, asset: { address: Address; symbol: string; decimals: number }, timestamp: bigint): Promise<EngineAssetStatus> {
  const [pending, claimed, forwarded, converted, automationForwarded, window, isUnpriced, synced, balance] = await Promise.all([
    client.readContract({ address: graph.engine, abi: feeEngineAbi, functionName: "pending", args: [asset.address], blockNumber: graph.blockNumber }),
    client.readContract({ address: graph.engine, abi: feeEngineAbi, functionName: "totalClaimed", args: [asset.address], blockNumber: graph.blockNumber }),
    client.readContract({ address: graph.engine, abi: feeEngineAbi, functionName: "totalForwarded", args: [asset.address], blockNumber: graph.blockNumber }),
    client.readContract({ address: graph.engine, abi: feeEngineAbi, functionName: "totalConverted", args: [asset.address], blockNumber: graph.blockNumber }),
    client.readContract({ address: graph.engine, abi: feeEngineAbi, functionName: "totalAutomationForwarded", args: [asset.address], blockNumber: graph.blockNumber }),
    client.readContract({ address: graph.engine, abi: feeEngineAbi, functionName: "window", args: [asset.address], blockNumber: graph.blockNumber }),
    client.readContract({ address: graph.engine, abi: feeEngineAbi, functionName: "isUnpriced", args: [asset.address], blockNumber: graph.blockNumber }).catch(() => null),
    client.readContract({ address: graph.engine, abi: feeEngineAbi, functionName: "totalSynced", args: [asset.address], blockNumber: graph.blockNumber }),
    client.readContract({ address: asset.address, abi: erc20Abi, functionName: "balanceOf", args: [graph.engine], blockNumber: graph.blockNumber }),
  ]);
  const pricing = isUnpriced === true ? "unsupported_static" : isUnpriced === false ? "supported" : "unknown";
  const available = balance < pending || pricing === "unknown" ? 0n : isUnpriced ? pending : timestamp >= window[0] + 300n ? pending / 10n : window[1] > window[2] ? window[1] - window[2] : 0n;
  let referenceWeth: string | null = null, error: string | null = pricing === "unknown" ? "Fee-asset classification could not be verified. Funds remain pending; refresh before processing." : null;
  if (pricing === "supported" && available > 0n && !sameAddress(asset.address, MUSEGOD_BUYBACK.tokenAddress)) {
    try { referenceWeth = String(await client.readContract({ address: graph.assetOracle ?? graph.oracle, abi: oracleAbi, functionName: "quoteToWeth", args: [asset.address, available], blockNumber: graph.blockNumber })); }
    catch { error = "A valid reference price is unavailable. Fees remain in the engine."; }
  }
  if (balance < pending) { error = "The token balance is below recorded pending funds; processing is paused for this asset."; referenceWeth = null; }
  return { ...asset, pending: String(pending), claimed: String(claimed), synced: String(synced), untracked: balance > pending ? String(balance - pending) : "0", forwarded: String(forwarded), converted: String(converted), automationForwarded: String(automationForwarded), pricing, available: String(available > pending ? pending : available), referenceWeth, error };
}

export class BuybackEngineReader {
  private cached?: { at: number; status: BuybackEngineStatus };
  private inFlight?: Promise<BuybackEngineStatus>;
  constructor(private readonly client: EngineClient, private readonly config: () => Promise<RuntimeConfig>, private readonly tokens: () => Promise<TokenRecord[]>, private readonly claimPreview: (address: Address, engine: Address) => Promise<EngineClaimPreview>, private readonly indexStore?: BuybackBurnIndexStore) {}
  async conversionQuote(token: Address, rawAmount: string, caller: Address): Promise<EngineConversionQuote> {
    const config = await this.config();
    if (!config.feeEngine || config.feePolicy !== ENGINE_FEE_POLICY || !assetsFor(config).some((asset) => sameAddress(asset.address, token)) || sameAddress(token, BUYBACK_WETH))
      throw new Error("This fee asset is not available for conversion on the active engine");
    if (!/^[1-9]\d{0,77}$/.test(rawAmount) || BigInt(rawAmount) >= 2n ** 128n) throw new Error("Invalid conversion amount");
    const amount = BigInt(rawAmount), graph = await verifyFeeEngine(this.client, config.feeEngine);
    if (!config.treasury || !sameAddress(config.treasury, graph.operationsTreasury) ||
      !config.automationReceiver || !sameAddress(config.automationReceiver, graph.automationReceiver) ||
      !config.automationTreasury || !sameAddress(config.automationTreasury, graph.automationTreasury) ||
      !config.wethForwarder || !sameAddress(config.wethForwarder, graph.forwarder) ||
      !config.buybackVault || !sameAddress(config.buybackVault, graph.vault) || !config.assetFeedOracle || !sameAddress(config.assetFeedOracle, graph.assetOracle) || !graph.sourceDeployed)
      throw new Error("The buyback graph or source WETH forwarding authorization could not be activated");
    const [pending, window, block, reference, executor] = await Promise.all([
      this.client.readContract({ address: graph.engine, abi: feeEngineAbi, functionName: "pending", args: [token], blockNumber: graph.blockNumber }),
      this.client.readContract({ address: graph.engine, abi: feeEngineAbi, functionName: "window", args: [token], blockNumber: graph.blockNumber }),
      this.client.getBlock({ blockNumber: graph.blockNumber }),
      this.client.readContract({ address: graph.assetOracle ?? graph.oracle, abi: oracleAbi, functionName: "quoteToWeth", args: [token, amount], blockNumber: graph.blockNumber }),
      this.client.readContract({ address: graph.engine, abi: feeEngineAbi, functionName: "routerExecutor", blockNumber: graph.blockNumber }),
    ]);
    const allowance = block.timestamp >= window[0] + 300n ? pending / 10n : window[1] > window[2] ? window[1] - window[2] : 0n;
    if (amount > pending || amount > allowance || reference === 0n) throw new Error("The conversion amount exceeds the current window or has no valid reference price");
    const minimum = (reference * 9900n + 9999n) / 10_000n;
    const query = new URLSearchParams({ tokenIn: token, tokenOut: BUYBACK_WETH, amountIn: rawAmount, excludeRFQSources: "true" });
    const headers = { "x-client-id": "musegodfun", "content-type": "application/json" };
    const routeResponse = await kyberResponse(await fetch(`https://aggregator-api.kyberswap.com/robinhood/api/v1/routes?${query}`, { headers, redirect: "manual", signal: AbortSignal.timeout(15_000) }));
    const summary = routeResponse.routeSummary as Record<string, unknown> | undefined;
    if (typeof routeResponse.routerAddress !== "string" || !sameAddress(routeResponse.routerAddress, buybackConfig.constants.router) || !summary ||
      summary.amountIn !== rawAmount || typeof summary.tokenIn !== "string" || !sameAddress(summary.tokenIn, token) ||
      typeof summary.tokenOut !== "string" || !sameAddress(summary.tokenOut, BUYBACK_WETH) || typeof summary.amountOut !== "string" || !/^[1-9]\d{0,77}$/.test(summary.amountOut))
      throw new Error("The conversion quote does not match the requested assets or router");
    const quoted = BigInt(summary.amountOut);
    if (quoted < minimum) throw new Error("The route cannot satisfy the 99% reference-price floor. Fees remain in the engine.");
    const slippageTolerance = conversionSlippageBps(quoted, minimum);
    const deadline = Math.floor(Date.now() / 1000) + 120;
    const encoded = await kyberResponse(await fetch("https://aggregator-api.kyberswap.com/robinhood/api/v1/route/build", {
      method: "POST", headers, redirect: "manual", signal: AbortSignal.timeout(15_000),
      body: JSON.stringify({ routeSummary: summary, sender: graph.engine, recipient: graph.engine, origin: caller, deadline, slippageTolerance, ignoreCappedSlippage: slippageTolerance > 2000, source: "musegodfun", enableGasEstimation: false }),
    }));
    if (encoded.amountIn !== rawAmount || encoded.transactionValue !== "0" || typeof encoded.routerAddress !== "string" ||
      !sameAddress(encoded.routerAddress, buybackConfig.constants.router) || typeof encoded.data !== "string" || !/^0x(?:[0-9a-fA-F]{2}){4,100000}$/.test(encoded.data))
      throw new Error("The encoded conversion transaction is invalid");
    const routeData = encoded.data as Hex;
    assertConversionRoute(routeData, { token, amount, engine: graph.engine, executor, minimum });
    const action = { kind: "convert" as const, token, amount: rawAmount, routeData, minWethOut: String(minimum), deadline };
    // Simulation exercises the real engine's route, price, balance and window
    // checks. This read-only call never signs or submits a transaction.
    const tx = engineTransaction(action, config);
    await this.client.call({ account: caller, ...tx });
    return { action, quotedWeth: String(quoted), expiresAt: deadline * 1000 };
  }
  async read(): Promise<BuybackEngineStatus> {
    if (this.cached && Date.now() - this.cached.at < 30_000) return this.cached.status;
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.readFresh().then((status) => { this.cached = { at: Date.now(), status }; return status; }).finally(() => { this.inFlight = undefined; });
    return this.inFlight;
  }
  private async readFresh(): Promise<BuybackEngineStatus> {
    const config = await this.config();
    const unavailable: BuybackEngineStatus = { available: false, reason: config.feePolicy === ENGINE_FEE_POLICY && deployment.automation.status !== "configured" ? "Awaiting Splits Automation deployment, its WETH-to-source-treasury rule and WETH forwarding authorization." : "The public buyback engine is not currently configured or its deployment could not be verified.", blockNumber: null, engine: null, swapper: null, executor: null, operationsTreasury: null, automationReceiver: null, automationTreasury: null, wethForwarder: null, sourceDeployed: false, sourceWeth: null, sourceAllowance: null, sourceForwarded: null, sourceAvailable: null, assets: [], pools: [], swapperWeth: null, directBurned: null, convertedWeth: null, burns: [], burnScanFrom: null };
    if (deploymentChain(config) !== 4663 || config.feePolicy !== ENGINE_FEE_POLICY) return unavailable;
    const candidate = config.feeEngine ?? deployment.contracts.engine.address;
    if (!candidate) return unavailable;
    // The reviewed manifest fixes this read-only candidate even while signing
    // is withheld. Revoking allowance must not hide balances or burn history.
    const graph = await verifyFeeEngineRuntime(this.client, getAddress(candidate));
    if (!config.treasury || !sameAddress(config.treasury, graph.operationsTreasury))
      return { ...unavailable, reason: "The operations treasury does not match the verified deployment." };
    const available = !!config.buybackVault && sameAddress(config.buybackVault, graph.vault) && !!config.assetFeedOracle && sameAddress(config.assetFeedOracle, graph.assetOracle) && !!config.feeEngine && !!config.buybackExecutor && sameAddress(config.buybackExecutor, graph.executor) &&
      !!config.automationReceiver && sameAddress(config.automationReceiver, graph.automationReceiver) &&
      !!config.automationTreasury && sameAddress(config.automationTreasury, graph.automationTreasury) &&
      !!config.wethForwarder && sameAddress(config.wethForwarder, graph.forwarder) && graph.sourceDeployed;
    const reason = !graph.sourceDeployed ? "The Splits source treasury is not deployed on this network. Processing is awaiting deployment and WETH authorization." :
      BigInt(graph.sourceAllowance) === 0n ? "Waiting for the source treasury's WETH approval to the fixed forwarder. A human must sign this authorization in Splits." :
      !available ? "The verified buyback deployment is awaiting activation. Refresh the platform configuration before processing." : null;
    const block = await this.client.getBlock({ blockNumber: graph.blockNumber });
    const pools = listedTokens(await this.tokens(), config.mode, config.deploymentChainId).filter((token) => token.feePolicy === ENGINE_FEE_POLICY && token.feeEngine && sameAddress(token.feeEngine, graph.engine));
    const tracked = new Map<string, { address: Address; symbol: string; decimals: number }>([
      [BUYBACK_WETH.toLowerCase(), { address: BUYBACK_WETH, symbol: "WETH", decimals: 18 }],
      [MUSEGOD_BUYBACK.tokenAddress.toLowerCase(), { address: MUSEGOD_BUYBACK.tokenAddress, symbol: "MUSEGOD", decimals: 18 }],
    ]);
    for (const token of pools) {
      const quote = assetsFor(config).find((asset) => sameAddress(asset.address, token.quoteAddress));
      if (quote) tracked.set(quote.address.toLowerCase(), quote);
      tracked.set(token.address.toLowerCase(), { address: token.address, symbol: token.symbol, decimals: 18 });
    }
    const assets: EngineAssetStatus[] = [];
    const assetList = [...tracked.values()];
    for (let i = 0; i < assetList.length; i += 6) {
      const rows = await Promise.all(assetList.slice(i, i + 6).map((asset) => readFeeAssetStatus(this.client, graph, asset, block.timestamp)));
      assets.push(...rows);
    }
    const [swapperWeth, directBurned, convertedWeth, vaultWeth, vaultAvailable, vaultSpent, vaultBurned, priceReady] = await Promise.all([
      this.client.readContract({ address: BUYBACK_WETH, abi: erc20Abi, functionName: "balanceOf", args: [graph.swapper], blockNumber: graph.blockNumber }),
      this.client.readContract({ address: graph.engine, abi: feeEngineAbi, functionName: "totalDirectBurned", blockNumber: graph.blockNumber }),
      this.client.readContract({ address: graph.engine, abi: feeEngineAbi, functionName: "totalConvertedWeth", blockNumber: graph.blockNumber }),
      this.client.readContract({ address: BUYBACK_WETH, abi: erc20Abi, functionName: "balanceOf", args: [graph.vault], blockNumber: graph.blockNumber }),
      this.client.readContract({ address: graph.vault, abi: buybackVaultAbi, functionName: "available", blockNumber: graph.blockNumber }),
      this.client.readContract({ address: graph.vault, abi: buybackVaultAbi, functionName: "rollingSpent", blockNumber: graph.blockNumber }),
      this.client.readContract({ address: graph.vault, abi: buybackVaultAbi, functionName: "totalBurned", blockNumber: graph.blockNumber }),
      this.client.readContract({ address: graph.vault, abi: buybackVaultAbi, functionName: "checkPrices", blockNumber: graph.blockNumber }).then(() => true, () => false),
    ]);
    const indexed = await scanBuybackBurnIndex(this.client, this.indexStore, {
      engine: graph.engine, swapper: graph.swapper, head: graph.blockNumber,
      deploymentBlock: manifestDeploymentBlock(deployment),
    }).catch(() => ({ burns: [] as BuybackEngineStatus["burns"], from: null, to: null, caughtUp: false }));
    const burns = indexed.burns, burnScanFrom = indexed.from;
    const poolStatus: BuybackEngineStatus["pools"] = [];
    for (let i = 0; i < pools.length; i += 4) poolStatus.push(...await Promise.all(pools.slice(i, i + 4).map(async ({ address, poolId, symbol }) => {
      let claimable: EngineClaimPreview | null = null;
      try { claimable = await this.claimPreview(address, graph.engine); } catch { /* Unknown preview amounts are not reported as zero. */ }
      return { address, poolId, symbol, claimable };
    })));
    return { available, reason, feedProposals: graph.feedProposals, vault: graph.vault, assetOracle: graph.assetOracle, vaultWeth: String(vaultWeth), vaultAvailable: String(priceReady ? vaultAvailable : 0n), vaultSpent: String(vaultSpent), vaultBurned: String(vaultBurned), buybackWaitReason: !priceReady ? "Buybacks are waiting for available history and spot/5-minute/30-minute prices within 2%. Fees remain held; token trading is unaffected." : vaultAvailable === 0n && vaultWeth > 0n ? "Buybacks are waiting for the shared 0.01 WETH rolling five-minute budget." : null, blockNumber: String(graph.blockNumber), engine: graph.engine, swapper: graph.swapper, executor: graph.executor, operationsTreasury: graph.operationsTreasury, automationReceiver: graph.automationReceiver, automationTreasury: graph.automationTreasury, wethForwarder: graph.forwarder, sourceDeployed: graph.sourceDeployed, sourceWeth: graph.sourceWeth, sourceAllowance: graph.sourceAllowance, sourceForwarded: graph.sourceForwarded, sourceAvailable: graph.sourceAvailable, assets, pools: poolStatus, swapperWeth: String(swapperWeth), directBurned: String(directBurned), convertedWeth: String(convertedWeth), burns, burnScanFrom: burnScanFrom, burnScanTo: indexed.to, burnIndexCaughtUp: indexed.caughtUp };
  }
}

export type BuybackBurnIndexStore = {
  snapshot(key: string): { at: number; data: unknown } | null | Promise<{ at: number; data: unknown } | null>;
  saveSnapshot(key: string, data: unknown, at: number): void | Promise<void>;
};
type BurnIndex = { version: 1; from: string; to: string; hash: Hex | null; burns: BuybackEngineStatus["burns"] };
function manifestDeploymentBlock(manifest: BuybackDeployment): bigint | null {
  const raw = manifest.contracts.engine.blockNumber;
  return typeof raw === "string" && /^[0-9]+$/.test(raw) ? BigInt(raw) : null;
}
export async function scanBuybackBurnIndex(client: EngineClient, store: BuybackBurnIndexStore | undefined,
  input: { engine: Address; swapper: Address; head: bigint; deploymentBlock: bigint | null }) {
  const empty = { burns: [] as BuybackEngineStatus["burns"], from: null as string | null, to: null as string | null, caughtUp: false };
  if (!store || input.deploymentBlock === null) return empty;
  const start = input.deploymentBlock;
  // Only committed checkpoints are exposed. A reorg resets the cursor and rebuilds receipts.
  const key = `buyback:index:4663:${input.engine.toLowerCase()}:${input.swapper.toLowerCase()}`;
  const saved = (await store.snapshot(key))?.data as BurnIndex | undefined;
  let state: BurnIndex = saved?.version === 1 && saved.from === String(start) && /^-?[0-9]+$/.test(saved.to) && Array.isArray(saved.burns)
    ? saved : { version: 1, from: String(start), to: String(start - 1n), hash: null, burns: [] };
  if (state.hash && (await client.getBlock({ blockNumber: BigInt(state.to) })).hash !== state.hash)
    state = { version: 1, from: String(start), to: String(start - 1n), hash: null, burns: [] };
  const confirmed = input.head > 64n ? input.head - 64n : 0n;
  let cursor = BigInt(state.to) + 1n;
  // Ten blocks works with the documented Alchemy free-tier restriction. A bounded
  // round advances persistently instead of rescanning the same range per request.
  for (let page = 0; page < 50 && cursor <= confirmed; page++) {
    const end = cursor + 9n < confirmed ? cursor + 9n : confirmed;
    const before = await client.getBlock({ blockNumber: end });
    const [direct, flash] = await Promise.all([
      client.getLogs({ address: MUSEGOD_BUYBACK.tokenAddress, event: erc20Abi.find((e) => e.type === "event" && e.name === "Transfer")!, args: { from: input.engine, to: MUSEGOD_BUYBACK.burnAddress }, fromBlock: cursor, toBlock: end, strict: true }),
      client.getLogs({ address: input.swapper, event: flashAbi[0], args: { beneficiary: MUSEGOD_BUYBACK.burnAddress }, fromBlock: cursor, toBlock: end, strict: true }),
    ]);
    const rows: BuybackEngineStatus["burns"] = [];
    const hashes = [...new Set([...direct, ...flash].map((log) => log.transactionHash).filter((hash): hash is Hex => !!hash))];
    for (const hash of hashes) {
      const receipt = await client.getTransactionReceipt({ hash });
      if (receipt.status !== "success" || receipt.blockNumber < cursor || receipt.blockNumber > end ||
        (await client.getBlock({ blockNumber: receipt.blockNumber })).hash !== receipt.blockHash) throw new Error("Buyback index encountered a noncanonical receipt; retrying later");
      const amount = verifiedFlashBurn(receipt, input.swapper);
      if (amount > 0n) rows.push({ hash, blockNumber: String(receipt.blockNumber), amount: String(amount), source: "swapper" });
      let feeBurn = 0n;
      for (const log of receipt.logs) {
        if (!sameAddress(log.address, MUSEGOD_BUYBACK.tokenAddress)) continue;
        try { const event = decodeEventLog({ abi: erc20Abi, data: log.data, topics: log.topics, strict: true });
          if (event.eventName === "Transfer" && sameAddress(event.args.from, input.engine) && sameAddress(event.args.to, MUSEGOD_BUYBACK.burnAddress)) feeBurn += event.args.value;
        } catch { /* Only exact token transfers count. */ }
      }
      if (feeBurn > 0n) rows.push({ hash, blockNumber: String(receipt.blockNumber), amount: String(feeBurn), source: "engine" });
    }
    const after = await client.getBlock({ blockNumber: end });
    if (!before.hash || after.hash !== before.hash) throw new Error("Buyback index block changed during collection; retrying later");
    const unique = new Map([...state.burns, ...rows].map((row) => [`${row.hash}:${row.source}`, row]));
    state = { version: 1, from: String(start), to: String(end), hash: before.hash,
      burns: [...unique.values()].sort((a, b) => BigInt(a.blockNumber) > BigInt(b.blockNumber) ? -1 : 1).slice(0, 1000) };
    await store.saveSnapshot(key, state, Date.now());
    cursor = end + 1n;
  }
  return { burns: state.burns.slice(0, 50), from: state.from, to: BigInt(state.to) >= start ? state.to : null, caughtUp: cursor > confirmed };
}
