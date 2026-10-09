import express from "express";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createDualChainApp, knownPage } from "../server/app";
import { loadEnvironment, runtimeFromEnv, redact, type RuntimeEnvironment } from "../server/config";

/** Check the actual ingress before routing any API or page. The loopback HTTPS
 * proxy must preserve the authorized Host; a config label alone is insufficient. */
export function baseCanaryOriginGuard(origin: string): express.RequestHandler {
  const authorized = new URL(origin);
  if (authorized.protocol !== "https:" || authorized.origin !== origin)
    throw new Error("A canonical private HTTPS origin is required.");
  return (req, res, next) => {
    const forwardedHost = req.headers["x-forwarded-host"];
    if (!req.secure || req.headers.host !== authorized.host ||
      forwardedHost !== undefined && forwardedHost !== authorized.host ||
      req.headers["x-forwarded-proto"] !== "https" ||
      req.headers.origin !== undefined && req.headers.origin !== origin) {
      res.status(403).json({ error: "The request is outside the authorized private Base canary origin." });
      return;
    }
    next();
  };
}

/** A private launch/control scope; financial source journals and the shared
 * Vault authority still use canonical Base/Robinhood scopes. */
export function baseCanaryRuntimes(environment: RuntimeEnvironment, origin?: string) {
  if (environment.NODE_ENV === "production" || environment.CHAIN_MODE !== "base" || environment.SUPABASE_DATA_SCOPE !== "verify-base-canary" ||
    !environment.DATA_DIR || !environment.SUPABASE_URL || !environment.SUPABASE_SECRET_KEY)
    throw new Error("Canary serving requires explicit nonproduction Base mode, verify-base-canary scope, isolated local directory and reviewed persistent Supabase storage.");
  const base = runtimeFromEnv(undefined, environment), robinhood = runtimeFromEnv(4663, environment);
  const url = origin ? new URL(origin) : null;
  if (!url || url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash ||
    ["musegod.fun", "www.musegod.fun"].includes(url.hostname))
    throw new Error("Canary serving requires an exact separately authorized private HTTPS origin.");
  base.canaryOrigin = url.origin;
  robinhood.config.writesEnabled = false;
  robinhood.config.blockReason = "This private canary origin exposes Robinhood reads only.";
  return [robinhood, base];
}
export async function runBaseCanaryServer(args = process.argv.slice(2)) {
  if (!args.length || args[0] === "--help") { console.log("Usage: npx tsx scripts/base-canary-server.ts --serve --origin=https://private-canary.example [--port=5196]\nOwner-authorized private canary origin only. Defaults to help; never resumes controls or signs. Bind is loopback; approved HTTPS forwarding and wallet access are owner-managed."); return; }
  if (!args.includes("--serve") || args.some(arg => arg !== "--serve" && !/^--port=\d+$/.test(arg) && !arg.startsWith("--origin="))) throw new Error("Use --serve with --origin and an optional --port.");
  loadEnvironment();
  const port = Number(args.find(arg => arg.startsWith("--port="))?.slice(7) ?? 5196);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("Invalid private canary port.");
  const runtimes = baseCanaryRuntimes(process.env, args.find(arg => arg.startsWith("--origin="))?.slice(9));
  const {app: dualChainApp,services} = createDualChainApp(app => {
    app.use(express.static(resolve("dist")));
    app.get("/{*path}", (req,res) => res.status(knownPage(req.path) ? 200 : 404).sendFile(resolve("dist/index.html")));
  }, "loopback", runtimes);
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", "loopback");
  app.use(baseCanaryOriginGuard(runtimes.find(runtime => runtime.config.chainId === 8453)!.canaryOrigin!));
  app.use(dualChainApp);
  // A scope label alone cannot enable signing: service.config verifies the
  // immutable graph and the governor's unexpired canary authorization.
  const config = await services.get(8453)!.config();
  if (!config.writesEnabled) throw new Error("Canary serving is blocked until Collector verification, owner approval and the isolated runtime CAS resume pass.");
  const server = app.listen(port,"127.0.0.1",()=>console.log(`Private Base canary: http://127.0.0.1:${port}/create?chainId=8453`));
  const stop = () => { server.close(()=>void Promise.all([...services.values()].map(async service=>{await service.vaultLedgerRuntime?.close();await service.store.close();})).finally(()=>process.exit())); };
  process.once("SIGINT",stop);process.once("SIGTERM",stop);
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  await runBaseCanaryServer().catch(error=>{console.error(redact(error));process.exitCode=1;});
