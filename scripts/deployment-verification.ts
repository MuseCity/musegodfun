import { createHash } from "node:crypto";
import type { BuildInfo } from "../src/lib/build-info";

export const DEPLOYMENT_REPOSITORY = "https://github.com/MuseCity/musegodfun";
const apiRoot = "https://api.github.com/repos/MuseCity/musegodfun";
const shaPattern = /^[a-f0-9]{40}$/;
const digestPattern = /^[a-f0-9]{64}$/;
const versionPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const jsonLimit = 4 * 1024 * 1024;
const assetLimit = 64 * 1024 * 1024;
const archiveLimit = 256 * 1024 * 1024;
const assetHosts = new Set(["github.com", "release-assets.githubusercontent.com", "objects.githubusercontent.com"]);

export interface VerifiedBuildInfo extends BuildInfo {
  source: "github-actions";
  dirty: false;
  buildId: string;
  runUrl: string;
  releaseUrl: string;
}

export interface ReleaseRecord {
  schemaVersion: 1;
  commit: string;
  buildId: string;
  worker: "musegod-fun";
  workerVersionId: string;
  previousWorkerVersionId: string | null;
  files: { "build-info.json": string; "frontend.tar.gz": string };
}

export interface DeploymentVerificationOptions {
  release: string;
  origin: string;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
  githubToken?: string;
}

export interface DeploymentVerificationSummary {
  repository: string;
  release: string;
  origin: string;
  commit: string;
  buildId: string;
  workerVersionId: string;
  filesVerified: number;
  routesVerified: string[];
  bytesVerified: number;
  manifestSha256: string;
  archiveSha256: string;
}

type GitHubAsset = { name: string; browser_download_url: string; digest: string; size: number; state: string };
type Download = { bytes: Buffer; headers: Headers };

export function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function fail(message: string): never { throw new Error(message); }
function check(condition: unknown, message: string): asserts condition { if (!condition) fail(message); }
function object(value: unknown, label: string): Record<string, unknown> {
  check(value !== null && typeof value === "object" && !Array.isArray(value), `${label} must be an object`);
  return value as Record<string, unknown>;
}
function string(value: unknown, label: string): string {
  check(typeof value === "string", `${label} must be a string`);
  return value;
}
function parseJson(bytes: Buffer, label: string): unknown {
  try { return JSON.parse(bytes.toString("utf8")); }
  catch { return fail(`${label} is not valid JSON`); }
}
function hash(value: unknown, label: string): string {
  const result = string(value, label);
  check(digestPattern.test(result), `${label} must be a SHA-256 digest`);
  return result;
}

function parseBuildInfo(value: unknown, tag: string, commit: string): VerifiedBuildInfo {
  const data = object(value, "GitHub build-info.json");
  const [, runId, attempt] = tag.split("-");
  check(data.schemaVersion === 1, "Unsupported build-info.json schema version");
  check(data.repository === DEPLOYMENT_REPOSITORY, "Build repository does not match the trusted repository");
  check(data.commit === commit, "Build commit does not match the locked GitHub tag commit");
  check(data.source === "github-actions" && data.dirty === false, "Release must be a clean GitHub Actions build");
  check(data.buildId === tag, "Build ID does not match the release tag");
  check(data.runUrl === `${DEPLOYMENT_REPOSITORY}/actions/runs/${runId}/attempts/${attempt}`, "Build Actions run URL does not match the release tag");
  check(data.releaseUrl === `${DEPLOYMENT_REPOSITORY}/releases/tag/${tag}`, "Build release URL does not match the release tag");
  const files = object(data.files, "Build files");
  const entries = Object.entries(files);
  check(entries.length > 0 && entries.length <= 10_000, "Build must list 1 to 10000 files");
  check(Object.hasOwn(files, "/index.html"), "Build files must include /index.html");
  check(!Object.hasOwn(files, "/build-info.json"), "Build files must exclude /build-info.json itself");
  for (const [path, digest] of entries) {
    const url = new URL(path, "https://musegod.fun");
    check(path.startsWith("/") && !path.startsWith("//") && !path.includes("\\") &&
      url.origin === "https://musegod.fun" && url.pathname === path && !url.search && !url.hash,
    `Build file path is not a canonical absolute URL path: ${path}`);
    hash(digest, `Build file digest for ${path}`);
  }
  return data as unknown as VerifiedBuildInfo;
}

function parseReleaseRecord(value: unknown, tag: string, commit: string): ReleaseRecord {
  const data = object(value, "release.json");
  check(data.schemaVersion === 1, "Unsupported release.json schema version");
  check(data.commit === commit, "Release record commit does not match the locked GitHub tag commit");
  check(data.buildId === tag, "Release record build ID does not match the release tag");
  check(data.worker === "musegod-fun", "Release record must identify the musegod-fun Worker");
  check(versionPattern.test(string(data.workerVersionId, "Worker version ID")), "Worker version ID must be a UUID");
  check(data.previousWorkerVersionId === null ||
    (typeof data.previousWorkerVersionId === "string" && versionPattern.test(data.previousWorkerVersionId)),
  "Previous Worker version ID must be a UUID or null");
  const files = object(data.files, "Release record files");
  hash(files["build-info.json"], "Release manifest digest");
  hash(files["frontend.tar.gz"], "Release archive digest");
  return data as unknown as ReleaseRecord;
}

/** Trust GitHub's immutable release, rather than any identity supplied by the origin. */
export async function verifyDeployment(options: DeploymentVerificationOptions): Promise<DeploymentVerificationSummary> {
  check(/^build-[1-9][0-9]*-[1-9][0-9]*$/.test(options.release), "Release must use build-<runID>-<attempt>");
  const originUrl = new URL(options.origin);
  check(["https:", "http:"].includes(originUrl.protocol) && !originUrl.username && !originUrl.password &&
    originUrl.pathname === "/" && !originUrl.search && !originUrl.hash, "Origin must be an HTTP(S) origin without a path or credentials");
  const origin = originUrl.origin;
  const fetcher = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? 20_000;
  check(Number.isInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 60_000, "HTTP timeout must be 1 to 60000 milliseconds");
  const githubToken = options.githubToken?.trim();
  check(!githubToken || !/[\r\n]/.test(githubToken), "GitHub token must not contain line breaks");

  async function download(url: string, limit: number, kind: "api" | "asset" | "origin"): Promise<Download> {
    const signal = AbortSignal.timeout(timeoutMs);
    let current = url;
    for (let redirects = 0; ; redirects++) {
      const response = await fetcher(current, {
        redirect: "manual", signal,
        headers: kind === "api"
          ? { accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", "user-agent": "musegodfun-deployment-verifier",
            ...(githubToken ? { authorization: `Bearer ${githubToken}` } : {}) }
          : { accept: "*/*" },
      });
      // Node fetch decodes gzip/br transport compression; hash these decoded bytes.
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        await response.body?.cancel();
        check(kind === "asset" && location && redirects < 4, `Redirect is not allowed for ${current}`);
        const next = new URL(location, current);
        check(next.protocol === "https:" && assetHosts.has(next.hostname) && !next.username && !next.password,
          `Untrusted GitHub asset redirect: ${next.origin}`);
        current = next.href;
        continue;
      }
      if (response.status !== 200) {
        const diagnostic = kind === "origin"
          ? ["x-worker-version", "x-source-commit", "cf-cache-status", "cf-ray", "content-type"]
            .map(name => `${name}=${(response.headers.get(name) ?? "missing").slice(0, 128)}`).join(", ")
          : "";
        await response.body?.cancel();
        fail(`Expected HTTP 200 for ${current}, received ${response.status}${diagnostic ? ` (${diagnostic})` : ""}`);
      }
      check(!response.redirected && (!response.url || response.url === current), `Unexpected followed redirect for ${current}`);
      const reader = response.body?.getReader();
      if (!reader) return { bytes: Buffer.alloc(0), headers: response.headers };
      const chunks: Uint8Array[] = [];
      let length = 0;
      try {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          length += chunk.value.byteLength;
          check(length <= limit, `Response exceeds ${limit} bytes for ${current}`);
          chunks.push(chunk.value);
        }
      } catch (error) { await reader.cancel().catch(() => undefined); throw error; }
      finally { reader.releaseLock(); }
      return { bytes: Buffer.concat(chunks), headers: response.headers };
    }
  }
  async function api(path: string): Promise<unknown> {
    return parseJson((await download(`${apiRoot}${path}`, jsonLimit, "api")).bytes, "GitHub API response");
  }

  const tag = options.release;
  const release = object(await api(`/releases/tags/${encodeURIComponent(tag)}`), "GitHub release");
  check(release.tag_name === tag && release.draft === false && release.immutable === true,
    "GitHub release must be published, immutable, and match the requested tag");
  check(release.html_url === `${DEPLOYMENT_REPOSITORY}/releases/tag/${tag}`, "Unexpected GitHub release URL");
  let gitObject = object(object(await api(`/git/ref/tags/${encodeURIComponent(tag)}`), "GitHub tag ref").object, "GitHub tag object");
  for (let depth = 0; gitObject.type === "tag"; depth++) {
    check(depth < 4 && shaPattern.test(string(gitObject.sha, "Annotated tag SHA")), "Invalid or excessively nested annotated tag");
    gitObject = object(object(await api(`/git/tags/${gitObject.sha}`), "GitHub annotated tag").object, "GitHub tag target");
  }
  const commit = string(gitObject.sha, "GitHub tag commit");
  check(gitObject.type === "commit" && shaPattern.test(commit), "GitHub tag must resolve to a complete commit SHA");
  check(Array.isArray(release.assets), "GitHub release assets are missing");
  const requiredNames = ["build-info.json", "frontend.tar.gz", "release.json"] as const;
  const downloads = new Map<string, Buffer>();
  await Promise.all(requiredNames.map(async (name) => {
    const matches = (release.assets as unknown[]).filter((asset) => object(asset, "GitHub asset").name === name);
    check(matches.length === 1, `Release must have exactly one ${name} attachment`);
    const asset = object(matches[0], "GitHub asset") as unknown as GitHubAsset;
    check(asset.state === "uploaded", `GitHub attachment is not uploaded: ${name}`);
    check(asset.browser_download_url === `${DEPLOYMENT_REPOSITORY}/releases/download/${tag}/${name}`, `Untrusted GitHub attachment URL for ${name}`);
    const limit = name === "frontend.tar.gz" ? archiveLimit : jsonLimit;
    check(Number.isInteger(asset.size) && asset.size >= 0 && asset.size <= limit, `Invalid GitHub attachment size for ${name}`);
    check(typeof asset.digest === "string" && /^sha256:[a-f0-9]{64}$/.test(asset.digest), `GitHub SHA-256 attachment digest is missing for ${name}`);
    const { bytes } = await download(asset.browser_download_url, limit, "asset");
    check(bytes.length === asset.size, `GitHub attachment size mismatch for ${name}`);
    check(`sha256:${sha256(bytes)}` === asset.digest, `GitHub attachment digest mismatch for ${name}`);
    downloads.set(name, bytes);
  }));
  const manifestBytes = downloads.get("build-info.json")!;
  const archiveBytes = downloads.get("frontend.tar.gz")!;
  const buildInfo = parseBuildInfo(parseJson(manifestBytes, "GitHub build-info.json"), tag, commit);
  const record = parseReleaseRecord(parseJson(downloads.get("release.json")!, "release.json"), tag, commit);
  const manifestSha256 = sha256(manifestBytes), archiveSha256 = sha256(archiveBytes);
  check(manifestSha256 === record.files["build-info.json"], "Release record manifest digest mismatch");
  check(archiveSha256 === record.files["frontend.tar.gz"], "Release record archive digest mismatch");

  function verifyHeaders(headers: Headers, path: string) {
    check(headers.get("x-source-commit") === commit, `Source commit header mismatch for ${path}`);
    check(headers.get("x-worker-version") === record.workerVersionId, `Worker version header mismatch for ${path}`);
  }
  const onlineManifest = await download(`${origin}/build-info.json`, jsonLimit, "origin");
  verifyHeaders(onlineManifest.headers, "/build-info.json");
  check(onlineManifest.bytes.equals(manifestBytes), "Origin build-info.json bytes differ from the immutable GitHub manifest");
  const routesVerified = ["/", "/create"];
  for (const path of routesVerified) {
    const route = await download(`${origin}${path}`, assetLimit, "origin");
    verifyHeaders(route.headers, path);
    check(sha256(route.bytes) === buildInfo.files["/index.html"], `HTML digest mismatch for ${path}`);
  }
  const files = Object.entries(buildInfo.files);
  let nextFile = 0, bytesVerified = 0;
  await Promise.all(Array.from({ length: Math.min(4, files.length) }, async () => {
    while (nextFile < files.length) {
      const [path, digest] = files[nextFile++];
      const file = await download(`${origin}${path}`, assetLimit, "origin");
      if (path.endsWith(".html")) verifyHeaders(file.headers, path);
      check(sha256(file.bytes) === digest, `File digest mismatch for ${path}`);
      bytesVerified += file.bytes.length;
    }
  }));
  return { repository: DEPLOYMENT_REPOSITORY, release: tag, origin, commit, buildId: tag,
    workerVersionId: record.workerVersionId, filesVerified: files.length, routesVerified, bytesVerified,
    manifestSha256, archiveSha256 };
}
