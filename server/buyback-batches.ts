import {
  createPublicClient, http, erc20Abi, encodeFunctionData, decodeFunctionData,
  decodeEventLog, keccak256, parseAbi, recoverTypedDataAddress, hashTypedData, type Address, type Hex, type PublicClient,
} from "viem";
import { robinhood } from "viem/chains";
import { CONTRACTS, sameAddress, stockByAddress, type RuntimeConfig } from "../src/lib/config";
import { MUSEGOD_BUYBACK } from "../src/lib/fee-policy";
import { RELAY_APPROVAL_PROXY, buybackAuthorizationTypedData, type BuybackAuthorization, type BuybackPrepareInput,
  type BuybackBatch, type BuybackStep, type BuybackStepKind } from "../src/lib/buyback";
import { BuybackError, BuybackReader, BUYBACK_CODE_HASHES, RELAY_ROUTER, validateRelayExecution } from "./buyback";

type ReceiptProof = { hash: Hex; blockHash: Hex; blockNumber: string };
type StoredBatch = BuybackBatch & {
  steps: Partial<Record<BuybackStepKind, BuybackStep>>;
  proofs: Partial<Record<BuybackStepKind | "destination", ReceiptProof>>;
  orderId: Hex;
  metadata: Hex;
  nonces?: Partial<Record<BuybackStepKind, number>>;
  authorizationNonce?: Hex;
  authorizationDigest?: Hex;
};
export type BuybackBatchStore = {
  saveBuybackBatch(batch: StoredBatch): unknown | Promise<unknown>;
  getBuybackBatch(id: string): any | Promise<any>;
  listBuybackBatches(): any[] | Promise<any[]>;
};
type ReadClient = PublicClient<any, any>;
type Options = { robinhoodClient?: ReadClient; fetch?: typeof fetch; now?: () => number };
const collectAbi = parseAbi(["function collectFees(bytes32 poolId)"]);
const fundsAbi = parseAbi(["event FundsMovement(address from,address to,address currency,uint256 amount,bytes metadata)"]);
const hashPattern = /^0x[0-9a-fA-F]{64}$/;
const kinds = ["approval", "deposit", "burn"] as const;
function fail(code: string, message: string): never { throw new BuybackError(code, message); }

export class BuybackBatchService {
  private readonly rh: ReadClient;
  private readonly fetcher: typeof fetch;
  private readonly now: () => number;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly reader: BuybackReader, private readonly store: BuybackBatchStore,
    private readonly base: ReadClient, private readonly config: RuntimeConfig, options: Options = {}) {
    this.rh = options.robinhoodClient ?? createPublicClient({ chain: robinhood,
      transport: http("https://rpc.mainnet.chain.robinhood.com", { retryCount: 0, timeout: 12_000 }) });
    this.fetcher = options.fetch ?? fetch.bind(globalThis); this.now = options.now ?? Date.now;
  }
  private locked<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work, work); this.queue = next.catch(() => {}); return next;
  }
  private visible(batch: StoredBatch): BuybackBatch {
    const { steps: _steps, proofs: _proofs, orderId: _orderId, metadata: _metadata, nonces: _nonces,
      authorizationNonce: _authorizationNonce, authorizationDigest: _authorizationDigest, ...publicBatch } = batch;
    return publicBatch;
  }
  private async load(id: string): Promise<StoredBatch> {
    if (!hashPattern.test(id)) fail("INVALID_BATCH", "Invalid buyback batch ID");
    const batch = await this.store.getBuybackBatch(id.toLowerCase());
    if (!batch) fail("BATCH_NOT_FOUND", "Buyback batch not found");
    return batch as StoredBatch;
  }
  private async save(batch: StoredBatch) {
    batch.updatedAt = this.now(); await this.store.saveBuybackBatch(batch);
  }
  private signing(batch?: StoredBatch) {
    if (this.config.mode !== "base" || this.config.chainId !== 8453 || !this.config.writesEnabled || !this.config.treasury)
      fail("SIGNING_DISABLED", "Mainnet buyback signing is not enabled");
    if (batch && !sameAddress(batch.quote.treasury, this.config.treasury))
      fail("TREASURY_CHANGED", "The batch treasury differs from the current configuration. New signing is blocked; existing transactions can still be verified.");
  }
  private async network(client: ReadClient, chainId: number) {
    if (await client.getChainId() !== chainId) fail("WRONG_CHAIN", "The buyback RPC network does not match");
  }
  async list(): Promise<BuybackBatch[]> {
    return (await this.store.listBuybackBatches()).map((b) => this.visible(b));
  }
  async prepare(input: BuybackPrepareInput, authorization?: BuybackAuthorization): Promise<BuybackBatch> {
    return this.locked(async () => {
      this.signing();
      const claimHashes = input.claimHashes ?? [];
      if (!Array.isArray(claimHashes) || claimHashes.length > 20 ||
        claimHashes.some((h) => typeof h !== "string" || !hashPattern.test(h)) ||
        new Set(claimHashes.map((h) => h.toLowerCase())).size !== claimHashes.length)
        fail("INVALID_CLAIMS", "Invalid fee claim receipt");
      try { stockByAddress(input.stockAddress); } catch { fail("INVALID_INPUT", "Invalid buyback stock token or amount"); }
      if (!/^(0|[1-9]\d{0,20})(\.\d{1,8})?$/.test(input.amount) || Number(input.amount) <= 0)
        fail("INVALID_INPUT", "Invalid buyback stock token or amount");
      if (!authorization || !hashPattern.test(authorization.nonce) || !/^0x[0-9a-fA-F]{130}$/.test(authorization.signature) ||
        !Number.isSafeInteger(authorization.expiresAt) || authorization.expiresAt <= this.now() || authorization.expiresAt > this.now() + 300_000)
        fail("AUTHORIZATION_REQUIRED", "Authorize this buyback budget with the configured treasury wallet. Authorization is valid for up to five minutes.");
      try {
        const signer = await recoverTypedDataAddress({
          ...buybackAuthorizationTypedData(input, this.config.treasury!, authorization.nonce, authorization.expiresAt), signature: authorization.signature,
        });
        if (!sameAddress(signer, this.config.treasury!)) throw new Error();
      } catch { fail("INVALID_AUTHORIZATION", "The budget authorization does not match the treasury, stock token, amount, or claim receipts"); }
      const existing = await this.store.listBuybackBatches();
      const authorizationDigest = hashTypedData(buybackAuthorizationTypedData(input, this.config.treasury!, authorization.nonce, authorization.expiresAt));
      const duplicate = existing.find((b: StoredBatch) => b.authorizationNonce?.toLowerCase() === authorization.nonce.toLowerCase());
      if (duplicate) {
        if (duplicate.authorizationDigest !== authorizationDigest) fail("NONCE_REUSED", "This authorization nonce has already been used for another buyback budget");
        return this.visible(duplicate);
      }
      if (existing.some((b: StoredBatch) => sameAddress(b.quote.treasury, this.config.treasury!) &&
        (this.now() - b.createdAt < 60_000 ||
          (!(["burned", "refunded", "expired"].includes(b.status) || (b.status === "failed" && !b.proofs.destination)) &&
            (Object.keys(b.hashes).length > 0 || b.quote.expiresAt > this.now())))))
        fail("ACTIVE_BATCH", "The treasury has an active buyback batch. Complete it or wait for the unsigned quote to expire.");
      await this.network(this.base, 8453);
      for (const hash of claimHashes) {
        const tx = await this.base.getTransaction({ hash: hash as Hex });
        if (!sameAddress(tx.from, this.config.treasury!) || !tx.to ||
          ![CONTRACTS.initializer, CONTRACTS.rehype].some((to) => sameAddress(tx.to!, to)))
          fail("INVALID_CLAIMS", "The fee claim transaction does not belong to this treasury or a platform fee contract");
        try { decodeFunctionData({ abi: collectAbi, data: tx.input }); } catch { fail("INVALID_CLAIMS", "The fee claim call does not match"); }
        const receipt = await this.confirmed(this.base, hash as Hex);
        if (!receipt || receipt.status !== "success") fail("INVALID_CLAIMS", "The fee claim receipt has not been successfully confirmed");
      }
      const { quote, raw } = await this.reader.prepareRoute(input);
      if (!sameAddress(quote.treasury, this.config.treasury!)) fail("TREASURY_CHANGED", "The buyback quote treasury does not match");
      if (await this.store.getBuybackBatch(quote.requestId.toLowerCase()))
        fail("REQUEST_ALREADY_USED", "The provider returned an existing order. The saved batch will not be overwritten.");
      const validated = await validateRelayExecution(quote, raw);
      const allowance = await this.base.readContract({ address: quote.stockAddress, abi: erc20Abi,
        functionName: "allowance", args: [quote.treasury, RELAY_APPROVAL_PROXY] });
      const batch: StoredBatch = {
        id: quote.requestId.toLowerCase(), quote, status: "prepared",
        nextStep: allowance >= BigInt(quote.amountIn) ? "deposit" : "approval",
        createdAt: this.now(), updatedAt: this.now(), receivedAmount: "0", burnedAmount: "0",
        hashes: {}, proofs: {}, nonces: {}, orderId: validated.orderId, metadata: validated.metadata,
        steps: { approval: validated.approval, deposit: validated.deposit },
        fundingSource: "treasury_allocation", claimHashes: claimHashes.map((h) => h.toLowerCase() as Hex),
        authorizationNonce: authorization.nonce.toLowerCase() as Hex,
        authorizationDigest,
      };
      await this.save(batch); return this.visible(batch);
    });
  }

  async step(id: string, kind: BuybackStepKind): Promise<BuybackStep> {
    return this.locked(async () => {
      if (!kinds.includes(kind)) fail("INVALID_STEP", "Invalid buyback step");
      const batch = await this.load(id); this.signing(batch);
      if (!batch.authorizationNonce) fail("AUTHORIZATION_REQUIRED", "The treasury wallet has not authorized this batch. Prepare it again.");
      await this.reconcileStored(batch);
      if (batch.nextStep !== kind || batch.hashes[kind]) fail("STEP_NOT_READY", "This step has already been submitted or is not ready to execute");
      const client = kind === "burn" ? this.rh : this.base;
      await this.network(client, kind === "burn" ? 4663 : 8453);
      const accountCode = await client.getCode({ address: batch.quote.treasury });
      if (accountCode && accountCode !== "0x") fail("UNSUPPORTED_TREASURY", "Buybacks currently require a treasury EOA with no delegated code");
      if (kind !== "burn" && this.now() >= batch.quote.expiresAt) fail("EXPIRED", "The buyback quote has expired. Prepare a new batch.");
      if (kind !== "burn") {
        for (const [address, expectedHash] of Object.entries(BUYBACK_CODE_HASHES)) {
          const code = await this.base.getCode({ address: address as Address });
          if (!code || keccak256(code) !== expectedHash) fail("CONTRACT_CHANGED", "The buyback route contract code does not match the verified version");
        }
        stockByAddress(batch.quote.stockAddress);
        const decimals = await this.base.readContract({ address: batch.quote.stockAddress, abi: erc20Abi, functionName: "decimals" });
        if (decimals !== 8) fail("INVALID_TOKEN", "The stock token decimals do not match");
      } else {
        await this.reader.readMUSEGODStats();
        const amount = BigInt(batch.receivedAmount) - BigInt(batch.burnedAmount);
        if (amount <= 0n) fail("NOTHING_TO_BURN", "This batch has no confirmed received amount available to burn");
        // Persist the exact burn request before returning it, so a later hash cannot
        // change its amount and two concurrent refreshes cannot issue different burns.
        if (!batch.steps.burn) batch.steps.burn = {
          batchId: batch.id, kind: "burn", chainId: 4663, from: batch.quote.treasury,
          to: MUSEGOD_BUYBACK.tokenAddress, value: "0", amount: amount.toString(),
          stockAddress: batch.quote.stockAddress, expiresAt: this.now() + 60_000,
          data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [MUSEGOD_BUYBACK.burnAddress, amount] }),
        };
        // A burn does not depend on a market quote; renew only its local UI deadline.
        if (batch.steps.burn.expiresAt <= this.now()) batch.steps.burn.expiresAt = this.now() + 60_000;
      }
      const step = batch.steps[kind]!;
      const [pendingNonce, latestNonce] = await Promise.all([
        client.getTransactionCount({ address: step.from, blockTag: "pending" }),
        client.getTransactionCount({ address: step.from, blockTag: "latest" }),
      ]);
      if (step.nonce === undefined && pendingNonce !== latestNonce)
        fail("PENDING_TRANSACTION", "The treasury has a pending transaction. Wait for confirmation before preparing this step.");
      if (step.nonce === undefined) step.nonce = pendingNonce;
      if (step.nonce !== pendingNonce) fail("NONCE_CHANGED", "The treasury nonce has changed. Recover the existing transaction hash before submitting again.");
      const token = kind === "burn" ? MUSEGOD_BUYBACK.tokenAddress : batch.quote.stockAddress;
      const balance = await client.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [batch.quote.treasury] });
      if (balance < BigInt(step.amount)) fail("INSUFFICIENT_BALANCE", "Insufficient treasury balance. Check the allocated buyback budget.");
      if (kind === "deposit") {
        const allowance = await this.base.readContract({ address: token, abi: erc20Abi, functionName: "allowance", args: [batch.quote.treasury, RELAY_APPROVAL_PROXY] });
        if (allowance < BigInt(step.amount)) fail("APPROVAL_REQUIRED", "The stock token allowance does not cover this batch amount");
      }
      try { await client.call({ account: step.from, to: step.to, data: step.data, value: 0n }); }
      catch { fail("SIMULATION_FAILED", "The buyback step simulation failed. Refresh the quote or check balances and gas."); }
      const [gas, gasPrice, nativeBalance] = await Promise.all([
        client.estimateGas({ account: step.from, to: step.to, data: step.data, value: 0n, nonce: step.nonce }),
        client.getGasPrice(), client.getBalance({ address: step.from }),
      ]);
      if (nativeBalance < gas * gasPrice * 125n / 100n) fail("INSUFFICIENT_GAS", "Insufficient ETH on this network for the estimated gas and buffer");
      await this.save(batch); return step;
    });
  }

  async track(id: string, kind: BuybackStepKind, hash: string): Promise<BuybackBatch> {
    return this.locked(async () => {
      if (!kinds.includes(kind) || !hashPattern.test(hash)) fail("INVALID_HASH", "Invalid buyback transaction hash");
      const batch = await this.load(id), step = batch.steps[kind];
      if (!step) fail("STEP_NOT_READY", "This buyback step has not been prepared");
      if (batch.cancellations?.some((proof) => proof.kind === kind && proof.hash.toLowerCase() === hash.toLowerCase())) {
        await this.reconcileStored(batch); return this.visible(batch);
      }
      const client = kind === "burn" ? this.rh : this.base;
      await this.network(client, step.chainId);
      const tx = await client.getTransaction({ hash: hash as Hex });
      if (!tx.to || !sameAddress(tx.from, step.from) || step.nonce === undefined || tx.nonce !== step.nonce)
        fail("TRANSACTION_MISMATCH", "The transaction account, contract, amount, or calldata does not match the buyback step");
      const exact = sameAddress(tx.to, step.to) && tx.input.toLowerCase() === step.data.toLowerCase() && tx.value === BigInt(step.value);
      const selfCancel = sameAddress(tx.to, step.from) && tx.input === "0x" && tx.value === 0n;
      if (!exact && !selfCancel) fail("TRANSACTION_MISMATCH", "Only this batch transaction or a zero-value self-transfer cancellation with the same nonce is accepted");
      for (const other of await this.store.listBuybackBatches()) {
        if (other.id !== batch.id && (Object.values(other.hashes).some((h) => String(h).toLowerCase() === hash.toLowerCase()) ||
          other.cancellations?.some((p: ReceiptProof) => p.hash.toLowerCase() === hash.toLowerCase())))
          fail("HASH_ALREADY_USED", "This transaction belongs to another buyback batch");
      }
      const previous = batch.hashes[kind];
      if (previous && previous.toLowerCase() !== hash.toLowerCase()) {
        if (await this.confirmed(client, previous)) fail("TRANSACTION_ALREADY_CONFIRMED", "This step already has a canonically confirmed transaction and cannot be replaced with another hash");
        const previousNonce = batch.nonces?.[kind] ?? (await client.getTransaction({ hash: previous })).nonce;
        if (previousNonce !== tx.nonce) fail("DUPLICATE_TRANSACTION", "This step already has another transaction. Duplicate submission is blocked.");
      }
      const receipt = await this.confirmed(client, hash as Hex);
      if (selfCancel || (exact && receipt?.status === "reverted")) {
        if (!receipt || (selfCancel && receipt.status !== "success"))
          fail("CANCELLATION_PENDING", "The cancellation has not received two canonical confirmations. This step remains locked.");
        if (selfCancel) {
          if (tx.type === "eip7702" || tx.authorizationList?.length || receipt.logs.length !== 0)
            fail("UNVERIFIED_CANCELLATION", "A self-transfer with authorizations or events cannot prove a cancellation without asset changes");
          const code = await client.getCode({ address: step.from, blockNumber: receipt.blockNumber });
          if (code && code !== "0x") fail("UNVERIFIED_CANCELLATION", "A self-transfer by a contract or delegated account cannot prove a cancellation without asset changes");
        }
        batch.cancellations ??= [];
        if (!batch.cancellations.some((proof) => proof.hash.toLowerCase() === hash.toLowerCase()))
          batch.cancellations.push({ ...this.proof(receipt), kind, status: receipt.status, nonce: tx.nonce, verifiedCanonical: true });
        delete batch.hashes[kind]; delete batch.proofs[kind]; delete batch.nonces?.[kind]; delete step.nonce;
        batch.nextStep = kind; batch.status = kind === "burn" ? "received" : "prepared";
        await this.save(batch); await this.reconcileStored(batch); return this.visible(batch);
      }
      batch.hashes[kind] = hash.toLowerCase() as Hex;
      batch.nonces ??= {}; batch.nonces[kind] = tx.nonce;
      batch.status = kind === "approval" ? "approval_pending" : kind === "deposit" ? "deposit_pending" : "burn_pending";
      batch.nextStep = null;
      await this.save(batch); await this.reconcileStored(batch); return this.visible(batch);
    });
  }
  async reconcile(id: string): Promise<BuybackBatch> {
    return this.locked(async () => {
      const batch = await this.load(id); await this.reconcileStored(batch); return this.visible(batch);
    });
  }
  private async confirmed(client: ReadClient, hash: Hex) {
    try {
      const receipt = await client.getTransactionReceipt({ hash });
      const [block, tip] = await Promise.all([client.getBlock({ blockNumber: receipt.blockNumber }), client.getBlockNumber()]);
      if (block.hash !== receipt.blockHash || tip < receipt.blockNumber + 1n) return null;
      return receipt;
    } catch { return null; }
  }
  private proof(receipt: { transactionHash: Hex; blockHash: Hex; blockNumber: bigint }): ReceiptProof {
    return { hash: receipt.transactionHash, blockHash: receipt.blockHash, blockNumber: receipt.blockNumber.toString() };
  }
  private async reconcileStored(batch: StoredBatch) {
    // Only a fresh canonical proof contributes to displayed accounting. Historical
    // hashes and proof locations remain available for recovery and reorg diagnosis.
    batch.receivedAmount = "0"; batch.burnedAmount = "0";
    for (const cancellation of batch.cancellations ?? []) cancellation.verifiedCanonical = false;
    try {
      await this.network(this.base, 8453); await this.network(this.rh, 4663);
      delete batch.error;
      for (const cancelled of batch.cancellations ?? []) {
        const receipt = await this.confirmed(cancelled.kind === "burn" ? this.rh : this.base, cancelled.hash);
        if (!receipt || receipt.status !== cancelled.status) {
          batch.status = "reorg"; batch.nextStep = null; batch.error = "The cancellation or failed receipt could not be verified on the canonical chain. Further steps are paused.";
          await this.save(batch); return;
        }
        cancelled.verifiedCanonical = true;
      }
      for (const kind of ["approval", "deposit"] as const) {
        const hash = batch.hashes[kind]; if (!hash) continue;
        const receipt = await this.confirmed(this.base, hash);
        if (!receipt) {
          if (batch.proofs[kind]) { batch.status = "reorg"; batch.error = "The confirmed transaction cannot currently be verified on the canonical chain. Further steps are paused."; }
          else batch.status = kind === "approval" ? "approval_pending" : kind === "deposit" ? "deposit_pending" : "burn_pending";
          batch.nextStep = null; await this.save(batch); return;
        }
        if (receipt.status !== "success") {
          batch.status = "failed"; batch.error = "The transaction receipt reports failure. Review it before preparing another batch."; batch.nextStep = null;
          await this.save(batch); return;
        }
        batch.proofs[kind] = this.proof(receipt);
      }
      if (!batch.hashes.deposit) {
        if (this.now() >= batch.quote.expiresAt) { batch.status = "expired"; batch.nextStep = null; }
        else { batch.status = "prepared"; batch.nextStep = batch.proofs.approval ? "deposit" : batch.nextStep; }
        await this.save(batch); return;
      }
      batch.status = "bridging"; batch.nextStep = null;
      if (!batch.destinationHash) {
        const response = await this.fetcher(`https://api.relay.link/intents/status/v3?requestId=${encodeURIComponent(batch.quote.requestId)}`, { signal: AbortSignal.timeout(10_000) });
        if (!response.ok) throw new Error();
        const state = await response.json() as any;
        if (state.originChainId !== 8453 || state.destinationChainId !== 4663 ||
          !Array.isArray(state.inTxHashes) || !state.inTxHashes.some((h: string) => h.toLowerCase() === batch.hashes.deposit)) throw new Error();
        if (state.status === "refund") { batch.status = "refunded"; batch.error = "Relay reports a refund. Verify the refunded amount in the treasury; it does not count as burned."; await this.save(batch); return; }
        if (state.status !== "success") { await this.save(batch); return; }
        if (!Array.isArray(state.txHashes) || state.txHashes.length !== 1 || !hashPattern.test(state.txHashes[0])) throw new Error();
        batch.destinationHash = state.txHashes[0].toLowerCase();
      }
      for (const other of await this.store.listBuybackBatches())
        if (other.id !== batch.id && other.destinationHash === batch.destinationHash)
          fail("DUPLICATE_DESTINATION", "The destination receipt belongs to another buyback batch");
      const receipt = await this.confirmed(this.rh, batch.destinationHash!);
      if (!receipt || receipt.status !== "success") {
        if (batch.proofs.destination) { batch.status = "reorg"; batch.error = "The destination receipt has changed. Further burning is paused."; }
        await this.save(batch); return;
      }
      const destinationBlock = await this.rh.getBlock({ blockNumber: receipt.blockNumber });
      if (destinationBlock.hash !== receipt.blockHash ||
        destinationBlock.timestamp < BigInt(Math.floor(batch.quote.quotedAt / 1000)))
        fail("STALE_DESTINATION", "The destination transfer predates this batch quote and cannot count toward this buyback");
      let incoming = 0n, outgoing = 0n, movement = 0n;
      for (const log of receipt.logs) {
        try {
          if (sameAddress(log.address, MUSEGOD_BUYBACK.tokenAddress)) {
            const event = decodeEventLog({ abi: erc20Abi, data: log.data, topics: log.topics });
            if (event.eventName === "Transfer") {
              if (sameAddress(event.args.to, batch.quote.treasury)) incoming += event.args.value;
              if (sameAddress(event.args.from, batch.quote.treasury)) outgoing += event.args.value;
            }
          } else if (sameAddress(log.address, RELAY_ROUTER)) {
            const event = decodeEventLog({ abi: fundsAbi, data: log.data, topics: log.topics });
            if (sameAddress(event.args.from, RELAY_ROUTER) && sameAddress(event.args.to, batch.quote.treasury) && sameAddress(event.args.currency, MUSEGOD_BUYBACK.tokenAddress) &&
              event.args.metadata.toLowerCase() === batch.metadata.toLowerCase()) movement += event.args.amount;
          }
        } catch { /* unrelated logs are not evidence */ }
      }
      const received = incoming - outgoing;
      if (received < BigInt(batch.quote.minimumOut) || movement !== received)
        fail("UNVERIFIED_RECEIPT", "The destination transfer or Relay order ID could not be verified. Burning is paused.");
      if (batch.steps.burn && BigInt(batch.steps.burn.amount) !== received)
        fail("RECEIPT_CHANGED", "The received amount changed after burn preparation. Further execution is paused.");
      batch.receivedAmount = received.toString(); batch.proofs.destination = this.proof(receipt);
      if (batch.hashes.burn) {
        const burn = await this.confirmed(this.rh, batch.hashes.burn);
        if (!burn) {
          batch.status = batch.proofs.burn ? "reorg" : "burn_pending";
          if (batch.proofs.burn) batch.error = "The burn transaction cannot currently be verified on the canonical chain. Further steps are paused.";
          await this.save(batch); return;
        }
        if (burn.status !== "success") {
          batch.status = "failed"; batch.error = "The burn transaction failed. Submit its hash for verification to recover the burn step.";
          await this.save(batch); return;
        }
        let total = 0n;
        for (const log of burn.logs) try {
          if (!sameAddress(log.address, MUSEGOD_BUYBACK.tokenAddress)) continue;
          const event = decodeEventLog({ abi: erc20Abi, data: log.data, topics: log.topics });
          if (event.eventName === "Transfer" && sameAddress(event.args.from, batch.quote.treasury) &&
            sameAddress(event.args.to, MUSEGOD_BUYBACK.burnAddress)) total += event.args.value;
        } catch { /* ignore unrelated events */ }
        if (total !== received) fail("UNVERIFIED_BURN", "The burn transfer amount does not match the amount received by this batch");
        batch.burnedAmount = total.toString(); batch.proofs.burn = this.proof(burn); batch.status = "burned";
      } else { batch.status = "received"; batch.nextStep = "burn"; }
      await this.save(batch);
    } catch (error) {
      batch.nextStep = null;
      batch.status = batch.proofs.destination || batch.proofs.burn ? "reorg" :
        batch.hashes.deposit ? "bridging" : batch.hashes.approval ? "approval_pending" : "prepared";
      batch.error = error instanceof BuybackError ? error.message : "The transaction is still awaiting verification because the provider is unavailable. A timeout does not mean failure.";
      await this.save(batch);
    }
  }
}
