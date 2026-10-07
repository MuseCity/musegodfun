import express from "express";
import { securityHeaders } from "./http-security";
import { TokenImages } from "./token-images";
import { z } from "zod";
import type { Hex } from "viem";
import { LaunchpadService, runtimeFromEnv } from "./service";
import { mainnetRpcUrl, redact, type Runtime, type DeploymentChainId } from "./config";
import { deploymentChain } from "../src/lib/config";
import { FirstBuyPaymentReader } from "./lifi";
import { MarketUnavailable } from "./snapshots";
import { MarketReader } from "./market";
import { MusegodReader } from "./musegod";
import { MusegodMarketReader } from "./musegod-market";
import { CHART_INTERVALS } from "../src/lib/market";
import { BuybackReader, BuybackError } from "./buyback";
import { BuybackBatchService } from "./buyback-batches";
import { BuybackEngineReader } from "./buyback-engine";
import type { MUSEGODStats } from "../src/lib/buyback";
import {
  addressSchema,
  errorMessage,
  hashSchema,
  minimumOutput,
} from "../src/lib/validation";

export const knownPage = (path: string) =>
  /^\/(?:create|rewards|buyback)?$/.test(path) ||
  /^\/token\/(?:(?:base|robinhood)\/)?0x[0-9a-fA-F]{40}$/.test(path);

export function legacyTokenPath(path: string): string | null {
  return /^\/token\/0x[0-9a-fA-F]{40}$/.test(path)
    ? path.replace("/token/", "/token/robinhood/") : null;
}

export function chainApiRoute(path: string): { chainId: DeploymentChainId; path: string } | null {
  if (!path.startsWith("/api/chains")) return null;
  const match = /^\/api\/chains\/(8453|4663)(\/.*)?$/.exec(path);
  if (!match) throw new Error("Unsupported deployment network");
  const target = `/api${match[2] || ""}`;
  if (target === "/api/rpc/robinhood") throw new Error("Use the selected chain RPC endpoint");
  return { chainId: Number(match[1]) as DeploymentChainId, path: target };
}

export function createApp(
  configurePages?: (app: express.Express) => void,
  trustProxy: "loopback" | true = "loopback",
  runtime: Runtime = runtimeFromEnv(),
) {
const app = express(),
  service = new LaunchpadService(runtime);
const images = new TokenImages(process.env.PINATA_JWT);
const market = new MarketReader({
  store: service.store,
  apiKey: process.env.COINGECKO_API_KEY,
});
const musegod = new MusegodReader(service.client, service.runtime.config, () => service.assertNetwork());
const musegodMarket = new MusegodMarketReader(service.runtime.config, service.store);
const buyback = new BuybackReader(service.runtime.config.treasury);
const buybackBatches = new BuybackBatchService(buyback, service.store, service.client, service.runtime.config);
const buybackEngine = new BuybackEngineReader(service.client, () => service.config(), () => service.tokens(), (address, engine) => service.engineClaimPreview(address, engine));
const payments = new FirstBuyPaymentReader({ client: service.client, chainId: deploymentChain(runtime.config),
  rpcChainId: runtime.config.mode === "fork" && runtime.config.chainId === 31337 ? 31337 : deploymentChain(runtime.config), ...runtime.lifi });
app.set("trust proxy", trustProxy);
app.disable("x-powered-by");
app.set("json replacer", (_key: string, value: unknown) =>
  typeof value === "bigint" ? value.toString() : value,
);

app.use((req, res, next) => {
  for (const [key, value] of Object.entries(securityHeaders(req.secure, process.env.NODE_ENV === "production")))
    res.setHeader(key, value);
  if (
    req.method === "POST" &&
    req.headers.origin &&
    req.headers.origin !== `${req.protocol}://${req.headers.host}`
  ) {
    res.status(403).json({ error: "Cross-site request rejected" });
    return;
  }
  next();
});
// Bound expensive public RPC/simulation work. No caller-controlled upstream URLs.
const rate = new Map<string, { at: number; count: number; uploads: number }>();
app.use("/api", (req, res, next) => {
  for (const [ip, row] of rate)
    if (Date.now() - row.at > 60_000) rate.delete(ip);
  if (rate.size > 10000) {
    res.status(503).json({ error: "Service is busy" });
    return;
  }
  const key = req.ip || "local",
    now = Date.now(),
    row = rate.get(key);
  if (!row || now - row.at > 60_000) {
    rate.set(key, { at: now, count: 1, uploads: 0 });
    next();
    return;
  }
  if (++row.count > 180) {
    res.setHeader("Retry-After", "60");
    res.status(429).json({ error: "Too many requests. Try again later." });
    return;
  }
  next();
});
let activeRequests = 0;
app.use("/api", (_req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  if (activeRequests >= 32) {
    res.status(503).json({ error: "Service is busy. Try again later." });
    return;
  }
  activeRequests++;
  let released = false;
  const release = () => {
    if (!released) {
      released = true;
      activeRequests--;
    }
  };
  res.once("finish", release);
  res.once("close", release);
  next();
});
app.use(express.json({ limit: "64kb" }));
const route =
  (fn: (req: express.Request, res: express.Response) => Promise<unknown>) =>
  (req: express.Request, res: express.Response, next: express.NextFunction) => {
    Promise.resolve(fn(req, res)).catch(next);
  };
app.get("/healthz", (_req, res) => res.json({ status: "ok" }));
app.post("/api/token-images", route(async (req, res) => {
  const key = req.ip || "local", row = rate.get(key) || { at: Date.now(), count: 1, uploads: 0 };
  rate.set(key, row);
  if (++row.uploads > 10) {
    res.setHeader("Retry-After", "60");
    res.status(429).json({ error: "Too many image uploads. Try again in a minute." });
    return;
  }
  res.json(await images.upload(req.body));
}));
let readyCheck: Promise<boolean> | undefined,
  readyAt = 0;
app.get(
  ["/readyz", "/api/readyz"],
  route(async (_req, res) => {
    if (!readyCheck || Date.now() - readyAt > 15000) {
      readyAt = Date.now();
      readyCheck = Promise.all([
        service.assertNetwork(),
        service.store.health(),
      ])
        .then(() => true)
        .catch(() => false);
    }
    const ready = await readyCheck;
    res.status(ready ? 200 : 503).json({
      status: ready ? "ready" : "unavailable",
      chainId: service.runtime.config.chainId,
      writesEnabled: service.runtime.config.writesEnabled,
    });
  }),
);
app.get(
  "/api/market/summaries",
  route(async (req, res) => {
    const addresses = z
      .string()
      .max(1300)
      .parse(req.query.addresses)
      .split(",");
    if (addresses.length > 30) {
      res.status(400).json({ error: "At most 30 pools are allowed" });
      return;
    }
    res.json(
      await market.summaries(
        await Promise.all(
          [...new Set(addresses)].map((a) =>
            service.token(addressSchema.parse(a)),
          ),
        ),
      ),
    );
  }),
);
app.post(
  "/api/launch/track",
  route(async (req, res) => {
    const { hash, planId } = z
      .object({ hash: hashSchema, planId: hashSchema })
      .parse(req.body);
    if (
      (await service.store.pendingLaunches()).filter(
        (p) => p.status === "pending",
      ).length >= 100
    ) {
      res.status(429).json({ error: "The pending registration queue is full" });
      return;
    }
    await service.trackLaunch(hash as Hex, planId);
    res.status(202).json({ status: "pending" });
  }),
);
app.get("/api/config", route(async (_req, res) => res.json(await service.config())));
app.get("/api/first-buy/prices", route(async (req, res) => {
  const pairedAsset = req.query.pairedAsset === undefined ? undefined : addressSchema.parse(req.query.pairedAsset);
  res.json(await payments.prices(pairedAsset));
}));
app.post("/api/first-buy/quote", route(async (req, res) => {
  const input = z.object({ account: addressSchema, fromToken: addressSchema, toToken: addressSchema,
    amount: z.string().max(40), slippageBps: z.union([z.literal(50), z.literal(100), z.literal(200), z.literal(500)]) }).strict().parse(req.body);
  await service.preflightFirstBuyPayment(input.toToken);
  res.json(await payments.quote(input));
}));
app.post("/api/first-buy/verify", route(async (req, res) => {
  const input = z.object({ quote: z.unknown(), hash: hashSchema }).strict().parse(req.body);
  res.json(await payments.verify({ quote: input.quote as Parameters<FirstBuyPaymentReader["verify"]>[0]["quote"], hash: input.hash as Hex }));
}));
app.get("/api/first-buy-lock/:address", route(async (req, res) =>
  res.json(await service.firstBuyLock(addressSchema.parse(req.params.address))),
));
app.get("/api/buyback/engine", route(async (_req, res) => res.json(await buybackEngine.read())));
let engineQuoting = false;
app.post("/api/buyback/engine/quote", route(async (req, res) => {
  const input = z.object({ token: addressSchema, amount: z.string().regex(/^[1-9]\d{0,77}$/), caller: addressSchema }).strict().parse(req.body);
  if (engineQuoting) { res.status(429).json({ error: "Another conversion preview is in progress. Try again shortly." }); return; }
  engineQuoting = true;
  try { res.json(await buybackEngine.conversionQuote(input.token, input.amount, input.caller)); }
  finally { engineQuoting = false; }
}));
let buybackStats: MUSEGODStats | null = null;
let buybackStatsPending: Promise<MUSEGODStats> | null = null;
let buybackQuoting = false;
function requireBuybackMainnet() {
  throw new BuybackError("CROSS_CHAIN_DEFERRED", "Base fee bridging is deferred while Robinhood issuance is being validated.");
}
app.get("/api/buyback/stats", route(async (_req, res) => {
  if (service.runtime.config.mode === "fork") throw new BuybackError("FORK_UNAVAILABLE", "Fork assets cannot use mainnet data.");
  if (buybackStats && Date.now() - buybackStats.checkedAt < 30_000) {
    res.json(buybackStats);
    return;
  }
  buybackStatsPending ??= buyback.readMUSEGODStats()
    .then((result) => { buybackStats = result; return result; })
    .finally(() => { buybackStatsPending = null; });
  res.json(await buybackStatsPending);
}));
app.post("/api/buyback/quote", route(async (req, res) => {
  requireBuybackMainnet();
  const input = z.object({ stockAddress: addressSchema, amount: z.string().max(40) }).strict().parse(req.body);
  if (buybackQuoting) {
    res.status(429).json({ error: "Another buyback quote is being calculated. Try again later." });
    return;
  }
  buybackQuoting = true;
  try { res.json(await buyback.quote(input)); }
  finally { buybackQuoting = false; }
}));
const buybackKind = z.enum(["approval", "deposit", "burn"]);
app.get("/api/buyback/batches", route(async (_req, res) => {
  requireBuybackMainnet();
  res.json(await buybackBatches.list());
}));
app.post("/api/buyback/batches", route(async (req, res) => {
  requireBuybackMainnet();
  const input = z.object({
    stockAddress: addressSchema, amount: z.string().max(40),
    claimHashes: z.array(hashSchema.transform((value) => value as Hex)).max(20).optional(),
    authorization: z.object({
      nonce: hashSchema.transform((value) => value as Hex), expiresAt: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
      signature: z.string().regex(/^0x[0-9a-fA-F]{130}$/).transform((value) => value as Hex),
    }).strict(),
  }).strict().parse(req.body);
  const { authorization, ...budget } = input;
  res.json(await buybackBatches.prepare(budget, authorization));
}));
app.get("/api/buyback/batches/:id/step", route(async (req, res) => {
  requireBuybackMainnet();
  res.json(await buybackBatches.step(hashSchema.parse(req.params.id), buybackKind.parse(req.query.kind)));
}));
app.post("/api/buyback/batches/:id/track", route(async (req, res) => {
  requireBuybackMainnet();
  const body = z.object({ kind: buybackKind, hash: hashSchema }).strict().parse(req.body);
  res.json(await buybackBatches.track(hashSchema.parse(req.params.id), body.kind, body.hash));
}));
app.post("/api/buyback/batches/:id/reconcile", route(async (req, res) => {
  requireBuybackMainnet();
  res.json(await buybackBatches.reconcile(hashSchema.parse(req.params.id)));
}));
app.get(
  "/api/stocks",
  route(async (_req, res) => res.json(await service.stocks())),
);
app.get(
  "/api/tokens",
  route(async (_req, res) => res.json(await service.tokens())),
);
app.get("/api/musegod", route(async (_req, res) => res.json(await musegod.info())));
app.get("/api/musegod/market/:section", route(async (req, res) => {
  const section = z.enum(["summary", "candles", "trades"]).parse(req.params.section);
  res.json(section === "candles"
    ? await musegodMarket.candles(z.enum(CHART_INTERVALS).parse(req.query.interval || "1h"))
    : await musegodMarket[section]());
}));
app.post("/api/musegod/quote", route(async (req, res) => {
  const input = z.object({ side: z.enum(["buy", "sell"]), amount: z.string().max(100),
    slippageBps: z.number().int().min(1).max(500).default(100) }).strict().parse(req.body);
  res.json(await musegod.quote(input.side, input.amount, input.slippageBps));
}));
app.get(
  "/api/tokens/:address/market/:section",
  route(async (req, res) => {
    const token = await service.token(addressSchema.parse(req.params.address));
    const section = z
      .enum(["summary", "candles", "trades", "holders"])
      .parse(req.params.section);
    const value =
      section === "candles"
        ? await market.candles(
            token,
            z.enum(CHART_INTERVALS).parse(req.query.interval || "1h"),
          )
        : await market[section](token);
    res.json(value);
  }),
);
app.get(
  "/api/tokens/:address",
  route(async (req, res) =>
    res.json(await service.state(addressSchema.parse(req.params.address))),
  ),
);
let preparing = false;
app.post(
  "/api/launch/validate",
  route(async (req, res) => {
    const { creator, data } = z.object({
      creator: addressSchema,
      data: z.string().regex(/^0x(?:[0-9a-fA-F]{2})+$/).max(60_000),
    }).parse(req.body);
    res.json(await service.validateLaunch(creator, data as Hex));
  }),
);
app.post(
  "/api/launch/prepare",
  route(async (req, res) => {
    if (preparing) {
      res.status(429).json({ error: "Another preview is being calculated. Try again later." });
      return;
    }
    preparing = true;
    try {
      res.json(await service.prepare(req.body.draft, req.body.creator, req.body.expectedCurvePolicy, req.body.firstBuy));
    } finally {
      preparing = false;
    }
  }),
);
app.post("/api/launch/simulate", route(async (req, res) => {
  const { creator, data } = z.object({ creator: addressSchema,
    data: z.string().regex(/^0x(?:[0-9a-fA-F]{2})+$/).max(60_000) }).strict().parse(req.body);
  res.json(await service.simulateLaunch(creator, data as Hex));
}));
app.post(
  "/api/launch/register",
  route(async (req, res) =>
    res.json(await service.register(hashSchema.parse(req.body.hash) as Hex)),
  ),
);
app.post(
  "/api/quote",
  route(async (req, res) => {
    const input = z
      .object({
        address: addressSchema,
        side: z.enum(["buy", "sell"]),
        amount: z.string(),
        slippageBps: z.number().int().min(1).max(500),
      })
      .parse(req.body);
    const quote = await service.quote(
      input.address,
      input.side,
      input.amount,
      input.slippageBps,
    );
    minimumOutput(BigInt(quote.amountOut), input.slippageBps);
    res.json(quote);
  }),
);
app.get(
  "/api/fees/:address",
  route(async (req, res) =>
    res.json(
      await service.fees(
        addressSchema.parse(req.params.address),
        addressSchema.parse(req.query.account),
      ),
    ),
  ),
);
const readMethods = new Set([
  "eth_chainId",
  "eth_blockNumber",
  "eth_call",
  "eth_getBalance",
  "eth_getCode",
  "eth_getTransactionReceipt",
  "eth_getTransactionByHash",
  "eth_getBlockByNumber",
  "eth_getTransactionCount",
  "eth_estimateGas",
  "eth_gasPrice",
  "eth_maxPriorityFeePerGas",
  "eth_feeHistory",
]);
app.post(
  ["/api/rpc", "/api/rpc/robinhood"],
  route(async (req, res) => {
    const body = z
      .object({
        jsonrpc: z.literal("2.0"),
        id: z.union([z.string(), z.number()]),
        method: z.string(),
        params: z.array(z.unknown()).max(10).default([]),
      })
      .parse(req.body);
    if (!readMethods.has(body.method)) {
      res.status(403).json({
        jsonrpc: "2.0",
        id: body.id,
        error: { code: -32601, message: "Read-only RPC method allowlist" },
      });
      return;
    }
    try {
      let result: unknown;
      if (req.path === "/api/rpc/robinhood") {
        if (service.runtime.config.mode === "fork") throw new Error("A local fork cannot query mainnet through the secondary RPC.");
        if (service.runtime.config.chainId === 4663) result = await service.rpcRequest(body.method, body.params);
        else {
        const response = await fetch(mainnetRpcUrl(4663), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(25_000),
        });
        if (!response.ok) throw new Error("Robinhood RPC is temporarily unavailable");
        const data = await response.json() as { error?: unknown; result?: unknown };
        if (data.error) throw new Error("Robinhood on-chain query did not complete");
        result = data.result;
        }
      } else result = await service.rpcRequest(body.method, body.params);
      res.json({
        jsonrpc: "2.0",
        id: body.id,
        result,
      });
    } catch (error) {
      res.json({
        jsonrpc: "2.0",
        id: body.id,
        error: {
          code: -32000,
          message: redact(
            error instanceof z.ZodError ? errorMessage(error) : error,
          ),
        },
      });
    }
  }),
);
app.use("/api", (_req, res) => res.status(404).json({ error: "API endpoint not found" }));
configurePages?.(app);

app.use(
  (
    error: unknown,
    _req: express.Request,
    res: express.Response,
    _next: express.NextFunction,
  ) => {
    const status =
      error instanceof MarketUnavailable
        ? 503
        : error instanceof z.ZodError
          ? 400
          : 422;
    res.status(status).json({
      error: redact(error instanceof z.ZodError ? errorMessage(error) : error),
      ...(error instanceof BuybackError ? { code: error.code } : {}),
      ...(error instanceof MarketUnavailable
        ? {
            status: error.status,
            source: error.source,
            nextRefreshAt: error.nextRefreshAt,
          }
        : {}),
    });
  },
);
return { app, service };
}

export function createDualChainApp(
  configurePages?: (app: express.Express) => void,
  trustProxy: "loopback" | true = "loopback",
  runtimes: Runtime[] = process.env.CHAIN_MODE === "fork" ? [runtimeFromEnv()] : [runtimeFromEnv(4663), runtimeFromEnv(8453)],
) {
  const app = express();
  app.set("trust proxy", trustProxy);
  app.disable("x-powered-by");
  const chains = new Map(runtimes.map((runtime) => [deploymentChain(runtime.config), createApp(undefined, trustProxy, runtime)]));
  const legacy = chains.get(4663) ?? (runtimes[0]?.config.mode === "fork" ? chains.get(deploymentChain(runtimes[0].config)) : undefined);
  if (!legacy) throw new Error("A Robinhood runtime is required for legacy API routes");
  app.use((req, res, next) => {
    for (const [key, value] of Object.entries(securityHeaders(req.secure, process.env.NODE_ENV === "production"))) res.setHeader(key, value);
    let selected: ReturnType<typeof chainApiRoute>;
    try { selected = chainApiRoute(req.path); }
    catch { res.status(400).json({ error: "Unsupported deployment network" }); return; }
    if (selected) {
      const target = chains.get(selected.chainId);
      if (!target) { res.status(422).json({ error: "The requested network is unavailable in this local fork" }); return; }
      const query = req.url.includes("?") ? req.url.slice(req.url.indexOf("?")) : "";
      req.url = selected.path + query;
      target.app(req, res, next);
    } else if (req.path === "/api" || req.path.startsWith("/api/") || ["/healthz", "/readyz"].includes(req.path)) {
      legacy.app(req, res, next);
    } else next();
  });
  configurePages?.(app);
  return { app, services: new Map([...chains].map(([chainId, entry]) => [chainId, entry.service])) };
}
