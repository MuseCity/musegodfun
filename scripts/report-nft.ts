import { existsSync, statSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { formatUnits } from "viem";
import type { TokenRecord } from "../src/lib/config";
import { LAUNCH_FEE_USD } from "../src/lib/launch-fee";
import { MUSES, isMuse } from "../src/lib/nft-mode";
import { parseCandles } from "../server/market";

// Offline operator report for NFT mode on Robinhood Chain (tasks/nft-mode.md §9). An operator runs it by hand:
//   npm run report:nft                       public catalog at https://musegod.fun
//   npm run report:nft -- --local <path>     a local SQLite store (its directory or launchpad.sqlite), opened read-only
// It prints markdown. No production process runs it. GeckoTerminal's public API is called at most 30 times a minute.

export const REPORT_ORIGIN = "https://musegod.fun";
export const GECKO_ORIGIN = "https://api.geckoterminal.com";
const CHAIN_ID = 4663;
const DAY_MS = 86_400_000;

export type Clock = { now(): number; sleep(milliseconds: number): Promise<void> };
export const systemClock: Clock = { now: () => Date.now(), sleep: (milliseconds) => new Promise((done) => setTimeout(done, milliseconds)) };

/** Waits until a call fits: at most `limit` calls in any rolling `windowMs`. */
export function rateLimiter(clock: Clock, limit = 30, windowMs = 60_000) {
  const sent: number[] = [];
  return async () => {
    for (;;) {
      const now = clock.now();
      while (sent.length && now - sent[0] >= windowMs) sent.shift();
      if (sent.length < limit) { sent.push(now); return; }
      await clock.sleep(sent[0] + windowMs - now);
    }
  };
}

/** Every token record in a local store, read-only. `path` is the store directory or its launchpad.sqlite file. */
export function readLocalTokens(path: string): TokenRecord[] {
  const file = existsSync(path) && statSync(path).isDirectory() ? join(path, "launchpad.sqlite") : path;
  if (!existsSync(file)) throw new Error("The local store was not found.");
  const db = new DatabaseSync(file, { readOnly: true });
  try { return (db.prepare("SELECT payload FROM tokens ORDER BY created_at DESC").all() as { payload: string }[]).map((row) => JSON.parse(row.payload)); }
  finally { db.close(); }
}

type Fetch = typeof fetch;
async function getJson(fetcher: Fetch, url: string) {
  const response = await fetcher(url, { headers: { accept: "application/json" }, redirect: "manual", signal: AbortSignal.timeout(20_000) });
  if (!response.ok) throw Object.assign(new Error(`HTTP ${response.status} from ${new URL(url).hostname}`), { status: response.status });
  return response.json() as Promise<unknown>;
}

const chainOf = (token: TokenRecord) => token.deploymentChainId ?? (token.mode === "robinhood" ? 4663 : 8453);
const statusOf = (token: TokenRecord) => token.nftVerification?.status ?? "unverified";
const short = (address: string) => `\`${address.slice(0, 6)}…${address.slice(-4)}\``;
const usd = (value: number) => `$${value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const nftLabel = (token: TokenRecord) => isMuse(token.nft!) ? `Muse #${token.nft!.tokenId}` : `${short(token.nft!.contract)} #${token.nft!.tokenId}`;

type Volume = { sevenDay: number; thirtyDay: number } | "not indexed" | "unavailable";
/** 7- and 30-day USD volume from daily candles: the last 7 (or 30) UTC days, today included. */
export function volumeFromCandles(candles: { time: number; volume: number }[], now: number) {
  const today = Math.floor(now / DAY_MS) * DAY_MS;
  const since = (days: number) => candles.filter((candle) => candle.time * 1000 >= today - (days - 1) * DAY_MS).reduce((sum, candle) => sum + candle.volume, 0);
  return { sevenDay: since(7), thirtyDay: since(30) };
}

export async function nftReport(options: { fetch?: Fetch; clock?: Clock; local?: string; origin?: string } = {}): Promise<string> {
  const fetcher = options.fetch ?? fetch, clock = options.clock ?? systemClock, origin = options.origin ?? REPORT_ORIGIN;
  const tokensUrl = `${origin}/api/chains/${CHAIN_ID}/tokens`;
  const catalog = options.local ? readLocalTokens(options.local) : await getJson(fetcher, tokensUrl);
  if (!Array.isArray(catalog)) throw new Error("The token catalog is not a JSON array.");
  const coins = (catalog as TokenRecord[]).filter((token) => token?.nft && chainOf(token) === CHAIN_ID);
  const now = clock.now();
  const lines = [`# NFT mode report: Robinhood Chain (${CHAIN_ID})`, "",
    `Generated ${new Date(now).toISOString()} from ${options.local ? "a local store (read-only)" : tokensUrl}.`, ""];

  // Launches by status and by collection.
  const statuses = ["verified", "unverified", "rejected"] as const;
  const count = (rows: TokenRecord[], status: string) => rows.filter((token) => statusOf(token) === status).length;
  lines.push("## Launches by status", "", "| Status | Coins |", "|---|---|",
    ...statuses.map((status) => `| ${status[0].toUpperCase()}${status.slice(1)} | ${count(coins, status)} |`), `| Total | ${coins.length} |`, "");
  const reasons = new Map<string, number>();
  for (const token of coins) if (statusOf(token) === "rejected") reasons.set(token.nftVerification?.reason ?? "unknown", (reasons.get(token.nftVerification?.reason ?? "unknown") ?? 0) + 1);
  if (reasons.size) lines.push(`Rejected by reason: ${[...reasons].map(([reason, total]) => `${reason} ${total}`).join(", ")}.`, "");
  const collections = new Map<string, TokenRecord[]>();
  for (const token of coins) {
    const key = token.nft!.contract.toLowerCase();
    collections.set(key, [...(collections.get(key) ?? []), token]);
  }
  // Muses are the verified collection (the committed allowlist); every other contract is an unverified collection.
  const ordered = [...collections].sort(([a, x], [b, y]) => Number(b === MUSES.contract.toLowerCase()) - Number(a === MUSES.contract.toLowerCase()) || y.length - x.length);
  lines.push("## Launches by collection", "", "| Collection | Label | Verified | Unverified | Rejected |", "|---|---|---|---|---|",
    ...ordered.map(([contract, rows]) => {
      const muses = contract === MUSES.contract.toLowerCase();
      return `| ${muses ? "Muses " : ""}${short(rows[0].nft!.contract)} | ${muses ? "verified collection" : "unverified collection"} | ${statuses.map((status) => count(rows, status)).join(" | ")} |`;
    }), "");

  // Paid launches: only a verified payment is ever stored on a record.
  const paid = coins.filter((token) => token.launchFee).length;
  lines.push("## Paid launches", "", "| Paid launches | USD collected |", "|---|---|", `| ${paid} | ${usd(paid * LAUNCH_FEE_USD)} |`, "",
    `Counted from records that carry a launch fee, at $${LAUNCH_FEE_USD} each.`, "");

  // Volume per NFT coin, throttled to the GeckoTerminal public limit.
  const throttle = rateLimiter(clock);
  const volumes: Volume[] = [];
  for (const token of coins) {
    await throttle();
    try {
      const raw = await getJson(fetcher, `${GECKO_ORIGIN}/api/v2/networks/robinhood/pools/${token.poolId}/ohlcv/day?aggregate=1&limit=30&currency=usd&token=${token.address}`);
      volumes.push(volumeFromCandles(parseCandles(raw, token, clock.now()).candles, clock.now()));
    } catch (error) { volumes.push((error as { status?: number }).status === 404 ? "not indexed" : "unavailable"); }
  }
  const cell = (volume: Volume, key: "sevenDay" | "thirtyDay") => typeof volume === "string" ? volume : usd(volume[key]);
  const indexed = volumes.filter((volume): volume is Exclude<Volume, string> => typeof volume !== "string");
  lines.push("## Volume per NFT coin (GeckoTerminal, USD)", "", "| Coin | NFT | Status | 7-day | 30-day |", "|---|---|---|---|---|",
    ...coins.map((token, index) => `| ${token.symbol} ${short(token.address)}${token.hidden ? " (hidden)" : ""} | ${nftLabel(token)} | ${statusOf(token)} | ${cell(volumes[index], "sevenDay")} | ${cell(volumes[index], "thirtyDay")} |`),
    "", `Totals over ${indexed.length} of ${coins.length} coins with data: 7-day ${usd(indexed.reduce((sum, volume) => sum + volume.sevenDay, 0))}, 30-day ${usd(indexed.reduce((sum, volume) => sum + volume.thirtyDay, 0))}. Days are UTC, today included.`, "");

  // MUSEGOD at the dead address.
  lines.push("## MUSEGOD burned", "");
  try {
    const stats = await getJson(fetcher, `${origin}/api/chains/${CHAIN_ID}/buyback/stats`) as { deadBalance?: unknown; decimals?: unknown; blockNumber?: unknown; burnAddress?: unknown };
    if (typeof stats.deadBalance !== "string" || !/^\d+$/.test(stats.deadBalance) || stats.decimals !== 18) throw new Error("malformed");
    const amount = Number(formatUnits(BigInt(stats.deadBalance), 18)).toLocaleString("en-US", { maximumFractionDigits: 2 });
    lines.push(`Dead-address balance: ${amount} MUSEGOD${typeof stats.blockNumber === "string" ? ` at block ${stats.blockNumber}` : ""}.`, "");
  } catch { lines.push("Dead-address balance: unavailable.", ""); }
  return lines.join("\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  if (!(args.length === 0 || (args.length === 2 && args[0] === "--local")))
    throw new Error("Usage: npm run report:nft [-- --local <store directory or launchpad.sqlite>]");
  try { console.log(await nftReport({ local: args[1] })); }
  catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
}
