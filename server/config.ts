import { validTreasury } from "../src/lib/validation";
import { networkName, type RuntimeConfig } from "../src/lib/config";
export function loadEnvironment() {
  try { process.loadEnvFile(".env"); }
  catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT")
      throw new Error("Unable to read server environment configuration");
  }
}
export function runtimeFromEnv(): { config: RuntimeConfig; rpcUrl: string; dataDir: string } {
  const rawMode = process.env.CHAIN_MODE || "robinhood";
  if (!["base", "robinhood", "fork"].includes(rawMode))
    throw new Error("CHAIN_MODE must be base, robinhood or fork");
  const mode = rawMode as RuntimeConfig["mode"];
  if (mode === "fork" && process.env.FORK_CHAIN_ID && !["8453", "4663"].includes(process.env.FORK_CHAIN_ID))
    throw new Error("FORK_CHAIN_ID must be 8453 or 4663");
  const deploymentChainId = mode === "fork" ? Number(process.env.FORK_CHAIN_ID || "8453") as 8453 | 4663 : mode === "robinhood" ? 4663 : 8453;
  const key = process.env.ALCHEMY_API_KEY?.trim();
  const rpcUrl = mode === "fork" ? process.env.FORK_RPC_URL || "http://127.0.0.1:8547"
    : key ? `https://${deploymentChainId === 4663 ? "robinhood-mainnet" : "base-mainnet"}.g.alchemy.com/v2/${encodeURIComponent(key)}`
    : deploymentChainId === 4663 ? process.env.ROBINHOOD_RPC_URL || "https://rpc.mainnet.chain.robinhood.com"
    : process.env.BASE_RPC_URL || "https://mainnet.base.org";
  const url = new URL(rpcUrl);
  if (mode === "fork" && !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))
    throw new Error("Fork RPC must be loopback");
  if (mode !== "fork" && url.protocol !== "https:") throw new Error("Mainnet RPC must use HTTPS");
  if (mode !== "fork" && process.env.NODE_ENV === "production" && (!process.env.SUPABASE_URL || !process.env.SUPABASE_SECRET_KEY))
    throw new Error("Production requires server-side Supabase configuration");
  const treasury = validTreasury(process.env.PLATFORM_TREASURY);
  if (process.env.PLATFORM_TREASURY && !treasury) throw new Error("Invalid PLATFORM_TREASURY address");
  const mainnetFlag = process.env.ENABLE_MAINNET_TRANSACTIONS;
  if (mainnetFlag && !["true", "false"].includes(mainnetFlag)) throw new Error("ENABLE_MAINNET_TRANSACTIONS must be true or false");
  if (mode !== "fork" && mainnetFlag === "true" && !treasury) throw new Error("Mainnet signing requires a valid PLATFORM_TREASURY");
  const writesEnabled = !!treasury && (mode === "fork" || mainnetFlag === "true");
  return {
    config: { mode, deploymentChainId, chainId: mode === "fork" ? 31337 : deploymentChainId, treasury, writesEnabled,
      blockReason: !treasury ? "The platform treasury is not configured. Browsing and drafts are available."
        : !writesEnabled ? "Mainnet is read-only. Connect a wallet to query balances and simulate issuance." : null },
    rpcUrl, dataDir: process.env.DATA_DIR || `.data/${mode}${mode === "fork" ? `-${deploymentChainId}` : ""}`,
  };
}
export function redact(value: unknown): string {
  let message = value instanceof Error ? value.message : String(value);
  if (/BASE_MAINNET is not enabled|ROBINHOOD_MAINNET is not enabled/.test(message))
    return `Enable ${networkName(runtimeFromEnv().config)} in the Alchemy application.`;
  for (const name of ["ALCHEMY_API_KEY", "COINGECKO_API_KEY", "BASE_RPC_URL", "ROBINHOOD_RPC_URL", "FORK_RPC_URL", "SUPABASE_SECRET_KEY", "SUPABASE_DB_URL", "PINATA_API_KEY", "PINATA_API_SECRET", "PINATA_JWT"]) {
    const secret = process.env[name];
    if (secret) message = message.split(secret).join("[redacted]");
  }
  return message.replace(/https?:\/\/[^\s"'<>]+/gi, "[upstream]").slice(0, 500);
}
