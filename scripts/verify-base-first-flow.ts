import { existsSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createPublicClient, decodeEventLog, erc20Abi, parseAbi, type Abi, type Address, type Hex, type TransactionReceipt } from "viem";
import { base, robinhood } from "viem/chains";
import baseDeployment from "../contracts/artifacts/base-collector-deployment.json";
import robinhoodDeployment from "../contracts/artifacts/buyback-v2-deployment.json";
import { CONTRACTS, sameAddress } from "../src/lib/config";
import { baseCollectorAbi, BASE_BUYBACK_FORWARDER, BASE_BUYBACK_RH_WETH, BASE_BUYBACK_TREASURY, BASE_BUYBACK_VAULT } from "../src/lib/base-buyback";
import { buybackVaultAbi } from "../src/lib/buyback-engine";
import { MUSEGOD_BUYBACK } from "../src/lib/fee-policy";
import { RELAY_ROUTER } from "../server/buyback";
import { alchemyRpcTransport } from "../server/alchemy-rpc";
import { loadEnvironment, redact, type RuntimeEnvironment } from "../server/config";

// Explicit manual report only. No caller in a keeper, Worker, scheduler or release gate.
export type BaseFirstFlowHashes = { claim: Hex; release: Hex; baseTransfer: Hex; arrival: Hex; forward: Hex; execute: Hex };
type Block = { number: bigint | null; hash: Hex | null };
export type FirstFlowClient = { getChainId(): Promise<number>; getTransactionReceipt(args: { hash: Hex }): Promise<TransactionReceipt>;
  getBlock(args: { blockNumber: bigint } | { blockTag: "finalized" }): Promise<Block> };
const collector = baseDeployment.collector.address as Address, automation = baseDeployment.constants.automationReceiver as Address;
const swapper = robinhoodDeployment.contracts.swapper.address as Address, executor = robinhoodDeployment.contracts.executor.address as Address;
const forwardAbi = parseAbi(["event Forwarded(address indexed caller,uint256 amount)"]);
const hash = (value: unknown): value is Hex => typeof value === "string" && /^0x[0-9a-f]{64}$/i.test(value);
const stages = ["claim", "release", "baseTransfer", "arrival", "forward", "execute"] as const;
type Event = { args: Record<string, any>; logIndex: number };
function events(receipt: TransactionReceipt, address: Address, abi: Abi, eventName: string): Event[] {
  return receipt.logs.filter(log => sameAddress(log.address, address)).flatMap(log => {
    try { const value = decodeEventLog({ abi, data: log.data, topics: log.topics, strict: true });
      return value.eventName === eventName ? [{ args: value.args as Record<string, any>, logIndex: log.logIndex }] : [];
    } catch { return []; }
  });
}
function transfers(receipt: TransactionReceipt, token: Address, from: Address | null, to: Address) {
  return events(receipt, token, erc20Abi, "Transfer").filter(event => event.args.value > 0n && !sameAddress(event.args.from, event.args.to) &&
    (!from || sameAddress(event.args.from, from)) && sameAddress(event.args.to, to));
}
const sum = (values: Event[], key: string) => values.reduce((total, event) => total + BigInt(event.args[key]), 0n);
const metadata = (receipt: TransactionReceipt, chainId: 8453 | 4663) => ({ chainId, transactionHash: receipt.transactionHash,
  blockNumber: String(receipt.blockNumber), blockHash: receipt.blockHash });
function ordered(before: TransactionReceipt, after: TransactionReceipt, beforeIndex: number, afterIndex: number) {
  if (before.blockNumber > after.blockNumber || before.blockNumber === after.blockNumber &&
    (before.transactionIndex > after.transactionIndex || before.transactionIndex === after.transactionIndex &&
      (before.transactionHash !== after.transactionHash || beforeIndex >= afterIndex))) throw new Error("Owner-selected stages are not in canonical execution order");
}
async function finalized(client: FirstFlowClient) {
  const block = await client.getBlock({ blockTag: "finalized" });
  if (block.number === null || block.number < 0n || !hash(block.hash)) throw new Error("A canonical finalized checkpoint is unavailable");
  return { number: block.number, hash: block.hash };
}
async function receipt(client: FirstFlowClient, transactionHash: Hex, head: { number: bigint; hash: Hex }) {
  const value = await client.getTransactionReceipt({ hash: transactionHash });
  if (value.status !== "success" || value.transactionHash.toLowerCase() !== transactionHash.toLowerCase() || !hash(value.blockHash) ||
    value.blockNumber < 0n || value.blockNumber > head.number || !Number.isSafeInteger(value.transactionIndex) || value.transactionIndex < 0)
    throw new Error("A supplied transaction is failed, unfinalized or has inconsistent identity");
  const block = await client.getBlock({ blockNumber: value.blockNumber });
  if (block.number !== value.blockNumber || block.hash !== value.blockHash) throw new Error("A supplied receipt is no longer canonical");
  const indexes = new Set<number>();
  for (const log of value.logs) {
    if (log.removed || log.transactionHash !== value.transactionHash || log.blockHash !== value.blockHash || log.blockNumber !== value.blockNumber ||
      log.transactionIndex !== value.transactionIndex || !Number.isSafeInteger(log.logIndex) || log.logIndex < 0 || indexes.has(log.logIndex))
      throw new Error("Receipt logs have inconsistent canonical identity or ordering");
    indexes.add(log.logIndex);
  }
  return value;
}

/** Checks only the owner-selected receipts. Amount comparisons do not prove
 * cross-chain identity, exclusive funding or which shared-Vault burn came from Base. */
export async function verifyBaseFirstFlow(hashes: BaseFirstFlowHashes, clients: { base: FirstFlowClient; robinhood: FirstFlowClient }, now = Date.now) {
  if (stages.some(stage => !hash(hashes[stage]))) throw new Error("All six explicit transaction hashes are required");
  const [sourceChain, destinationChain] = await Promise.all([clients.base.getChainId(), clients.robinhood.getChainId()]);
  if (sourceChain !== 8453 || destinationChain !== 4663) throw new Error("The manual report requires exact Base and Robinhood RPC scopes");
  const [sourceHead, destinationHead] = await Promise.all([finalized(clients.base), finalized(clients.robinhood)]);
  const receipts = new Map<string, TransactionReceipt>();
  for (const stage of stages) {
    const source = ["claim", "release", "baseTransfer"].includes(stage), key = `${source ? 8453 : 4663}:${hashes[stage].toLowerCase()}`;
    if (!receipts.has(key)) receipts.set(key, await receipt(source ? clients.base : clients.robinhood, hashes[stage], source ? sourceHead : destinationHead));
  }
  const read = (stage: typeof stages[number]) => receipts.get(`${["claim", "release", "baseTransfer"].includes(stage) ? 8453 : 4663}:${hashes[stage].toLowerCase()}`)!;
  const claimed = read("claim"), released = read("release"), outgoing = read("baseTransfer"), arrived = read("arrival"), forwarded = read("forward"), executed = read("execute");
  const credits = events(claimed, collector, baseCollectorAbi, "FeesClaimed").filter(event => event.args.amount > 0n);
  if (!credits.length || credits.some(event => ![CONTRACTS.initializer, CONTRACTS.rehype].some(manager => sameAddress(event.args.manager, manager))))
    throw new Error("The claim has no genuine positive Collector manager fee credits");
  for (const credit of credits) {
    const matching = credits.filter(event => sameAddress(event.args.manager, credit.args.manager) && sameAddress(event.args.token, credit.args.token));
    const delivered = transfers(claimed, credit.args.token, credit.args.manager, collector);
    if (sum(delivered, "value") !== sum(matching, "amount")) throw new Error("Manager fee credits do not match actual Collector token delivery");
  }
  const releases = events(released, collector, baseCollectorAbi, "FeesReleased").filter(event => event.args.amount > 0n);
  if (!releases.length || releases.some(event => !sameAddress(event.args.receiver, automation) || !credits.some(credit => sameAddress(credit.args.token, event.args.token))))
    throw new Error("The release does not forward a claimed fee asset to the fixed Automation");
  for (const release of releases) {
    const matching = releases.filter(event => sameAddress(event.args.token, release.args.token));
    if (sum(transfers(released, release.args.token, collector, automation), "value") !== sum(matching, "amount"))
      throw new Error("Released fees do not match actual fixed Automation token delivery");
  }
  const routeTransfers = [...new Set(releases.map(event => event.args.token.toLowerCase()))].flatMap(token =>
    transfers(outgoing, token as Address, automation, RELAY_ROUTER).map(event => ({ ...event, token: token as Address })));
  if (!routeTransfers.length) throw new Error("The Base Automation receipt has no positive fee-token transfer to the fixed Relay Router");
  const incoming = transfers(arrived, BASE_BUYBACK_RH_WETH, null, BASE_BUYBACK_TREASURY);
  if (!incoming.length) throw new Error("The selected Robinhood arrival has no actual canonical WETH transfer to Treasury");
  const forwards = events(forwarded, BASE_BUYBACK_FORWARDER, forwardAbi, "Forwarded").filter(event => event.args.amount > 0n);
  const vaultIncoming = transfers(forwarded, BASE_BUYBACK_RH_WETH, BASE_BUYBACK_TREASURY, BASE_BUYBACK_VAULT);
  if (!forwards.length || sum(forwards, "amount") !== sum(vaultIncoming, "value")) throw new Error("Fixed Forwarder events do not match actual Treasury-to-Vault WETH delivery");
  const executions = events(executed, BASE_BUYBACK_VAULT, buybackVaultAbi, "Executed").filter(event => event.args.wethAmount > 0n && event.args.museToDead > 0n);
  const spent = transfers(executed, BASE_BUYBACK_RH_WETH, BASE_BUYBACK_VAULT, swapper);
  const toDead = transfers(executed, MUSEGOD_BUYBACK.tokenAddress, executor, MUSEGOD_BUYBACK.burnAddress);
  if (!executions.length || sum(executions, "wethAmount") !== sum(spent, "value") || sum(executions, "museToDead") !== sum(toDead, "value"))
    throw new Error("Shared Vault executions do not match actual WETH spending and MUSEGOD delivery to dead");
  ordered(claimed, released, Math.max(...credits.map(event => event.logIndex)), Math.min(...releases.map(event => event.logIndex)));
  ordered(released, outgoing, Math.max(...releases.map(event => event.logIndex)), Math.min(...routeTransfers.map(event => event.logIndex)));
  ordered(arrived, forwarded, Math.max(...incoming.map(event => event.logIndex)), Math.min(...vaultIncoming.map(event => event.logIndex)));
  ordered(forwarded, executed, Math.max(...forwards.map(event => event.logIndex)), Math.min(...executions.map(event => event.logIndex)));
  for (const [client, head] of [[clients.base, sourceHead], [clients.robinhood, destinationHead]] as const) {
    if ((await client.getBlock({ blockNumber: head.number })).hash !== head.hash) throw new Error("The finalized report checkpoint changed during verification");
  }
  return { schemaVersion: 1, status: "manual_receipts_checked", checkedAt: now(), hashes,
    scope: "Owner-selected first-flow receipt report; not automatic cross-chain provenance or Base-specific burn attribution",
    trustSplitsNativeExecution: true, baseAttributedMuseToDead: null, erc20SupplyReductionClaimed: false,
    finalizedCheckpoints: { base: { number: String(sourceHead.number), hash: sourceHead.hash }, robinhood: { number: String(destinationHead.number), hash: destinationHead.hash } },
    claim: { ...metadata(claimed, 8453), collector, credits: credits.map(event => ({ token: event.args.token, manager: event.args.manager, poolId: event.args.poolId, amount: String(event.args.amount), logIndex: event.logIndex })) },
    release: { ...metadata(released, 8453), automation, releases: releases.map(event => ({ token: event.args.token, amount: String(event.args.amount), logIndex: event.logIndex })) },
    baseTransfer: { ...metadata(outgoing, 8453), router: RELAY_ROUTER, transfers: routeTransfers.map(event => ({ token: event.token, amount: String(event.args.value), logIndex: event.logIndex })) },
    arrival: { ...metadata(arrived, 4663), treasury: BASE_BUYBACK_TREASURY, actualWethReceived: String(sum(incoming, "value")) },
    forward: { ...metadata(forwarded, 4663), forwarder: BASE_BUYBACK_FORWARDER, vault: BASE_BUYBACK_VAULT, actualWethDelivered: String(sum(vaultIncoming, "value")) },
    sharedVaultExecution: { ...metadata(executed, 4663), vault: BASE_BUYBACK_VAULT, actualWethSpent: String(sum(spent, "value")), actualMuseToDead: String(sum(toDead, "value")), callerProfit: String(sum(executions, "profit")) },
    amountComparisons: { arrivalEqualsForward: sum(incoming, "value") === sum(vaultIncoming, "value"), forwardEqualsVaultSpend: sum(vaultIncoming, "value") === sum(spent, "value") },
    limitations: ["The owner supplied the hashes; no bridge request, trace, FIFO, source isolation or automatic discovery was performed.",
      "Automation, Treasury and Vault can hold other funds; equal amounts do not prove origin, and shared-Vault burning is not assigned to Base.",
      "Transfers to dead do not reduce ERC-20 totalSupply; this report is not a launch or signing gate."] };
}

export function parseBaseFirstFlowArguments(args: string[]) {
  const keys: Record<string, keyof BaseFirstFlowHashes> = { "--claim": "claim", "--release": "release", "--base-transfer": "baseTransfer", "--arrival": "arrival", "--forward": "forward", "--execute": "execute" };
  const values: Partial<BaseFirstFlowHashes> = {}; let output: string | undefined;
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index], value = args[index + 1];
    if (!value || value.startsWith("--")) throw new Error("Every manual report option requires its explicit value");
    if (key === "--out") { if (output) throw new Error("Output path is duplicated"); output = resolve(value); }
    else if (!keys[key] || values[keys[key]] || !hash(value)) throw new Error("Unknown, duplicate or invalid transaction hash option");
    else values[keys[key]] = value;
  }
  if (!output || stages.some(stage => !values[stage])) throw new Error("Usage: verify-base-first-flow.ts --claim HASH --release HASH --base-transfer HASH --arrival HASH --forward HASH --execute HASH --out NEW_JSON_PATH");
  return { hashes: values as BaseFirstFlowHashes, output };
}
export function writeBaseFirstFlowReport(output: string, report: Awaited<ReturnType<typeof verifyBaseFirstFlow>>) {
  writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx", mode: 0o600 });
}
export async function runBaseFirstFlowReport(args: string[], environment: RuntimeEnvironment) {
  const { hashes, output } = parseBaseFirstFlowArguments(args);
  if (existsSync(output)) throw new Error("The report already exists; choose a new output path");
  const report = await verifyBaseFirstFlow(hashes, {
    base: createPublicClient({ chain: base, transport: alchemyRpcTransport(8453, environment) }),
    robinhood: createPublicClient({ chain: robinhood, transport: alchemyRpcTransport(4663, environment) }),
  });
  writeBaseFirstFlowReport(output, report); return { status: report.status, output };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { loadEnvironment(); console.log(JSON.stringify(await runBaseFirstFlowReport(process.argv.slice(2), process.env))); }
  catch (error) { console.error(redact(error, process.env)); process.exitCode = 1; }
}
