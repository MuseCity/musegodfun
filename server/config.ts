import { validTreasury } from "../src/lib/validation";
import type { RuntimeConfig } from "../src/lib/config";
import { CURVE_POLICY } from "../src/lib/launch-curve";
import { ENGINE_FEE_POLICY, FEE_POLICY } from "../src/lib/fee-policy";
import type { Address } from "viem";

export type DeploymentChainId = 8453 | 4663;
export type RuntimeEnvironment = Readonly<Record<string, string | undefined>>;
export type Runtime = {
  environment?: RuntimeEnvironment;
  secrets?: { pinataJwt?: string; coingeckoApiKey?: string; turnstileSecret?: string };
  turnstileSiteKey?: string;
  config: RuntimeConfig;
  rpcUrl: string;
  dataDir: string;
  dataScope: string;
  launchGuardCandidate: Address | null;
  firstBuyGuardCandidate: Address | null;
  supabase?: { url: string; secretKey: string };
  lifi: { integrator: string; apiKey?: string; budget?: Pick<import("./supabase-store").StoreBackend,"reserveBudget"|"blockBudget"> };
};
export function loadEnvironment() {
  try { process.loadEnvFile(".env"); }
  catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT")
      throw new Error("Unable to read server environment configuration");
  }
}
export function mainnetRpcUrl(chainId: DeploymentChainId, environment: RuntimeEnvironment = process.env): string {
  const key = environment.ALCHEMY_API_KEY?.trim();
  return key ? `https://${chainId === 4663 ? "robinhood-mainnet" : "base-mainnet"}.g.alchemy.com/v2/${encodeURIComponent(key)}`
    : chainId === 4663 ? environment.ROBINHOOD_RPC_URL || "https://rpc.mainnet.chain.robinhood.com"
    : environment.BASE_RPC_URL || "https://mainnet.base.org";
}
export function runtimeFromEnv(requestedChainId?: DeploymentChainId, environment: RuntimeEnvironment = process.env): Runtime {
  if (requestedChainId !== undefined && ![8453, 4663].includes(requestedChainId))
    throw new Error("Unsupported deployment network");
  const rawMode = environment.CHAIN_MODE || "robinhood";
  if (!["base", "robinhood", "fork"].includes(rawMode))
    throw new Error("CHAIN_MODE must be base, robinhood or fork");
  if (rawMode === "fork" && environment.FORK_CHAIN_ID && !["8453", "4663"].includes(environment.FORK_CHAIN_ID))
    throw new Error("FORK_CHAIN_ID must be 8453 or 4663");
  const mode: RuntimeConfig["mode"] = rawMode === "fork" ? "fork"
    : requestedChainId === undefined ? rawMode as RuntimeConfig["mode"]
    : requestedChainId === 4663 ? "robinhood" : "base";
  const deploymentChainId = mode === "fork" ? Number(environment.FORK_CHAIN_ID || "8453") as 8453 | 4663 : mode === "robinhood" ? 4663 : 8453;
  if (requestedChainId !== undefined && requestedChainId !== deploymentChainId)
    throw new Error("The requested network is unavailable in this local fork");
  const rpcUrl = mode === "fork" ? environment.FORK_RPC_URL || "http://127.0.0.1:8547"
    : mainnetRpcUrl(deploymentChainId, environment);
  const url = new URL(rpcUrl);
  if (mode === "fork" && !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))
    throw new Error("Fork RPC must be loopback");
  if (mode !== "fork" && url.protocol !== "https:") throw new Error("Mainnet RPC must use HTTPS");
  if (mode !== "fork" && environment.NODE_ENV === "production" && (!environment.SUPABASE_URL || !environment.SUPABASE_SECRET_KEY))
    throw new Error("Production requires server-side Supabase configuration");
  const treasuryValue = environment[deploymentChainId === 8453 ? "BASE_PLATFORM_TREASURY" : "ROBINHOOD_PLATFORM_TREASURY"]
    ?? environment.PLATFORM_TREASURY;
  const treasury = validTreasury(treasuryValue);
  if (treasuryValue && !treasury) throw new Error("Invalid PLATFORM_TREASURY address");
  const feeEngineValue = deploymentChainId === 4663 ? environment.FEE_ENGINE_ADDRESS : undefined;
  const feeEngine = validTreasury(feeEngineValue);
  if (feeEngineValue && !feeEngine) throw new Error("Invalid FEE_ENGINE_ADDRESS address");
  const mainnetFlag = deploymentChainId === 8453 ? environment.ENABLE_BASE_TRANSACTIONS
    : environment.ENABLE_ROBINHOOD_TRANSACTIONS ?? environment.ENABLE_MAINNET_TRANSACTIONS;
  if (mainnetFlag && !["true", "false"].includes(mainnetFlag)) throw new Error("ENABLE_MAINNET_TRANSACTIONS must be true or false");
  if (mode !== "fork" && mainnetFlag === "true" && !treasury) throw new Error("Mainnet signing requires a valid PLATFORM_TREASURY");
  const writesEnabled = !!treasury && (mode === "fork" || mainnetFlag === "true");
  const publicAddress = (value: string | undefined, label: string) => {
    const address = validTreasury(value);
    if (value && !address) throw new Error(`Invalid ${label} address`);
    return address;
  };
  const launchGuardCandidate = publicAddress(deploymentChainId === 8453 ? environment.BASE_LAUNCH_GUARD_ADDRESS
    : environment.ROBINHOOD_LAUNCH_GUARD_ADDRESS ?? environment.LAUNCH_GUARD_ADDRESS, "launch guard");
  const firstBuyGuardCandidate = publicAddress(deploymentChainId === 8453 ? environment.BASE_FIRST_BUY_GUARD_ADDRESS
    : environment.ROBINHOOD_FIRST_BUY_GUARD_ADDRESS ?? environment.FIRST_BUY_GUARD_ADDRESS, "first buy guard");
  const dataScope = requestedChainId === undefined && environment.NODE_ENV !== "production"
    ? environment.SUPABASE_DATA_SCOPE || mode : mode;
  const defaultDir = `.data/${mode}${mode === "fork" ? `-${deploymentChainId}` : ""}`;
  const dataDir = environment.DATA_DIR
    ? requestedChainId !== undefined && mode !== "fork" ? `${environment.DATA_DIR}/${mode}` : environment.DATA_DIR
    : defaultDir;
  return {
    config: { mode, deploymentChainId, chainId: mode === "fork" ? 31337 : deploymentChainId, treasury, writesEnabled, curvePolicy: CURVE_POLICY, launchGuard: null,
      launchLockAvailable: false,
      feeEngine, feePolicy: feeEngine ? ENGINE_FEE_POLICY : FEE_POLICY, buybackExecutor: null,
      blockReason: !treasury ? "The platform treasury is not configured. Browsing and drafts are available."
        : !writesEnabled ? "Mainnet is read-only. Connect a wallet to query balances and simulate issuance." : null },
    rpcUrl, dataDir, dataScope, launchGuardCandidate, firstBuyGuardCandidate,
    environment, secrets: { pinataJwt: environment.PINATA_JWT, coingeckoApiKey: environment.COINGECKO_API_KEY, turnstileSecret: environment.TURNSTILE_SECRET_KEY },
    turnstileSiteKey: environment.TURNSTILE_SITE_KEY,
    ...(mode !== "fork" && environment.SUPABASE_URL ? { supabase: {
      url: environment.SUPABASE_URL, secretKey: environment.SUPABASE_SECRET_KEY || "",
    } } : {}),
    lifi: { integrator: environment.LIFI_INTEGRATOR || "musegodfun", ...(environment.LIFI_API_KEY ? { apiKey: environment.LIFI_API_KEY } : {}) },
  };
}
export function redact(value: unknown, environment: RuntimeEnvironment = process.env): string {
  let message = value instanceof Error ? value.message : String(value);
  if (/BASE_MAINNET is not enabled|ROBINHOOD_MAINNET is not enabled/.test(message))
    return `Enable ${message.includes("BASE_MAINNET") ? "Base" : "Robinhood Chain"} in the Alchemy application.`;
  for (const name of ["ALCHEMY_API_KEY", "COINGECKO_API_KEY", "BASE_RPC_URL", "ROBINHOOD_RPC_URL", "FORK_RPC_URL", "SUPABASE_SECRET_KEY", "SUPABASE_DB_URL", "PINATA_API_KEY", "PINATA_API_SECRET", "PINATA_JWT", "LIFI_API_KEY", "TURNSTILE_SECRET_KEY", "MUSEGOD_DEPLOY_PRIVATE_KEY", "MUSEGOD_KEEPER_PRIVATE_KEY", "EVM_DY"]) {
    const secret = environment[name];
    if (secret?.trim()) message = message.replace(new RegExp(secret.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"), "[redacted]");
  }
  return message.replace(/https?:\/\/[^\s"'<>]+/gi, "[upstream]").slice(0, 500);
}
