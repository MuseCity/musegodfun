import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { gzipSync } from "node:zlib";
import { once } from "node:events";
import { DEPLOYMENT_REPOSITORY, sha256, verifyDeployment, type ReleaseRecord, type VerifiedBuildInfo } from "../scripts/deployment-verification";

const commit = "a".repeat(40), tag = "build-12345-2";
const version = "12345678-1234-4567-89ab-123456789abc";
const previousVersion = "12345678-1234-4567-89ab-123456789abd";
const origin = "https://musegod.fun";
const apiRoot = "https://api.github.com/repos/MuseCity/musegodfun";
const downloadRoot = `${DEPLOYMENT_REPOSITORY}/releases/download/${tag}/`;

function byteResponse(bytes: Uint8Array, init?: ResponseInit) {
  return new Response(Uint8Array.from(bytes).buffer, init);
}

function fixture() {
  const bodies = new Map([
    ["/index.html", Buffer.from("<!doctype html><script src='/assets/app.js'></script>")],
    ["/assets/app.js", Buffer.from("console.log('committed frontend');")],
    ["/assets/app.css", Buffer.from("body { color: #123456; }")],
    ["/logo.svg", Buffer.from("<svg></svg>")],
  ]);
  const manifest: VerifiedBuildInfo = {
    schemaVersion: 1, repository: DEPLOYMENT_REPOSITORY, commit, source: "github-actions", dirty: false,
    buildId: tag, runUrl: `${DEPLOYMENT_REPOSITORY}/actions/runs/12345/attempts/2`,
    releaseUrl: `${DEPLOYMENT_REPOSITORY}/releases/tag/${tag}`,
    files: Object.fromEntries([...bodies].map(([path, body]) => [path, sha256(body)])),
  };
  const assets = new Map<string, Buffer>([["frontend.tar.gz", Buffer.from("fixture frozen frontend archive")]]);
  const record: ReleaseRecord = { schemaVersion: 1, commit, buildId: tag, worker: "musegod-fun",
    workerVersionId: version, previousWorkerVersionId: previousVersion,
    files: { "build-info.json": "", "frontend.tar.gz": "" } };
  function refresh() {
    assets.set("build-info.json", Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`));
    record.files["build-info.json"] = sha256(assets.get("build-info.json")!);
    record.files["frontend.tar.gz"] = sha256(assets.get("frontend.tar.gz")!);
    assets.set("release.json", Buffer.from(JSON.stringify(record)));
  }
  refresh();
  const requests: string[] = [];
  const overrides = new Map<string, () => Response>();
  const headers = { "x-source-commit": commit, "x-worker-version": version };
  const release = () => ({ tag_name: tag, draft: false, immutable: true,
    html_url: manifest.releaseUrl,
    assets: [...assets].map(([name, body]) => ({ name, state: "uploaded", size: body.length,
      digest: `sha256:${sha256(body)}`, browser_download_url: `${downloadRoot}${name}` })),
  });
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input);
    requests.push(url);
    assert.equal(init?.redirect, "manual");
    assert.ok(init?.signal instanceof AbortSignal);
    if (overrides.has(url)) return overrides.get(url)!();
    if (url === `${apiRoot}/releases/tags/${tag}`) return Response.json(release());
    if (url === `${apiRoot}/git/ref/tags/${tag}`) return Response.json({ object: { type: "commit", sha: commit } });
    if (url.startsWith(downloadRoot)) {
      const body = assets.get(url.slice(downloadRoot.length));
      return body ? byteResponse(body) : new Response(null, { status: 404 });
    }
    if (url === `${origin}/build-info.json`) return byteResponse(assets.get("build-info.json")!, { headers });
    if (url === `${origin}/` || url === `${origin}/create`) return new Response(bodies.get("/index.html")!, { headers });
    if (url.startsWith(origin)) {
      const body = bodies.get(url.slice(origin.length));
      return body ? new Response(body, { headers }) : new Response(null, { status: 404 });
    }
    throw new Error(`Unexpected fixture URL: ${url}`);
  };
  return { manifest, record, assets, bodies, requests, overrides, headers, refresh, fetcher, release };
}

test("deployment verification binds origin bytes and HTML routes to an immutable release and its actual tag", async () => {
  const data = fixture();
  const summary = await verifyDeployment({ release: tag, origin, fetch: data.fetcher });
  assert.equal(summary.commit, commit);
  assert.equal(summary.buildId, tag);
  assert.equal(summary.workerVersionId, version);
  assert.equal(summary.filesVerified, 4);
  assert.deepEqual(summary.routesVerified, ["/", "/create"]);
  assert.equal(summary.bytesVerified, [...data.bodies.values()].reduce((sum, body) => sum + body.length, 0));
  assert.ok(data.requests.includes(`${downloadRoot}frontend.tar.gz`));
  assert.ok(data.requests.includes(`${downloadRoot}release.json`));
  assert.ok(data.requests.includes(`${origin}/index.html`));
});

test("deployment verification resolves annotated GitHub tags to their commit", async () => {
  const data = fixture(), tagSha = "b".repeat(40);
  data.overrides.set(`${apiRoot}/git/ref/tags/${tag}`, () => Response.json({ object: { type: "tag", sha: tagSha } }));
  data.overrides.set(`${apiRoot}/git/tags/${tagSha}`, () => Response.json({ object: { type: "commit", sha: commit } }));
  assert.equal((await verifyDeployment({ release: tag, origin, fetch: data.fetcher })).commit, commit);
});

test("an optional GitHub token is sent only to repository API requests", async () => {
  const data = fixture(), token = "verification-test-token";
  const redirectedUrl = "https://release-assets.githubusercontent.com/github-production-release-asset/token-test";
  data.overrides.set(`${downloadRoot}frontend.tar.gz`, () => new Response(null, { status: 302, headers: { location: redirectedUrl } }));
  data.overrides.set(redirectedUrl, () => byteResponse(data.assets.get("frontend.tar.gz")!));
  const fetcher: typeof fetch = (input, init) => {
    const url = String(input), headers = new Headers(init?.headers);
    assert.equal(headers.get("authorization"), url.startsWith(`${apiRoot}/`) ? `Bearer ${token}` : null);
    return data.fetcher(input, init);
  };
  await verifyDeployment({ release: tag, origin, fetch: fetcher, githubToken: token });
  assert.ok(data.requests.some((url) => url === redirectedUrl));
});

test("public deployment verification works without authentication", async () => {
  const data = fixture();
  const fetcher: typeof fetch = (input, init) => {
    assert.equal(new Headers(init?.headers).get("authorization"), null);
    return data.fetcher(input, init);
  };
  await verifyDeployment({ release: tag, origin, fetch: fetcher });
});

test("deployment verification rejects a build's wrong SHA instead of trusting target_commitish", async () => {
  const data = fixture();
  data.manifest.commit = "b".repeat(40); data.refresh();
  await assert.rejects(verifyDeployment({ release: tag, origin, fetch: data.fetcher }), /Build commit.*locked GitHub tag/);
});

test("deployment verification rejects mutable releases and wrong run identities", async () => {
  const data = fixture();
  data.overrides.set(`${apiRoot}/releases/tags/${tag}`, () => Response.json({ ...data.release(), immutable: false }));
  await assert.rejects(verifyDeployment({ release: tag, origin, fetch: data.fetcher }), /immutable/);
  data.overrides.clear(); data.manifest.runUrl = `${DEPLOYMENT_REPOSITORY}/actions/runs/98765/attempts/2`; data.refresh();
  await assert.rejects(verifyDeployment({ release: tag, origin, fetch: data.fetcher }), /Actions run URL/);
});

test("deployment verification rejects origin manifest tampering or a cached earlier build", async () => {
  for (const body of [Buffer.from("{}"), Buffer.from(JSON.stringify({ ...fixture().manifest, commit: "b".repeat(40) }))]) {
    const data = fixture();
    data.overrides.set(`${origin}/build-info.json`, () => new Response(body, { headers: data.headers }));
    await assert.rejects(verifyDeployment({ release: tag, origin, fetch: data.fetcher }), /bytes differ.*GitHub manifest/);
  }
});

test("deployment verification rejects changed assets and stale route HTML", async () => {
  for (const path of ["/assets/app.js", "/", "/create"]) {
    const data = fixture();
    data.overrides.set(`${origin}${path}`, () => new Response("cached or replaced bytes", { headers: data.headers }));
    await assert.rejects(verifyDeployment({ release: tag, origin, fetch: data.fetcher }), /digest mismatch/);
  }
});

test("deployment verification rejects wrong or missing source and Worker headers", async () => {
  for (const [name, value] of [["x-worker-version", previousVersion], ["x-source-commit", "b".repeat(40)], ["x-worker-version", ""]]) {
    const data = fixture();
    data.overrides.set(`${origin}/build-info.json`, () => byteResponse(data.assets.get("build-info.json")!, {
      headers: { ...data.headers, [name]: value },
    }));
    await assert.rejects(verifyDeployment({ release: tag, origin, fetch: data.fetcher }), /header mismatch/);
  }
});

test("deployment verification rejects missing files, HTTP errors and same or cross-origin redirects", async () => {
  for (const response of [
    () => new Response(null, { status: 404 }),
    () => new Response(null, { status: 503 }),
    () => new Response(null, { status: 302, headers: { location: "/assets/old.js" } }),
    () => new Response(null, { status: 302, headers: { location: "https://other.example/app.js" } }),
  ]) {
    const data = fixture();
    data.overrides.set(`${origin}/assets/app.js`, response);
    await assert.rejects(verifyDeployment({ release: tag, origin, fetch: data.fetcher }), /HTTP 200|Redirect/);
  }
});

test("failed origin responses report Worker and cache metadata without accepting fallback HTML", async () => {
  const data = fixture();
  data.overrides.set(`${origin}/assets/app.css`, () => new Response("old fallback HTML", {
    status: 404, headers: { "x-worker-version": previousVersion, "cf-cache-status": "HIT", "content-type": "text/html" },
  }));
  await assert.rejects(verifyDeployment({ release: tag, origin, fetch: data.fetcher }), error => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /received 404/);
    assert.ok(error.message.includes(`x-worker-version=${previousVersion}`));
    assert.match(error.message, /cf-cache-status=HIT/);
    assert.match(error.message, /content-type=text\/html/);
    return true;
  });
});

test("deployment verification checks GitHub asset digests and release record hashes", async () => {
  const data = fixture();
  data.overrides.set(`${downloadRoot}frontend.tar.gz`, () => new Response(Buffer.from("altered bytes")));
  await assert.rejects(verifyDeployment({ release: tag, origin, fetch: data.fetcher }), /attachment size mismatch|attachment digest mismatch/);
  data.overrides.clear();
  data.record.files["frontend.tar.gz"] = "a".repeat(64);
  data.assets.set("release.json", Buffer.from(JSON.stringify(data.record)));
  await assert.rejects(verifyDeployment({ release: tag, origin, fetch: data.fetcher }), /record archive digest mismatch/);
});

test("deployment verification requires API asset digests and exact GitHub attachment URLs", async () => {
  for (const update of [
    { digest: null },
    { browser_download_url: "https://other.example/build-info.json" },
  ]) {
    const data = fixture();
    data.overrides.set(`${apiRoot}/releases/tags/${tag}`, () => {
      const release = data.release(); Object.assign(release.assets[0], update);
      return Response.json(release);
    });
    await assert.rejects(verifyDeployment({ release: tag, origin, fetch: data.fetcher }), /attachment digest|attachment URL/);
  }
});

test("deployment verification only permits known GitHub asset redirect hosts", async () => {
  const data = fixture(), redirectedUrl = "https://release-assets.githubusercontent.com/github-production-release-asset/fixture";
  data.overrides.set(`${downloadRoot}frontend.tar.gz`, () => new Response(null, { status: 302, headers: { location: redirectedUrl } }));
  data.overrides.set(redirectedUrl, () => byteResponse(data.assets.get("frontend.tar.gz")!));
  await verifyDeployment({ release: tag, origin, fetch: data.fetcher });
  data.overrides.set(`${downloadRoot}frontend.tar.gz`, () => new Response(null, { status: 302, headers: { location: "https://untrusted.example/archive" } }));
  await assert.rejects(verifyDeployment({ release: tag, origin, fetch: data.fetcher }), /Untrusted GitHub asset redirect/);
});

test("deployment verification rejects self references and paths that can leave the origin", async () => {
  for (const path of ["/build-info.json", "//other.example/file", "/assets/../file", "/asset.js?old=1"]) {
    const data = fixture(); data.manifest.files[path] = "a".repeat(64); data.refresh();
    await assert.rejects(verifyDeployment({ release: tag, origin, fetch: data.fetcher }), /exclude.*itself|canonical absolute URL path/);
  }
});

test("deployment verification limits resource concurrency to four", async () => {
  const data = fixture();
  for (let index = 0; index < 8; index++) {
    const path = `/assets/chunk-${index}.js`, body = Buffer.from(`chunk ${index}`);
    data.bodies.set(path, body); data.manifest.files[path] = sha256(body);
  }
  data.refresh();
  let active = 0, maximum = 0;
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.startsWith(`${origin}/assets/`)) {
      active++; maximum = Math.max(maximum, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      const result = await data.fetcher(input, init); active--; return result;
    }
    return data.fetcher(input, init);
  };
  const summary = await verifyDeployment({ release: tag, origin, fetch: fetcher });
  assert.equal(summary.filesVerified, 12);
  assert.equal(maximum, 4);
});

test("deployment verification hashes fetch-decoded gzip bytes from a real local HTTP response", async () => {
  const data = fixture();
  const server = createServer((request, response) => {
    const path = request.url!;
    const body = path === "/build-info.json" ? data.assets.get("build-info.json")!
      : data.bodies.get(path === "/" || path === "/create" ? "/index.html" : path);
    if (!body) { response.writeHead(404); response.end(); return; }
    response.writeHead(200, { ...data.headers, "content-encoding": "gzip" });
    response.end(gzipSync(body));
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const localOrigin = `http://127.0.0.1:${address.port}`;
  const fetcher: typeof fetch = (input, init) => String(input).startsWith(localOrigin)
    ? fetch(input, init) : data.fetcher(input, init);
  try {
    const summary = await verifyDeployment({ release: tag, origin: localOrigin, fetch: fetcher });
    assert.equal(summary.filesVerified, 4);
    assert.equal(summary.manifestSha256, sha256(data.assets.get("build-info.json")!));
  } finally {
    server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("deployment verification applies an HTTP timeout", async () => {
  const fetcher: typeof fetch = (_input, init) => new Promise((_resolve, reject) => {
    init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason), { once: true });
    // Keep the event loop active while the timeout signal's timer is unref'ed.
    setTimeout(() => reject(new Error("timeout signal was not applied")), 40).unref();
  });
  const keepAlive = setTimeout(() => undefined, 50);
  try { await assert.rejects(verifyDeployment({ release: tag, origin, fetch: fetcher, timeoutMs: 5 }), /timeout|aborted/i); }
  finally { clearTimeout(keepAlive); }
});
