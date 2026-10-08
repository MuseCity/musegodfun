import { useEffect, useState } from "react";
import { decodeEventLog, encodeFunctionData, erc20Abi, getAddress, isAddress, type Hash } from "viem";
import { bundlerAbi } from "@whetstone-research/doppler-sdk/evm";
import { useWallet, transactionClient } from "../lib/wallet";
import {
  transactions,
  transactionMatchesConfig,
  saveTransaction,
  updateTransaction,
  applyBuybackRecovery,
  type Transaction,
} from "../lib/transactions";
import { chainApi } from "../lib/api";
import type { BuybackBatch } from "../lib/buyback";
import {
  contractsFor,
  deploymentChain,
  explorerFor,
  networkName,
  sameAddress,
  shortAddress,
  type RuntimeConfig,
} from "../lib/config";
import { errorMessage, hashSchema } from "../lib/validation";
import { recoverMusegodTransaction } from "../lib/musegod-recovery";
import type { FirstBuyPaymentVerification } from "../lib/first-buy-payment";
import type { FirstBuyLockStatus } from "../lib/launch-plan";
import type { LaunchPlan } from "../lib/launch-plan";
import { launchIntentStorageKey } from "../lib/launch-intent";
import { bestEffort, recoveryDue, recoveryKey, settleRecovery } from "../lib/recovery-backoff";
const labels = {
  pending: "Pending",
  success: "Confirmed",
  failed: "Failed",
  cancelled: "Cancelled",
  replaced: "Replaced",
};
const actions = {
  launch: "Launch",
  approval: "Approval",
  swap: "Trade",
  claim: "Claim",
  recovered: "Manual recovery",
  buyback: "Buyback and burn",
  engine: "Public buyback engine",
};

function rowNetwork(row: Pick<Transaction, "chainId" | "deploymentChainId">): Pick<RuntimeConfig, "chainId" | "mode"> & { deploymentChainId: 8453 | 4663 } {
  const target = row.chainId === 31337 ? row.deploymentChainId ?? 8453 : row.chainId;
  if (target !== 8453 && target !== 4663) throw new Error("Unsupported transaction network");
  return { chainId: row.chainId, deploymentChainId: target, mode: row.chainId === 31337 ? "fork" as const
    : target === 4663 ? "robinhood" as const : "base" as const };
}

export async function checkHistoryTransaction(row: Transaction, deps: {
  client?: ReturnType<typeof transactionClient>;
  read?: typeof chainApi;
  update?: (patch: Partial<Transaction>) => void;
} = {}) {
  const network = rowNetwork(row);
  const client = deps.client ?? transactionClient(row.chainId, network);
  const read = deps.read ?? chainApi;
  let observedStatus = row.status, observedReplacement = row.replacement, observedRegistered = !!row.registered;
  const update = deps.update ?? ((patch) => {
    const current = transactions().find((entry) => entry.hash === row.hash && transactionMatchesConfig(entry, network));
    // A wallet confirmation or replacement callback may settle this row while
    // the older RPC lookup is waiting. Its result cannot overwrite newer proof.
    if (!current || current.status !== observedStatus || current.replacement !== observedReplacement ||
      !!current.registered !== observedRegistered) return;
    updateTransaction(row.hash, row.chainId, patch, network.deploymentChainId);
    observedStatus = patch.status ?? current.status;
    observedReplacement = patch.replacement ?? current.replacement;
    observedRegistered = patch.registered ?? !!current.registered;
  });
  if (await client.getChainId() !== row.chainId) throw new Error("The transaction lookup RPC is on the wrong network");
  if (row.musegodRecovery) {
    await recoverMusegodTransaction(row, client, (next) => {
      const current = transactions().find((entry) => entry.hash === next.hash &&
        transactionMatchesConfig(entry, network));
      if (current && next.hash === row.hash && next.status === "pending" && current.status !== row.status) return;
      saveTransaction({ ...current, ...next });
    });
    return;
  }
  if (row.action === "buyback" && row.batchId && row.buybackKind) {
    const trackedHash = (row.status === "cancelled" || row.status === "replaced") && row.replacement ? row.replacement : row.hash;
    const tracked = await read<BuybackBatch>(8453, `/buyback/batches/${encodeURIComponent(row.batchId)}/track`, { kind: row.buybackKind, hash: trackedHash });
    const cancelled = applyBuybackRecovery(tracked, row.buybackKind, trackedHash);
    update({ registered: true });
    const reconciled = await read<BuybackBatch>(8453, `/buyback/batches/${encodeURIComponent(row.batchId)}/reconcile`, {});
    applyBuybackRecovery(reconciled, row.buybackKind, trackedHash);
    if (cancelled || trackedHash !== row.hash) return;
  }
  const replacing = !!(row.firstBuyClaim || row.firstBuyPayment) &&
    (row.status === "cancelled" || row.status === "replaced") && !!row.replacement;
  const effectiveHash = replacing ? row.replacement! : row.hash;
  const receipt = await client.getTransactionReceipt({ hash: effectiveHash });
  const [head, block] = await Promise.all([
    client.getBlockNumber(), client.getBlock({ blockNumber: receipt.blockNumber }),
  ]);
  if (block.hash !== receipt.blockHash || head < receipt.blockNumber + 1n) {
    update(row.firstBuyClaim || row.firstBuyPayment
      ? { status: replacing ? row.status : "pending", registered: false } : { status: "pending" });
    return;
  }
  let submitted: Awaited<ReturnType<typeof client.getTransaction>> | undefined;
  if (replacing) {
    submitted = await client.getTransaction({ hash: effectiveHash });
    let nonce = row.nonce;
    if (!Number.isSafeInteger(nonce) || nonce! < 0) {
      const original = await client.getTransaction({ hash: row.hash });
      if (!sameAddress(original.from, row.account) || original.hash.toLowerCase() !== row.hash.toLowerCase())
        throw new Error("The original transaction nonce could not be verified.");
      nonce = original.nonce;
    }
    if (!sameAddress(submitted.from, row.account) || submitted.nonce !== nonce ||
      submitted.chainId !== row.chainId ||
      submitted.hash.toLowerCase() !== effectiveHash.toLowerCase() || receipt.transactionHash.toLowerCase() !== effectiveHash.toLowerCase() ||
      submitted.blockHash !== receipt.blockHash || submitted.blockNumber !== receipt.blockNumber)
      throw new Error("The replacement transaction does not prove the original nonce was settled.");
    const expected = row.firstBuyClaim ? { to: row.firstBuyClaim.bundler, data: row.firstBuyClaim.data, value: "0" }
      : row.firstBuyPayment!.transaction;
    const sameCall = submitted.to && sameAddress(submitted.to, expected.to) &&
      submitted.input.toLowerCase() === expected.data.toLowerCase() && submitted.value === BigInt(expected.value);
    if (!sameCall) {
      if (row.status === "cancelled") {
        if (!submitted.to || !sameAddress(submitted.to, row.account) || submitted.input !== "0x" || submitted.value !== 0n)
          throw new Error("The cancellation transaction is not an empty self-transfer.");
        const code = await client.getCode({ address: row.account, blockNumber: receipt.blockNumber });
        if (code && code !== "0x") throw new Error("The account code prevents classifying this transaction as a cancellation.");
      }
      update({ registered: true, nonce });
      return;
    }
  }
  const completed = (patch: Partial<Transaction>) => update(replacing ? { ...patch, status: row.status } : patch);
  if (row.firstBuyPayment) {
    const payment = await read<FirstBuyPaymentVerification>(network.deploymentChainId, "/first-buy/verify", {
      quote: row.firstBuyPayment, hash: effectiveHash,
    });
    if (payment.hash.toLowerCase() !== effectiveHash.toLowerCase()) throw new Error("The payment receipt identity changed.");
    if (payment.status !== "pending" && (payment.blockHash !== receipt.blockHash ||
      payment.blockNumber !== receipt.blockNumber.toString() ||
      (payment.status === "success") !== (receipt.status === "success")))
      throw new Error("The payment receipt changed while it was being checked. Check again.");
    completed({ status: payment.status === "success" ? "success" : payment.status === "reverted" ? "failed" : "pending",
      registered: payment.status !== "pending" });
    return;
  }
  if (row.firstBuyClaim) {
    const claim = row.firstBuyClaim;
    if (!isAddress(claim.token, { strict: false }) || !isAddress(claim.bundler, { strict: false }))
      throw new Error("The saved lock claim identity is invalid.");
    const canonical = encodeFunctionData({ abi: bundlerAbi, functionName: "claim", args: [claim.token] });
    submitted ??= await client.getTransaction({ hash: effectiveHash });
    if (!sameAddress(submitted.from, row.account) || !submitted.to || !sameAddress(submitted.to, claim.bundler) ||
      submitted.input.toLowerCase() !== canonical.toLowerCase() || claim.data.toLowerCase() !== canonical.toLowerCase() ||
      submitted.value !== 0n || submitted.chainId !== row.chainId ||
      submitted.hash.toLowerCase() !== effectiveHash.toLowerCase() || receipt.transactionHash.toLowerCase() !== effectiveHash.toLowerCase() ||
      submitted.blockHash !== receipt.blockHash || submitted.blockNumber !== receipt.blockNumber)
      throw new Error("The lock claim transaction does not match its saved recipient and calldata.");
    if (receipt.status === "reverted") {
      completed({ status: "failed", registered: true });
      return;
    }
    const state = await read<FirstBuyLockStatus | null>(network.deploymentChainId, `/first-buy-lock/${claim.token}`);
    if (!state || !sameAddress(state.recipient, row.account) || !sameAddress(state.bundler, claim.bundler))
      throw new Error("The lock claim no longer matches its verified position.");
    let received = 0n, net = 0n;
    for (const log of receipt.logs) {
      if (!sameAddress(log.address, claim.token)) continue;
      try {
        const event = decodeEventLog({ abi: erc20Abi, data: log.data, topics: log.topics });
        if (event.eventName !== "Transfer") continue;
        if (sameAddress(event.args.to, row.account)) {
          net += event.args.value;
          if (sameAddress(event.args.from, claim.bundler)) received += event.args.value;
        }
        if (sameAddress(event.args.from, row.account)) net -= event.args.value;
      } catch { /* Other token events are not claim evidence. */ }
    }
    if (received <= 0n || net !== received || BigInt(state.claimedAmount) < received)
      throw new Error("The lock claim has no matching net token receipt from its Bundler.");
    completed({ status: "success", registered: true });
    return;
  }
  update({ status: receipt.status === "success" ? "success" : "failed" });
  if (row.action === "launch" && receipt.status === "success") {
    let recoveryPlan: LaunchPlan | undefined;
    try {
      if (row.intentId) recoveryPlan = JSON.parse(localStorage.getItem(launchIntentStorageKey(network, row.account, row.intentId, "plan")) || "null") ?? undefined;
    } catch { /* The server can still recover its retained plan. */ }
    await read(network.deploymentChainId, "/launch/register", { hash: row.hash, ...(recoveryPlan ? { recoveryPlan } : {}) });
    update({ registered: true });
  }
}
export default function TransactionHistory({
  config,
}: {
  config: RuntimeConfig | null;
}) {
  const wallet = useWallet(),
    [rows, setRows] = useState(transactions),
    [hash, setHash] = useState(""),
    [recoveryChain, setRecoveryChain] = useState<8453 | 4663>(config ? deploymentChain(config) : 4663),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    const sync = () => setRows(transactions());
    window.addEventListener("musegod:transactions", sync);
    window.addEventListener("storage", sync);
    return () => {
      window.removeEventListener("musegod:transactions", sync);
      window.removeEventListener("storage", sync);
    };
  }, []);
  function relevant(row: Transaction) {
    return config?.mode === "fork" ? transactionMatchesConfig(row, config) : row.chainId === 8453 || row.chainId === 4663;
  }
  async function check(row: Transaction) {
    if (!config || !wallet.account || !relevant(row) || !sameAddress(row.account, wallet.account)) return;
    await checkHistoryTransaction(row);
  }
  useEffect(() => {
    if (!config || !wallet.account) return;
    let active = true,
      running = false;
    const recover = async () => {
      if (running) return;
      running = true;
      try {
        for (const row of transactions().filter(
          (r) =>
            relevant(r) &&
            sameAddress(r.account, wallet.account!) &&
            (r.status === "pending" ||
              ((r.action === "buyback" || r.firstBuyClaim || r.firstBuyPayment) && !!r.replacement && !r.registered) ||
              ((r.action === "launch" || r.action === "buyback") &&
                r.status === "success" &&
                !r.registered) || ((r.firstBuyClaim || r.firstBuyPayment) && r.status === "success" && !r.registered)),
        )) {
          if (!active) break;
          const key = recoveryKey(row.chainId, row.hash);
          if (!recoveryDue(key)) continue;
          await settleRecovery(key, async () => {
            if (row.action === "launch" && row.planId)
              await bestEffort(() => chainApi(rowNetwork(row).deploymentChainId, "/launch/track", {
                hash: row.hash,
                planId: row.planId,
              }));
            await check(row);
          }).catch(() => {});
        }
      } finally {
        running = false;
      }
    };
    void recover();
    const timer = setInterval(() => void recover(), 15000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [config?.chainId, config?.mode, config?.deploymentChainId, wallet.account]);
  useEffect(() => {
    if (config) setRecoveryChain(deploymentChain(config));
  }, [config?.chainId, config?.deploymentChainId]);
  if (!wallet.account || !config) return null;
  const visible = rows
    .filter(
      (r) =>
        relevant(r) && sameAddress(r.account, wallet.account!),
    )
    .reverse();
  async function recoverHash() {
    setBusy(true);
    setError("");
    try {
      const value = hashSchema.parse(hash.trim()) as Hash;
      const lookupConfig = config!.mode === "fork" ? config!
        : await chainApi<RuntimeConfig>(recoveryChain, "/config");
      const chainId = lookupConfig.chainId;
      const client = transactionClient(chainId, lookupConfig);
      if (await client.getChainId() !== chainId) throw new Error("The transaction lookup RPC is on the wrong network");
      const tx = await client.getTransaction({ hash: value });
      if (!sameAddress(tx.from, wallet.account!))
        throw new Error("This transaction does not belong to the connected wallet.");
      const existing = transactions().find((row) => transactionMatchesConfig(row, lookupConfig) &&
        row.hash.toLowerCase() === value.toLowerCase() && sameAddress(row.account, tx.from));
      if (existing) {
        // Preserve the frozen payment, launch plan and replacement fingerprint.
        // A manual check ignores the background backoff and settles it.
        await settleRecovery(recoveryKey(existing.chainId, existing.hash), () => check(existing), true);
        setHash("");
        return;
      }
      const row: Transaction = {
        hash: value,
        chainId,
        ...(lookupConfig.mode === "fork" ? { deploymentChainId: deploymentChain(lookupConfig) } : {}),
        account: getAddress(tx.from),
        action:
          tx.to && (sameAddress(tx.to, contractsFor(lookupConfig).airlock) ||
            (lookupConfig.launchGuard && sameAddress(tx.to, lookupConfig.launchGuard)))
            ? "launch"
            : "recovered",
        status: "pending",
        at: Date.now(),
      };
      saveTransaction(row);
      await settleRecovery(recoveryKey(row.chainId, row.hash), () => check(row), true);
      setHash("");
    } catch (e) {
      setError(`The lookup is incomplete. Saved pending statuses are retained. ${errorMessage(e)}`);
    } finally {
      setBusy(false);
    }
  }
  return (
    <details className="transaction-history">
      <summary>
        Wallet transaction history · {visible.filter((r) => r.status === "pending").length}{" "}
        pending
      </summary>
      <p>Records are stored in this browser. A timeout remains pending. Enter a transaction hash to resume checking.</p>
      {config.mode !== "fork" && <label>
        Lookup network
        <select value={recoveryChain} onChange={(e) => setRecoveryChain(Number(e.target.value) as 8453 | 4663)}>
          <option value={8453}>Base</option>
          <option value={4663}>Robinhood Chain</option>
        </select>
      </label>}
      <label>
        Transaction hash
        <input
          value={hash}
          onChange={(e) => setHash(e.target.value)}
          placeholder="0x…"
        />
      </label>
      <button disabled={busy || !hash} onClick={() => void recoverHash()}>
        Resume lookup
      </button>
      {error && <p role="alert">{error}</p>}
      <ul>
        {visible.map((row) => (
          <li key={`${row.chainId}:${row.deploymentChainId ?? ""}:${row.hash}`}>
            <span>
              {row.firstBuyClaim ? "First buy lock claim" : row.firstBuyPayment ? "First buy payment conversion" : row.action === "buyback" ? ({ approval: "Buyback approval", deposit: "Cross-chain buyback", burn: "MUSEGOD burn" }[row.buybackKind!]) : actions[row.action]} · {(row.firstBuyClaim || row.firstBuyPayment) && !row.registered && row.status === "cancelled" ? "Cancellation pending verification" : (row.firstBuyClaim || row.firstBuyPayment) && !row.registered && row.status === "replaced" ? "Replacement pending verification" : labels[row.status]} · {networkName(rowNetwork(row))} ·{" "}
            </span>
            {row.chainId !== 31337 ? (
              <a
                href={`${explorerFor({ mode: row.chainId === 4663 ? "robinhood" : "base" })}/tx/${row.hash}`}
                target="_blank"
                rel="noreferrer"
              >
                {shortAddress(row.hash)}
              </a>
            ) : (
              <code>{shortAddress(row.hash)}</code>
            )}{" "}
            <button
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                setError("");
                try {
                  await settleRecovery(recoveryKey(row.chainId, row.hash), () => check(row), true);
                } catch (e) {
                  setError(errorMessage(e));
                } finally {
                  setBusy(false);
                }
              }}
            >
              Check again
            </button>
            {row.replacement && <small>Replaced by {row.replacement}</small>}
          </li>
        ))}
      </ul>
    </details>
  );
}
