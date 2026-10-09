import { decodeEventLog, erc20Abi, getAddress, isAddress, parseAbi, zeroAddress, type Address, type Hex, type PublicClient, type TransactionReceipt, type Transport } from "viem";
import { CONTRACTS, STOCKS, sameAddress } from "../src/lib/config";
import { BASE_BUYBACK_PROTOCOL, BASE_BUYBACK_RH_WETH, BASE_BUYBACK_TREASURY, BASE_BUYBACK_VAULT, BASE_BUYBACK_WETH, baseCollectorAbi,
  type BaseCollectorStatus, type BaseFeeBatch, type BaseTransactionFee } from "../src/lib/base-buyback";
import { verifyBaseCollector } from "./base-collector";

type Client = PublicClient<Transport, any>;
export type BaseQuoteGraph = { collector: Address; paused: boolean; automationReceiver: Address; runtimeHash: Hex;
  initialDeploymentBlock: bigint | string; manifestFingerprint: Hex };
export type BaseFeeDependencies = { client: Client; collector: Address;
  verifyGraph?: (client: Client, collector: Address, options?: { requireActivation?: boolean }) => Promise<BaseQuoteGraph>;
  batches?: () => Promise<BaseFeeBatch[]>; ledgerComplete?: boolean;
  custodyReport?: () => Promise<{ ready: boolean; assets: { asset: Address; pending: string; verifiedClaimed: string }[]; receivedWeth: string; refundedWeth: string }>;
  automationPolicy?: () => Promise<"unverified" | "configured" | "paused">;
};
async function rpc<T>(work: () => Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([work(), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("timeout")), 15_000); })]); }
  catch { throw new Error("The canonical Base RPC evidence could not be verified."); } finally { clearTimeout(timer); }
}
/** Retained name for the chain-scoped read API. Native Splits signs its own work: this reader never prepares swap/bridge calldata. */
export class BaseFeeQuoteReader {
  readonly client: Client; readonly collector: Address;
  constructor(readonly deps: BaseFeeDependencies) {
    if (!isAddress(deps.collector, { strict: false }) || sameAddress(deps.collector, zeroAddress)) throw new Error("A deployed Base fee adapter address is required.");
    this.client = deps.client; this.collector = getAddress(deps.collector);
  }
  async graph(): Promise<BaseQuoteGraph> {
    const checked = await (this.deps.verifyGraph ?? verifyBaseCollector)(this.client, this.collector, { requireActivation: false });
    if (!sameAddress(checked.collector, this.collector) || await rpc(() => this.client.getChainId()) !== 8453) throw new Error("The Base fee adapter network or address changed.");
    return checked;
  }
  async status(): Promise<BaseCollectorStatus> {
    const empty: BaseCollectorStatus = { kind: "base_splits_native", protocol: BASE_BUYBACK_PROTOCOL, chainId: 8453, available: false,
      collector: this.collector, automation: null, destinationChainId: 4663, destinationTreasury: BASE_BUYBACK_TREASURY,
      destinationVault: BASE_BUYBACK_VAULT, paused: true, nativeAutomationState: "unverified", totalBridgedWeth: "0", totalRefundedWeth: "0",
      assets: [], batches: [], ledgerComplete: false, assetsComplete: false };
    try {
      const graph = await this.graph(), block = await rpc(() => this.client.getBlock({ blockTag: "latest" }));
      if (!block.hash || block.number === null) throw new Error("Canonical adapter block unavailable");
      const batches = (await this.deps.batches?.() ?? []).filter(batch => batch.protocol === BASE_BUYBACK_PROTOCOL && sameAddress(batch.collector, this.collector));
      const custody = await this.deps.custodyReport?.();
      const assets = new Map(STOCKS.map(stock => [stock.address.toLowerCase(), { chainId: 8453 as const, address: stock.address, symbol: stock.symbol, decimals: stock.decimals }]));
      assets.set(BASE_BUYBACK_WETH.toLowerCase(), { chainId: 8453, address: BASE_BUYBACK_WETH, symbol: "WETH", decimals: 18 });
      const discovered = new Set<string>(custody?.assets.map(row => row.asset) ?? []);
      for (const batch of batches) for (const credit of batch.claimCredits ?? []) discovered.add(credit.token);
      for (const token of discovered) {
        if (!isAddress(token, { strict: false }) || sameAddress(token, zeroAddress) || assets.has(token.toLowerCase())) continue;
        const address = getAddress(token);
        const [symbol, decimals] = await Promise.all([
          rpc(() => this.client.readContract({ address, abi: erc20Abi, functionName: "symbol", blockNumber: block.number! })),
          rpc(() => this.client.readContract({ address, abi: erc20Abi, functionName: "decimals", blockNumber: block.number! })),
        ]);
        if (typeof symbol !== "string" || symbol.length < 1 || symbol.length > 64 || !Number.isInteger(decimals) || decimals < 0 || decimals > 255) throw new Error("Unverified asset precision");
        assets.set(address.toLowerCase(), { chainId: 8453, address, symbol, decimals });
      }
      const rows: BaseCollectorStatus["assets"] = [];
      // Bound concurrent RPC requests; native fee observation must not consume recovery capacity with a burst.
      for (const asset of assets.values()) {
        const [pending, untracked, claimed, released, balance] = await Promise.all([
          ...["pendingFees", "untrackedBalance", "totalClaimed", "totalReleased"].map(name => rpc(() => this.client.readContract({ address: this.collector, abi: baseCollectorAbi,
            functionName: name as "pendingFees", args: [asset.address], blockNumber: block.number! }))),
          rpc(() => this.client.readContract({ address: asset.address, abi: erc20Abi, functionName: "balanceOf", args: [graph.automationReceiver], blockNumber: block.number! })),
        ]);
        rows.push({ ...asset, pending: String(pending), untracked: String(untracked), totalClaimed: String(claimed), totalReleased: String(released), automationBalance: String(balance) });
      }
      if ((await rpc(() => this.client.getBlock({ blockNumber: block.number! }))).hash !== block.hash) throw new Error("Canonical adapter snapshot changed");
      return { ...empty, available: true, automation: graph.automationReceiver, paused: graph.paused, assets: rows, batches,
        nativeAutomationState: await this.deps.automationPolicy?.() ?? "unverified",
        ledgerComplete: custody?.ready === true, assetsComplete: custody?.ready === true,
        totalBridgedWeth: custody?.ready ? custody.receivedWeth : "0", totalRefundedWeth: custody?.ready ? custody.refundedWeth : "0" };
    } catch { return { ...empty, error: "The Base fee adapter deployment or canonical custody journal is not ready." }; }
  }
}
export function collectorClaimEvidence(receipt: TransactionReceipt, collector: Address, poolId: Hex) {
  if (receipt.status !== "success") throw new Error("Fee claim receipt failed");
  const credits = receipt.logs.filter(log => sameAddress(log.address, collector)).flatMap(log => {
    try { const event = decodeEventLog({ abi: baseCollectorAbi, data: log.data, topics: log.topics, strict: true });
      return event.eventName === "FeesClaimed" && event.args.poolId === poolId && event.args.amount >= 0n &&
        [CONTRACTS.initializer, CONTRACTS.rehype].some(manager => sameAddress(manager, event.args.manager))
        ? [{ ...event.args, amount: String(event.args.amount) }] : [];
    } catch { return []; }
  });
  if (!credits.length) throw new Error("Fee claim receipt has no verified manager credit events");
  // Another permissionless claimer can win the race. Canonical zero-fee success is resolved, never fee income.
  if (credits.every(credit => BigInt(credit.amount) === 0n)) return [];
  return credits;
}
export function collectorReleaseEvidence(receipt: TransactionReceipt, collector: Address, token: Address, amount: string, automation: Address) {
  if (receipt.status !== "success") throw new Error("Fee release receipt failed");
  const releases = receipt.logs.filter(log => sameAddress(log.address, collector)).flatMap(log => {
    try { const event = decodeEventLog({ abi: baseCollectorAbi, data: log.data, topics: log.topics, strict: true });
      return event.eventName === "FeesReleased" && sameAddress(event.args.token, token) && sameAddress(event.args.receiver, automation) && String(event.args.amount) === amount ? [event.args] : [];
    } catch { return []; }
  });
  const transfers = receipt.logs.filter(log => sameAddress(log.address, token)).flatMap(log => {
    try { const event = decodeEventLog({ abi: erc20Abi, data: log.data, topics: log.topics, strict: true });
      return event.eventName === "Transfer" && sameAddress(event.args.from, collector) && sameAddress(event.args.to, automation) ? [event.args.value] : [];
    } catch { return []; }
  });
  if (releases.length !== 1 || transfers.length !== 1 || String(transfers[0]) !== amount) throw new Error("Fee release lacks a unique actual Automation transfer");
  return { token, amount, automation };
}
export async function canonicalBaseReceipt(client: PublicClient<Transport, any>, hash: Hex, chainId: 8453 | 4663): Promise<TransactionReceipt> {
  if (await rpc(() => client.getChainId()) !== chainId) throw new Error("The receipt proof RPC is on another network.");
  const [receipt, head] = await Promise.all([rpc(() => client.getTransactionReceipt({ hash })), rpc(() => client.getBlockNumber({ cacheTime: 0 }))]);
  const block = await rpc(() => client.getBlock({ blockNumber: receipt.blockNumber }));
  if (receipt.transactionHash.toLowerCase() !== hash.toLowerCase() || block.hash !== receipt.blockHash || head < receipt.blockNumber + 1n) throw new Error("The receipt lacks canonical two-confirmation proof.");
  return receipt;
}
export const BASE_GAS_PRICE_ORACLE = getAddress("0x420000000000000000000000000000000000000F");
export const baseGasPriceOracleAbi = parseAbi([
  "function getL1Fee(bytes unsignedTransaction) view returns(uint256)",
  "function getL1FeeUpperBound(uint256 unsignedTransactionSize) view returns(uint256)",
  "function getOperatorFee(uint256 gasUsed) view returns(uint256)",
]);
/** Base's canonical total fee includes L1 publication and any operator fee.
 * Anvil's null L1 fields cannot stand in for actual Base fee evidence. */
export async function readCanonicalBaseTransactionFee(client: PublicClient<Transport, any>, receipt: TransactionReceipt): Promise<BaseTransactionFee> {
  if (await rpc(() => client.getChainId()) !== 8453) throw new Error("Base fee evidence requires the Base RPC.");
  const raw = await rpc(() => client.request({ method: "eth_getTransactionReceipt", params: [receipt.transactionHash] })) as Record<string, unknown> | null;
  const rawInteger = (value: unknown) => {
    if (typeof value !== "string" || !/^0x[\da-f]{1,64}$/i.test(value)) throw new Error("The canonical Base receipt lacks execution or L1 fee evidence. Signing is stopped.");
    return BigInt(value);
  };
  if (!raw || raw.transactionHash !== receipt.transactionHash || raw.blockHash !== receipt.blockHash || rawInteger(raw.blockNumber) !== receipt.blockNumber)
    throw new Error("The Base fee receipt identity is not canonical.");
  const gasUsed = rawInteger(raw.gasUsed), gasPrice = rawInteger(raw.effectiveGasPrice), l1 = rawInteger(raw.l1Fee);
  if (gasUsed !== receipt.gasUsed || gasPrice !== receipt.effectiveGasPrice) throw new Error("The Base fee receipt execution quantities changed.");
  const [operator, block] = await Promise.all([
    rpc(() => client.readContract({ address: BASE_GAS_PRICE_ORACLE, abi: baseGasPriceOracleAbi, functionName: "getOperatorFee", args: [gasUsed], blockNumber: receipt.blockNumber })),
    rpc(() => client.getBlock({ blockNumber: receipt.blockNumber })),
  ]);
  if (block.hash !== receipt.blockHash || operator < 0n) throw new Error("The canonical Base fee block or operator fee changed.");
  const execution = gasUsed * gasPrice;
  return { transactionHash: receipt.transactionHash, blockNumber: String(receipt.blockNumber), blockHash: receipt.blockHash,
    executionWei: String(execution), l1Wei: String(l1), operatorWei: String(operator), totalWei: String(execution + l1 + operator) };
}
