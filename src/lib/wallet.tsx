import { quoteNow } from "./quote-clock";
import { assertLaunchIntentLock, launchIntentStorageKey, saveFrozenLaunch } from "./launch-intent";
import {
  createContext,
  useContext,
  useEffect,
  useState,
  useRef,
  type ReactNode,
} from "react";
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  custom,
  decodeFunctionData,
  decodeEventLog,
  encodeFunctionData,
  erc20Abi,
  getAddress,
  serializeTypedData,
  formatEther,
  formatUnits,
  keccak256,
  http,
  toHex,
  type Address,
  type EIP1193Provider,
  type Hash,
  type Hex,
} from "viem";
import { base, robinhood } from "viem/chains";
import { contractsFor, deploymentChain, networkName, sameAddress, stockByAddress, ROBINHOOD_BUNDLER, ROBINHOOD_BUNDLER_CODE_HASH, BASE_BUNDLER_CODE_HASH, type RuntimeConfig } from "./config";
import { MUSEGOD_BUYBACK } from "./fee-policy";
import { RELAY_APPROVAL_PROXY, RELAY_DEPOSITORY, buybackAuthorizationTypedData, type BuybackStep, type BuybackPrepareInput, type BuybackAuthorization, type BuybackBatch } from "./buyback";
import { assertSigningEnabled, errorMessage, simulationError } from "./validation";
import { permit2Abi, swapTransaction } from "./protocol";
import type { V4PoolKey } from "@whetstone-research/doppler-sdk/evm";
import {
  WalletConnection,
  walletAnnouncement,
  type Provider,
  type WalletOption,
} from "./wallet-connection";
import {
  assertTransactionStorage,
  isUnresolvedFirstBuyClaim,
  applyBuybackRecovery,
  saveTransaction,
  transactions,
  updateTransaction,
  type Transaction,
} from "./transactions";
import { api, chainApi } from "./api";
import { useNetwork } from "./network";
import { assertFirstBuyPaymentQuote, firstBuyDiamondAbi, firstBuyPaymentRefreshInput, type FirstBuyPaymentQuote, type FirstBuyPaymentVerification } from "./first-buy-payment";
import { assertFirstBuyLaunchConfig, executeFirstBuyPayment } from "./first-buy-wallet";
import { bundlerAbi } from "./first-buy-lock";
import type { FirstBuyLockStatus } from "./launch-plan";
import { MUSEGOD_ROUTER_VERIFICATION, assertMusegodTradingEnabled, type MusegodQuote } from "./musegod";
import { executeMusegodTrade } from "./musegod-trade";
import type { LaunchPlan, LaunchTransaction } from "./launch-plan";
import { assertLaunchRequest, assertLaunchWalletPlan, bufferedLaunchGas, executeLaunchPlan, launchDraftInput, type LaunchSimulation } from "./launch-wallet";
import { engineTransaction, type EngineAction } from "./buyback-engine";
declare global {
  interface Window {
    ethereum?: Provider;
  }
}
export type Quote = {
  token: Address;
  side: "buy" | "sell";
  amountIn: string;
  amountOut: string;
  currencyIn: Address;
  poolKey: V4PoolKey;
  slippageBps: number;
  quotedAt: number;
  expiresAt: number;
};
export const publicClient = createPublicClient({
  transport: http("/api/chains/4663/rpc", { retryCount: 2, retryDelay: 500, timeout: 30_000 }),
});
export const robinhoodClient = createPublicClient({
  chain: robinhood,
  transport: http("/api/chains/4663/rpc", { retryCount: 2, retryDelay: 500, timeout: 30_000 }),
});
const scopedClients = new Map<string, typeof publicClient>();
export function transactionClient(chainId: number, config?: Pick<RuntimeConfig, "chainId" | "deploymentChainId">) {
  if (![8453, 31337, 4663].includes(chainId)) throw new Error("Unsupported transaction network");
  const target = chainId === 31337 ? config?.deploymentChainId : chainId;
  if (target !== 8453 && target !== 4663) throw new Error("A fork transaction requires its deployment network");
  const key = `${chainId}:${target}`;
  let client = scopedClients.get(key);
  if (!client) {
    client = createPublicClient({ transport: http(`/api/chains/${target}/rpc`, { retryCount: 2, retryDelay: 500, timeout: 30_000 }) });
    scopedClients.set(key, client);
  }
  return client;
}
export function walletChain(config: RuntimeConfig) {
  assertSigningEnabled(config);
  return defineChain({
    ...(deploymentChain(config) === 4663 ? robinhood : base),
    id: config.chainId,
    name: networkName(config),
  });
}

// This extra client-side guard limits the buyback signing capability. Source
// calldata also requires the server's full Relay route validation for this batch.
export function assertBuybackStep(step: BuybackStep, config: RuntimeConfig, account: Address, now = Date.now()) {
  assertSigningEnabled(config);
  if (config.mode !== "base" || config.chainId !== 8453 || !config.treasury ||
    !sameAddress(config.treasury, account) || !sameAddress(step.from, account))
    throw new Error("Only the configured mainnet treasury wallet can confirm buyback steps");
  if (!/^[a-zA-Z0-9-]{1,80}$/.test(step.batchId) ||
    !["approval", "deposit", "burn"].includes(step.kind) ||
    step.value !== "0" || !Number.isFinite(step.expiresAt) || step.expiresAt <= now ||
    !Number.isSafeInteger(step.nonce) || step.nonce! < 0 ||
    !/^[1-9]\d{0,77}$/.test(step.amount) || BigInt(step.amount) >= 2n ** 256n ||
    !/^0x(?:[0-9a-fA-F]{2}){4,100000}$/.test(step.data))
    throw new Error("The buyback step has expired or has invalid parameters. Request it again.");
  if (stockByAddress(step.stockAddress).chainId !== 8453)
    throw new Error("Legacy cross-chain buybacks require a Base stock token");
  const amount = BigInt(step.amount);
  if (step.kind === "burn") {
    const expected = encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [MUSEGOD_BUYBACK.burnAddress, amount] });
    if (step.chainId !== 4663 || !sameAddress(step.to, MUSEGOD_BUYBACK.tokenAddress) || step.data.toLowerCase() !== expected.toLowerCase())
      throw new Error("The burn step must transfer the MUSEGOD received by this batch to the dead address");
  } else {
    if (step.chainId !== 8453) throw new Error("The buyback source transaction must execute on Base");
    if (step.kind === "approval") {
      const decoded = decodeFunctionData({ abi: erc20Abi, data: step.data });
      if (!sameAddress(step.to, step.stockAddress) || decoded.functionName !== "approve" ||
        decoded.args[1] !== amount || ![RELAY_DEPOSITORY, RELAY_APPROVAL_PROXY].some((a) => sameAddress(a, decoded.args[0])))
        throw new Error("Buyback approval is limited to this batch amount and the verified Relay contract");
      const expected = encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [decoded.args[0], amount] });
      if (expected.toLowerCase() !== step.data.toLowerCase()) throw new Error("The buyback approval data does not match");
    } else if (![RELAY_DEPOSITORY, RELAY_APPROVAL_PROXY].some((a) => sameAddress(a, step.to))) {
      throw new Error("The buyback source transaction target is not allowed");
    }
  }
}
export function assertSameBuybackStep(expected: BuybackStep, fresh: BuybackStep) {
  if (expected.batchId !== fresh.batchId || expected.kind !== fresh.kind ||
    expected.chainId !== fresh.chainId || !sameAddress(expected.from, fresh.from) ||
    !sameAddress(expected.to, fresh.to) || expected.data.toLowerCase() !== fresh.data.toLowerCase() ||
    expected.value !== fresh.value || expected.amount !== fresh.amount || expected.nonce !== fresh.nonce ||
    !sameAddress(expected.stockAddress, fresh.stockAddress))
    throw new Error("The buyback batch or transaction parameters have changed. Preview again.");
}
export function assertBuybackRequest(request: { method: string; params?: unknown }, step: BuybackStep) {
  if (request.method === "eth_chainId") return;
  if (request.method !== "eth_sendTransaction" || !Array.isArray(request.params) || request.params.length !== 1)
    throw new Error("The buyback wallet request is not allowed");
  const tx = request.params[0] as Record<string, unknown>;
  const allowed = ["from", "to", "data", "value", "chainId", "gas", "gasPrice", "maxFeePerGas", "maxPriorityFeePerGas", "nonce", "type"];
  if (!tx || typeof tx !== "object" || Object.keys(tx).some((key) => !allowed.includes(key)) ||
    typeof tx.from !== "string" || !sameAddress(tx.from, step.from) ||
    typeof tx.to !== "string" || !sameAddress(tx.to, step.to) ||
    typeof tx.data !== "string" || tx.data.toLowerCase() !== step.data.toLowerCase() ||
    (tx.value !== undefined && tx.value !== "0x0" && tx.value !== "0x00") ||
    tx.nonce !== toHex(step.nonce!) ||
    (tx.chainId !== undefined && tx.chainId !== toHex(step.chainId)))
    throw new Error("The wallet request does not match the buyback batch");
}
export function buybackAuthorizationPayload(input: BuybackPrepareInput, treasury: Address, nonce: Hex, expiresAt: number) {
  const typedData = buybackAuthorizationTypedData(input, treasury, nonce, expiresAt);
  return serializeTypedData({ ...typedData, domain: { ...typedData.domain, chainId: BigInt(typedData.domain.chainId) }, types: {
    EIP712Domain: [
      { name: "name", type: "string" }, { name: "version", type: "string" }, { name: "chainId", type: "uint256" },
    ] as const,
    ...typedData.types,
  } });
}
export function submitBuybackPreparation(input: BuybackPrepareInput, authorization: BuybackAuthorization) {
  return chainApi<BuybackBatch>(8453, "/buyback/batches", { ...input, authorization });
}
type WalletState = {
  account: Address | null;
  chainId: number | null;
  error: string;
  connecting: boolean;
  revision: number;
  connect: () => Promise<void>;
  disconnect: () => void;
  switchChain: (chainId: number) => Promise<void>;
  send: (
    to: Address,
    data: Hex,
    config: RuntimeConfig,
    onHash?: (hash: Hash) => void,
  ) => Promise<Hash>;
  launch: (plan: LaunchPlan, config: RuntimeConfig, progress: (message: string) => void,
    onHash?: (hash: Hash) => void, assertCurrent?: () => void, onPlan?: (plan: LaunchPlan) => void) => Promise<Hash>;
  trade: (
    quote: Quote,
    config: RuntimeConfig,
    progress: (message: string) => void,
  ) => Promise<Hash>;
  buyback: (step: BuybackStep, config: RuntimeConfig, onHash?: (hash: Hash) => void) => Promise<Hash>;
  prepareBuyback: (input: BuybackPrepareInput, config: RuntimeConfig) => Promise<BuybackBatch>;
  engineAction: (action: EngineAction, config: RuntimeConfig, onHash?: (hash: Hash) => void) => Promise<Hash>;
  balance: (token: Address, config?: RuntimeConfig) => Promise<bigint>;
  balanceNative: (config?: RuntimeConfig) => Promise<bigint>;
  payFirstBuy: (quote: FirstBuyPaymentQuote, config: RuntimeConfig, progress: (message: string) => void,
    onHash: (hash: Hash) => void, assertCurrent?: () => void, onQuote?: (quote: FirstBuyPaymentQuote) => void) => Promise<FirstBuyPaymentVerification>;
  claimFirstBuy: (token: Address, config: RuntimeConfig, onHash?: (hash: Hash) => void) => Promise<Hash>;
  tradeMusegod: (quote: MusegodQuote, config: RuntimeConfig, progress: (message: string) => void,
    onHash?: (hash: Hash) => void) => Promise<Hash>;
};
// Preserve context identity when Vite updates the provider and its consumers
// in the same batch. Production has no hot module data.
const Context: ReturnType<typeof createContext<WalletState | null>> =
  import.meta.hot?.data.walletContext ??
  createContext<WalletState | null>(null);
if (import.meta.hot) import.meta.hot.data.walletContext = Context;
export function WalletProvider({ children }: { children: ReactNode }) {
  const network = useNetwork();
  const [connection, setConnection] = useState({
    account: null as Address | null,
    chainId: null as number | null,
    error: "",
    connecting: false,
    revision: 0,
  });
  const [options, setOptions] = useState<WalletOption[]>([]),
    [open, setOpen] = useState(false);
  const [ethBalance, setEthBalance] = useState<string | null>(null);
  const [balanceNetwork, setBalanceNetwork] = useState<string | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const operation = useRef<symbol | null>(null);
  async function exclusive<T>(action: () => Promise<T>): Promise<T> {
    if (operation.current)
      throw new Error("A transaction is already being processed. Check your wallet transaction history first.");
    const owner = Symbol("wallet-request"); operation.current = owner;
    try {
      return await action();
    } finally {
      if (operation.current === owner) operation.current = null;
    }
  }
  const controller = useRef<WalletConnection | null>(null);
  if (!controller.current)
    controller.current = new WalletConnection(setConnection, (rdns) => {
      try {
        if (rdns) localStorage.setItem("musegod.wallet.v1", rdns);
        else localStorage.removeItem("musegod.wallet.v1");
      } catch {
        /* Connection still works without persistence. */
      }
    });
  const { account, chainId, error, connecting, revision } = connection;
  useEffect(() => {
    let active = true;
    setEthBalance(null);
    setBalanceNetwork(null);
    if (account && chainId && [8453, 31337, 4663].includes(chainId))
      void (async () => {
        const current = await chainApi<RuntimeConfig>(chainId === 31337 ? network.chainId : chainId as 8453 | 4663, "/config");
        if (chainId !== current.chainId)
          throw new Error("The wallet network is not active for this platform");
        const client = transactionClient(chainId, current);
        if (await client.getChainId() !== chainId) throw new Error("The balance RPC network does not match the wallet network");
        return { amount: await client.getBalance({ address: account }),
          network: chainId === current.chainId ? networkName(current) : robinhood.name };
      })()
        .then(({ amount, network }) => {
          if (active) { setEthBalance(formatEther(amount)); setBalanceNetwork(network); }
        })
        .catch(() => {});
    return () => {
      active = false;
    };
  }, [account, chainId, revision, network.chainId]);
  useEffect(() => {
    const wallets: WalletOption[] = [];
    let restored = false;
    const add = (option: WalletOption) => {
      if (wallets.some((w) => w.provider === option.provider)) return;
      wallets.push(option);
      setOptions([...wallets]);
      let saved: string | null = null;
      try {
        saved = localStorage.getItem("musegod.wallet.v1");
      } catch {}
      if (!restored && !controller.current?.selected && saved === option.rdns) {
        restored = true;
        void controller.current?.select(option, true);
      }
    };
    const announce = (e: Event) => {
      const option = walletAnnouncement((e as CustomEvent).detail);
      if (option) add(option);
    };
    window.addEventListener("eip6963:announceProvider", announce);
    window.dispatchEvent(new Event("eip6963:requestProvider"));
    const legacy = setTimeout(() => {
      if (window.ethereum && !wallets.length)
        add({
          id: "legacy",
          name: "Browser wallet",
          rdns: "legacy",
          provider: window.ethereum,
        });
    }, 300);
    return () => {
      clearTimeout(legacy);
      window.removeEventListener("eip6963:announceProvider", announce);
      controller.current?.dispose();
    };
  }, []);
  useEffect(() => {
    if (open) dialog.current?.showModal();
    else dialog.current?.close();
  }, [open]);
  async function connect() {
    setOpen(true);
    window.dispatchEvent(new Event("eip6963:requestProvider"));
  }
  function disconnect() {
    controller.current!.disconnect();
  }
  async function switchChain(id: number) {
    try {
      if (![8453, 31337, 4663].includes(id)) throw new Error("Unsupported wallet network");
      const p = controller.current?.selected?.provider;
      if (!p) throw new Error("Connect your wallet first");
      const selectedAccount = controller.current!.state.account;
      const unchanged = () => {
        if (controller.current?.selected?.provider !== p || controller.current.state.account !== selectedAccount)
          throw new Error("The wallet has changed. Select the network again.");
      };
      try {
        await p.request({ method: "wallet_switchEthereumChain", params: [{ chainId: toHex(id) }] });
      } catch (error) {
        if (id !== robinhood.id || (error as { code?: number }).code !== 4902) throw error;
        unchanged();
        await p.request({
          method: "wallet_addEthereumChain",
          params: [{ chainId: toHex(robinhood.id), chainName: robinhood.name,
            nativeCurrency: robinhood.nativeCurrency,
            rpcUrls: ["https://rpc.mainnet.chain.robinhood.com"],
            blockExplorerUrls: [robinhood.blockExplorers.default.url] }],
        });
        unchanged();
        await p.request({ method: "wallet_switchEthereumChain", params: [{ chainId: toHex(id) }] });
      }
      unchanged();
    } catch (e) {
      setConnection((previous) => ({ ...previous, error: errorMessage(e) }));
    }
  }
  async function signer(config: RuntimeConfig, expected: Address, validateAction?: (current: RuntimeConfig) => Promise<unknown>,
    guardRequest?: (request: Parameters<Provider["request"]>[0]) => void, beforeSend?: () => void) {
    assertSigningEnabled(config);
    assertTransactionStorage();
    const p = controller.current?.selected?.provider;
    if (!p) throw new Error("The wallet is unavailable");
    const validate = async () => {
      // Recheck the server switch for every wallet request, including after an
      // approval. An open page cannot keep signing after an operator rollback.
      const [current, rpcChainId] = await Promise.all([
        chainApi<RuntimeConfig>(deploymentChain(config), "/config"),
        transactionClient(config.chainId, config).getChainId(),
      ]);
      assertSigningEnabled(current);
      if (config.mode !== "fork" && (current.securityProtocol !== 1 || current.signingPaused !== false ||
        !Number.isSafeInteger(current.controlRevision) || current.controlRevision! < 0))
        throw new Error("The current signing controls could not be verified. Your draft and payment are saved.");
      if (
        current.chainId !== config.chainId ||
        current.mode !== config.mode ||
        deploymentChain(current) !== deploymentChain(config) ||
        current.treasury !== config.treasury ||
        rpcChainId !== config.chainId
      )
        throw new Error("The platform configuration or RPC network has changed. Refresh and preview again.");
      await validateAction?.(current);
      await controller.current!.validate(expected, config.chainId, p);
    };
    await controller.current!.validate(expected, config.chainId, p);
    return createWalletClient({
      account: expected,
      chain: walletChain(config),
      transport: custom({
        request: async (request: Parameters<Provider["request"]>[0]) => {
          guardRequest?.(request);
          const method = (request as unknown as { method: string }).method;
          if (/^(?:eth_sendTransaction|eth_sign|personal_sign|eth_signTypedData)/.test(method) || method === "wallet_sendCalls") {
            await validate();
            if (method === "eth_sendTransaction") beforeSend?.();
          }
          return p.request(request);
        },
      } as Provider, { retryCount: 0 }),
    });
  }
  async function confirmed(
    hash: Hash,
    config: Pick<RuntimeConfig, "chainId" | "deploymentChainId">,
    expected: Address,
    action: Transaction["action"],
    extra: Pick<Transaction, "batchId" | "buybackKind" | "nonce" | "musegodRecovery" | "firstBuyPayment" | "firstBuyClaim" | "intentId" | "tokenAddress" | "planId"> = {},
    background = false,
  ) {
    saveTransaction({
      hash,
      chainId: config.chainId,
      ...(config.chainId === 31337 ? { deploymentChainId: config.deploymentChainId ?? 8453 } : {}),
      account: expected,
      action,
      status: "pending",
      at: Date.now(),
      ...extra,
    });
    if (!background && action !== "approval") operation.current = null;
    let replaced = false;
    try {
      const client = transactionClient(config.chainId, config);
      if (await client.getChainId() !== config.chainId)
        throw new Error("The transaction lookup RPC is on the wrong network");
      if (extra.musegodRecovery || extra.firstBuyPayment || extra.firstBuyClaim) {
        try {
          const submitted = await client.getTransaction({ hash });
          const fingerprint = extra.musegodRecovery ?? (extra.firstBuyPayment ? {
            to: extra.firstBuyPayment.transaction.to, dataHash: keccak256(extra.firstBuyPayment.transaction.data), value: extra.firstBuyPayment.transaction.value,
          } : extra.firstBuyClaim ? { to: extra.firstBuyClaim.bundler, dataHash: keccak256(extra.firstBuyClaim.data), value: "0" } : null);
          if (fingerprint && sameAddress(submitted.from, expected) && submitted.to &&
            sameAddress(submitted.to, fingerprint.to) &&
            keccak256(submitted.input) === fingerprint.dataHash && submitted.value.toString() === fingerprint.value) {
            extra = { ...extra, nonce: submitted.nonce };
            updateTransaction(hash, config.chainId, { nonce: submitted.nonce }, config.deploymentChainId);
          }
        } catch { /* Recovery retries nonce discovery from the actual transaction. */ }
      }
      const waitOptions = {
        hash,
        confirmations: 2,
        timeout: 120000,
        onReplaced: (r: { reason: string; transaction: { hash: Hash }; replacedTransaction: { nonce: number } }) => {
          updateTransaction(hash, config.chainId, {
            status: r.reason === "cancelled" ? "cancelled" : "replaced",
            replacement: r.transaction.hash,
            ...(action === "launch" || extra.firstBuyPayment || extra.firstBuyClaim ? { nonce: r.replacedTransaction.nonce } : {}),
            ...(action === "buyback" ? { registered: false } : {}),
          }, config.deploymentChainId);
          replaced = r.reason !== "repriced";
          if (!replaced)
            saveTransaction({
              hash: r.transaction.hash,
              chainId: config.chainId,
              ...(config.chainId === 31337 ? { deploymentChainId: config.deploymentChainId ?? 8453 } : {}),
              account: expected,
              action,
              planId: transactions().find(
                (t) => t.hash === hash && t.chainId === config.chainId,
              )?.planId,
              status: "pending",
              at: Date.now(),
              ...extra,
            });
          if (extra.batchId && extra.buybackKind)
            void chainApi<BuybackBatch>(8453, `/buyback/batches/${encodeURIComponent(extra.batchId)}/track`, {
              kind: extra.buybackKind, hash: r.transaction.hash,
            }).then((batch) => {
              applyBuybackRecovery(batch, extra.buybackKind!, r.transaction.hash);
              if (!replaced) updateTransaction(r.transaction.hash, config.chainId, { registered: true }, config.deploymentChainId);
            }).catch(() => {});
        },
      };
      let receipt;
      const waitUntil = Date.now() + 120_000;
      while (true) {
        try { receipt = await client.waitForTransactionReceipt({ ...waitOptions, timeout: Math.max(1, waitUntil - Date.now()) }); break; }
        catch (cause) {
          if (Date.now() >= waitUntil || !/429|503|timeout|timed out|too many|busy|HTTP request failed|fetch failed/i.test(String(cause))) throw cause;
          await new Promise((resolve) => setTimeout(resolve, 1000));
        }
      }
      if (replaced) throw new Error("The transaction was cancelled or replaced. Check your transaction history.");
      const [head, canonicalBlock] = await Promise.all([
        client.getBlockNumber(), client.getBlock({ blockNumber: receipt.blockNumber }),
      ]);
      if (canonicalBlock.hash !== receipt.blockHash || head < receipt.blockNumber + 1n)
        throw new Error("The transaction confirmation changed. Check its pending status in transaction history.");
      updateTransaction(receipt.transactionHash, config.chainId, {
        status: receipt.status === "success" ? "success" : "failed",
      }, config.deploymentChainId);
      if (receipt.status !== "success")
        throw new Error("The transaction failed. Check your transaction history.");
      return receipt.transactionHash;
    } catch (e) {
      if (
        transactions().some(
          (t) =>
            t.hash === hash &&
            t.chainId === config.chainId &&
            t.status === "pending",
        )
      )
        throw new Error(`The transaction is still pending. Check it again in your wallet transaction history: ${hash}`);
      throw e;
    }
  }
  async function send(
    to: Address,
    data: Hex,
    config: RuntimeConfig,
    onHash?: (hash: Hash) => void,
  ) {
    const publicClient = transactionClient(config.chainId, config);
    if (!account) throw new Error("Connect your wallet first");
    const expected = account;
    const contracts = contractsFor(config);
    if (
      ![contracts.initializer, contracts.rehype].some((a) =>
        sameAddress(a, to),
      )
    )
      throw new Error("The transaction target is not allowed");
    const wallet = await signer(config, expected);
    await publicClient
      .call({ account: expected, to, data })
      .catch((error: unknown) => {
        throw simulationError(error);
      });
    const gas = await fundedGas(publicClient, to, data, 0n, config, expected);
    const hash = await wallet.sendTransaction({ to, data, value: 0n, gas });
    const confirmation = confirmed(
      hash,
      config,
      expected,
      "claim",
    );
    onHash?.(hash);
    return confirmation;
  }
  async function submitTrackedLaunch(transaction: LaunchTransaction, config: RuntimeConfig, expected: Address, gas: bigint,
    context: { kind: "approval" | "launch" | "payment"; intentId?: string; planId?: Hex; tokenAddress?: Address; quote?: FirstBuyPaymentQuote },
    signingWallet: (beforeSend: () => void) => ReturnType<typeof signer>) {
    const marker = context.intentId ? launchIntentStorageKey(config, expected, context.intentId, "submission") : null;
    const saved = { transaction, account: expected, chainId: config.chainId,
      deploymentChainId: deploymentChain(config), ...context, at: Date.now() };
    let requested = false, timedOut = false, timeoutAt = 0, savedMarker: string | undefined;
    const changed = () => window.dispatchEvent(new Event("musegod:launch-submission"));
    const clearMarker = () => {
      if (!marker) return true;
      if (savedMarker && localStorage.getItem(marker) === savedMarker) { localStorage.removeItem(marker); changed(); return true; }
      return false;
    };
    let timer: ReturnType<typeof setTimeout>;
    let restartTimeout: () => void, expire: () => void;
    const timeout = new Promise<never>((_, reject) => {
      expire = () => {
        timedOut = true;
        reject(new Error(requested
          ? "The wallet request is still unresolved. Your saved request will not be resent. Check your wallet or create another token."
          : "The wallet request took too long before submission. Your draft is saved; reconnect your wallet and review again."));
      };
      restartTimeout = () => {
        clearTimeout(timer);
        timeoutAt = performance.now() + 300_000;
        timer = setTimeout(expire, 300_000);
      };
      restartTimeout();
    });
    const submission = (async () => {
      const wallet = await signingWallet(() => {
        // A timed-out preflight must never reach the provider later. A request
        // already handed to the wallet remains owned by this frozen intent.
        if (timedOut || performance.now() >= timeoutAt) {
          expire(); throw new Error("The wallet request expired before submission. Review again.");
        }
        if (requested) throw new Error("This wallet request was already sent. Check its saved status.");
        if (marker) { savedMarker = JSON.stringify(saved); localStorage.setItem(marker, savedMarker); changed(); }
        requested = true;
        // Give the wallet its complete five-minute response window even when
        // the preceding configuration and transaction checks were slow.
        restartTimeout();
      });
      if (timedOut) throw new Error("The wallet request expired before submission. Review again.");
      return wallet.sendTransaction({ to: transaction.to, data: transaction.data, value: BigInt(transaction.value), gas });
    })().then((hash) => {
      // Background tabs can delay timer callbacks. An overdue response must
      // still take the recovery path, even if its promise runs before the timer.
      if (!timedOut && performance.now() >= timeoutAt) expire();
      if (marker && savedMarker && localStorage.getItem(marker) === savedMarker) {
        savedMarker = JSON.stringify({ ...saved, hash }); localStorage.setItem(marker, savedMarker); changed();
      }
      if (timedOut && !transactions().some((row) => row.hash === hash && row.chainId === config.chainId &&
        (config.chainId !== 31337 || row.deploymentChainId === config.deploymentChainId))) {
        // Never resume the old UI callbacks or a subsequent approval/payment.
        // Receipt observation only updates the original intent's history.
        void confirmed(hash, config, expected, context.kind === "payment" ? "swap" : context.kind, {
          intentId: context.intentId, planId: context.planId, tokenAddress: context.tokenAddress,
          ...(context.kind === "payment" ? { firstBuyPayment: context.quote } : {}),
        }, true).catch(() => {});
      }
      return { hash, clearMarker };
    }, (cause: unknown) => {
      if (!requested || /4001|user rejected|user denied/i.test(String(cause))) clearMarker();
      throw cause;
    });
    try { return await Promise.race([submission, timeout]); }
    finally { clearTimeout(timer!); }
  }
  async function confirmLaunchApproval(transaction: LaunchTransaction, config: RuntimeConfig, expected: Address, gas: bigint,
    context: { intentId?: string; planId?: Hex; quote?: FirstBuyPaymentQuote },
    signingWallet: (beforeSend: () => void) => ReturnType<typeof signer>, onHash?: (hash: Hash) => void) {
    const { hash, clearMarker } = await submitTrackedLaunch(transaction, config, expected, gas,
      { ...context, kind: "approval" }, signingWallet);
    onHash?.(hash);
    await confirmed(hash, config, expected, "approval", { intentId: context.intentId, planId: context.planId });
    // Only a canonical successful receipt releases this intent. Unknown wallet
    // results and pending confirmations retain the exact approval for recovery.
    if (!clearMarker()) throw new Error("The saved approval request changed. Check the current transaction before continuing.");
  }
  async function engineAction(action: EngineAction, config: RuntimeConfig, onHash?: (hash: Hash) => void) {
    const publicClient = transactionClient(config.chainId, config);
    if (!account) throw new Error("Connect your wallet first");
    const expected = account;
    const frozen = Object.freeze({ ...action }) as EngineAction;
    const tx = engineTransaction(frozen, config);
    const validate = async (current: RuntimeConfig) => {
      const fresh = engineTransaction(frozen, current);
      if (!sameAddress(fresh.to, tx.to) || fresh.data.toLowerCase() !== tx.data.toLowerCase() ||
        current.feeEngine !== config.feeEngine || current.buybackExecutor !== config.buybackExecutor ||
        current.treasury !== config.treasury || current.automationReceiver !== config.automationReceiver ||
        current.automationTreasury !== config.automationTreasury || current.wethForwarder !== config.wethForwarder ||
        current.buybackVault !== config.buybackVault || current.assetFeedOracle !== config.assetFeedOracle)
        throw new Error("The buyback engine configuration or transaction changed. Refresh and preview again.");
    };
    await signer(config, expected, validate);
    await publicClient.call({ account: expected, ...tx }).catch((error: unknown) => { throw simulationError(error); });
    const wallet = await signer(config, expected, validate,
      (request) => assertLaunchRequest(request, { to: tx.to, data: tx.data, value: "0", from: expected, chainId: config.chainId }));
    const gas = await fundedGas(publicClient, tx.to, tx.data, 0n, config, expected);
    const hash = await wallet.sendTransaction({ ...tx, gas });
    const confirmation = confirmed(hash, config, expected, "engine");
    onHash?.(hash);
    return confirmation;
  }
  async function launch(plan: LaunchPlan, config: RuntimeConfig, progress: (message: string) => void,
    onHash?: (hash: Hash) => void, assertCurrent?: () => void, onPlan?: (plan: LaunchPlan) => void) {
    const publicClient = transactionClient(config.chainId, config);
    const api = <T,>(path: string, body?: unknown) => chainApi<T>(deploymentChain(config), path, body);
    if (!account) throw new Error("Connect your wallet first");
    const expected = account;
    const validate = async (frozen: LaunchPlan, current: RuntimeConfig, signing = false) => {
      assertCurrent?.();
      if (frozen.intentId) await assertLaunchIntentLock(config, expected, frozen.intentId);
      assertLaunchWalletPlan(frozen, current, expected);
      const result = await api<{ valid: true; curvePolicy: string; planId?: Hex; intentId?: string; validityVersion?: number; signingExpiresAt?: number }>("/launch/validate", {
        creator: expected, data: frozen.data, ...(signing ? { signing: true } : {}),
      });
      if (result.valid !== true || result.curvePolicy !== frozen.curvePolicy || frozen.validityVersion === 2 &&
        (result.planId !== frozen.id || result.intentId !== frozen.intentId || result.validityVersion !== 2 || result.signingExpiresAt !== frozen.signingExpiresAt))
        throw new Error("The launch preview has changed. Run a new preview.");
      assertCurrent?.();
    };
    const signingWallet = (transaction: LaunchTransaction, frozen: LaunchPlan, beforeSend?: () => void) => signer(config, expected,
      (current) => validate(frozen, current, true),
      (request) => assertLaunchRequest(request, { ...transaction, from: expected, chainId: config.chainId }), beforeSend);
    return executeLaunchPlan(plan, config, expected, {
      validate: (frozen) => validate(frozen, config),
      refresh: async (previous) => {
        const refreshed = await api<LaunchPlan>("/launch/prepare", {
          draft: launchDraftInput(previous), creator: expected, expectedCurvePolicy: previous.curvePolicy,
          options: { intentId: previous.intentId, previousPlanId: previous.id,
            acceptedMinAmountOut: previous.firstBuy?.acceptedMinAmountOut ?? previous.firstBuy?.minAmountOut },
          firstBuy: { amount: previous.firstBuy?.amount ?? "0", slippageBps: previous.firstBuy?.slippageBps ?? 100, lockDays: previous.firstBuy?.lockDays ?? 0 },
        });
        saveFrozenLaunch(config, expected, refreshed); onPlan?.(refreshed); return refreshed;
      },
      onPlan,
      balance: (token) => publicClient.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [expected] }),
      allowance: (token, spender) => publicClient.readContract({ address: token, abi: erc20Abi, functionName: "allowance", args: [expected, spender] }),
      approve: async (transaction, frozen) => {
        await publicClient.call({ account: expected, to: transaction.to, data: transaction.data, value: 0n })
          .catch((error: unknown) => { throw simulationError(error); });
        const [estimate, block] = await Promise.all([
          publicClient.estimateGas({ account: expected, to: transaction.to, data: transaction.data, value: 0n }),
          publicClient.getBlock(),
        ]);
        const gas = bufferedLaunchGas(estimate, block.gasLimit);
        await ensureGas(config, expected, 0n, gas);
        saveFrozenLaunch(config, expected, frozen);
        await confirmLaunchApproval(transaction, config, expected, gas, { intentId: frozen.intentId, planId: frozen.id },
          (beforeSend) => signingWallet(transaction, frozen, beforeSend),
          (hash) => progress(`Waiting for first buy approval · ${hash}`));
      },
      simulate: (frozen) => api<LaunchSimulation>("/launch/simulate", { creator: expected, data: frozen.data }),
      submit: async (transaction, gas, frozen) => {
        const block = await publicClient.getBlock();
        const bufferedGas = bufferedLaunchGas(gas, block.gasLimit);
        await ensureGas(config, expected, 0n, bufferedGas);
        saveFrozenLaunch(config, expected, frozen);
        const { hash } = await submitTrackedLaunch(transaction, config, expected, bufferedGas,
          { kind: "launch", intentId: frozen.intentId, planId: frozen.id, tokenAddress: frozen.tokenAddress },
          (beforeSend) => signer(config, expected, (current) => validate(frozen, current, true),
          (request) => assertLaunchRequest(request, { ...transaction, from: expected, chainId: config.chainId }),
          beforeSend));
        const confirmation = confirmed(hash, config, expected, "launch", { intentId: frozen.intentId, tokenAddress: frozen.tokenAddress, planId: frozen.id });
        onHash?.(hash);
        progress(`Waiting for on-chain launch confirmation · ${hash}`);
        return confirmation;
      },
      progress,
    });
  }
  async function trade(
    quote: Quote,
    config: RuntimeConfig,
    progress: (message: string) => void,
  ) {
    const publicClient = transactionClient(config.chainId, config);
    if (!account) throw new Error("Connect your wallet first");
    const expected = account;
    const contracts = contractsFor(config);
    const fresh = () => {
      if (quoteNow(quote) >= quote.expiresAt)
        throw new Error("The quote has expired. Request a new quote. Existing approvals can still be reused.");
    };
    fresh();
    const amount = BigInt(quote.amountIn),
      wallet = await signer(config, expected);
    const balance = await publicClient.readContract({
      address: quote.currencyIn,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [expected],
    });
    if (balance < amount) throw new Error("Insufficient available token balance");
    const allowance = await publicClient.readContract({
      address: quote.currencyIn,
      abi: erc20Abi,
      functionName: "allowance",
      args: [expected, contracts.permit2],
    });
    if (allowance < amount) {
      progress("1/3 · Approve this transaction amount");
      fresh();
      await signer(config, expected);
      const request = {
        address: quote.currencyIn,
        abi: erc20Abi,
        functionName: "approve" as const,
        args: [contracts.permit2, amount] as const,
        account: expected,
      };
      await publicClient.simulateContract(request);
      await signer(config, expected);
      await confirmed(
        await wallet.writeContract({ ...request, gas: await fundedContractGas(publicClient, request, config, expected) }),
        config,
        expected,
        "approval",
      );
    }
    const block = await publicClient.getBlock();
    const deadline = block.timestamp + 300n;
    const permit = await publicClient.readContract({
      address: contracts.permit2,
      abi: permit2Abi,
      functionName: "allowance",
      args: [expected, quote.currencyIn, contracts.router],
    });
    if (
      permit[0] !== amount ||
      permit[1] < Number(block.timestamp + 60n) ||
      permit[1] > Number(deadline)
    ) {
      progress("2/3 · Approve the trading router; approval expires in 5 minutes");
      fresh();
      await signer(config, expected);
      const request = {
        address: contracts.permit2,
        abi: permit2Abi,
        functionName: "approve" as const,
        args: [
          quote.currencyIn,
          contracts.router,
          amount,
          Number(deadline),
        ] as const,
        account: expected,
      };
      await publicClient.simulateContract(request).catch((error: unknown) => {
        throw simulationError(error);
      });
      fresh();
      await signer(config, expected);
      await confirmed(
        await wallet.writeContract({ ...request, gas: await fundedContractGas(publicClient, request, config, expected) }),
        config,
        expected,
        "approval",
      );
    }
    fresh();
    const tx = swapTransaction(
      quote.poolKey,
      quote.currencyIn,
      amount,
      BigInt(quote.amountOut),
      quote.slippageBps,
      deadline,
      contracts,
    );
    await publicClient
      .call({
        account: expected,
        to: tx.to,
        data: tx.data,
        value: 0n,
      })
      .catch((error: unknown) => {
        throw simulationError(error);
      });
    fresh();
    await signer(config, expected);
    progress("3/3 · Confirm the transaction in your wallet");
    const hash = await wallet.sendTransaction({
      to: tx.to,
      data: tx.data,
      value: 0n,
      gas: await fundedGas(publicClient, tx.to, tx.data, 0n, config, expected),
    });
    progress(`Waiting for onchain confirmation · ${hash}`);
    return confirmed(hash, config, expected, "swap");
  }
  async function balance(token: Address, config?: RuntimeConfig) {
    if (!account) throw new Error("No wallet connected");
    const current = config ?? await chainApi<RuntimeConfig>(network.chainId, "/config");
    const publicClient = transactionClient(current.chainId, current);
    if (await publicClient.getChainId() !== current.chainId) throw new Error("The balance RPC network does not match the selected network.");
    return publicClient.readContract({
      address: token,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [account],
    });
  }
  async function balanceNative(config?: RuntimeConfig) {
    if (!account) throw new Error("No wallet connected");
    const current = config ?? await chainApi<RuntimeConfig>(network.chainId, "/config");
    const publicClient = transactionClient(current.chainId, current);
    if (await publicClient.getChainId() !== current.chainId) throw new Error("The balance RPC network differs from the selected network.");
    return publicClient.getBalance({ address: account });
  }
  async function fundedGas(client: typeof publicClient, to: Address, data: Hex, value: bigint, config: RuntimeConfig, expected: Address) {
    const [estimate, block] = await Promise.all([client.estimateGas({ account: expected, to, data, value }), client.getBlock()]);
    const gas = bufferedLaunchGas(estimate, block.gasLimit);
    await ensureGas(config, expected, value, gas); return gas;
  }
  async function fundedContractGas(client: typeof publicClient, request: { address: Address; abi: unknown; functionName: string; args: readonly unknown[] }, config: RuntimeConfig, expected: Address) {
    const data = encodeFunctionData(request as Parameters<typeof encodeFunctionData>[0]);
    return fundedGas(client, request.address, data, 0n, config, expected);
  }
  async function ensureGas(config: RuntimeConfig, expected: Address, value: bigint, gas: bigint) {
    const client = transactionClient(config.chainId, config);
    const [fees, available] = await Promise.all([client.estimateFeesPerGas(), client.getBalance({ address: expected })]);
    const price = fees.maxFeePerGas ?? fees.gasPrice;
    if (gas <= 0n || price === undefined || price < 0n || available < value + (gas * price * 120n + 99n) / 100n)
      throw new Error("Keep enough ETH for this transaction and its gas reserve. Reduce the payment amount and preview again.");
  }
  async function payFirstBuy(quote: FirstBuyPaymentQuote, config: RuntimeConfig, progress: (message: string) => void,
    onHash: (hash: Hash) => void, assertCurrent?: () => void, onQuote?: (quote: FirstBuyPaymentQuote) => void): Promise<FirstBuyPaymentVerification> {
    if (!account) throw new Error("Connect your wallet first");
    config = Object.freeze({ ...config });
    const expected = account, client = transactionClient(config.chainId, config);
    let submittedQuote = quote;
    let clearSubmission: (() => boolean) | undefined;
    const validate = async (frozen: FirstBuyPaymentQuote, current: RuntimeConfig) => {
      assertCurrent?.();
      if (frozen.intentId) await assertLaunchIntentLock(config, expected, frozen.intentId);
      assertFirstBuyLaunchConfig(config, current);
      const swaps = assertFirstBuyPaymentQuote(frozen);
      const [facet, code] = await Promise.all([
        frozen.protocol === "wrap" ? Promise.resolve(frozen.facet) : client.readContract({ address: frozen.router, abi: firstBuyDiamondAbi, functionName: "facetAddress", args: [frozen.transaction.data.slice(0, 10) as Hex] }),
        client.getCode({ address: frozen.facet }),
      ]);
      if (!sameAddress(facet, frozen.facet) || !code || keccak256(code) !== frozen.facetRuntimeHash)
        throw new Error("The payment router changed. Request a new quote after verification.");
      for (const swap of swaps) {
        const selector = swap.callData.slice(0, 10) as Hex;
        const allowed = frozen.chainId === 4663
          ? await client.readContract({ address: frozen.router, abi: firstBuyDiamondAbi, functionName: "isContractSelectorWhitelisted", args: [swap.callTo, selector] })
          : (await client.readContract({ address: frozen.router, abi: firstBuyDiamondAbi, functionName: "isAddressWhitelisted", args: [swap.callTo] }) &&
            await client.readContract({ address: frozen.router, abi: firstBuyDiamondAbi, functionName: "isFunctionSelectorWhitelisted", args: [selector] }));
        if (!allowed) throw new Error("The payment route is no longer allowed by LI.FI. Preview again.");
        if (!sameAddress(swap.approveTo, swap.callTo)) {
          const approvalAllowed = frozen.chainId === 4663
            ? await client.readContract({ address: frozen.router, abi: firstBuyDiamondAbi, functionName: "isContractSelectorWhitelisted", args: [swap.approveTo, "0xffffffff"] })
            : await client.readContract({ address: frozen.router, abi: firstBuyDiamondAbi, functionName: "isAddressWhitelisted", args: [swap.approveTo] });
          if (!approvalAllowed) throw new Error("The payment route approval target is no longer allowed by LI.FI.");
        }
      }
      assertCurrent?.();
    };
    const signingWallet = (transaction: LaunchTransaction, frozen: FirstBuyPaymentQuote, beforeSend?: () => void) => signer(config, expected,
      (current) => validate(frozen, current), (request) => assertLaunchRequest(request, { ...transaction, from: expected, chainId: config.chainId }), beforeSend);
    const hash = await executeFirstBuyPayment(quote, config, expected, {
      validate: (frozen) => validate(frozen, config),
      refresh: async (previous) => ({ ...(await chainApi<FirstBuyPaymentQuote>(deploymentChain(config), "/first-buy/quote",
        { ...firstBuyPaymentRefreshInput(previous), account: expected })), intentId: previous.intentId }),
      onQuote: (fresh) => { submittedQuote = fresh; onQuote?.(fresh); },
      balance: (token) => sameAddress(token, "0x0000000000000000000000000000000000000000")
        ? client.getBalance({ address: expected }) : client.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [expected] }),
      allowance: (token, spender) => client.readContract({ address: token, abi: erc20Abi, functionName: "allowance", args: [expected, spender] }),
      approve: async (tx, frozen) => {
        const gas = await fundedGas(client, tx.to, tx.data, 0n, config, expected);
        await confirmLaunchApproval(tx, config, expected, gas, { intentId: frozen.intentId, quote: frozen },
          (beforeSend) => signingWallet(tx, frozen, beforeSend),
          (hash) => progress(`Waiting for payment approval · ${hash}`));
      },
      simulate: async (frozen) => {
        await client.call({ account: expected, to: frozen.transaction.to, data: frozen.transaction.data, value: BigInt(frozen.transaction.value) })
          .catch((error: unknown) => { throw simulationError(error); });
        return client.estimateGas({ account: expected, to: frozen.transaction.to, data: frozen.transaction.data, value: BigInt(frozen.transaction.value) });
      },
      submit: async (frozen, gas) => {
        gas = bufferedLaunchGas(gas, (await client.getBlock()).gasLimit);
        await ensureGas(config, expected, BigInt(frozen.transaction.value), gas);
        const { hash: submitted, clearMarker } = await submitTrackedLaunch(frozen.transaction, config, expected, gas,
          { kind: "payment", intentId: frozen.intentId, quote: frozen },
          (beforeSend) => signingWallet(frozen.transaction, frozen, beforeSend));
        clearSubmission = clearMarker;
        const confirmation = confirmed(submitted, config, expected, "swap", { firstBuyPayment: frozen, intentId: frozen.intentId });
        onHash(submitted);
        progress(`Waiting for payment conversion confirmation · ${submitted}`);
        return confirmation;
      }, progress,
    });
    const verification = await chainApi<FirstBuyPaymentVerification>(deploymentChain(config), "/first-buy/verify", { quote: submittedQuote, hash });
    if (verification.status !== "pending" && clearSubmission && !clearSubmission())
      throw new Error("The saved payment request changed. Check the current transaction before continuing.");
    return verification;
  }
  async function claimFirstBuy(token: Address, config: RuntimeConfig, onHash?: (hash: Hash) => void) {
    if (!account) throw new Error("Connect the recipient wallet first");
    const expected = account, client = transactionClient(config.chainId, config);
    if (transactions().some((row) => isUnresolvedFirstBuyClaim(row, token, expected, config)))
      throw new Error("A claim for this first buy is already submitted. Check its saved status before submitting again.");
    const state = await chainApi<FirstBuyLockStatus | null>(deploymentChain(config), `/first-buy-lock/${token}`);
    if (!state?.claimTransaction || !sameAddress(state.recipient, expected) || BigInt(state.claimableAmount) <= 0n)
      throw new Error("This first buy is not claimable by the connected wallet.");
    const tx = state.claimTransaction;
    const canonical = encodeFunctionData({ abi: bundlerAbi, functionName: "claim", args: [token] });
    if (!sameAddress(tx.to, ROBINHOOD_BUNDLER) || !sameAddress(tx.to, state.bundler) || tx.data !== canonical || tx.value !== "0") throw new Error("The lock claim transaction does not match its position.");
    const validate = async () => {
      const code = await client.getCode({ address: ROBINHOOD_BUNDLER });
      if (!code || keccak256(code) !== (deploymentChain(config) === 4663 ? ROBINHOOD_BUNDLER_CODE_HASH : BASE_BUNDLER_CODE_HASH))
        throw new Error("The first buy Bundler identity changed. Claims are paused for verification.");
      const fresh = await chainApi<FirstBuyLockStatus | null>(deploymentChain(config), `/first-buy-lock/${token}`);
      if (!fresh?.claimTransaction || !sameAddress(fresh.recipient, expected) || fresh.claimTransaction.data !== tx.data ||
        !sameAddress(fresh.claimTransaction.to, tx.to) || BigInt(fresh.claimableAmount) <= 0n)
        throw new Error("The first buy lock changed. Refresh its status.");
    };
    const gas = await client.estimateGas({ account: expected, to: tx.to, data: tx.data, value: 0n });
    const finalGas = bufferedLaunchGas(gas, (await client.getBlock()).gasLimit);
    await ensureGas(config, expected, 0n, finalGas);
    const wallet = await signer(config, expected, validate, (request) => assertLaunchRequest(request, { ...tx, from: expected, chainId: config.chainId }));
    const hash = await wallet.sendTransaction({ to: tx.to, data: tx.data, value: 0n, gas: finalGas });
    const confirmation = confirmed(hash, config, expected, "claim", { firstBuyClaim: { token, bundler: state.bundler, data: tx.data } }); onHash?.(hash);
    const confirmedHash = await confirmation;
    const receipt = await client.getTransactionReceipt({ hash: confirmedHash });
    let received = 0n;
    for (const log of receipt.logs) {
      if (!sameAddress(log.address, token)) continue;
      try {
        const event = decodeEventLog({ abi: erc20Abi, data: log.data, topics: log.topics });
        if (event.eventName === "Transfer" && sameAddress(event.args.from, state.bundler) && sameAddress(event.args.to, expected)) received += event.args.value;
      } catch { /* Ignore non-transfer token events. */ }
    }
    const fresh = await chainApi<FirstBuyLockStatus | null>(deploymentChain(config), `/first-buy-lock/${token}`);
    if (received !== BigInt(state.claimableAmount) || !fresh || BigInt(fresh.claimedAmount) < BigInt(state.claimedAmount) + received)
      throw new Error("The claim is confirmed, but its token receipt needs to be checked. Refresh the lock status before trying again.");
    updateTransaction(confirmedHash, config.chainId, { registered: true }, config.deploymentChainId);
    return confirmedHash;
  }
  async function tradeMusegod(quote: MusegodQuote, config: RuntimeConfig,
    progress: (message: string) => void, onHash?: (hash: Hash) => void) {
    const publicClient = transactionClient(config.chainId, config);
    if (!account) throw new Error("Connect your wallet first");
    const expected = account;
    return executeMusegodTrade(quote, config, {
      account: expected, client: publicClient,
      routerCodeHash: MUSEGOD_ROUTER_VERIFICATION.runtimeHash,
      assertEnabled: () => { assertSigningEnabled(config); assertMusegodTradingEnabled(config); },
      signer: (validate) => signer(config, expected, validate),
      confirmed: (hash, action, request) => confirmed(hash, config, expected, action, {
        musegodRecovery: { to: request.to, dataHash: keccak256(request.data), value: request.value.toString(), fromBlock: request.fromBlock },
      }), progress, onHash,
    });
  }
  async function buyback(step: BuybackStep, config: RuntimeConfig, onHash?: (hash: Hash) => void) {
    const api = <T,>(path: string, body?: unknown) => chainApi<T>(8453, path, body);
    if (!account) throw new Error("Connect the treasury wallet first");
    const expected = account;
    assertBuybackStep(step, config, expected);
    assertTransactionStorage();
    const rows = transactions();
    if (rows.some((t) => t.batchId === step.batchId && t.buybackKind === step.kind &&
      (t.nonce === undefined || t.nonce === step.nonce) &&
      (t.status === "pending" || t.status === "success")))
      throw new Error("This buyback step already has a submitted transaction. Recover its status before submitting again.");
    const provider = controller.current?.selected?.provider;
    if (!provider) throw new Error("The wallet is unavailable");
    const client = transactionClient(step.chainId);
    const validate = async () => {
      const [current, fresh, rpcChainId, code] = await Promise.all([
        api<RuntimeConfig>("/config"),
        api<BuybackStep>(`/buyback/batches/${encodeURIComponent(step.batchId)}/step?kind=${step.kind}`),
        client.getChainId(),
        client.getCode({ address: expected }),
      ]);
      assertBuybackStep(step, current, expected);
      assertBuybackStep(fresh, current, expected);
      assertSameBuybackStep(step, fresh);
      if (current.mode !== config.mode || current.chainId !== config.chainId ||
        !sameAddress(current.treasury!, config.treasury!) || rpcChainId !== step.chainId)
        throw new Error("The buyback configuration or RPC network has changed. Preview again.");
      if (code && code !== "0x") throw new Error("Buybacks currently support only treasury EOA wallets");
      await controller.current!.validate(expected, step.chainId, provider);
    };
    await validate();
    await client.call({ account: expected, to: step.to, data: step.data, value: 0n })
      .catch((error: unknown) => { throw simulationError(error); });
    const wallet = createWalletClient({
      account: expected,
      chain: step.chainId === 4663 ? robinhood : base,
      transport: custom({
        request: async (request: Parameters<Provider["request"]>[0]) => {
          // Only the transaction described by the freshly validated batch may
          // reach the selected provider; message and typed-data signing are rejected.
          assertBuybackRequest(request, step);
          await validate();
          return provider.request(request);
        },
      } as Provider, { retryCount: 0 }),
    });
    const hash = await wallet.sendTransaction({ to: step.to, data: step.data, value: 0n, nonce: step.nonce! });
    const confirmation = confirmed(hash, { chainId: step.chainId }, expected, "buyback", {
      batchId: step.batchId, buybackKind: step.kind, nonce: step.nonce,
    });
    onHash?.(hash);
    const tracked = api<BuybackBatch>(`/buyback/batches/${encodeURIComponent(step.batchId)}/track`, { kind: step.kind, hash })
      .then((batch) => {
        applyBuybackRecovery(batch, step.kind, hash);
        updateTransaction(hash, step.chainId, { registered: true }, config.deploymentChainId);
      }).catch(() => {});
    const [confirmedHash] = await Promise.all([confirmation, tracked]);
    await api(`/buyback/batches/${encodeURIComponent(step.batchId)}/reconcile`, {}).catch(() => {});
    return confirmedHash;
  }
  async function prepareBuyback(input: BuybackPrepareInput, config: RuntimeConfig): Promise<BuybackBatch> {
    const publicClient = transactionClient(config.chainId, config);
    const api = <T,>(path: string, body?: unknown) => chainApi<T>(deploymentChain(config), path, body);
    if (!account) throw new Error("Connect the treasury wallet first");
    const expected = account;
    assertSigningEnabled(config);
    if (config.mode !== "base" || config.chainId !== 8453 || !config.treasury || !sameAddress(expected, config.treasury))
      throw new Error("Only the configured Base mainnet treasury wallet can authorize a buyback budget");
    const provider = controller.current?.selected?.provider;
    if (!provider) throw new Error("The wallet is unavailable");
    const stock = stockByAddress(input.stockAddress);
    if (stock.chainId !== 8453)
      throw new Error("Legacy cross-chain buybacks require a Base stock token");
    const normalized: BuybackPrepareInput = {
      stockAddress: stock.address,
      amount: input.amount,
      claimHashes: [...(input.claimHashes ?? [])],
    };
    const nonce = toHex(crypto.getRandomValues(new Uint8Array(32)));
    const expiresAt = Date.now() + 300_000;
    const payload = buybackAuthorizationPayload(normalized, expected, nonce, expiresAt);
    const validate = async () => {
      const [current, rpcChainId, code] = await Promise.all([
        api<RuntimeConfig>("/config"), publicClient.getChainId(), publicClient.getCode({ address: expected }),
      ]);
      assertSigningEnabled(current);
      if (current.mode !== "base" || current.chainId !== 8453 || rpcChainId !== 8453 ||
        !current.treasury || !sameAddress(current.treasury, expected) ||
        !sameAddress(current.treasury, config.treasury!) || Date.now() >= expiresAt)
        throw new Error("The buyback authorization has expired or the platform configuration has changed. Confirm the budget again.");
      if (code && code !== "0x") throw new Error("Buybacks currently support only treasury EOA wallets");
      await controller.current!.validate(expected, 8453, provider);
    };
    await validate();
    // Explicit budget confirmation only: the provider receives this one fixed
    // EIP-712 payload, and no transaction can be submitted by this method.
    const signature = await provider.request({ method: "eth_signTypedData_v4", params: [expected, payload] });
    await validate();
    if (!/^0x[0-9a-fA-F]{130}$/.test(signature)) throw new Error("The wallet returned an invalid budget signature");
    return submitBuybackPreparation(normalized, { nonce, expiresAt, signature });
  }
  return (
    <Context.Provider
      value={{
        account,
        chainId,
        error,
        connecting,
        revision,
        connect,
        disconnect,
        switchChain,
        send: (...args) => exclusive(() => send(...args)),
        launch: (...args) => exclusive(() => launch(...args)),
        trade: (...args) => exclusive(() => trade(...args)),
        buyback: (...args) => exclusive(() => buyback(...args)),
        prepareBuyback: (...args) => exclusive(() => prepareBuyback(...args)),
        engineAction: (...args) => exclusive(() => engineAction(...args)),
        payFirstBuy: (...args) => exclusive(() => payFirstBuy(...args)),
        claimFirstBuy: (...args) => exclusive(() => claimFirstBuy(...args)),
        balance,
        balanceNative,
        tradeMusegod: (...args) => exclusive(() => tradeMusegod(...args)),
      }}
    >
      {children}
      {open && (
        <dialog
          ref={dialog}
          className="wallet-dialog"
          onCancel={() => setOpen(false)}
          onClose={() => setOpen(false)}
          aria-labelledby="wallet-title"
        >
          <div className="section-heading">
            <h2 id="wallet-title">{account ? "Wallet account" : "Connect wallet"}</h2>
            <button aria-label="Close wallet dialog" onClick={() => setOpen(false)}>
              Close
            </button>
          </div>
          <p>
            Connecting only reads your address and balances; no signature is required. On mobile, use your wallet browser.
          </p>
          {account && (
            <>
              <code className="wallet-address">{account}</code>
              <p>
                Network ID: {chainId}
                {chainId && [8453, 31337, 4663].includes(chainId)
                  ? ` · ${balanceNetwork ?? (chainId === 4663 ? "Robinhood Chain" : chainId === 31337 ? "Local fork" : "Base")} ETH balance: ${ethBalance ?? "Unavailable"}`
                  : " · Balance queries are unavailable on this network"}
              </p>
              <button className="secondary" onClick={disconnect}>
                Disconnect
              </button>
            </>
          )}
          {options.map((option) => (
            <button
              className="wallet-option"
              key={option.id}
              disabled={connecting}
              onClick={async () => {
                await controller.current!.select(option);
                if (controller.current!.state.account) setOpen(false);
              }}
            >
              {option.name}{" "}
              {controller.current?.selected?.provider === option.provider
                ? " · Selected"
                : ""}
            </button>
          ))}
          {!options.length && (
            <p role="status">
              No wallet detected. Open this page in a browser with MetaMask, Coinbase Wallet,
              or another compatible wallet installed.
            </p>
          )}
          {error && <p role="alert">{error}</p>}
        </dialog>
      )}
    </Context.Provider>
  );
}
export function useWallet() {
  const value = useContext(Context);
  if (!value) throw new Error("WalletProvider missing");
  return value;
}
