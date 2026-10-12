import { decodeEventLog, erc20Abi, getAddress, isAddress, parseAbi, zeroAddress, type Address, type Hex, type PublicClient, type TransactionReceipt, type Transport } from "viem";
import { CONTRACTS, STOCKS, sameAddress } from "../src/lib/config";
import { BASE_AUTOMATION_FEE_POLICY } from "../src/lib/fee-policy";
import type { LaunchpadService } from "./service";
import { BASE_BUYBACK_PROTOCOL, BASE_BUYBACK_RH_WETH, BASE_BUYBACK_TREASURY, BASE_BUYBACK_VAULT, BASE_BUYBACK_WETH, baseCollectorAbi,
  type BaseCollectorStatus, type BaseFeeAsset, type BaseTransactionFee } from "../src/lib/base-buyback";

type Client = PublicClient<Transport, any>;
export type BaseRecoveryAssetPolicy = { chainId: 8453; address: Address; symbol: string; decimals: number; minimumRaw: string };
export const BASE_RECOVERY_FIXED_ASSETS: readonly BaseRecoveryAssetPolicy[] = [
  ...STOCKS.map(stock => ({ ...stock,chainId: 8453 as const,minimumRaw: String(10n ** BigInt(Math.max(0,stock.decimals - 2))) })),
  { chainId: 8453,address: BASE_BUYBACK_WETH,symbol: "WETH",decimals: 18,minimumRaw: "10000000000000" },
];
const validProofHash = (value: unknown): value is Hex => typeof value === "string" && /^0x[\da-f]{64}$/i.test(value);
/** The private token registry is written only after complete launch registration. Reuse that proof instead of replaying creation on every poll. */
export async function readTrustedBaseRecoveryAssets(service: Pick<LaunchpadService,"store">,collector: Address,only?: Address) {
  const policies = new Map(BASE_RECOVERY_FIXED_ASSETS.map(asset=>[asset.address.toLowerCase(),asset]));
  for (const token of await service.store.tokens()) {
    if (only && !sameAddress(token.address,only) || token.mode !== "base" || token.deploymentChainId !== 8453 ||
      token.feePolicy !== BASE_AUTOMATION_FEE_POLICY || !token.feeEngine || !sameAddress(token.feeEngine,collector) ||
      !validProofHash(token.transactionHash) || !validProofHash(token.poolId) || !token.blockNumber || !/^[1-9]\d*$/.test(token.blockNumber) ||
      !token.creator || !isAddress(token.creator,{strict:false}) || sameAddress(token.creator,zeroAddress) ||
      !isAddress(token.address,{strict:false}) || sameAddress(token.address,zeroAddress) || !STOCKS.some(stock=>sameAddress(stock.address,token.quoteAddress)) ||
      typeof token.symbol !== "string" || !token.symbol) continue;
    if (!policies.has(token.address.toLowerCase())) policies.set(token.address.toLowerCase(),{
      chainId:8453,address:getAddress(token.address),symbol:token.symbol.slice(0,64),decimals:18,minimumRaw:"1000000000000000000" });
  }
  return [...policies.values()];
}
export type BaseQuoteGraph = { collector: Address; automationReceiver: Address; runtimeHash?: Hex;
  initialDeploymentBlock?: bigint | string; manifestFingerprint?: Hex };
export const BUYBACK_SUMMARY_CACHE_MS = 300_000;
export type BaseFeeDependencies = { client: Client; collector: Address; verifiedGraph: BaseQuoteGraph;
  assets?: () => Promise<BaseFeeAsset[]>; includeTaskState?: boolean; now?: () => number;
};
async function rpc<T>(work: () => Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([work(),new Promise<never>((_,reject) => { timer = setTimeout(() => reject(new Error("timeout")),15_000); })]); }
  catch { throw new Error("The canonical Base RPC evidence could not be verified."); } finally { clearTimeout(timer); }
}
export function unavailableBaseCollectorStatus(collector: Address | null = null, reason = "Base fee totals are temporarily unavailable."): BaseCollectorStatus {
  return { kind: "base_splits_native",protocol: BASE_BUYBACK_PROTOCOL,chainId: 8453,available: false,collector,automation: null,
    destinationChainId: 4663,destinationTreasury: BASE_BUYBACK_TREASURY,destinationVault: BASE_BUYBACK_VAULT,
    paused: true,nativeAutomationState: "unverified",checkedAt: 0,blockNumber: null,assets: [],assetsComplete: false,error: reason };
}
/** Counter-only display/task reader. Startup owns immutable verification; this class never scans transfer history. */
export class BaseFeeQuoteReader {
  readonly client: Client; readonly collector: Address;
  private cached?: { until: number; status: BaseCollectorStatus };
  private inFlight?: Promise<BaseCollectorStatus>;
  private readonly now: () => number;
  constructor(readonly deps: BaseFeeDependencies) {
    if (!isAddress(deps.collector,{ strict: false }) || sameAddress(deps.collector,zeroAddress) ||
      !sameAddress(deps.verifiedGraph.collector,deps.collector) || !isAddress(deps.verifiedGraph.automationReceiver,{strict:false}) ||
      sameAddress(deps.verifiedGraph.automationReceiver,zeroAddress)) throw new Error("The fixed Base Collector and Automation configuration is required.");
    this.client = deps.client; this.collector = getAddress(deps.collector); this.now = deps.now ?? (() => Date.now());
  }
  async status(): Promise<BaseCollectorStatus> {
    if (this.cached && this.now() < this.cached.until) return structuredClone(this.cached.status);
    if (!this.inFlight) this.inFlight = this.readFresh().then(status => {
      this.cached = { until: this.now() + BUYBACK_SUMMARY_CACHE_MS,status }; return status;
    }).finally(() => { this.inFlight = undefined; });
    return structuredClone(await this.inFlight);
  }
  private async readFresh(): Promise<BaseCollectorStatus> {
    const empty = unavailableBaseCollectorStatus(this.collector);
    try {
      const graph = this.deps.verifiedGraph, blockNumber = await this.client.getBlockNumber();
      const assets = new Map(BASE_RECOVERY_FIXED_ASSETS.map(asset => [asset.address.toLowerCase(),asset] as [string,BaseFeeAsset]));
      let assetsComplete = true;
      for (const asset of await this.deps.assets?.() ?? []) {
        if (!isAddress(asset.address,{strict:false}) || sameAddress(asset.address,zeroAddress) || asset.chainId !== 8453 ||
          !Number.isInteger(asset.decimals) || asset.decimals < 0 || asset.decimals > 255 || typeof asset.symbol !== "string" || !asset.symbol) { assetsComplete = false; continue; }
        if (!assets.has(asset.address.toLowerCase())) assets.set(asset.address.toLowerCase(),{...asset,address:getAddress(asset.address),symbol:asset.symbol.slice(0,64)});
      }
      const names = this.deps.includeTaskState ? ["totalClaimed","totalReleased","totalUntrackedReleased","balanceOf","pendingFees","untrackedBalance","pendingUntracked","totalUntrackedSynced","verifiedAssets"] as const
        : ["totalClaimed","totalReleased","totalUntrackedReleased","balanceOf"] as const;
      const contracts = [{ address: this.collector,abi: baseCollectorAbi,functionName: "paused" as const },
        ...[...assets.values()].flatMap(asset => names.map(functionName => functionName === "balanceOf"
          ? { address: asset.address,abi: erc20Abi,functionName,args: [graph.automationReceiver] }
          : { address: this.collector,abi: baseCollectorAbi,functionName,args: [asset.address] }))];
      const results = await this.client.multicall({contracts,allowFailure: true,blockNumber,batchSize: 128 * 1024});
      if (results[0]?.status !== "success" || typeof results[0].result !== "boolean") throw new Error("Collector pause state unavailable");
      const paused = results[0].result, rows: BaseCollectorStatus["assets"] = [];
      const unsigned = (result: typeof results[number]) => {
        if (result?.status !== "success" || typeof result.result !== "bigint" || result.result < 0n || result.result >= 2n ** 256n) throw new Error("Counter unavailable");
        return result.result;
      };
      for (const [index,asset] of [...assets.values()].entries()) {
        try {
          const values = results.slice(1 + index * names.length,1 + (index + 1) * names.length);
          const claimed = unsigned(values[0]),released = unsigned(values[1]),releasedUntracked = unsigned(values[2]),balance = unsigned(values[3]);
          if (released > claimed) throw new Error("Collector fee counters are inconsistent");
          const row: BaseCollectorStatus["assets"][number] = { ...asset,pending: String(claimed - released),
            totalClaimed: String(claimed),totalReleased: String(released),totalUntrackedReleased: String(releasedUntracked),automationBalance: String(balance) };
          if (this.deps.includeTaskState) {
            row.pending = String(unsigned(values[4])); row.untracked = String(unsigned(values[5]));
            row.pendingUntracked = String(unsigned(values[6])); row.totalUntrackedSynced = String(unsigned(values[7]));
            if (values[8]?.status !== "success" || typeof values[8].result !== "boolean") throw new Error("Asset registration unavailable");
            row.verifiedAsset = values[8].result;
          }
          rows.push(row);
        } catch { assetsComplete = false; }
      }
      return { ...empty,available: true,automation: graph.automationReceiver,paused,nativeAutomationState: paused ? "paused" : "configured",
        checkedAt: this.now(),blockNumber: String(blockNumber),assets: rows,assetsComplete,error: undefined };
    } catch {
      if (this.cached?.status.available) return { ...this.cached.status,stale: true,error: "Base fee totals are delayed; values show the previous sample." };
      return { ...empty,checkedAt: this.now() };
    }
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
export function collectorReleaseEvidence(receipt: TransactionReceipt, collector: Address, token: Address, amount: string, automation: Address, untracked = false) {
  if (receipt.status !== "success") throw new Error("Fee release receipt failed");
  const releases = receipt.logs.filter(log => sameAddress(log.address, collector)).flatMap(log => {
    try { const event = decodeEventLog({ abi: baseCollectorAbi, data: log.data, topics: log.topics, strict: true });
      return event.eventName === (untracked ? "UntrackedReleased" : "FeesReleased") && sameAddress(event.args.token, token) && sameAddress(event.args.receiver, automation) && String(event.args.amount) === amount ? [event.args] : [];
    } catch { return []; }
  });
  const transfers = receipt.logs.filter(log => sameAddress(log.address, token)).flatMap(log => {
    try { const event = decodeEventLog({ abi: erc20Abi, data: log.data, topics: log.topics, strict: true });
      return event.eventName === "Transfer" && event.args.value > 0n && !sameAddress(event.args.from,event.args.to) && sameAddress(event.args.from, collector) && sameAddress(event.args.to, automation) ? [event.args.value] : [];
    } catch { return []; }
  });
  if (releases.length !== 1 || transfers.length !== 1 || String(transfers[0]) !== amount) throw new Error("Fee release lacks a unique actual Automation transfer");
  return { token, amount, automation };
}
/** Synchronization only classifies previously unknown balance; it is not a manager receipt or transfer. */
export function collectorUntrackedSyncEvidence(receipt: TransactionReceipt, collector: Address, token: Address) {
  if (receipt.status !== "success") throw new Error("Unknown synchronization receipt failed");
  const syncs = receipt.logs.filter(log => sameAddress(log.address,collector)).flatMap(log => {
    try { const event = decodeEventLog({ abi: baseCollectorAbi, data: log.data, topics: log.topics, strict: true });
      return event.eventName === "UntrackedSynced" && sameAddress(event.args.token,token) && event.args.amount > 0n ? [event.args] : [];
    } catch { return []; }
  });
  if (syncs.length !== 1) throw new Error("Unknown synchronization lacks its unique independent counter event");
  return { token, amount: String(syncs[0].amount) };
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
export async function readCanonicalBaseTransactionFee(client: PublicClient<Transport, any>, receipt: TransactionReceipt,retained?: BaseTransactionFee): Promise<BaseTransactionFee> {
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
  let receiptOperator: bigint | undefined;
  if ("operatorFeeScalar" in raw || "operatorFeeConstant" in raw) {
    const scalar = rawInteger(raw.operatorFeeScalar),constant = rawInteger(raw.operatorFeeConstant);
    if (scalar > (1n<<32n)-1n || constant > (1n<<64n)-1n) throw new Error("Canonical operator fee parameters exceed their protocol bounds.");
    // Isthmus divides a nonzero scalar by 1e6; Jovian multiplies it by 100. A literal zero scalar
    // makes both reviewed formulas exactly the constant. Missing fields never prove zero fees.
    if (scalar === 0n) receiptOperator = constant;
  }
  const execution = gasUsed * gasPrice;
  let operator: bigint;
  if (retained) {
    const amounts = [retained.executionWei,retained.l1Wei,retained.operatorWei,retained.totalWei];
    if (retained.transactionHash !== receipt.transactionHash || retained.blockHash !== receipt.blockHash || retained.blockNumber !== String(receipt.blockNumber) ||
      !amounts.every(amount=>typeof amount === "string" && /^(0|[1-9]\d*)$/.test(amount)) || BigInt(retained.executionWei)!==execution || BigInt(retained.l1Wei)!==l1 ||
      BigInt(retained.totalWei)!==BigInt(retained.executionWei)+BigInt(retained.l1Wei)+BigInt(retained.operatorWei) ||
      receiptOperator !== undefined && BigInt(retained.operatorWei)!==receiptOperator) throw new Error("Retained canonical Base fee evidence no longer matches the full receipt cost.");
    // This private journal value was fully verified at mining. The same canonical receipt/header commits the
    // immutable transaction cost; rechecking asset logs needs no historical GasPriceOracle state again.
    operator = BigInt(retained.operatorWei);
  } else operator = receiptOperator ?? await rpc(() => client.readContract({ address: BASE_GAS_PRICE_ORACLE,abi: baseGasPriceOracleAbi,functionName: "getOperatorFee",args: [gasUsed],blockNumber: receipt.blockNumber }));
  const block = await rpc(() => client.getBlock({ blockNumber: receipt.blockNumber }));
  if (block.hash !== receipt.blockHash || operator < 0n) throw new Error("The canonical Base fee block or operator fee changed.");
  return { transactionHash: receipt.transactionHash, blockNumber: String(receipt.blockNumber), blockHash: receipt.blockHash,
    executionWei: String(execution), l1Wei: String(l1), operatorWei: String(operator), totalWei: String(execution + l1 + operator) };
}
