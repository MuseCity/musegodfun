import { keccak256, TransactionReceiptNotFoundError, type PublicClient } from "viem";
import { sameAddress } from "./config";
import { saveTransaction, transactions, validMusegodRecovery, type Transaction } from "./transactions";

type ChainTransaction = Awaited<ReturnType<PublicClient["getTransaction"]>>;
type Receipt = Awaited<ReturnType<PublicClient["getTransactionReceipt"]>>;
const SCAN_LIMIT = 16n;

export async function recoverMusegodTransaction(
  row: Transaction,
  client: PublicClient,
  persist: (next: Transaction) => void = (next) => {
    const current = transactions().find((item) => item.hash === next.hash && item.chainId === next.chainId);
    // Live confirmation may settle the same row while this read-only scan runs.
    if (current && next.hash === row.hash && next.status === "pending" && current.status !== row.status) return;
    saveTransaction({ ...current, ...next });
  },
): Promise<void> {
  if (!validMusegodRecovery(row)) return;
  if (await client.getChainId() !== row.chainId) throw new Error("The MUSEGOD recovery RPC is on the wrong network.");
  if ((row.status === "replaced" || row.status === "cancelled") && row.replacement) return;
  const metadata = row.musegodRecovery!;
  let original = row;
  const readReceipt = async (hash: Transaction["hash"]) => {
    try { return await client.getTransactionReceipt({ hash }); }
    catch (error) {
      if (error instanceof TransactionReceiptNotFoundError) return null;
      throw error;
    }
  };
  const canonical = async (receipt: Receipt) => {
    const [head, block] = await Promise.all([
      client.getBlockNumber(), client.getBlock({ blockNumber: receipt.blockNumber }),
    ]);
    return head >= receipt.blockNumber + 1n && block.number === receipt.blockNumber && block.hash === receipt.blockHash;
  };
  const oldReceipt = await readReceipt(row.hash);
  if (oldReceipt) {
    if (oldReceipt.transactionHash !== row.hash || !await canonical(oldReceipt)) {
      persist({ ...row, status: "pending", musegodRecovery: { ...metadata, checkedBlock: undefined } });
      return;
    }
    persist({ ...row, status: oldReceipt.status === "success" ? "success" : "failed", replacement: undefined });
    return;
  }
  if (!Number.isSafeInteger(original.nonce) || original.nonce! < 0) {
    let transaction: ChainTransaction;
    try { transaction = await client.getTransaction({ hash: row.hash }); }
    catch { return; }
    if (!sameAddress(transaction.from, row.account) || transaction.hash !== row.hash ||
      !Number.isSafeInteger(transaction.nonce) || transaction.nonce < 0 || !sameFingerprint(transaction)) return;
    original = { ...row, nonce: transaction.nonce };
    persist(original);
  }
  const minedNonce = await client.getTransactionCount({ address: row.account, blockTag: "latest" });
  if (!Number.isSafeInteger(minedNonce) || minedNonce <= original.nonce!) return;
  const head = await client.getBlockNumber();
  if (head < 1n) return;
  const confirmedHead = head - 1n;
  const from = BigInt(metadata.fromBlock);
  const start = metadata.checkedBlock === undefined ? from : BigInt(metadata.checkedBlock) + 1n;
  if (start > confirmedHead) {
    // A completed unsuccessful pass starts again next time. This also prevents
    // a persisted cursor from permanently skipping a replacement after a reorg.
    if (metadata.checkedBlock !== undefined)
      persist({ ...original, status: "pending", musegodRecovery: { ...metadata, checkedBlock: undefined } });
    return;
  }
  const end = start + SCAN_LIMIT - 1n < confirmedHead ? start + SCAN_LIMIT - 1n : confirmedHead;
  let previousHash: `0x${string}` | null = null;
  for (let first = start; first <= end; first += 4n) {
    const numbers = Array.from({ length: Number(end - first + 1n < 4n ? end - first + 1n : 4n) }, (_, index) => first + BigInt(index));
    const blocks = await Promise.all(numbers.map((blockNumber) => client.getBlock({ blockNumber, includeTransactions: true })));
    for (let index = 0; index < blocks.length; index++) {
      const block = blocks[index];
      if (block.number !== numbers[index] || !block.hash || (previousHash && block.parentHash !== previousHash)) return;
      previousHash = block.hash;
      const replacement = block.transactions.find((transaction) => typeof transaction !== "string" &&
        sameAddress(transaction.from, row.account) && transaction.nonce === original.nonce);
      if (replacement && typeof replacement !== "string") {
        const receipt = await readReceipt(replacement.hash);
        if (replacement.blockNumber !== block.number || replacement.blockHash !== block.hash ||
          !receipt || receipt.transactionHash !== replacement.hash || receipt.blockNumber !== block.number ||
          receipt.blockHash !== block.hash || !await canonical(receipt)) return;
        if (replacement.hash === row.hash) {
          persist({ ...original, status: receipt.status === "success" ? "success" : "failed", replacement: undefined });
          return;
        }
        const repriced = sameFingerprint(replacement);
        const ordinarySelfTransfer = sameAddress(replacement.from, row.account) && replacement.to &&
          sameAddress(replacement.to, row.account) && replacement.value === 0n && replacement.input === "0x" &&
          ["legacy", "eip2930", "eip1559"].includes(replacement.type) && !replacement.authorizationList?.length;
        const emptyCode = ordinarySelfTransfer
          ? await client.getCode({ address: row.account, blockNumber: block.number }) : undefined;
        // An already delegated account can execute code even for an empty self
        // transaction, so classify cancellation only with explicit EOA evidence.
        // viem getCode maps a successful eth_getCode "0x" result to undefined.
        const cancelled = ordinarySelfTransfer && (emptyCode === undefined || emptyCode === "0x");
        if (!await canonical(receipt)) return;
        const next: Transaction = {
          hash: replacement.hash, chainId: row.chainId, deploymentChainId: row.deploymentChainId,
          account: row.account, action: repriced ? row.action : "recovered",
          status: receipt.status === "success" ? "success" : "failed", at: Date.now(), nonce: replacement.nonce, replacement: undefined,
          ...(repriced ? { musegodRecovery: { ...metadata, checkedBlock: block.number.toString() } } : {}),
        };
        // Record the proven receipt before linking the superseded hash.
        persist(next);
        persist({ ...original, status: cancelled ? "cancelled" : "replaced", replacement: replacement.hash,
          musegodRecovery: { ...metadata, checkedBlock: block.number.toString() } });
        return;
      }
    }
    const last = blocks.at(-1)!;
    if ((await client.getBlock({ blockNumber: last.number! })).hash !== last.hash) return;
    persist({ ...original, status: "pending", musegodRecovery: { ...metadata, checkedBlock: last.number!.toString() } });
  }

  function sameFingerprint(transaction: ChainTransaction) {
    return transaction.to !== null && sameAddress(transaction.to, metadata.to) &&
      /^0x(?:[0-9a-f]{2})*$/i.test(transaction.input) && keccak256(transaction.input).toLowerCase() === metadata.dataHash.toLowerCase() &&
      transaction.value.toString() === metadata.value && !transaction.authorizationList?.length;
  }
}
