import { validTreasury } from "../src/lib/validation";
import type { RuntimeConfig } from "../src/lib/config";
import { CURVE_POLICY } from "../src/lib/launch-curve";
import { ENGINE_FEE_POLICY, FEE_POLICY } from "../src/lib/fee-policy";
import type { Address } from "viem";

export type DeploymentChainId = 8453 | 4663;
export type Runtime = {
  config: RuntimeConfig;
  rpcUrl: string;
  dataDir: string;
  dataScope: string;
  launchGuardCandidate: Address | null;
  firstBuyGuardCandidate: Address | null;
  supabase?: { url: string; secretKey: string };
  lifi: { integrator: string; apiKey?: string };
};
export function loadEnvironment() {
  try { process.loadEnvFile(".env"); }
  catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT")
      throw new Error("Unable to read server environment configuration");
  }
}
export function runtimeFromEnv(requestedChainId?: DeploymentChainId): Runtime {
  if (requestedChainId !== undefined && ![8453, 4663].includes(requestedChainId))
    throw new Error("Unsupported deployment network");
  const rawMode = process.env.CHAIN_MODE || "robinhood";
  if (!["base", "robinhood", "fork"].includes(rawMode))
    throw new Error("CHAIN_MODE must be base, robinhood or fork");
  if (rawMode === "fork" && process.env.FORK_CHAIN_ID && !["8453", "4663"].includes(process.env.FORK_CHAIN_ID))
    throw new Error("FORK_CHAIN_ID must be 8453 or 4663");
  const mode: RuntimeConfig["mode"] = rawMode === "fork" ? "fork"
    : requestedChainId === undefined ? rawMode as RuntimeConfig["mode"]
    : requestedChainId === 4663 ? "robinhood" : "base";
  const deploymentChainId = mode === "fork" ? Number(process.env.FORK_CHAIN_ID || "8453") as 8453 | 4663 : mode === "robinhood" ? 4663 : 8453;
  if (requestedChainId !== undefined && requestedChainId !== deploymentChainId)
    throw new Error("The requested network is unavailable in this local fork");
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
  const treasuryValue = process.env[deploymentChainId === 8453 ? "BASE_PLATFORM_TREASURY" : "ROBINHOOD_PLATFORM_TREASURY"]
    ?? process.env.PLATFORM_TREASURY;
  const treasury = validTreasury(treasuryValue);
  if (treasuryValue && !treasury) throw new Error("Invalid PLATFORM_TREASURY address");
  const feeEngineValue = deploymentChainId === 4663 ? process.env.FEE_ENGINE_ADDRESS : undefined;
  const feeEngine = validTreasury(feeEngineValue);
  if (feeEngineValue && !feeEngine) throw new Error("Invalid FEE_ENGINE_ADDRESS address");
  const mainnetFlag = deploymentChainId === 8453 ? process.env.ENABLE_BASE_TRANSACTIONS
    : process.env.ENABLE_ROBINHOOD_TRANSACTIONS ?? process.env.ENABLE_MAINNET_TRANSACTIONS;
  if (mainnetFlag && !["true", "false"].includes(mainnetFlag)) throw new Error("ENABLE_MAINNET_TRANSACTIONS must be true or false");
  if (mode !== "fork" && mainnetFlag === "true" && !treasury) throw new Error("Mainnet signing requires a valid PLATFORM_TREASURY");
  const writesEnabled = !!treasury && (mode === "fork" || mainnetFlag === "true");
  const publicAddress = (value: string | undefined, label: string) => {
    const address = validTreasury(value);
    if (value && !address) throw new Error(`Invalid ${label} address`);
    return address;
  };
  const launchGuardCandidate = publicAddress(deploymentChainId === 8453 ? process.env.BASE_LAUNCH_GUARD_ADDRESS
    : process.env.ROBINHOOD_LAUNCH_GUARD_ADDRESS ?? process.env.LAUNCH_GUARD_ADDRESS, "launch guard");
  const firstBuyGuardCandidate = publicAddress(deploymentChainId === 8453 ? process.env.BASE_FIRST_BUY_GUARD_ADDRESS
    : process.env.ROBINHOOD_FIRST_BUY_GUARD_ADDRESS ?? process.env.FIRST_BUY_GUARD_ADDRESS, "first buy guard");
  const dataScope = requestedChainId === undefined && process.env.NODE_ENV !== "production"
    ? process.env.SUPABASE_DATA_SCOPE || mode : mode;
  const defaultDir = `.data/${mode}${mode === "fork" ? `-${deploymentChainId}` : ""}`;
  const dataDir = process.env.DATA_DIR
    ? requestedChainId !== undefined && mode !== "fork" ? `${process.env.DATA_DIR}/${mode}` : process.env.DATA_DIR
    : defaultDir;
  return {
    config: { mode, deploymentChainId, chainId: mode === "fork" ? 31337 : deploymentChainId, treasury, writesEnabled, curvePolicy: CURVE_POLICY, launchGuard: null,
      launchLockAvailable: false,
      feeEngine, feePolicy: feeEngine ? ENGINE_FEE_POLICY : FEE_POLICY, buybackExecutor: null,
      blockReason: !treasury ? "The platform treasury is not configured. Browsing and drafts are available."
        : !writesEnabled ? "Mainnet is read-only. Connect a wallet to query balances and simulate issuance." : null },
    rpcUrl, dataDir, dataScope, launchGuardCandidate, firstBuyGuardCandidate,
    ...(mode !== "fork" && process.env.SUPABASE_URL ? { supabase: {
      url: process.env.SUPABASE_URL, secretKey: process.env.SUPABASE_SECRET_KEY || "",
    } } : {}),
    lifi: { integrator: process.env.LIFI_INTEGRATOR || "musegodfun", ...(process.env.LIFI_API_KEY ? { apiKey: process.env.LIFI_API_KEY } : {}) },
  };
}
export function redact(value: unknown): string {
  let message = value instanceof Error ? value.message : String(value);
  if (/BASE_MAINNET is not enabled|ROBINHOOD_MAINNET is not enabled/.test(message))
    return `Enable ${message.includes("BASE_MAINNET") ? "Base" : "Robinhood Chain"} in the Alchemy application.`;
  for (const name of ["ALCHEMY_API_KEY", "COINGECKO_API_KEY", "BASE_RPC_URL", "ROBINHOOD_RPC_URL", "FORK_RPC_URL", "SUPABASE_SECRET_KEY", "SUPABASE_DB_URL", "PINATA_API_KEY", "PINATA_API_SECRET", "PINATA_JWT", "LIFI_API_KEY", "MUSEGOD_DEPLOY_PRIVATE_KEY", "MUSEGOD_KEEPER_PRIVATE_KEY", "EVM_DY"]) {
    const secret = process.env[name];
    if (secret?.trim()) message = message.replace(new RegExp(secret.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"), "[redacted]");
  }
  return message.replace(/https?:\/\/[^\s"'<>]+/gi, "[upstream]").slice(0, 500);
}
