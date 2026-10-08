import { decodeEventLog, erc20Abi, getAddress, hashMessage, keccak256, parseAbi, recoverMessageAddress, toBytes, type Address, type Hex, type PublicClient, type TransactionReceipt } from "viem";
import type { BuybackDeployment } from "./buyback-engine";

const OLD_FORWARDER = getAddress("0x3B6d01e627Fe6e06C831E0f9f57aC976a88309Ff");
const MAX = 2n ** 256n - 1n;
const FORWARDER_ALLOWANCE_CAP = 288n * 10n ** 16n;
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const hash = (value: unknown): value is Hex => typeof value === "string" && /^0x[0-9a-fA-F]{64}$/.test(value);
const rawAmount = (value: unknown, allowZero = false) => {
  if (typeof value !== "string" || !/^(?:0|[1-9]\d{0,77})$/.test(value) || BigInt(value) >= MAX || !allowZero && BigInt(value) === 0n) throw new Error("Activation proof requires an exact finite raw amount");
  return BigInt(value);
};
type ReceiptReference = { chainId: number; graphFingerprint: Hex; transactionHash: Hex };
type ApprovalProof = ReceiptReference & { source: Address; token: Address; spender: Address; amount: string };
export type NativeAcceptanceProof = {
  chainId: number; graphFingerprint: Hex; ruleId: string; schedulerRunId: string;
  evidenceUri: string; evidenceSha256: Hex; unpricedToken: Address; inputAmount: string; wethAmount: string;
  feeCollectionTransactionHash: Hex; feeTransactionHash: Hex; conversionTransactionHash: Hex; sweepTransactionHash: Hex;
  forwardTransactionHash: Hex; settlementTransactionHash: Hex; signer: Address; signature: Hex;
};
export type BuybackActivation = {
  schemaVersion: 1; chainId: 4663; graphFingerprint: Hex;
  oldForwarderRevocation: ApprovalProof; newFiniteAllowance: ApprovalProof;
  nativeAutomationAcceptance: NativeAcceptanceProof;
  legacySwapperCutover: { blockNumber: string; blockHash: Hex; wethBalance: "0" };
};
export type GovernorControlProof = { chainId: number; graphFingerprint: Hex; blockNumber: string; blockHash: Hex; signer: Address; signature: Hex };
type ActivationClient = Pick<PublicClient, "getChainId" | "getCode" | "readContract" | "getTransactionReceipt"> & {
  getBlock(parameters: { blockNumber: bigint } | { blockTag: "finalized" }): Promise<{ number?: bigint | null; hash?: Hex | null }>;
};
const unpricedAbi = parseAbi(["event UnpricedForwarded(address indexed token,uint256 amount,address indexed automation)"]);
const claimedAbi = parseAbi(["event FeesClaimed(bytes32 indexed poolId,address indexed manager,address indexed token,uint256 amount)"]);
const collectedCounterAbi = parseAbi(["function totalAutomationForwarded(address token) view returns(uint256)"]);
const forwardAbi = parseAbi(["event Forwarded(address indexed caller,uint256 amount)"]);
const executeAbi = parseAbi(["event Executed(address indexed caller,uint256 wethAmount,uint256 museToDead,uint256 profit)"]);
const flashAbi = parseAbi(["event Flash(address indexed beneficiary,address indexed trader,((address base,address quote) quotePair,uint128 baseAmount,bytes data)[] quoteParams,address tokenToBeneficiary,uint256[] amountsToBeneficiary,uint256 excessToBeneficiary)"]);
const erc1271Abi = parseAbi(["function isValidSignature(bytes32 hash,bytes signature) view returns(bytes4)"]);

/** Fixed ordering avoids JSON property-order dependence. No mutable activation fields enter this hash. */
export function buybackGraphFingerprint(manifest: BuybackDeployment): Hex {
  const nodes = ["oracle", "swapper", "executor", "assetOracle", "vault", "engine", "forwarder"] as const;
  if (manifest.chainId !== 4663 || manifest.schemaVersion !== 2) throw new Error("Activation only supports the reviewed V2 Robinhood graph");
  const contracts = nodes.map((name) => {
    const entry = manifest.contracts[name];
    if (!entry?.address || !hash(entry.runtimeHash)) throw new Error("Activation graph is incomplete");
    return [name, getAddress(entry.address).toLowerCase(), entry.runtimeHash.toLowerCase()];
  });
  const constants = Object.entries(manifest.constants).sort(([a], [b]) => a.localeCompare(b)).map(([name, value]) => {
    if (!value) throw new Error("Activation account is missing");
    return [name, getAddress(value).toLowerCase()];
  });
  const descriptions = Object.entries(manifest.assetFeedDescriptions ?? {}).sort(([a], [b]) => a.localeCompare(b)).map(([token, value]) => [token.toLowerCase(), value.descriptionHash.toLowerCase()]);
  if (descriptions.length !== 38) throw new Error("Activation initial feed metadata is incomplete");
  return keccak256(toBytes(JSON.stringify(["musegod-buyback-v2", 4663, contracts, constants, descriptions,
    { windowSeconds: 300, wethCap: "10000000000000000", forwarderAllowanceCap: String(FORWARDER_ALLOWANCE_CAP), deviationBps: 200, governanceDelay: 604800, conversionFloorBps: 9900, offerFactor: 985000 }])));
}
export function governorControlMessage(proof: Omit<GovernorControlProof, "signer" | "signature">): string {
  return `MUSEGOD BUYBACK V2 GOVERNOR CONTROL\nchainId=4663\ngraph=${proof.graphFingerprint.toLowerCase()}\ncontrolBlock=${proof.blockNumber}\ncontrolBlockHash=${proof.blockHash.toLowerCase()}`;
}
export function nativeAcceptanceMessage(proof: Omit<NativeAcceptanceProof, "signer" | "signature">): string {
  return `MUSEGOD BUYBACK V2 NATIVE AUTOMATION ACCEPTANCE\n${JSON.stringify({ chainId: 4663, graphFingerprint: proof.graphFingerprint.toLowerCase(), ruleId: proof.ruleId, schedulerRunId: proof.schedulerRunId,
    evidenceUri: proof.evidenceUri, evidenceSha256: proof.evidenceSha256.toLowerCase(), unpricedToken: proof.unpricedToken.toLowerCase(), inputAmount: proof.inputAmount, wethAmount: proof.wethAmount,
    feeCollectionTransactionHash: proof.feeCollectionTransactionHash.toLowerCase(), feeTransactionHash: proof.feeTransactionHash.toLowerCase(), conversionTransactionHash: proof.conversionTransactionHash.toLowerCase(), sweepTransactionHash: proof.sweepTransactionHash.toLowerCase(), forwardTransactionHash: proof.forwardTransactionHash.toLowerCase(), settlementTransactionHash: proof.settlementTransactionHash.toLowerCase() })}\nI attest that the identified native scheduled rule executed this conversion and sweep. Manual funding alone is not native Automation acceptance. This attestation is an external execution claim, not an on-chain scheduler proof.`;
}
async function signedByGovernor(client: ActivationClient, governor: Address, signer: Address, signature: Hex, message: string, blockNumber: bigint, code: Hex | undefined) {
  if (typeof signature !== "string" || !/^0x(?:[0-9a-fA-F]{2})+$/.test(signature)) throw new Error("Missing governor activation signature");
  if (!code || code === "0x") {
    const recovered = await recoverMessageAddress({ message, signature });
    if (!same(recovered, signer) || !same(recovered, governor)) throw new Error("Activation attestation is not signed by the immutable governor");
  } else {
    // A multisig signature may not be a recoverable 65-byte EOA signature.
    if (!same(signer, governor)) throw new Error("Activation attestation names another governor contract");
    const valid = await client.readContract({ address: governor, abi: erc1271Abi, functionName: "isValidSignature", args: [hashMessage(message), signature], blockNumber });
    if (valid !== "0x1626ba7e") throw new Error("Governor contract rejected the activation signature");
  }
}
function events<T>(receipt: TransactionReceipt, address: Address, abi: readonly unknown[]): (T & { logIndex: number })[] {
  const found: (T & { logIndex: number })[] = [];
  for (const log of receipt.logs) if (same(log.address, address)) {
    try { found.push({ ...decodeEventLog({ abi, topics: log.topics, data: log.data, strict: true }), logIndex: log.logIndex } as unknown as T & { logIndex: number }); } catch { /* Other events are not acceptance proof. */ }
  }
  return found;
}
function transfers(receipt: TransactionReceipt, token: Address, from: Address | null, to: Address | null): bigint {
  return events<{ eventName: string; args: { from: Address; to: Address; value: bigint } }>(receipt, token, erc20Abi)
    .filter((e) => e.eventName === "Transfer" && (!from || same(e.args.from, from)) && (!to || same(e.args.to, to))).reduce((sum, e) => sum + e.args.value, 0n);
}
/** Replay only historical evidence here. Current governor authority is checked
 * separately on every call, including hits in the finalized evidence cache. */
async function verifyActivationEvidence(client: ActivationClient, manifest: BuybackDeployment, head: bigint) {
  const proof = manifest.activation as BuybackActivation | undefined;
  const control = manifest.governance?.controlProof as GovernorControlProof | undefined;
  if (!proof || proof.schemaVersion !== 1 || proof.chainId !== 4663 || !control || typeof control !== "object") throw new Error("Buyback first activation proof is incomplete");
  const fingerprint = buybackGraphFingerprint(manifest);
  const bound = (value: { chainId: number; graphFingerprint: Hex } | undefined) => {
    if (!value || value.chainId !== 4663 || !hash(value.graphFingerprint) || value.graphFingerprint.toLowerCase() !== fingerprint) throw new Error("Activation proof belongs to another graph");
  };
  bound(proof); bound(control); bound(proof.oldForwarderRevocation); bound(proof.newFiniteAllowance); bound(proof.nativeAutomationAcceptance);
  const c = manifest.constants;
  const weth = getAddress(c.weth), muse = getAddress(c.muse), source = getAddress(c.automationTreasury!), automation = getAddress(c.automation!);
  const node = (name: "assetOracle" | "engine" | "vault" | "forwarder" | "swapper" | "executor") => getAddress(manifest.contracts[name]!.address!);
  const receipts = new Map<Hex, Promise<TransactionReceipt>>();
  const receipt = (transactionHash: Hex) => {
    if (!hash(transactionHash)) throw new Error("Activation receipt hash is missing");
    if (!receipts.has(transactionHash)) receipts.set(transactionHash, (async () => {
      const r = await client.getTransactionReceipt({ hash: transactionHash });
      if (!same(r.transactionHash, transactionHash) || r.status !== "success" || head < r.blockNumber + 64n || (await client.getBlock({ blockNumber: r.blockNumber })).hash !== r.blockHash) throw new Error("Activation receipt is not successful, confirmed and canonical");
      return r;
    })());
    return receipts.get(transactionHash)!;
  };
  if (!/^\d+$/.test(control.blockNumber) || !hash(control.blockHash) || head < BigInt(control.blockNumber) + 64n) throw new Error("Governor control proof lacks a canonical confirmed block");
  const approval = async (p: ApprovalProof, spender: Address, amount: bigint) => {
    if (!same(p.source, source) || !same(p.token, weth) || !same(p.spender, spender) || rawAmount(p.amount, true) !== amount) throw new Error("Activation approval addresses or amount differ");
    const r = await receipt(p.transactionHash);
    if (!events<{ eventName: string; args: { owner: Address; spender: Address; value: bigint } }>(r, weth, erc20Abi).some((e) => e.eventName === "Approval" && same(e.args.owner, source) && same(e.args.spender, spender) && e.args.value === amount)) throw new Error("Activation has no exact WETH Approval receipt");
    return r;
  };
  const approvedAmount = rawAmount(proof.newFiniteAllowance.amount);
  if (approvedAmount > FORWARDER_ALLOWANCE_CAP) throw new Error("The Forwarder approval exceeds the fixed 2.88 WETH ceiling");
  const cutover = proof.legacySwapperCutover;
  if (!cutover || !/^\d+$/.test(cutover.blockNumber) || !hash(cutover.blockHash) || cutover.wethBalance !== "0") throw new Error("Activation needs a zero-reserve legacy Swapper checkpoint");
  const cutoverBlock = BigInt(cutover.blockNumber);
  if (head < cutoverBlock + 64n) throw new Error("Legacy platform WETH reserve has not been cleared at the canonical cutover");
  const native = proof.nativeAutomationAcceptance, input = rawAmount(native.inputAmount), output = rawAmount(native.wethAmount);
  if (output > rawAmount(proof.newFiniteAllowance.amount) || output > 10n ** 16n || !hash(native.evidenceSha256) || !native.ruleId || native.ruleId.length > 200 || !native.schedulerRunId || native.schedulerRunId.length > 200 || native.evidenceUri.length > 2000 || !/^https:\/\/[^\s]+$/.test(native.evidenceUri)) throw new Error("Native scheduler acceptance metadata is missing");
  const asset = getAddress(native.unpricedToken);
  if (same(asset, weth) || same(asset, muse) || Object.keys(manifest.assetFeedDescriptions ?? {}).some((token) => same(token, asset))) throw new Error("Native acceptance requires an originally unpriced fee asset");
  // Only collection/release and conversion/sweep may be atomic. Collection's
  // exact event order is checked below; every other phase needs its own receipt.
  const distinctPhases = [native.feeTransactionHash, native.conversionTransactionHash, native.forwardTransactionHash, native.settlementTransactionHash];
  if (!same(native.feeCollectionTransactionHash, native.feeTransactionHash)) distinctPhases.push(native.feeCollectionTransactionHash);
  if (!same(native.conversionTransactionHash, native.sweepTransactionHash)) distinctPhases.push(native.sweepTransactionHash);
  if (new Set(distinctPhases.map((value) => value.toLowerCase())).size !== distinctPhases.length) throw new Error("Activation phases require distinct receipts except atomic collection/release or conversion/sweep");
  // The receipt references and historical checkpoints are independent. Let
  // HTTP batching combine them without weakening any canonical/event checks.
  const [controlBlock, revocation, approved, checkpoint, reserve, collection, fee, conversion, sweep, forwarded, settled] = await Promise.all([
    client.getBlock({ blockNumber: BigInt(control.blockNumber) }),
    approval(proof.oldForwarderRevocation, OLD_FORWARDER, 0n), approval(proof.newFiniteAllowance, node("forwarder"), approvedAmount),
    client.getBlock({ blockNumber: cutoverBlock }),
    client.readContract({ address: weth, abi: erc20Abi, functionName: "balanceOf", args: [node("swapper")], blockNumber: cutoverBlock }),
    receipt(native.feeCollectionTransactionHash), receipt(native.feeTransactionHash), receipt(native.conversionTransactionHash),
    receipt(native.sweepTransactionHash), receipt(native.forwardTransactionHash), receipt(native.settlementTransactionHash),
  ]);
  if (controlBlock.hash !== control.blockHash) throw new Error("Governor control proof lacks a canonical confirmed block");
  if (cutoverBlock < revocation.blockNumber || checkpoint.hash !== cutover.blockHash || reserve !== 0n)
    throw new Error("Legacy platform WETH reserve has not been cleared at the canonical cutover");
  const after = (a: TransactionReceipt, b: TransactionReceipt) => a.blockNumber > b.blockNumber || a.blockNumber === b.blockNumber && a.transactionIndex > b.transactionIndex;
  if (same(approved.transactionHash, forwarded.transactionHash) || after(approved, forwarded) || cutoverBlock >= forwarded.blockNumber || after(collection, fee) || after(fee, conversion) || after(conversion, sweep) || after(sweep, forwarded) || after(forwarded, settled)) throw new Error("Activation receipts are not in the funding and settlement order");
  const released = events<{ args: { token: Address; amount: bigint; automation: Address } }>(fee, node("engine"), unpricedAbi)
    .filter((e) => same(e.args.token, asset) && e.args.amount === input && same(e.args.automation, automation));
  if (released.length !== 1 || !Number.isSafeInteger(released[0].logIndex) || released[0].logIndex < 0 || transfers(fee, asset, node("engine"), automation) !== input) throw new Error("Native acceptance has no exact Engine unpriced fee receipt");
  const cutoff = same(collection.transactionHash, fee.transactionHash) ? released[0].logIndex : Number.MAX_SAFE_INTEGER;
  const claims = events<{ args: { manager: Address; token: Address; amount: bigint } }>(collection, node("engine"), claimedAbi)
    .filter((e) => same(e.args.token, asset) && [c.initializer, c.rehype].some((manager) => same(manager, e.args.manager)) && Number.isSafeInteger(e.logIndex) && e.logIndex >= 0 && e.logIndex < cutoff);
  const collected = claims.reduce((total, e) => total + e.args.amount, 0n);
  if (collected < input) throw new Error("Native acceptance requires actual FeesClaimed before unpriced release; synced donations are insufficient");
  const collectedTransfers = events<{ eventName: string; args: { from: Address; to: Address; value: bigint } }>(collection, asset, erc20Abi)
    .filter((e) => e.eventName === "Transfer" && Number.isSafeInteger(e.logIndex) && e.logIndex >= 0 && e.logIndex < cutoff);
  for (const manager of [c.initializer, c.rehype]) {
    const claimed = claims.filter((e) => same(e.args.manager, manager)).reduce((total, e) => total + e.args.amount, 0n);
    const net = collectedTransfers.reduce((total, e) => total + (same(e.args.from, manager) && same(e.args.to, node("engine")) ? e.args.value : 0n) - (same(e.args.from, node("engine")) && same(e.args.to, manager) ? e.args.value : 0n), 0n);
    if (net !== claimed) throw new Error("Actual fee collection does not match the fixed manager to Engine net token transfers");
  }
  // Bound every release during this interval by the newly evidenced fees. This
  // conservatively rejects reusing an old, already-spent claim after a donation.
  if (collection.blockNumber === 0n) throw new Error("Fee collection has no historical counter checkpoint");
  const [releasedBefore, releasedAfter] = await Promise.all([collection.blockNumber - 1n, fee.blockNumber].map((blockNumber) =>
    client.readContract({ address: node("engine"), abi: collectedCounterAbi, functionName: "totalAutomationForwarded", args: [asset], blockNumber })));
  if (releasedAfter < releasedBefore || releasedAfter - releasedBefore < input || releasedAfter - releasedBefore > collected) throw new Error("The fee collection has already been spent or does not cover all releases in the canary interval");
  if (transfers(conversion, asset, automation, null) !== input) throw new Error("Native conversion did not spend the recorded Automation fee input");
  if (same(native.conversionTransactionHash, native.sweepTransactionHash)) {
    if (transfers(conversion, weth, null, source) !== output) throw new Error("Native conversion did not deliver the recorded source WETH");
  } else if (transfers(conversion, weth, null, automation) !== output || transfers(sweep, weth, automation, source) !== output) throw new Error("Native conversion/sweep receipts do not link the recorded WETH");
  if (!events<{ args: { amount: bigint } }>(forwarded, node("forwarder"), forwardAbi).some((e) => e.args.amount === output) || transfers(forwarded, weth, source, node("vault")) !== output) throw new Error("Native WETH did not reach the fixed Vault through Forwarder V2");
  const executed = events<{ args: { wethAmount: bigint; museToDead: bigint; profit: bigint } }>(settled, node("vault"), executeAbi);
  if (executed.length !== 1 || executed[0].args.wethAmount !== output || executed[0].args.museToDead <= 0n || transfers(settled, weth, node("vault"), node("swapper")) !== output || transfers(settled, weth, node("swapper"), node("executor")) !== output || transfers(settled, muse, node("executor"), getAddress(c.beneficiary)) !== executed[0].args.museToDead) throw new Error("Activation requires exact successful Vault settlement and DEAD receipts");
  const flashes = events<{ args: { beneficiary: Address; trader: Address; tokenToBeneficiary: Address; quoteParams: { quotePair: { base: Address; quote: Address }; baseAmount: bigint }[]; amountsToBeneficiary: bigint[] } }>(settled, node("swapper"), flashAbi);
  if (flashes.length !== 1 || !same(flashes[0].args.beneficiary, c.beneficiary) || !same(flashes[0].args.trader, node("executor")) || !same(flashes[0].args.tokenToBeneficiary, muse) || flashes[0].args.quoteParams.length !== 1 || !same(flashes[0].args.quoteParams[0].quotePair.base, weth) || !same(flashes[0].args.quoteParams[0].quotePair.quote, muse) || flashes[0].args.quoteParams[0].baseAmount !== output || flashes[0].args.amountsToBeneficiary.length !== 1 || flashes[0].args.amountsToBeneficiary[0] !== executed[0].args.museToDead) throw new Error("Activation Vault receipt lacks the canonical Swapper settlement");
  return { fingerprint, activatedAtBlock: String(settled.blockNumber), nativeSchedulerEvidence: "governor_signed_external_attestation_with_canonical_token_receipts" as const };
}

type ActivationEvidence = Awaited<ReturnType<typeof verifyActivationEvidence>>;
const finalizedEvidence = new WeakMap<object, Map<string, { result?: ActivationEvidence; lastBlock?: bigint; inFlight?: Promise<ActivationEvidence> }>>();

/** Only successful evidence whose blocks are finalized may survive a request.
 * Network, governor code/EIP-1271 authority, and the caller's confirmation head
 * remain live checks. Mutable graph/allowances are checked by the graph reader. */
export async function verifyBuybackActivation(client: ActivationClient, manifest: BuybackDeployment, head: bigint) {
  // Bind concurrent work to the same proof bytes used for its cache key.
  manifest = structuredClone(manifest);
  const proof = manifest.activation as BuybackActivation | undefined;
  const control = manifest.governance?.controlProof as GovernorControlProof | undefined;
  if (!proof || proof.schemaVersion !== 1 || proof.chainId !== 4663 || !control || typeof control !== "object" ||
    !proof.nativeAutomationAcceptance || typeof proof.nativeAutomationAcceptance !== "object")
    throw new Error("Buyback first activation proof is incomplete");
  const fingerprint = buybackGraphFingerprint(manifest);
  for (const value of [proof, control, proof.oldForwarderRevocation, proof.newFiniteAllowance, proof.nativeAutomationAcceptance])
    if (!value || value.chainId !== 4663 || !hash(value.graphFingerprint) || value.graphFingerprint.toLowerCase() !== fingerprint)
      throw new Error("Activation proof belongs to another graph");
  if (!/^\d+$/.test(control.blockNumber) || !hash(control.blockHash) || head < BigInt(control.blockNumber) + 64n)
    throw new Error("Governor control proof lacks a canonical confirmed block");
  const governor = getAddress(manifest.constants.treasury), native = proof.nativeAutomationAcceptance;
  const [chainId, code] = await Promise.all([client.getChainId(), client.getCode({ address: governor, blockNumber: head })]);
  if (chainId !== 4663) throw new Error("Activation receipts must be read from Robinhood chain 4663");
  await Promise.all([
    signedByGovernor(client, governor, control.signer, control.signature, governorControlMessage(control), head, code),
    signedByGovernor(client, governor, native.signer, native.signature, nativeAcceptanceMessage(native), head, code),
  ]);
  const key = keccak256(toBytes(JSON.stringify([fingerprint, proof, control])));
  let cache = finalizedEvidence.get(client);
  if (!cache) { cache = new Map(); finalizedEvidence.set(client, cache); }
  let entry = cache.get(key);
  if (!entry) {
    entry = {}; cache.set(key, entry);
    for (const [oldKey, old] of cache) if (cache.size > 16 && oldKey !== key && !old.inFlight) cache.delete(oldKey);
  }
  if (!entry.result && !entry.inFlight) {
    const selected = entry;
    selected.inFlight = (async () => {
      const [result, finalized] = await Promise.all([
        verifyActivationEvidence(client, manifest, head),
        // Unsupported finalized reads keep the old full replay semantics.
        client.getBlock({ blockTag: "finalized" }).catch(() => null),
      ]);
      const lastBlock = BigInt(control.blockNumber) > BigInt(result.activatedAtBlock) ? BigInt(control.blockNumber) : BigInt(result.activatedAtBlock);
      if (finalized?.number !== undefined && finalized.number !== null && hash(finalized.hash) && finalized.number >= lastBlock) {
        selected.result = result; selected.lastBlock = lastBlock;
      }
      return result;
    })().finally(() => {
      selected.inFlight = undefined;
      if (!selected.result) cache!.delete(key);
    });
  }
  const result = entry.result ?? await entry.inFlight!;
  const lastBlock = entry.lastBlock ?? (BigInt(control.blockNumber) > BigInt(result.activatedAtBlock) ? BigInt(control.blockNumber) : BigInt(result.activatedAtBlock));
  if (head < lastBlock + 64n) throw new Error("Activation receipt is not successful, confirmed and canonical");
  return { ...result };
}
