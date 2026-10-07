import { z } from "zod";
import { getAddress, isAddress, parseUnits, zeroAddress } from "viem";
import { DEAD, launchAssetsFor, stockByAddress, type RuntimeConfig } from "./config";
import { DEFAULT_TRADING_FEE_BPS, TRADING_FEE_BPS, tradingFeeBpsFor } from "./trading-fee";

export function assertSigningEnabled(config: RuntimeConfig) {
  if (!config.writesEnabled)
    throw new Error(config.blockReason || "Transactions are not enabled");
  if (!validTreasury(config.treasury || undefined))
    throw new Error("The platform treasury address is invalid. Signing is blocked.");
  const deployment = config.deploymentChainId ?? (config.mode === "robinhood" ? 4663 : 8453);
  if (
    !["base", "robinhood", "fork"].includes(config.mode) ||
    ![8453, 4663].includes(deployment) ||
    config.chainId !== (config.mode === "fork" ? 31337 : config.mode === "robinhood" ? 4663 : 8453) ||
    (config.mode !== "fork" && deployment !== config.chainId)
  )
    throw new Error("The signing network does not match the platform mode");
}

export const addressSchema = z
  .string()
  .refine((s) => isAddress(s, { strict: false }), "Enter a valid contract address")
  .transform((s) => getAddress(s));
export const hashSchema = z
  .string()
  .regex(/^0x[0-9a-fA-F]{64}$/, "Invalid transaction hash format");
export const amountSchema = z
  .string()
  .regex(
    /^(?:0|[1-9]\d{0,20})(?:\.\d{1,18})?$/,
    "Enter a decimal amount with up to 18 decimal places",
  );
const publicLink = (host?: "x" | "telegram") =>
  z
    .string()
    .trim()
    .max(500)
    .refine(
      (value) => !value || !!safeSocialLink(value, host),
      "Enter a valid public HTTPS URL. X and Telegram links must use their respective websites.",
    )
    .optional();
export const launchSchema = z
  .object({
    name: z.string().trim().min(1, "Enter a token name").max(32, "The name must be 32 characters or fewer"),
    symbol: z
      .string()
      .trim()
      .regex(
        /^[A-Za-z][A-Za-z0-9]{0,9}$/,
        "The symbol must contain 1–10 letters or digits and start with a letter",
      )
      .transform((s) => s.toUpperCase()),
    description: z.string().trim().max(280, "The description must be 280 characters or fewer"),
    image: z
      .string()
      .max(500)
      .refine((s) => !s || safeImage(s) !== "", "The image must use a public HTTPS URL"),
    website: publicLink(),
    twitter: publicLink("x"),
    telegram: publicLink("telegram"),
    tradingFeeBps: z.number().int().refine(
      (value) => TRADING_FEE_BPS.some((fee) => fee === value),
      "Select a supported trading fee between 1% and 3%",
    ).default(DEFAULT_TRADING_FEE_BPS),
    quoteAddress: addressSchema.refine((s) => {
      try {
        stockByAddress(s);
        return true;
      } catch {
        return false;
      }
    }, "Select a supported pairing asset"),
  })
  .strict();
// Persisted drafts and already broadcast plans may predate fee selection.
// Full validation fills their original 1% rate before constructing calldata.
export type LaunchInput = Omit<z.infer<typeof launchSchema>, "tradingFeeBps"> & { tradingFeeBps?: number };
export function restoreDraft(raw: string | null, config?: Pick<RuntimeConfig, "mode" | "deploymentChainId">): LaunchInput {
  const assets = launchAssetsFor(config);
  const draft: LaunchInput = {
    name: "",
    symbol: "",
    description: "",
    image: "",
    website: "",
    twitter: "",
    telegram: "",
    quoteAddress: assets[0].address,
    tradingFeeBps: DEFAULT_TRADING_FEE_BPS,
  };
  try {
    const saved = JSON.parse(raw || "null");
    if (!saved || typeof saved !== "object") return draft;
    try {
      draft.tradingFeeBps = tradingFeeBpsFor(saved.tradingFeeBps);
    } catch {
      // An invalid optional fee cannot discard the rest of an incomplete draft.
    }
    // A saved draft may be incomplete. Full launch validation belongs to preview.
    for (const [key, limit] of [
      ["name", 32],
      ["symbol", 10],
      ["description", 280],
      ["image", 500],
      ["website", 500],
      ["twitter", 500],
      ["telegram", 500],
    ] as const) {
      if (typeof saved[key] === "string")
        draft[key] = saved[key].slice(0, limit);
    }
    if (typeof saved.quoteAddress === "string") {
      // The initial render may precede /config. Preserve a recognized choice
      // until the active network arrives; its whitelist is checked again then.
      const asset = config ? assets.find((candidate) => candidate.address.toLowerCase() === saved.quoteAddress.toLowerCase())
        : stockByAddress(saved.quoteAddress);
      if (asset) draft.quoteAddress = asset.address;
    }
  } catch {
    /* Corrupt or unsupported stored fields fall back to the defaults. */
  }
  return draft;
}
export function safeImage(value: string): string {
  try {
    const u = new URL(value);
    return u.protocol === "https:" &&
      !u.username &&
      !u.password &&
      !/^(localhost|127\.|0\.|\[|10\.|192\.168\.|169\.254\.)/.test(u.hostname)
      ? u.href
      : "";
  } catch {
    return "";
  }
}
export function safeSocialLink(value: string, host?: "x" | "telegram"): string {
  const safe = safeImage(value);
  if (!safe) return "";
  const hostname = new URL(safe).hostname;
  if (
    host === "x" &&
    !["x.com", "www.x.com", "twitter.com", "www.twitter.com"].includes(hostname)
  )
    return "";
  if (host === "telegram" && hostname !== "t.me") return "";
  return safe;
}
export function validTreasury(value: string | undefined) {
  if (!value || !isAddress(value, { strict: false })) return null;
  const address = getAddress(value);
  return address === zeroAddress || address === DEAD ? null : address;
}
export function parseAmount(value: string, decimals: number): bigint {
  amountSchema.parse(value);
  if ((value.split(".")[1]?.length ?? 0) > decimals)
    throw new Error(`The amount supports up to ${decimals} decimal places`);
  const n = parseUnits(value, decimals);
  if (n <= 0n || n >= 2n ** 128n) throw new Error("The amount is outside the supported range");
  return n;
}
export function minimumOutput(amount: bigint, bps: number) {
  if (!Number.isInteger(bps) || bps < 1 || bps > 500)
    throw new Error("Slippage must be between 0.01% and 5%");
  const min = (amount * BigInt(10_000 - bps)) / 10_000n;
  if (min <= 0n) throw new Error("The quoted output is too small");
  return min;
}
export function errorMessage(error: unknown) {
  if (error instanceof z.ZodError)
    return error.issues[0]?.message ?? "Check your input";
  const e = error as { shortMessage?: string; message?: string; code?: number };
  if (e?.code === 4001) return "You cancelled the wallet request. You can make changes and try again.";
  const detail = e?.shortMessage || e?.message || "";
  if (
    /ContractPaused|PolicyUnauthorized|policy.*(rejected|denied)|transfer.*(blocked|restricted)/i.test(
      detail,
    )
  )
    return `Stock transfers are paused or restricted by the issuer. The transaction was not submitted. ${detail}`.slice(
      0,
      500,
    );
  return (e?.shortMessage || e?.message || "The action could not be completed. Try again.").slice(
    0,
    500,
  );
}

export function simulationError(error: unknown): Error {
  return new Error(
    `Transaction simulation failed. The transaction was not submitted. Check balances, slippage, and stock transfer restrictions or pauses. Retry if the network is unavailable. ${errorMessage(error)}`,
  );
}
