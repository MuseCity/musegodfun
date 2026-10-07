import { DurableObject } from "cloudflare:workers";
import { httpServerHandler } from "cloudflare:node";
import { createServer } from "node:http";
import { createApp, knownPage, chainApiRoute, legacyTokenPath } from "../server/app";
import { redact, runtimeFromEnv } from "../server/config";
import { securityHeaders } from "../server/http-security";
import { IngressLimiter, PreviewQueue, RiskChallenge } from "../server/abuse";
import type { RuntimeEnvironment } from "../server/config";

interface Env {
  [name: string]: unknown;
  ASSETS: Fetcher;
  LAUNCHPAD: DurableObjectNamespace<LaunchpadRuntime>;
  CF_VERSION_METADATA: { id: string; tag?: string; timestamp: string };
  LIFI_INTEGRATOR?: string;
  LIFI_API_KEY?: string;
  BASE_FIRST_BUY_GUARD_ADDRESS?: string;
  ROBINHOOD_FIRST_BUY_GUARD_ADDRESS?: string;
  FIRST_BUY_GUARD_ADDRESS?: string;
}

export class LaunchpadRuntime extends DurableObject<Env> {
  private app!: ReturnType<typeof createApp>["app"];
  private service!: ReturnType<typeof createApp>["service"];
  private fingerprint = "";
  private readonly chainId: 4663 | 8453;
  private readonly ingress = new IngressLimiter();
  private readonly previews = new PreviewQueue();
  private readonly challenge = new RiskChallenge();
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const chainId = ctx.id.equals(env.LAUNCHPAD.idFromName("robinhood-mainnet")) ? 4663
      : ctx.id.equals(env.LAUNCHPAD.idFromName("base-mainnet")) ? 8453 : null;
    if (!chainId) throw new Error("Unknown launchpad runtime identity");
    this.chainId = chainId;
    this.refreshRuntime();
  }
  private refreshRuntime() {
    // Read native bindings on every request. Removed bindings never fall back to process.env.
    const environment: Record<string,string|undefined> = {};
    for (const [key,value] of Object.entries(this.env)) if(typeof value === "string") environment[key]=value;
    const fingerprint = JSON.stringify(Object.entries(environment).sort(([a],[b])=>a.localeCompare(b)));
    if (fingerprint === this.fingerprint) return;
    const runtime = runtimeFromEnv(this.chainId, environment as RuntimeEnvironment);
    if (runtime.config.mode === "fork" || !runtime.supabase?.url || !runtime.supabase.secretKey)
      throw new Error("Cloudflare requires a mainnet runtime and server-side Supabase storage");
    const { app, service } = createApp(undefined, true, runtime, { ingressManaged:true, previews:this.previews, challenge:this.challenge });
    this.service = service;
    this.app = app;
    this.fingerprint = fingerprint;
  }
  async fetch(request: Request): Promise<Response> {
    const admission = this.ingress.admit(request.headers.get("x-forwarded-for") || "unknown", new URL(request.url).pathname);
    if (admission.status) return Response.json({error:"Service capacity is temporarily limited. Try again shortly."},{status:admission.status,headers:{"Retry-After":"60"}});
    try {
      this.refreshRuntime();
      const headers=new Headers(request.headers);
      headers.set("x-runtime-risk",admission.challenge ? "challenge" : "normal");
      return await this.handleRequest(new Request(request,{headers}));
    } finally {admission.release();}
  }
  private async handleRequest(request: Request): Promise<Response> {
    if (await this.ctx.storage.getAlarm() === null)
      await this.ctx.storage.setAlarm(Date.now() + 30_000);
    // Drain the actual ingress stream before Node can reject a request early.
    // The adapter may otherwise continue reading it after sending the response.
    if (request.body) {
      const reader = request.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0, timedOut = false;
      const timeout = setTimeout(() => { timedOut = true; void reader.cancel(); }, 30_000);
      try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 65_536) {
          await reader.cancel();
          return Response.json({ error: "Request body is too large" }, { status: 413 });
        }
        chunks.push(value);
      }
      } finally { clearTimeout(timeout); }
      if (timedOut) return Response.json({ error: "Request timed out" }, { status: 408 });
      const body = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
      const headers = new Headers(request.headers);
      headers.set("content-length", String(size));
      request = new Request(request.url, { method: request.method, headers, body, signal: request.signal });
    }
    // Node's virtual port registry is isolate-wide, so each request owns a
    // temporary server rather than retaining a fixed port across DO eviction.
    const server = createServer(this.app);
    server.listen(0);
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("HTTP adapter did not start");
    const handler = httpServerHandler({ port: address.port });
    try {
      return await handler.fetch!(request as Parameters<NonNullable<typeof handler.fetch>>[0], this.env, this.ctx as unknown as ExecutionContext) as Response;
    } finally {
      server.close();
    }
  }
  async alarm() {
    try {
      this.refreshRuntime();
      await this.service.store.cleanup();
      await this.service.reconcile(60_000);
    } catch (error) {
      console.error(`Launchpad maintenance failed: ${redact(error, this.service.runtime.environment)}`);
    } finally {
      await this.ctx.storage.setAlarm(Date.now() + 30_000);
    }
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    let response: Response;
    if (url.pathname === "/api" || url.pathname.startsWith("/api/") || ["/healthz", "/readyz"].includes(url.pathname)) {
      let selected: ReturnType<typeof chainApiRoute>;
      try { selected = chainApiRoute(url.pathname); }
      catch { return Response.json({ error: "Unsupported deployment network" }, { status: 400, headers: securityHeaders(url.protocol === "https:") }); }
      const headers = new Headers(request.headers);
      // Replace caller-supplied proxy headers before Express trusts them.
      headers.delete("forwarded");
      headers.delete("x-runtime-risk");
      headers.set("x-forwarded-for", request.headers.get("cf-connecting-ip") || "127.0.0.1");
      headers.set("x-forwarded-proto", url.protocol.slice(0, -1));
      headers.set("x-forwarded-host", url.host);
      const chainId = selected?.chainId ?? 4663;
      const forwardedUrl = new URL(request.url);
      // Older DO versions recognize /readyz while code updates propagate.
      if (selected) forwardedUrl.pathname = selected.path === "/api/readyz" ? "/readyz" : selected.path;
      response = await env.LAUNCHPAD.get(env.LAUNCHPAD.idFromName(chainId === 8453 ? "base-mainnet" : "robinhood-mainnet"))
        .fetch(new Request(forwardedUrl, new Request(request, { headers })));
    } else {
      const redirect = legacyTokenPath(url.pathname);
      if (redirect && request.method === "GET") {
        url.pathname = redirect;
        return new Response(null, { status: 308, headers: { Location: url.toString(), ...securityHeaders(url.protocol === "https:"), "Cache-Control": "no-cache" } });
      }
      const assetUrl = new URL(request.url);
      if (knownPage(url.pathname)) assetUrl.pathname = "/index.html";
      response = await env.ASSETS.fetch(new Request(assetUrl, request));
      if (response.status === 404 && request.method === "GET") {
        assetUrl.pathname = "/index.html";
        const page = await env.ASSETS.fetch(new Request(assetUrl, request));
        response = new Response(page.body, { status: 404, headers: page.headers });
      }
    }
    const headers = new Headers(response.headers);
    for (const [key, value] of Object.entries(securityHeaders(url.protocol === "https:"))) headers.set(key, value);
    if (url.pathname === "/api" || url.pathname.startsWith("/api/")) headers.set("Cache-Control", "no-store");
    if (url.pathname === "/build-info.json" || headers.get("Content-Type")?.includes("text/html")) {
      headers.set("Cache-Control", url.pathname === "/build-info.json" ? "no-store" : "no-cache, max-age=0, must-revalidate");
      if (env.CF_VERSION_METADATA?.id) headers.set("X-Worker-Version", env.CF_VERSION_METADATA.id);
      if (/^[a-f0-9]{40}$/.test(env.CF_VERSION_METADATA?.tag || "")) headers.set("X-Source-Commit", env.CF_VERSION_METADATA.tag!);
    }
    if (url.pathname.startsWith("/assets/") && response.ok) headers.set("Cache-Control", "public, max-age=31536000, immutable");
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  },
} satisfies ExportedHandler<Env>;
