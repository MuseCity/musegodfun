import assert from "node:assert/strict";
import { readFile, writeFile, readdir } from "node:fs/promises";
import { loadEnvironment } from "../server/config";
loadEnvironment();
const root = "http://127.0.0.1:5188";
const checks: string[] = [];
const call = async (path: string, body?: unknown, origin?: string) =>
  fetch(root + path, {
    method: body ? "POST" : "GET",
    headers: {
      "content-type": "application/json",
      ...(origin ? { origin } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
assert.equal((await call("/healthz")).status, 200);
checks.push("health");
const config = await (await call("/api/config")).json();
assert.equal(config.writesEnabled, process.env.ENABLE_MAINNET_TRANSACTIONS === "true");
assert(config.treasury);
checks.push("explicit browser signing configuration and valid treasury");
for (const rpcPath of ["/api/rpc", "/api/rpc/robinhood"])
for (const method of [
  "eth_sendTransaction",
  "eth_sendRawTransaction",
  "eth_sign",
  "personal_sign",
  "eth_signTypedData_v4",
])
  assert.equal(
    (await call(rpcPath, { jsonrpc: "2.0", id: 1, method, params: [] }))
      .status,
    403,
  );
checks.push("RPC proxy rejects every signing / broadcast method even when wallet signing is enabled");
assert.equal(
  (
    await call("/api/launch/track", {
      hash: "0x" + "1".repeat(64),
      planId: "0x" + "1".repeat(64),
    })
  ).status,
  422,
);
assert.equal(
  (
    await call(
      "/api/launch/register",
      { hash: "0x" + "1".repeat(64) },
      "https://evil.test",
    )
  ).status,
  403,
);
assert.equal(
  (await call("/api/launch/register", { hash: "0x" + "1".repeat(64) }, "null"))
    .status,
  403,
);
checks.push("cross-origin requests and unverifiable launch tracking rejected");
const page = await call("/");
assert(
  page.headers
    .get("content-security-policy")
    ?.includes("frame-ancestors 'none'"),
);
assert.equal(page.headers.get("x-frame-options"), "DENY");
assert.equal((await call("/does-not-exist")).status, 404);
checks.push("production headers and unknown route");
const texts = [
  JSON.stringify(config),
  await (await call("/api/stocks")).text(),
];
for (const f of await readdir("dist/assets"))
  if (f.endsWith(".js")) texts.push(await readFile("dist/assets/" + f, "utf8"));
for (const secret of [
  "ALCHEMY_API_KEY",
  "COINGECKO_API_KEY",
  "SUPABASE_SECRET_KEY",
  "SUPABASE_DB_URL",
  "PINATA_API_KEY",
  "PINATA_API_SECRET",
  "PINATA_JWT",
]
  .map((k) => process.env[k])
  .filter(Boolean))
  for (const text of texts)
    assert(
      !text.includes(secret!),
      "Secret must not occur in bundle/API error",
    );
checks.push("keys absent from production bundle and responses");
const ready = await call("/readyz");
const readiness = await ready.json();
await writeFile(
  "docs/evidence/runtime-http.json",
  JSON.stringify(
    {
      observedAt: new Date().toISOString(),
      checks,
      readiness,
      readyStatus: ready.status,
      mainnetVerified: readiness.status === "ready",
    },
    null,
    2,
  ),
);
console.log(
  `PASS: ${checks.length} runtime HTTP checks; readiness ${ready.status}`,
);
