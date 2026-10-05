import { DurableObject } from "cloudflare:workers";
import { httpServerHandler } from "cloudflare:node";
import { createServer } from "node:http";
import { createApp, knownPage } from "../server/app";
import { redact, runtimeFromEnv } from "../server/config";
import { securityHeaders } from "../server/http-security";

interface Env {
  ASSETS: Fetcher;
  LAUNCHPAD: DurableObjectNamespace<LaunchpadRuntime>;
}

export class LaunchpadRuntime extends DurableObject<Env> {
  private readonly app;
  private readonly service;
  private activeRequests = 0;
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const runtime = runtimeFromEnv();
    if (runtime.config.mode !== "robinhood" || !process.env.SUPABASE_URL || !process.env.SUPABASE_SECRET_KEY)
      throw new Error("Cloudflare requires Robinhood mainnet and server-side Supabase storage");
    const { app, service } = createApp(undefined, true);
    this.service = service;
    this.app = app;
  }
  async fetch(request: Request): Promise<Response> {
    if (this.activeRequests >= 32)
      return Response.json({ error: "Service is busy. Try again later." }, { status: 503 });
    this.activeRequests++;
    try { return await this.handleRequest(request); }
    finally { this.activeRequests--; }
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
      await this.service.store.cleanup();
      await this.service.reconcile(60_000);
    } catch (error) {
      console.error(`Launchpad maintenance failed: ${redact(error)}`);
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
      const headers = new Headers(request.headers);
      // Replace caller-supplied proxy headers before Express trusts them.
      headers.delete("forwarded");
      headers.set("x-forwarded-for", request.headers.get("cf-connecting-ip") || "127.0.0.1");
      headers.set("x-forwarded-proto", url.protocol.slice(0, -1));
      headers.set("x-forwarded-host", url.host);
      response = await env.LAUNCHPAD.get(env.LAUNCHPAD.idFromName("robinhood-mainnet")).fetch(new Request(request, { headers }));
    } else {
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
    if (url.pathname.startsWith("/assets/") && response.ok) headers.set("Cache-Control", "public, max-age=31536000, immutable");
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  },
} satisfies ExportedHandler<Env>;
