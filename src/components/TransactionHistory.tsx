import { useEffect, useState } from "react";
import { getAddress, type Hash } from "viem";
import { useWallet, transactionClient } from "../lib/wallet";
import {
  transactions,
  transactionMatchesConfig,
  saveTransaction,
  updateTransaction,
  applyBuybackRecovery,
  type Transaction,
} from "../lib/transactions";
import { api } from "../lib/api";
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
export default function TransactionHistory({
  config,
}: {
  config: RuntimeConfig | null;
}) {
  const wallet = useWallet(),
    [rows, setRows] = useState(transactions),
    [hash, setHash] = useState(""),
    [recoveryChain, setRecoveryChain] = useState<number>(config?.chainId || 8453),
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
  async function check(row: Transaction) {
    if (!config || (!transactionMatchesConfig(row, config) && !(config.mode === "base" && row.chainId === 4663))) return;
    const client = transactionClient(row.chainId);
    if (await client.getChainId() !== row.chainId) throw new Error("The transaction lookup RPC is on the wrong network");
    if (row.musegodRecovery) {
      await recoverMusegodTransaction(row, client);
      return;
    }
    if (row.action === "buyback" && row.batchId && row.buybackKind) {
      const trackedHash = (row.status === "cancelled" || row.status === "replaced") && row.replacement ? row.replacement : row.hash;
      const tracked = await api<BuybackBatch>(`/buyback/batches/${encodeURIComponent(row.batchId)}/track`, { kind: row.buybackKind, hash: trackedHash });
      const cancelled = applyBuybackRecovery(tracked, row.buybackKind, trackedHash);
      updateTransaction(row.hash, row.chainId, { registered: true });
      const reconciled = await api<BuybackBatch>(`/buyback/batches/${encodeURIComponent(row.batchId)}/reconcile`, {});
      applyBuybackRecovery(reconciled, row.buybackKind, trackedHash);
      if (cancelled || trackedHash !== row.hash) return;
    }
    const receipt = await client.getTransactionReceipt({
      hash: row.hash,
    });
    const [head, block] = await Promise.all([
      client.getBlockNumber(),
      client.getBlock({ blockNumber: receipt.blockNumber }),
    ]);
    if (block.hash !== receipt.blockHash || head < receipt.blockNumber + 1n) {
      updateTransaction(row.hash, row.chainId, { status: "pending" });
      return;
    }
    updateTransaction(row.hash, row.chainId, {
      status: receipt.status === "success" ? "success" : "failed",
    });
    if (
      row.action === "launch" &&
      receipt.status === "success"
    ) {
      await api("/launch/register", { hash: row.hash });
      updateTransaction(row.hash, row.chainId, { registered: true });
    }
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
            (transactionMatchesConfig(r, config) || (config.mode === "base" && r.chainId === 4663)) &&
            sameAddress(r.account, wallet.account!) &&
            (r.status === "pending" ||
              (r.action === "buyback" && !!r.replacement && !r.registered) ||
              ((r.action === "launch" || r.action === "buyback") &&
                r.status === "success" &&
                !r.registered)),
        )) {
          if (!active) break;
          if (row.action === "launch" && row.planId)
            await api("/launch/track", {
              hash: row.hash,
              planId: row.planId,
            }).catch(() => {});
          await check(row).catch(() => {});
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
    if (config) setRecoveryChain(config.chainId);
  }, [config?.chainId]);
  if (!wallet.account || !config) return null;
  const visible = rows
    .filter(
      (r) =>
        (transactionMatchesConfig(r, config) || (config.mode === "base" && r.chainId === 4663)) && sameAddress(r.account, wallet.account!),
    )
    .reverse();
  async function recoverHash() {
    setBusy(true);
    setError("");
    try {
      const value = hashSchema.parse(hash.trim()) as Hash;
      const chainId = config!.mode === "base" ? recoveryChain : config!.chainId;
      const client = transactionClient(chainId);
      if (await client.getChainId() !== chainId) throw new Error("The transaction lookup RPC is on the wrong network");
      const tx = await client.getTransaction({ hash: value });
      if (!sameAddress(tx.from, wallet.account!))
        throw new Error("This transaction does not belong to the connected wallet.");
      const musegodRecord = transactions().find((row) => row.chainId === chainId &&
        row.hash.toLowerCase() === value.toLowerCase() && sameAddress(row.account, tx.from) && row.musegodRecovery);
      if (musegodRecord) {
        // Manual lookup of a saved MUSEGOD hash must retain its fingerprint,
        // nonce and scan progress instead of replacing it with a generic row.
        await check(musegodRecord);
        setHash("");
        return;
      }
      const row: Transaction = {
        hash: value,
        chainId,
        ...(config!.mode === "fork" ? { deploymentChainId: deploymentChain(config!) } : {}),
        account: getAddress(tx.from),
        action:
          chainId === config!.chainId && tx.to && sameAddress(tx.to, contractsFor(config!).airlock)
            ? "launch"
            : "recovered",
        status: "pending",
        at: Date.now(),
      };
      saveTransaction(row);
      await check(row);
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
      {config.mode === "base" && <label>
        Lookup network
        <select value={recoveryChain} onChange={(e) => setRecoveryChain(Number(e.target.value))}>
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
          <li key={`${row.chainId}:${row.hash}`}>
            <span>
              {row.action === "buyback" ? ({ approval: "Buyback approval", deposit: "Cross-chain buyback", burn: "MUSEGOD burn" }[row.buybackKind!]) : actions[row.action]} · {labels[row.status]} · {row.chainId === config.chainId ? networkName(config) : row.chainId === 4663 ? "Robinhood Chain" : "Base"} ·{" "}
            </span>
            {config.mode !== "fork" ? (
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
                  await check(row);
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
