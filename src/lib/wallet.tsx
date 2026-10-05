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
  encodeFunctionData,
  erc20Abi,
  getAddress,
  serializeTypedData,
  formatEther,
  http,
  toHex,
  type Address,
  type EIP1193Provider,
  type Hash,
  type Hex,
} from "viem";
import { base, robinhood } from "viem/chains";
import { contractsFor, deploymentChain, networkName, sameAddress, stockByAddress, type RuntimeConfig } from "./config";
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
  applyBuybackRecovery,
  saveTransaction,
  transactions,
  updateTransaction,
  type Transaction,
} from "./transactions";
import { api } from "./api";
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
  transport: http("/api/rpc", { retryCount: 0, timeout: 30_000 }),
});
export const robinhoodClient = createPublicClient({
  chain: robinhood,
  transport: http("/api/rpc/robinhood", { retryCount: 0, timeout: 30_000 }),
});
export function transactionClient(chainId: number, config?: Pick<RuntimeConfig, "chainId">) {
  if (![8453, 31337, 4663].includes(chainId)) throw new Error("Unsupported transaction network");
  if (config?.chainId === chainId) return publicClient;
  if (chainId === 4663) return robinhoodClient;
  if (chainId === 8453 || chainId === 31337) return publicClient;
  throw new Error("Unsupported transaction network");
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
  return api<BuybackBatch>("/buyback/batches", { ...input, authorization });
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
  trade: (
    quote: Quote,
    config: RuntimeConfig,
    progress: (message: string) => void,
  ) => Promise<Hash>;
  buyback: (step: BuybackStep, config: RuntimeConfig, onHash?: (hash: Hash) => void) => Promise<Hash>;
  prepareBuyback: (input: BuybackPrepareInput, config: RuntimeConfig) => Promise<BuybackBatch>;
  balance: (token: Address) => Promise<bigint>;
};
// Preserve context identity when Vite updates the provider and its consumers
// in the same batch. Production has no hot module data.
const Context: ReturnType<typeof createContext<WalletState | null>> =
  import.meta.hot?.data.walletContext ??
  createContext<WalletState | null>(null);
if (import.meta.hot) import.meta.hot.data.walletContext = Context;
export function WalletProvider({ children }: { children: ReactNode }) {
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
  const operation = useRef(false);
  async function exclusive<T>(action: () => Promise<T>): Promise<T> {
    if (operation.current)
      throw new Error("A transaction is already being processed. Check your wallet transaction history first.");
    operation.current = true;
    try {
      return await action();
    } finally {
      operation.current = false;
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
        const current = await api<RuntimeConfig>("/config");
        if (chainId !== current.chainId && !(current.mode === "base" && chainId === 4663))
          throw new Error("The wallet network is not active for this platform");
        const client = transactionClient(chainId);
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
  }, [account, chainId, revision]);
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
  async function signer(config: RuntimeConfig, expected: Address, validateAction?: () => Promise<unknown>) {
    assertSigningEnabled(config);
    assertTransactionStorage();
    if (transactions().filter((t) => t.status === "pending").length >= 100)
      throw new Error("Check the pending transaction first");
    const p = controller.current?.selected?.provider;
    if (!p) throw new Error("The wallet is unavailable");
    const validate = async () => {
      // Recheck the server switch for every wallet request, including after an
      // approval. An open page cannot keep signing after an operator rollback.
      const [current, rpcChainId] = await Promise.all([
        api<RuntimeConfig>("/config"),
        publicClient.getChainId(),
      ]);
      assertSigningEnabled(current);
      if (
        current.chainId !== config.chainId ||
        current.mode !== config.mode ||
        deploymentChain(current) !== deploymentChain(config) ||
        current.treasury !== config.treasury ||
        rpcChainId !== config.chainId
      )
        throw new Error("The platform configuration or RPC network has changed. Refresh and preview again.");
      await validateAction?.();
      await controller.current!.validate(expected, config.chainId, p);
    };
    await validate();
    return createWalletClient({
      account: expected,
      chain: walletChain(config),
      transport: custom({
        request: async (request: Parameters<Provider["request"]>[0]) => {
          await validate();
          return p.request(request);
        },
      } as Provider),
    });
  }
  async function confirmed(
    hash: Hash,
    config: Pick<RuntimeConfig, "chainId" | "deploymentChainId">,
    expected: Address,
    action: Transaction["action"],
    extra: Pick<Transaction, "batchId" | "buybackKind" | "nonce"> = {},
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
    let replaced = false;
    try {
      const client = transactionClient(config.chainId);
      if (await client.getChainId() !== config.chainId)
        throw new Error("The transaction lookup RPC is on the wrong network");
      const receipt = await client.waitForTransactionReceipt({
        hash,
        confirmations: 2,
        timeout: 120000,
        onReplaced: (r) => {
          updateTransaction(hash, config.chainId, {
            status: r.reason === "cancelled" ? "cancelled" : "replaced",
            replacement: r.transaction.hash,
            ...(action === "buyback" ? { registered: false } : {}),
          });
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
            void api<BuybackBatch>(`/buyback/batches/${encodeURIComponent(extra.batchId)}/track`, {
              kind: extra.buybackKind, hash: r.transaction.hash,
            }).then((batch) => {
              applyBuybackRecovery(batch, extra.buybackKind!, r.transaction.hash);
              if (!replaced) updateTransaction(r.transaction.hash, config.chainId, { registered: true });
            }).catch(() => {});
        },
      });
      if (replaced) throw new Error("The transaction was cancelled or replaced. Check your transaction history.");
      updateTransaction(receipt.transactionHash, config.chainId, {
        status: receipt.status === "success" ? "success" : "failed",
      });
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
    if (!account) throw new Error("Connect your wallet first");
    const expected = account;
    const contracts = contractsFor(config);
    if (
      ![contracts.airlock, contracts.initializer, contracts.rehype].some((a) =>
        sameAddress(a, to),
      )
    )
      throw new Error("The transaction target is not allowed");
    const validateLaunch = sameAddress(to, contracts.airlock)
      ? () => api("/launch/validate", { creator: expected, data })
      : undefined;
    const wallet = await signer(config, expected, validateLaunch);
    await publicClient
      .call({ account: expected, to, data })
      .catch((error: unknown) => {
        throw simulationError(error);
      });
    await signer(config, expected);
    const hash = await wallet.sendTransaction({ to, data, value: 0n });
    const confirmation = confirmed(
      hash,
      config,
      expected,
      sameAddress(to, contracts.airlock) ? "launch" : "claim",
    );
    onHash?.(hash);
    return confirmation;
  }
  async function trade(
    quote: Quote,
    config: RuntimeConfig,
    progress: (message: string) => void,
  ) {
    if (!account) throw new Error("Connect your wallet first");
    const expected = account;
    const contracts = contractsFor(config);
    const fresh = () => {
      if (Date.now() >= quote.expiresAt)
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
        await wallet.writeContract(request),
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
        await wallet.writeContract(request),
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
    });
    progress(`Waiting for onchain confirmation · ${hash}`);
    return confirmed(hash, config, expected, "swap");
  }
  async function balance(token: Address) {
    if (!account) throw new Error("No wallet connected");
    return publicClient.readContract({
      address: token,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [account],
    });
  }
  async function buyback(step: BuybackStep, config: RuntimeConfig, onHash?: (hash: Hash) => void) {
    if (!account) throw new Error("Connect the treasury wallet first");
    const expected = account;
    assertBuybackStep(step, config, expected);
    assertTransactionStorage();
    const rows = transactions();
    if (rows.filter((t) => t.status === "pending").length >= 100)
      throw new Error("Check the pending transaction first");
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
      } as Provider),
    });
    const hash = await wallet.sendTransaction({ to: step.to, data: step.data, value: 0n, nonce: step.nonce! });
    const confirmation = confirmed(hash, { chainId: step.chainId }, expected, "buyback", {
      batchId: step.batchId, buybackKind: step.kind, nonce: step.nonce,
    });
    onHash?.(hash);
    const tracked = api<BuybackBatch>(`/buyback/batches/${encodeURIComponent(step.batchId)}/track`, { kind: step.kind, hash })
      .then((batch) => {
        applyBuybackRecovery(batch, step.kind, hash);
        updateTransaction(hash, step.chainId, { registered: true });
      }).catch(() => {});
    const [confirmedHash] = await Promise.all([confirmation, tracked]);
    await api(`/buyback/batches/${encodeURIComponent(step.batchId)}/reconcile`, {}).catch(() => {});
    return confirmedHash;
  }
  async function prepareBuyback(input: BuybackPrepareInput, config: RuntimeConfig): Promise<BuybackBatch> {
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
        trade: (...args) => exclusive(() => trade(...args)),
        buyback: (...args) => exclusive(() => buyback(...args)),
        prepareBuyback: (...args) => exclusive(() => prepareBuyback(...args)),
        balance,
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
