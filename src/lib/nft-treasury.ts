import { decodeFunctionData, decodeFunctionResult, encodeFunctionData, erc20Abi, erc721Abi, pad, parseAbi, type Abi, type Address, type EncodeFunctionDataParameters, type Hex,
  type PublicClient } from "viem";
import { robinhood } from "viem/chains";
import { deploymentChain, sameAddress, shortAddress, type RuntimeConfig, type TokenRecord } from "./config";
import { ERC6551_REGISTRY, TOKENBOUND_V3_IMPLEMENTATION, TOKENBOUND_V3_PROXY, isMuse, nftKey, treasuryFor, vaultFor, type NftRef } from "./nft-mode";

const vaultAbi = parseAbi(["function sweep(bytes32[] poolIds, address[] tokens)"]);
const factoryAbi = parseAbi(["function deploy(uint256 homeChainId, address nft, uint256 tokenId) returns (address)"]);
const registryAbi = parseAbi(["function createAccount(address implementation, bytes32 salt, uint256 chainId, address tokenContract, uint256 tokenId) returns (address)"]);
// Tokenbound V3 AccountV3 (0x41C8…44eC), checked on Sourcify 2026-10-14. A lock is capped at 365 days by the account.
const accountAbi = parseAbi(["function execute(address to, uint256 value, bytes data, uint8 operation) payable returns (bytes)",
  "function lock(uint256 lockedUntil)", "function initialize(address implementation)", "function lockedUntil() view returns (uint256)",
  "function isLocked() view returns (bool)"]);
type Tx = { to: Address; data: Hex };

type FeePair = { fees0: string; fees1: string };
type PendingFee = { token: Address; lp: FeePair; trade: FeePair; poolKey: { currency0: Address; currency1: Address } } | { token: Address; error: string };
/** Every bound coin contributes to the view, including rejected coins that still pay this NFT's vault. */
export type NftTreasuryView = { nft: NftRef; vault: Address; vaultDeployed: boolean; treasury: Address; treasuryDeployed: boolean; treasuryInitialized: boolean;
  coins: { token: Address; symbol: string; poolId: Hex; quoteAddress: Address }[];
  balances: { token: Address; symbol: string; amount: string; vaultAmount: string | null }[]; pendingFees: PendingFee[] };

export const sweepTx = (vault: Address, poolIds: Hex[], tokens: Address[]): Tx =>
  ({ to: vault, data: encodeFunctionData({ abi: vaultAbi, functionName: "sweep", args: [poolIds, tokens] }) });
/** Collect only pools with readable nonzero fees, at most five per wallet confirmation. A chunk forwards only its own currencies;
 * balances already sitting in the vault remain sweepable without collecting empty pools. No pending funds means no transaction. */
export function pendingSweepTxs(vault: Address, view: Pick<NftTreasuryView, "coins" | "pendingFees" | "balances">): Tx[] {
  const pending = new Set(view.pendingFees.filter((entry) => !("error" in entry) &&
    [entry.lp.fees0, entry.lp.fees1, entry.trade.fees0, entry.trade.fees1].some((amount) => BigInt(amount) > 0n)).map((entry) => entry.token.toLowerCase()));
  const coins = view.coins.filter((coin) => pending.has(coin.token.toLowerCase())), steps: Tx[] = [], forwarded = new Set<string>();
  for (let start = 0; start < coins.length; start += 5) {
    const chunk = coins.slice(start, start + 5);
    const tokens = [...new Map(chunk.flatMap((coin) => [coin.token, coin.quoteAddress]).map((token) => [token.toLowerCase(), token])).values()];
    tokens.forEach((token) => forwarded.add(token.toLowerCase()));
    steps.push(sweepTx(vault, chunk.map((coin) => coin.poolId), tokens));
  }
  const balances = view.balances.filter((row) => row.vaultAmount && BigInt(row.vaultAmount) > 0n && !forwarded.has(row.token.toLowerCase()));
  for (let start = 0; start < balances.length; start += 10) steps.push(sweepTx(vault, [], balances.slice(start, start + 10).map((row) => row.token)));
  return steps;
}
export const deployVaultTx = (factory: Address, nft: NftRef): Tx =>
  ({ to: factory, data: encodeFunctionData({ abi: factoryAbi, functionName: "deploy", args: [BigInt(nft.chainId), nft.contract, BigInt(nft.tokenId)] }) });
/** The second activation step alone, `initialize(TOKENBOUND_V3_IMPLEMENTATION)` on the treasury: it finishes an activation whose account
 * was created but never initialized. */
export const finishActivationTx = (nft: NftRef): Tx =>
  ({ to: treasuryFor(nft), data: encodeFunctionData({ abi: accountAbi, functionName: "initialize", args: [TOKENBOUND_V3_IMPLEMENTATION] }) });
export const activateTreasuryTxs = (nft: NftRef): Tx[] => [
  { to: ERC6551_REGISTRY, data: encodeFunctionData({ abi: registryAbi, functionName: "createAccount",
    args: [TOKENBOUND_V3_PROXY, pad("0x00", { size: 32 }), BigInt(nft.chainId), nft.contract, BigInt(nft.tokenId)] }) },
  finishActivationTx(nft),
];
/** EIP-1967's implementation slot, keccak256("eip1967.proxy.implementation") - 1. The Tokenbound account proxy keeps its implementation there
 * once `initialize` ran; until then it is zero and the account answers nothing (its lock cannot be read, nothing can be withdrawn). */
export const ERC1967_IMPLEMENTATION_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc" as const;
/** The treasury finished activation: its implementation slot (`eth_getStorageAt`) holds exactly Tokenbound V3. */
export function treasuryInitialized(slot: Hex | undefined): boolean {
  try { return !!slot && slot !== "0x" && BigInt(slot) === BigInt(TOKENBOUND_V3_IMPLEMENTATION); } catch { return false; }
}
/** Treasury `execute(target, value, data, 0)`: a plain call, never a delegatecall. Native ETH travels inside execute, not on the outer call. */
export function withdrawTx(nft: NftRef, token: Address | "native", to: Address, amount: bigint): Tx {
  const call = token === "native" ? { target: to, value: amount, data: "0x" as Hex }
    : { target: token, value: 0n, data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [to, amount] }) };
  return { to: treasuryFor(nft), data: encodeFunctionData({ abi: accountAbi, functionName: "execute", args: [call.target, call.value, call.data, 0] }) };
}
export const lockTx = (nft: NftRef, until: number): Tx =>
  ({ to: treasuryFor(nft), data: encodeFunctionData({ abi: accountAbi, functionName: "lock", args: [BigInt(until)] }) });
export const depositTx = (nft: NftRef, token: Address, amount: bigint): Tx =>
  ({ to: token, data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [treasuryFor(nft), amount] }) });

/** `data` is exactly `abi`'s canonical encoding of one call (no trailing bytes), or null. */
function exactCall(abi: Abi, data: Hex) {
  try {
    const call = decodeFunctionData({ abi, data });
    const encoded = encodeFunctionData({ abi, functionName: call.functionName, args: call.args } as EncodeFunctionDataParameters);
    return encoded.toLowerCase() === data.toLowerCase() ? { functionName: call.functionName, args: call.args ?? [] } : null;
  } catch { return null; }
}
/** The only NFT-treasury calls the wallet signs (the last check before a signature). Every address is derived here from `nft` and the
 * server-verified factory, never taken from the caller. Allowed, all with an outer value of 0:
 * - factory.deploy(this NFT) to the verified factory, and vault.sweep to this NFT's vault under it;
 * - registry.createAccount(proxy, salt 0, this NFT) and treasury.initialize(implementation);
 * - treasury.lock(until), and treasury.execute as a plain call (operation 0) that withdraws to `account`: native ETH with no calldata, or
 *   an ERC-20 transfer(account, amount) with no ETH. The account itself only lets its owner execute or lock;
 * - an ERC-20 transfer(treasury, amount) to any token (a deposit), except the NFT's own contract: a legacy collection with
 *   transfer(address,uint256) would move the NFT into its own treasury, locking it forever. */
export function isNftTreasuryTx(config: Pick<RuntimeConfig, "mode" | "deploymentChainId" | "nftMode">, nft: NftRef,
  tx: { to: Address; data: Hex; value: bigint }, account: Address): boolean {
  if (tx.value !== 0n || nft.chainId !== deploymentChain(config)) return false;
  const factory = config.nftMode?.vaultFactory ?? null, treasury = treasuryFor(nft);
  const same = (a: Hex, b: Hex) => a.toLowerCase() === b.toLowerCase();
  if (sameAddress(tx.to, treasury)) {
    if (activateTreasuryTxs(nft).some((step) => sameAddress(step.to, treasury) && same(step.data, tx.data))) return true;
    const call = exactCall(accountAbi, tx.data);
    if (call?.functionName === "lock") return true;
    if (call?.functionName !== "execute") return false;
    const [target, value, data, operation] = call.args as [Address, bigint, Hex, number];
    if (operation !== 0) return false;
    if (value > 0n) return data === "0x" && sameAddress(target, account);
    const transfer = exactCall(erc20Abi, data);
    return transfer?.functionName === "transfer" && sameAddress(transfer.args[0] as Address, account);
  }
  if (sameAddress(tx.to, ERC6551_REGISTRY)) return same(tx.data, activateTreasuryTxs(nft)[0].data);
  if (factory && sameAddress(tx.to, factory)) return same(tx.data, deployVaultTx(factory, nft).data);
  if (factory && sameAddress(tx.to, vaultFor(nft, factory))) return exactCall(vaultAbi, tx.data)?.functionName === "sweep";
  if (sameAddress(tx.to, nft.contract)) return false;
  const transfer = exactCall(erc20Abi, tx.data);
  return transfer?.functionName === "transfer" && sameAddress(transfer.args[0] as Address, treasury);
}

type MulticallReader = Pick<PublicClient, "multicall">;
// Canonical Multicall3, the same address on Robinhood Chain and Base.
const MULTICALL3 = robinhood.contracts.multicall3.address;

/** The account's lock, read in one call through the RPC proxy. */
export async function readTreasuryLock(client: MulticallReader, nft: NftRef): Promise<{ lockedUntil: number; locked: boolean }> {
  const treasury = treasuryFor(nft);
  const [until, locked] = await client.multicall({ allowFailure: true, multicallAddress: MULTICALL3, batchSize: 0, contracts: [
    { address: treasury, abi: accountAbi, functionName: "lockedUntil" }, { address: treasury, abi: accountAbi, functionName: "isLocked" }] });
  if (until?.status !== "success" || locked?.status !== "success") throw new Error("The treasury lock could not be read.");
  return { lockedUntil: Number(until.result), locked: locked.result === true };
}
// Multicall3's aggregate3, declared view as in viem's own ABI so it can be read with eth_call.
const aggregate3Abi = parseAbi(["struct Call3 { address target; bool allowFailure; bytes callData; }", "struct Result { bool success; bytes returnData; }",
  "function aggregate3(Call3[] calls) view returns (Result[] returnData)"]);
/** A collection's `name()` as a label: invisible and direction-changing characters removed (the contract chooses the text), whitespace
 * collapsed, at most 48 characters; null when nothing is left. */
export function collectionName(raw: string): string | null {
  const text = raw.replace(/[\u0000-\u001f\u007f-\u009f\u00ad\u034f\u061c\u180e\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/g, " ").replace(/\s+/g, " ").trim();
  const chars = Array.from(text);
  return !chars.length ? null : chars.length > 48 ? `${chars.slice(0, 47).join("").trimEnd()}…` : text;
}
/** What any viewer can read about the NFT through the RPC proxy: its holder and its collection's name. Both run inside one aggregate3 call
 * so the chain's own answers are told apart from a failed read (viem's multicall reports both as a failed entry). `holder` is null when
 * `ownerOf` reverts or answers nothing usable (a burned token, a non-ERC-721), `collection` when the contract has no usable `name()`;
 * throws when the chain cannot be read. */
export async function readNftPublic(client: Pick<PublicClient, "readContract">, nft: NftRef): Promise<{ holder: Address | null; collection: string | null }> {
  const [owner, name] = await client.readContract({ address: MULTICALL3, abi: aggregate3Abi, functionName: "aggregate3", args: [[
    encodeFunctionData({ abi: erc721Abi, functionName: "ownerOf", args: [BigInt(nft.tokenId)] }), encodeFunctionData({ abi: erc721Abi, functionName: "name" }),
  ].map((callData) => ({ target: nft.contract, allowFailure: true, callData }))] });
  const decoded = <T>(answer: { success: boolean; returnData: Hex } | undefined, decode: (data: Hex) => T): T | null => {
    if (!answer?.success || answer.returnData === "0x") return null;
    try { return decode(answer.returnData); } catch { return null; }
  };
  const holder = decoded(owner, (data) => decodeFunctionResult({ abi: erc721Abi, functionName: "ownerOf", data }));
  const collection = decoded(name, (data) => decodeFunctionResult({ abi: erc721Abi, functionName: "name", data }));
  return { holder: holder && BigInt(holder) !== 0n ? holder : null, collection: collection === null ? null : collectionName(collection) };
}
export const LOCK_PRESET_DAYS = [1, 7, 30] as const;
/** The lock's end, from the latest block's timestamp. */
export const lockTarget = (blockTimestamp: bigint, days: number) => Number(blockTimestamp) + days * 86_400;

export const NFT_OWNER_SCAN_LIMIT = 200;
/** The NFTs `account` holds among the first 200 NFT coins, each with its coins: one `ownerOf` multicall through the RPC proxy.
 * `capped` says coins past the limit were not checked. A failed read (a burned token, a non-ERC-721) counts as not held. */
export async function heldNftCoins(client: MulticallReader, tokens: TokenRecord[], account: Address) {
  const nftCoins = tokens.filter((token) => token.nft), scanned = nftCoins.slice(0, NFT_OWNER_SCAN_LIMIT);
  const byNft = new Map<string, { nft: NftRef; coins: TokenRecord[] }>();
  for (const coin of scanned) {
    const key = nftKey(coin.nft!), entry = byNft.get(key);
    if (entry) entry.coins.push(coin); else byNft.set(key, { nft: coin.nft!, coins: [coin] });
  }
  const entries = [...byNft.values()], capped = nftCoins.length > NFT_OWNER_SCAN_LIMIT;
  if (!entries.length) return { held: [], capped };
  // batchSize 0: one eth_call, never viem's default 1024-byte chunks (8 requests for 200 NFTs).
  const owners = await client.multicall({ allowFailure: true, multicallAddress: MULTICALL3, batchSize: 0, contracts: entries.map(({ nft }) =>
    ({ address: nft.contract, abi: erc721Abi, functionName: "ownerOf", args: [BigInt(nft.tokenId)] })) });
  return { held: entries.filter((_, index) => {
    const owner = owners[index];
    return owner?.status === "success" && typeof owner.result === "string" && sameAddress(owner.result, account);
  }), capped };
}

/** The badge an NFT coin shows, decided by the collection allowlist alone (D7), never by the coin's status: "Muse #N" for the Muses,
 * otherwise the unverified-collection warning, which names the short contract address with `withContract` (where space allows: the NFT
 * page and the token header). A rejected coin shows none. */
export function nftBadge(token: Pick<TokenRecord, "nft" | "nftVerification">, { withContract = false } = {}): string | null {
  if (!token.nft || token.nftVerification?.status === "rejected") return null;
  if (isMuse(token.nft)) return `Muse #${token.nft.tokenId}`;
  return `NFT · unverified collection${withContract ? ` · ${shortAddress(token.nft.contract)}` : ""}`;
}
/** An NFT coin as Explore lists it: bound, not rejected and not hidden. */
export const listedNftCoin = (token: Pick<TokenRecord, "nft" | "nftVerification" | "hidden">) =>
  !!token.nft && token.nftVerification?.status !== "rejected" && !token.hidden;

/** A treasury card row's value and, where the value alone does not say what it means, the explanation its info tip shows
 * (tasks/token-ip-detail-plan.md §14, §15). */
export type CardRow = { value: string; tip?: string; warning?: boolean };
/** The Collection row: the collection's on-chain name, or its short address without one (`name` undefined while it is read). The allowlist
 * decides verification, as for the badge (D7); an unverified name keeps a visible marker, since anyone can deploy a contract with that name. */
export function collectionRow(nft: NftRef, verified: boolean, name: string | null | undefined): CardRow {
  const tip = isMuse(nft) ? "The official Muses contract, on musegod.fun's verified list." : verified ? "This collection's contract is on musegod.fun's verified list."
    : "Not on musegod.fun's verified list. Anyone can deploy a look-alike collection with the same name, so check the contract address.";
  if (name === undefined) return { value: "Reading…", tip };
  const label = name ?? shortAddress(nft.contract);
  return verified ? { value: label, tip } : { value: `${label} · unverified`, warning: true, tip };
}
const REJECTED_REASONS = new Map([
  ["already_launched", "Another coin was verified for this NFT first."],
  ["not_controller", "The wallet that launched it did not control the NFT."],
  ["not_erc721", "The bound contract is not an ERC-721 NFT."],
  ["fee", "The launch fee was not paid."],
  ["pair", "Its pair was not allowed when it launched."],
]);
const UNCONFIRMED_REASONS = new Map([
  ["rpc", "The chain could not be read at launch, so the holder check did not finish."],
  ["fee_unconfirmed", "The launch fee payment is not confirmed yet."],
]);
/** The Official coin row: the coin's registration status, with the stored reason in words. A rejected coin still pays the NFT's vault. */
export function officialCoinRow(verification: TokenRecord["nftVerification"]): CardRow {
  const reason = verification?.reason ?? "";
  if (verification?.status === "verified") return { value: "Yes", tip: "This NFT's one verified coin, launched by its holder or the holder's delegate. Each NFT gets one." };
  if (verification?.status === "rejected") return { value: "No", warning: true,
    tip: `${REJECTED_REASONS.get(reason) ?? (reason ? `Reason: ${reason}.` : "No reason was recorded.")} Its creator fees still go to this NFT's vault.` };
  return { value: "Not confirmed yet", tip: UNCONFIRMED_REASONS.get(reason) ?? "musegod.fun has not confirmed that the NFT's holder launched it." };
}
/** Where the treasury account stands; "reading" until the treasury view or a confirmed action reports it. */
export type TreasuryState = "reading" | "unavailable" | "not_deployed" | "not_initialized" | "active";
export function treasuryStatusRow(state: TreasuryState): CardRow {
  switch (state) {
    case "reading": return { value: "Reading…" };
    case "unavailable": return { value: "Unavailable" };
    case "not_deployed": return { value: "Not activated yet", tip: "Swept fees still arrive at its address. It needs one activation before the holder can withdraw." };
    case "not_initialized": return { value: "Activation not finished", tip: "Withdraw and Lock open once the activation finishes." };
    case "active": return { value: "Active" };
  }
}
export const LOCK_TIP = "While on, the treasury cannot send anything until the date, even for its holder; holders use it while selling the NFT. Approvals it gave earlier still work.";
/** The Withdrawal lock row. An account that is not activated cannot be locked, so its lock is off. */
export function withdrawalLockRow(state: TreasuryState, lock: { lockedUntil: number; locked: boolean } | null, lockError: string, date: (seconds: number) => string): CardRow {
  const value = state === "reading" ? "Reading…" : state === "unavailable" ? "Unavailable" : state !== "active" ? "Off"
    : lockError ? "Unavailable" : !lock ? "Reading…" : lock.locked ? `On until ${date(lock.lockedUntil)}` : "Off";
  return { value, tip: LOCK_TIP, warning: state === "active" && !!lock?.locked && !lockError };
}
