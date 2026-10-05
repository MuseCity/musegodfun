import { decodeFunctionData, encodeFunctionData, erc20Abi, toHex, type Address, type Hash } from "viem";
import { CURVE_POLICY } from "./launch-curve";
import { contractsFor, deploymentChain, sameAddress, assetsFor, type RuntimeConfig } from "./config";
import { assertOpeningValuation } from "./opening-valuation";
import { assertSigningEnabled } from "./validation";
import type { LaunchPlan, LaunchTransaction } from "./launch-plan";
import { launchGuardAbi } from "./launch-guard";
import { transactionMatchesConfig, type Transaction } from "./transactions";

export type LaunchSimulation = { valid: true; gas: string; amountOut: string | null; simulatedAt: number };
export type LaunchWalletStep = LaunchTransaction & { from: Address; chainId: number };
export type PendingLaunchResolution = {
  hash: Hash;
  terminal: "failed" | "cancelled" | null;
  proofHash?: Hash;
  account?: Address;
  nonce?: number;
};

export function pendingLaunchResolution(hash: Hash, rows: Transaction[], config: RuntimeConfig): PendingLaunchResolution {
  let current = hash;
  const seen = new Set<string>();
  while (!seen.has(current.toLowerCase())) {
    seen.add(current.toLowerCase());
    const row = rows.find((entry) => entry.hash.toLowerCase() === current.toLowerCase() &&
      entry.action === "launch" && transactionMatchesConfig(entry, config));
    if (!row) return { hash: current, terminal: null };
    if (row.status === "failed" || row.status === "cancelled")
      return { hash: current, terminal: row.status, proofHash: row.status === "cancelled" ? row.replacement : current,
        account: row.account, nonce: row.nonce };
    if (row.status !== "replaced" || !row.replacement) return { hash: current, terminal: null };
    current = row.replacement;
  }
  return { hash, terminal: null };
}

export async function terminalLaunchIsCanonical(result: PendingLaunchResolution, deps: {
  receipt: (hash: Hash) => Promise<{ status: "success" | "reverted"; from: Address; blockNumber: bigint; blockHash: Hash }>;
  transaction: (hash: Hash) => Promise<{ from: Address; nonce: number }>;
  head: () => Promise<bigint>;
  block: (blockNumber: bigint) => Promise<{ hash: Hash | null }>;
}) {
  if (!result.terminal || !result.proofHash || !result.account ||
    (result.terminal === "cancelled" && !Number.isSafeInteger(result.nonce))) return false;
  try {
    const receipt = await deps.receipt(result.proofHash);
    const [head, block] = await Promise.all([deps.head(), deps.block(receipt.blockNumber)]);
    if (block.hash !== receipt.blockHash || head < receipt.blockNumber + 1n || !sameAddress(receipt.from, result.account)) return false;
    if (result.terminal === "failed") return receipt.status === "reverted";
    const transaction = await deps.transaction(result.proofHash);
    return sameAddress(transaction.from, result.account) && transaction.nonce === result.nonce;
  } catch { return false; }
}

export function bufferedLaunchGas(estimate: bigint, blockGasLimit: bigint) {
  const gas = (estimate * 125n + 99n) / 100n;
  if (estimate <= 0n || blockGasLimit <= 0n || gas > blockGasLimit * 80n / 100n)
    throw new Error("The launch gas requirement exceeds the safe block limit. Run a new preview.");
  return gas;
}

export function freezeLaunchPlan(plan: LaunchPlan): LaunchPlan {
  const copy = JSON.parse(JSON.stringify(plan)) as LaunchPlan;
  function freeze(value: unknown) {
    if (!value || typeof value !== "object") return;
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  freeze(copy);
  return copy;
}

export function assertLaunchWalletPlan(plan: LaunchPlan, config: RuntimeConfig, account: Address, now = Date.now()) {
  assertSigningEnabled(config);
  if (plan.curvePolicy !== CURVE_POLICY || config.curvePolicy !== CURVE_POLICY)
    throw new Error("The launch curve policy has changed. Run a new preview.");
  if (!sameAddress(plan.creator, account) || !plan.transaction ||
    plan.transaction.data.toLowerCase() !== plan.data.toLowerCase() || plan.transaction.value !== "0" ||
    !/^0x(?:[0-9a-fA-F]{2}){4,100000}$/.test(plan.data))
    throw new Error("The launch transaction does not match this preview. Run a new preview.");
  assertOpeningValuation(plan.openingValuation, plan.draft.quoteAddress, deploymentChain(config), now);
  if (!assetsFor(config).some((asset) => sameAddress(asset.address, plan.draft.quoteAddress)))
    throw new Error("The selected quote asset is not supported on this network");
  if (!plan.firstBuy) {
    if (plan.approval || !sameAddress(plan.transaction.to, contractsFor(config).airlock))
      throw new Error("The launch transaction target is not allowed");
    return;
  }
  const buy = plan.firstBuy;
  if (!config.launchGuard || !sameAddress(buy.guard, config.launchGuard) ||
    !sameAddress(plan.transaction.to, buy.guard) || !sameAddress(buy.recipient, account) ||
    !sameAddress(buy.quoteAddress, plan.draft.quoteAddress) ||
    !Number.isSafeInteger(buy.deadline) || buy.deadline * 1000 <= now ||
    ![50, 100, 200, 500].includes(buy.slippageBps) ||
    ![buy.amountIn, buy.expectedAmountOut, buy.minAmountOut].every((amount) => /^[1-9]\d{0,77}$/.test(amount) && BigInt(amount) < 2n ** 128n) ||
    BigInt(buy.minAmountOut) !== BigInt(buy.expectedAmountOut) * BigInt(10_000 - buy.slippageBps) / 10_000n)
    throw new Error("The first buy has expired or changed. Run a new preview.");
  const decoded = decodeFunctionData({ abi: launchGuardAbi, data: plan.data });
  if (decoded.functionName !== "createAndBuy" ||
    decoded.args[1] !== BigInt(buy.amountIn) || decoded.args[2] !== BigInt(buy.minAmountOut) ||
    decoded.args[3] !== BigInt(buy.deadline) || !sameAddress(decoded.args[0].numeraire, buy.quoteAddress) ||
    encodeFunctionData({ abi: launchGuardAbi, functionName: "createAndBuy", args: decoded.args }).toLowerCase() !== plan.data.toLowerCase())
    throw new Error("The launch calldata does not match the first buy preview");
  const approval = plan.approval;
  const data = encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [buy.guard, BigInt(buy.amountIn)] });
  if (!approval || !sameAddress(approval.token, buy.quoteAddress) || !sameAddress(approval.spender, buy.guard) ||
    approval.amount !== buy.amountIn || !sameAddress(approval.transaction.to, buy.quoteAddress) ||
    approval.transaction.value !== "0" || approval.transaction.data.toLowerCase() !== data.toLowerCase())
    throw new Error("Approval must cover only this first buy amount and the configured launch guard");
}

export function assertLaunchRequest(request: { method: string; params?: unknown }, step: LaunchWalletStep) {
  if (request.method === "eth_chainId") return;
  if (request.method !== "eth_sendTransaction" || !Array.isArray(request.params) || request.params.length !== 1)
    throw new Error("The launch wallet request is not allowed");
  const tx = request.params[0] as Record<string, unknown>;
  const allowed = ["from", "to", "data", "value", "chainId", "gas", "gasPrice", "maxFeePerGas", "maxPriorityFeePerGas", "nonce", "type"];
  if (!tx || typeof tx !== "object" || Object.keys(tx).some((key) => !allowed.includes(key)) ||
    typeof tx.from !== "string" || !sameAddress(tx.from, step.from) ||
    typeof tx.to !== "string" || !sameAddress(tx.to, step.to) ||
    typeof tx.data !== "string" || tx.data.toLowerCase() !== step.data.toLowerCase() ||
    (tx.value !== undefined && tx.value !== "0x0" && tx.value !== "0x00") ||
    (tx.chainId !== undefined && tx.chainId !== toHex(step.chainId)))
    throw new Error("The wallet transaction does not match the frozen launch preview");
}

export async function executeLaunchPlan(plan: LaunchPlan, config: RuntimeConfig, account: Address, deps: {
  validate: (frozen: LaunchPlan) => Promise<void>;
  balance: (token: Address) => Promise<bigint>;
  allowance: (token: Address, spender: Address) => Promise<bigint>;
  approve: (transaction: LaunchTransaction, frozen: LaunchPlan) => Promise<void>;
  simulate: (frozen: LaunchPlan) => Promise<LaunchSimulation>;
  submit: (transaction: LaunchTransaction, gas: bigint, frozen: LaunchPlan) => Promise<Hash>;
  progress: (message: string) => void;
}) {
  const frozen = freezeLaunchPlan(plan);
  const validate = async () => {
    assertLaunchWalletPlan(frozen, config, account);
    await deps.validate(frozen);
  };
  await validate();
  if (frozen.firstBuy) {
    const buy = frozen.firstBuy;
    const amount = BigInt(buy.amountIn);
    const [balance, allowance] = await Promise.all([
      deps.balance(buy.quoteAddress), deps.allowance(buy.quoteAddress, buy.guard),
    ]);
    if (balance < amount) throw new Error("Insufficient quote asset balance for the first buy");
    if (allowance < amount) {
      deps.progress("Approve only the first buy amount in your wallet");
      await validate();
      await deps.approve(frozen.approval!.transaction, frozen);
      await validate();
      if (await deps.allowance(buy.quoteAddress, buy.guard) < amount)
        throw new Error("The first buy approval is not sufficient. Check its transaction status.");
    }
  }
  deps.progress(frozen.firstBuy ? "Simulating the complete launch and first buy…" : "Simulating the launch…");
  await validate();
  const simulation = await deps.simulate(frozen);
  if (simulation.valid !== true || !/^[1-9]\d{0,19}$/.test(simulation.gas) ||
    simulation.amountOut !== (frozen.firstBuy?.expectedAmountOut ?? null))
    throw new Error("The simulated first buy or launch has changed. Run a new preview.");
  await validate();
  deps.progress(frozen.firstBuy ? "Confirm launch and first buy in your wallet" : "Confirm the launch in your wallet");
  return deps.submit(frozen.transaction!, BigInt(simulation.gas), frozen);
}
