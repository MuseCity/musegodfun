import { encodeFunctionData, isAddress, type Address, type Hash } from "viem";
import type { BuybackBatch, BuybackStepKind } from "./buyback";
import { deploymentChain, ROBINHOOD_BUNDLER, sameAddress, type RuntimeConfig } from "./config";
import { MUSEGOD } from "./musegod";
import { assertFirstBuyPaymentQuote, type FirstBuyPaymentQuote } from "./first-buy-payment";
import { bundlerAbi } from "./first-buy-lock";
export type Transaction = {
  hash: Hash;
  chainId: number;
  deploymentChainId?: 8453 | 4663;
  account: Address;
  action: "launch" | "approval" | "swap" | "claim" | "recovered" | "buyback" | "engine";
  status: "pending" | "success" | "failed" | "cancelled" | "replaced";
  at: number;
  replacement?: Hash;
  planId?: Hash;
  registered?: boolean;
  batchId?: string;
  buybackKind?: "approval" | "deposit" | "burn";
  nonce?: number;
  musegodRecovery?: {
    to: Address;
    dataHash: Hash;
    value: string;
    fromBlock: string;
    checkedBlock?: string;
  };
  firstBuyPayment?: FirstBuyPaymentQuote;
  firstBuyClaim?: { token: Address; bundler: Address; data: `0x${string}` };
};
export function validMusegodRecovery(row: Pick<Transaction, "action" | "chainId" | "deploymentChainId" | "musegodRecovery">) {
  const metadata = row.musegodRecovery;
  if (!metadata || (row.chainId !== 4663 && !(row.chainId === 31337 && row.deploymentChainId === 4663)) ||
    !["approval", "swap"].includes(row.action) ||
    typeof metadata.to !== "string" || metadata.to.toLowerCase() !==
      (row.action === "approval" ? MUSEGOD.token : MUSEGOD.router).toLowerCase() ||
    typeof metadata.dataHash !== "string" || !/^0x[0-9a-f]{64}$/i.test(metadata.dataHash) ||
    typeof metadata.value !== "string" || !/^(?:0|[1-9]\d{0,77})$/.test(metadata.value) ||
    typeof metadata.fromBlock !== "string" || !/^\d{1,20}$/.test(metadata.fromBlock) ||
    (metadata.checkedBlock !== undefined && (typeof metadata.checkedBlock !== "string" || !/^\d{1,20}$/.test(metadata.checkedBlock) ||
      BigInt(metadata.checkedBlock) < BigInt(metadata.fromBlock)))) return false;
  return BigInt(metadata.value) < 2n ** 256n;
}
const key = "musegod.transactions.v1";
export function transactions(): Transaction[] {
  try {
    const data: unknown = JSON.parse(localStorage.getItem(key) || "[]");
    return Array.isArray(data)
      ? data
          .filter(
            (x): x is Transaction =>
              !!x &&
              /^0x[0-9a-f]{64}$/i.test(x.hash) &&
              [8453, 31337, 4663].includes(x.chainId) &&
              (x.deploymentChainId === undefined ||
                ([8453, 4663].includes(x.deploymentChainId) &&
                  (x.chainId === 31337 || x.deploymentChainId === x.chainId))) &&
              /^0x[0-9a-f]{40}$/i.test(x.account) &&
              [
                "pending",
                "success",
                "failed",
                "cancelled",
                "replaced",
              ].includes(x.status) &&
              ["launch", "approval", "swap", "claim", "recovered", "buyback", "engine"].includes(
                x.action,
              ) &&
              (x.action !== "buyback" || (
                typeof x.batchId === "string" &&
                /^[a-zA-Z0-9-]{1,80}$/.test(x.batchId) &&
                ["approval", "deposit", "burn"].includes(x.buybackKind) &&
                x.chainId === (x.buybackKind === "burn" ? 4663 : 8453)
              )) &&
              Number.isFinite(x.at),
          )
          .map((row) => {
            row = { ...row };
            if (row.firstBuyPayment !== undefined) {
              try {
                assertFirstBuyPaymentQuote(row.firstBuyPayment, Date.now(), true);
                const chain = row.chainId === 31337 ? row.deploymentChainId ?? 8453 : row.chainId;
                if (row.action !== "swap" || row.firstBuyPayment.chainId !== chain || !sameAddress(row.firstBuyPayment.account, row.account))
                  throw new Error("Invalid payment transaction context");
              } catch { delete row.firstBuyPayment; }
            }
            if (row.firstBuyClaim !== undefined) {
              const claim = row.firstBuyClaim;
              if (row.action !== "claim" || !claim || typeof claim.token !== "string" || !isAddress(claim.token, { strict: false }) ||
                typeof claim.bundler !== "string" || !sameAddress(claim.bundler, ROBINHOOD_BUNDLER) ||
                claim.data !== encodeFunctionData({ abi: bundlerAbi, functionName: "claim", args: [claim.token] }))
                delete row.firstBuyClaim;
            }
            if (row.musegodRecovery === undefined) return row;
            if (!validMusegodRecovery(row)) {
              const { musegodRecovery: _ignored, ...legacy } = row;
              return legacy;
            }
            // Preserve old transaction rows; malformed recovery fields cannot
            // authorize scans or turn a guessed nonce into an identity proof.
            return Number.isSafeInteger(row.nonce) && row.nonce! >= 0 ? row : { ...row, nonce: undefined };
          })
          .slice(-200)
      : [];
  } catch {
    return [];
  }
}
export function transactionMatchesConfig(
  transaction: Pick<Transaction, "chainId" | "deploymentChainId">,
  config: Pick<RuntimeConfig, "chainId" | "mode" | "deploymentChainId">,
) {
  return transaction.chainId === config.chainId &&
    (config.mode !== "fork" || (transaction.deploymentChainId ?? 8453) === deploymentChain(config));
}
export function isUnresolvedFirstBuyClaim(row: Transaction, token: Address, account: Address,
  config: Pick<RuntimeConfig, "chainId" | "mode" | "deploymentChainId">) {
  return !!row.firstBuyClaim && sameAddress(row.firstBuyClaim.token, token) && sameAddress(row.account, account) &&
    transactionMatchesConfig(row, config) &&
    (row.status === "pending" || (!row.registered && (row.status === "cancelled" || row.status === "replaced")));
}
export function assertTransactionStorage() {
  localStorage.setItem(key, JSON.stringify(transactions()));
}
export function saveTransaction(tx: Transaction) {
  const rows = transactions().filter(
    (t) => !(t.hash === tx.hash && t.chainId === tx.chainId &&
      (t.chainId !== 31337 || (t.deploymentChainId ?? 8453) === (tx.deploymentChainId ?? 8453))),
  );
  // Preserve every unresolved transaction; refuse further submissions if the queue is full.
  rows.push(tx);
  const pending = rows.filter((t) => t.status === "pending"),
    settled = rows
      .filter((t) => t.status !== "pending")
      .slice(-(200 - pending.length));
  localStorage.setItem(
    key,
    JSON.stringify([...settled, ...pending].sort((a, b) => a.at - b.at)),
  );
  window.dispatchEvent(new Event("musegod:transactions"));
}
export function updateTransaction(
  hash: Hash,
  chainId: number,
  patch: Partial<Transaction>,
  deploymentChainId?: 8453 | 4663,
) {
  const tx = transactions().find(
    (t) => t.hash === hash && t.chainId === chainId &&
      (chainId !== 31337 || (t.deploymentChainId ?? 8453) === (deploymentChainId ?? 8453)),
  );
  if (tx) saveTransaction({ ...tx, ...patch });
}
export function applyBuybackRecovery(batch: BuybackBatch, kind: BuybackStepKind, submittedHash: Hash) {
  const proof = batch.cancellations?.find((p) => p.kind === kind && p.verifiedCanonical === true &&
    p.hash.toLowerCase() === submittedHash.toLowerCase() && Number.isSafeInteger(p.nonce) && p.nonce >= 0);
  if (!proof) return false;
  const chainId = kind === "burn" ? 4663 : 8453;
  for (const row of transactions().filter((t) => t.action === "buyback" && t.batchId === batch.id &&
    t.buybackKind === kind && t.chainId === chainId && t.nonce === proof.nonce &&
    t.account.toLowerCase() === batch.quote.treasury.toLowerCase())) {
    updateTransaction(row.hash, chainId, {
      status: proof.status === "reverted" ? "failed" : "cancelled",
      replacement: row.hash.toLowerCase() === proof.hash.toLowerCase() ? undefined : proof.hash,
      registered: true,
    });
  }
  return true;
}
