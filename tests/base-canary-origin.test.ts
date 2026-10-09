import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { request } from "node:http";
import { baseCanaryOriginGuard } from "../scripts/base-canary-server";

test("private canary checks the actual HTTPS host and origin before any signing handler", async () => {
  const origin = "https://base-canary.example", app = express();
  let prepared = 0;
  app.set("trust proxy", "loopback");
  app.use(baseCanaryOriginGuard(origin));
  app.post("/api/chains/8453/launch/prepare", (_req, res) => { prepared++; res.json({ accepted: true }); });
  app.get("/create", (_req, res) => res.send("private page"));
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const send = (path: string, headers: Record<string, string>, method = "GET") => new Promise<number>(resolve => {
    const req = request(`${base}${path}`, { method, headers }, res => { res.resume(); res.on("end", () => resolve(res.statusCode!)); });
    req.end();
  });
  try {
    const valid = { host: "base-canary.example", "x-forwarded-proto": "https", origin };
    assert.equal(await send("/api/chains/8453/launch/prepare", valid, "POST"), 200);
    assert.equal(prepared, 1);
    for (const headers of [
      { ...valid, host: "another.example", origin: "https://another.example" },
      { ...valid, host: "musegod.fun", origin: "https://musegod.fun" },
      { ...valid, origin: "https://another.example" },
      { ...valid, "x-forwarded-proto": "http" },
      { ...valid, "x-forwarded-proto": "https,http" },
      { ...valid, "x-forwarded-host": "another.example" },
      { host: "base-canary.example", origin },
    ]) {
      assert.equal(await send("/api/chains/8453/launch/prepare", headers, "POST"), 403);
      assert.equal(await send("/create", headers), 403);
    }
    assert.equal(prepared, 1, "rejected origins never reach the prepare handler");
    assert.equal(await send("/create", { host: "base-canary.example", "x-forwarded-host": "base-canary.example", "x-forwarded-proto": "https" }), 200);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});
