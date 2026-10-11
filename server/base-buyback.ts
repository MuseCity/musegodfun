import { decodeEventLog, erc20Abi, getAddress, isAddress, keccak256, parseAbi, stringToHex, zeroAddress, type Address, type Hex, type PublicClient, type TransactionReceipt, type Transport } from "viem";
import { CONTRACTS, STOCKS, sameAddress } from "../src/lib/config";
import { BASE_AUTOMATION_FEE_POLICY } from "../src/lib/fee-policy";
import { assertRecoveryPlan, verifyCreationAccounting } from "./launch-verification";
import { tradingFeeBpsFor } from "../src/lib/trading-fee";
import type { LaunchpadService } from "./service";
import { airlockAbi } from "@whetstone-research/doppler-sdk/evm";
import { BASE_BUYBACK_PROTOCOL, BASE_BUYBACK_RH_WETH, BASE_BUYBACK_TREASURY, BASE_BUYBACK_VAULT, BASE_BUYBACK_WETH, baseCollectorAbi,
  type BaseCollectorStatus, type BaseFeeBatch, type BaseTransactionFee } from "../src/lib/base-buyback";
import { verifyBaseCollector } from "./base-collector";

type Client = PublicClient<Transport, any>;
export type BaseRecoveryAssetPolicy = { chainId: 8453; address: Address; symbol: string; decimals: number; minimumRaw: string };
export const BASE_RECOVERY_FIXED_ASSETS: readonly BaseRecoveryAssetPolicy[] = [
  ...STOCKS.map(stock => ({ ...stock,chainId: 8453 as const,minimumRaw: String(10n ** BigInt(Math.max(0,stock.decimals - 2))) })),
  { chainId: 8453,address: BASE_BUYBACK_WETH,symbol: "WETH",decimals: 18,minimumRaw: "10000000000000" },
];
type BaseIssuanceCache = { id: string; protocol: "internal_native_base_issuance_v1"; version: 1; binding: Hex;
  creationHash: Hex; blockNumber: string; blockHash: Hex; creationCalldataHash: Hex; planId: string; finalizedCreation?: true };
const validProofHash = (value: unknown): value is Hex => typeof value === "string" && /^0x[\da-f]{64}$/i.test(value);
/** The issuance registry is private persistent state. A status row or a Collector-blessed arbitrary pool is not issuance proof. */
export async function readTrustedBaseRecoveryAssets(service: Pick<LaunchpadService,"client"|"store"|"sdk"|"contracts"|"state"|"fees">, collector: Address,only?: Address) {
  if (await service.client.getChainId() !== 8453) throw new Error("Automatic fee assets require the canonical Base registry and RPC");
  const policies = new Map(BASE_RECOVERY_FIXED_ASSETS.map(asset=>[asset.address.toLowerCase(),asset]));
  let current: { number: bigint | null; hash: Hex | null } | undefined,finalized: { number: bigint | null; hash: Hex | null } | null | undefined;
  for (const token of await service.store.tokens()) {
    if (only && !sameAddress(token.address,only) || token.mode !== "base" || token.deploymentChainId !== 8453 || token.feePolicy !== BASE_AUTOMATION_FEE_POLICY || !token.feeEngine ||
      !sameAddress(token.feeEngine,collector) || !token.transactionHash || !token.blockNumber || !token.creator || policies.has(token.address.toLowerCase())) continue;
    try {
      // Current balance/manager reads select candidates, never establish issuance identity. Dormant historical
      // registrations need no repeated creation RPC; a selected signing asset always gets the full proof below.
      if (!only) {
        const balance = await service.client.readContract({ address: token.address,abi: erc20Abi,functionName: "balanceOf",args: [collector] });
        if (typeof balance !== "bigint" || balance < 0n) continue;
        if (balance === 0n) {
          const fees = await service.fees(token.address,collector);
          if (![fees.lp.fees0,fees.lp.fees1,fees.trade.fees0,fees.trade.fees1].some(amount=>amount > 0n)) continue;
        }
      }
      current ??= await service.client.getBlock({ blockTag: "latest" });
      if (current.number === null || !validProofHash(current.hash)) continue;
      if (finalized === undefined) finalized = await service.client.getBlock({ blockTag: "finalized" }).catch(()=>null);
      const binding = keccak256(stringToHex(JSON.stringify({ version: 1,address: token.address.toLowerCase(),creator: token.creator.toLowerCase(),poolId: token.poolId,
        quoteAddress: token.quoteAddress.toLowerCase(),transactionHash: token.transactionHash.toLowerCase(),blockNumber: token.blockNumber,
        feePolicy: token.feePolicy,collector: collector.toLowerCase(),tradingFeeBps: tradingFeeBpsFor(token.tradingFeeBps),contracts: service.contracts })));
      const id = `internal_native_issuance:${binding}`,audit = service.store as Partial<Pick<LaunchpadService["store"],"getBuybackBatch"|"compareAndSetBuybackAudit">>,
        cacheStore = audit.getBuybackBatch && audit.compareAndSetBuybackAudit ? service.store : undefined;
      const stored = cacheStore ? await cacheStore.getBuybackBatch(id) : null;
      const validCache = (value: any): value is BaseIssuanceCache => value?.id === id && value.protocol === "internal_native_base_issuance_v1" && value.version === 1 &&
        value.binding === binding && value.finalizedCreation === true && value.creationHash === token.transactionHash && value.blockNumber === token.blockNumber &&
        validProofHash(value.blockHash) && validProofHash(value.creationCalldataHash) && typeof value.planId === "string" && value.planId.length>0;
      let proof = validCache(stored) && finalized?.number !== null && finalized?.number !== undefined && finalized.number>=BigInt(token.blockNumber) &&
        (await service.client.getBlock({ blockNumber: BigInt(token.blockNumber) })).hash===stored.blockHash ? stored : undefined;
      const cached = !!proof;
      if (!proof) {
        const receipt = await canonicalBaseReceipt(service.client,token.transactionHash,8453), tx = await service.client.getTransaction({ hash: token.transactionHash });
        const plan = await service.store.findPlan(receipt.from,tx.input);
        if (receipt.status !== "success" || receipt.blockNumber !== BigInt(token.blockNumber) || !plan || !tx.to || !receipt.to || !sameAddress(tx.to,receipt.to) ||
          !sameAddress(tx.from,token.creator) || !sameAddress(receipt.from,token.creator) || !sameAddress(plan.creator,token.creator) || !sameAddress(plan.tokenAddress,token.address) ||
          plan.poolId !== token.poolId || !sameAddress(plan.draft.quoteAddress,token.quoteAddress) || plan.feePolicy !== BASE_AUTOMATION_FEE_POLICY ||
          !plan.feeEngine || !sameAddress(plan.feeEngine,collector) || !plan.transaction || !sameAddress(plan.transaction.to,tx.to) ||
          tx.value !== BigInt(plan.transaction.value) || tx.input.toLowerCase() !== plan.data.toLowerCase()) continue;
        const creations = receipt.logs.filter(log=>sameAddress(log.address,service.contracts.airlock)).flatMap(log=>{
          try { const event = decodeEventLog({ abi: airlockAbi,data: log.data,topics: log.topics,strict: true });
            return event.eventName === "Create" && sameAddress(event.args.asset,token.address) && sameAddress(event.args.numeraire,token.quoteAddress) && sameAddress(event.args.initializer,service.contracts.initializer) ? [event.args] : [];
          } catch { return []; }
        });
        if (creations.length !== 1) continue;
        // A finalized, privately cached receipt/calldata/factory proof does not need replay on every fee poll.
        assertRecoveryPlan(plan,service.contracts,service.sdk);
        verifyCreationAccounting(plan,receipt,service.contracts,tradingFeeBpsFor(token.tradingFeeBps));
        proof = { id,protocol: "internal_native_base_issuance_v1",version: 1,binding,creationHash: token.transactionHash,
          blockNumber: token.blockNumber,blockHash: receipt.blockHash,creationCalldataHash: keccak256(tx.input),planId: plan.id };
      }
      await service.state(token.address,token);
      // The immutable project token's precision is read freshly; historical state is unnecessary.
      const decimals = await service.client.readContract({ address: token.address,abi: erc20Abi,functionName: "decimals",blockNumber: current.number });
      if (decimals !== 18) continue; // Fixed project token factory emits the 18-decimal issuance; this is observed, not guessed.
      if ((await service.client.getBlock({ blockNumber: BigInt(proof.blockNumber) })).hash!==proof.blockHash ||
        (await service.client.getBlock({ blockNumber: current.number })).hash!==current.hash) continue;
      if (!cached&&cacheStore&&finalized?.number !== null&&finalized?.number !== undefined&&finalized.number>=BigInt(proof.blockNumber)&&validProofHash(finalized.hash)) {
        if ((await service.client.getBlock({ blockNumber: finalized.number })).hash!==finalized.hash || !await cacheStore.compareAndSetBuybackAudit({ ...proof,finalizedCreation: true },stored)) continue;
      }
      policies.set(token.address.toLowerCase(),{ chainId: 8453,address: token.address,symbol: token.symbol,decimals,minimumRaw: String(10n ** BigInt(decimals)) });
    } catch { /* A failed or absent registry proof withholds only this asset's automatic tasks. */ }
  }
  return [...policies.values()];
}
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
      let assetsComplete = custody?.ready === true;
      for (const batch of batches) for (const credit of batch.claimCredits ?? []) discovered.add(credit.token);
      for (const batch of batches) for (const token of batch.claimAssets ?? []) discovered.add(token);
      for (const token of discovered) {
        if (!isAddress(token, { strict: false }) || sameAddress(token, zeroAddress)) { assetsComplete = false; continue; }
        if (assets.has(token.toLowerCase())) continue;
        const address = getAddress(token);
        const [symbolResult, decimalsResult] = await Promise.allSettled([
          rpc(() => this.client.readContract({ address, abi: erc20Abi, functionName: "symbol", blockNumber: block.number! })),
          rpc(() => this.client.readContract({ address, abi: erc20Abi, functionName: "decimals", blockNumber: block.number! })),
        ]);
        const decimals = decimalsResult.status === "fulfilled" ? decimalsResult.value : undefined;
        if (typeof decimals !== "number" || !Number.isInteger(decimals) || decimals < 0 || decimals > 255) { assetsComplete = false; continue; }
        const actualSymbol = symbolResult.status === "fulfilled" ? symbolResult.value : undefined;
        const validSymbol = typeof actualSymbol === "string" && actualSymbol.length > 0;
        if (!validSymbol || actualSymbol.length > 64) assetsComplete = false;
        const symbol = validSymbol ? actualSymbol.slice(0, 64) : `${address.slice(0, 6)}…${address.slice(-4)}`;
        assets.set(address.toLowerCase(), { chainId: 8453, address, symbol, decimals });
      }
      const rows: BaseCollectorStatus["assets"] = [];
      // Bound concurrent RPC requests; native fee observation must not consume recovery capacity with a burst.
      for (const asset of assets.values()) {
        try {
        const [pending, untracked, claimed, released, pendingUntracked, syncedUntracked, releasedUntracked, verifiedAsset, balance] = await Promise.all([
          ...["pendingFees", "untrackedBalance", "totalClaimed", "totalReleased", "pendingUntracked", "totalUntrackedSynced", "totalUntrackedReleased"].map(name => rpc(() => this.client.readContract({ address: this.collector, abi: baseCollectorAbi,
            functionName: name as "pendingFees", args: [asset.address], blockNumber: block.number! }))),
          rpc(() => this.client.readContract({ address: this.collector, abi: baseCollectorAbi, functionName: "verifiedAssets", args: [asset.address], blockNumber: block.number! })),
          rpc(() => this.client.readContract({ address: asset.address, abi: erc20Abi, functionName: "balanceOf", args: [graph.automationReceiver], blockNumber: block.number! })),
        ]);
        rows.push({ ...asset, pending: String(pending), untracked: String(untracked), totalClaimed: String(claimed), totalReleased: String(released),
          pendingUntracked: String(pendingUntracked), totalUntrackedSynced: String(syncedUntracked), totalUntrackedReleased: String(releasedUntracked), verifiedAsset: verifiedAsset === true, automationBalance: String(balance) });
        } catch { assetsComplete = false; }
      }
      if ((await rpc(() => this.client.getBlock({ blockNumber: block.number! }))).hash !== block.hash) throw new Error("Canonical adapter snapshot changed");
      return { ...empty, available: true, automation: graph.automationReceiver, paused: graph.paused, assets: rows, batches,
        nativeAutomationState: await this.deps.automationPolicy?.() ?? "unverified",
        ledgerComplete: custody?.ready === true, assetsComplete,
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
