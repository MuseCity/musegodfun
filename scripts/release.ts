import { execFileSync } from "node:child_process";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as waitForPropagation } from "node:timers/promises";
import type { BuildInfo } from "../src/lib/build-info";
import { readBuildIdentity, REPOSITORY } from "./build-info";
import { assertBuildManifest, assertFrozenBuild, assertLaunchRuntime, assertReleaseCheckout, publishCandidate, ReleaseFailure, requireSingleActiveVersion, runtimeVarsFromBindings, sha256, snapshotBuild } from "./release-policy";

const repositorySlug = "MuseCity/musegodfun", workerName = "musegod-fun";
const origins = ["https://musegod.fun", "https://www.musegod.fun"];
const apiVersion = "2026-03-10";

// CI alone tolerates a bounded edge propagation window. The standalone verifier stays strict.
export async function verifyProductionCandidate(candidate: string, checks: {
  activeVersion(): Promise<string>;
  assertFrozen(): void;
  verifyOrigin(origin: string): Promise<void>;
  describe(message: string): void;
  wait(milliseconds: number): Promise<unknown>;
}): Promise<void> {
  for (let attempt = 1; attempt <= 3; attempt++) {
    checks.assertFrozen();
    if (await checks.activeVersion() !== candidate) throw new Error("Candidate changed before production verification");
    let passed = false, failure: unknown;
    try {
      // Restart the whole pair on every attempt; results from different rounds cannot be combined.
      for (const origin of origins) await checks.verifyOrigin(origin);
      passed = true;
    } catch (error) { failure = error; }
    // Source/artifact changes and external activations never enter the retry path.
    checks.assertFrozen();
    if (await checks.activeVersion() !== candidate) throw new Error("Candidate changed during production verification");
    if (passed) return;
    const reason = failure instanceof Error ? failure.message : String(failure);
    checks.describe(`Production verification attempt ${attempt}/3 failed: ${reason}${attempt < 3 ? "; retrying both origins in 10 seconds" : "; retry budget exhausted"}`);
    if (attempt === 3) throw new Error("Production verification failed after 3 complete attempts", { cause: failure });
    await checks.wait(10_000);
  }
}

interface ReleaseAsset { id: number; name: string; digest: string; state: string; browser_download_url: string }
interface GitHubRelease { id: number; upload_url: string; tag_name: string; target_commitish: string; draft: boolean; immutable: boolean; html_url: string; assets: ReleaseAsset[] }
interface WorkerVersion {
  id: string;
  annotations?: Record<string, string>;
  resources: { bindings: { name: string; type: string; [key: string]: unknown }[]; script?: { migration_tag?: string } };
}
interface WranglerConfig {
  name: string; account_id: string; assets: { directory: string };
  migrations?: { tag: string }[]; build?: unknown; exports?: unknown;
  vars: Record<string, string>;
}

const git = (...args: string[]) => execFileSync("git", args, { encoding: "utf8" }).trim();
const required = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}; automatic publication must run in the configured GitHub workflow`);
  return value;
};

function frozenBuild() {
  const identity = readBuildIdentity();
  if (identity.source !== "github-actions" || !identity.buildId || !identity.runUrl || !identity.releaseUrl)
    throw new Error("Production publication only accepts a clean GitHub Actions master push build");
  assertReleaseCheckout(required("GITHUB_SHA"), git("rev-parse", "HEAD"), git("status", "--porcelain", "--untracked-files=all"));
  const directory = resolve("dist"), frozen = snapshotBuild(directory);
  const info = JSON.parse(readFileSync(join(directory, "build-info.json"), "utf8")) as BuildInfo;
  for (const [key, value] of Object.entries(identity)) {
    if (info[key as keyof BuildInfo] !== value) throw new Error(`Frozen build identity differs from the checkout: ${key}`);
  }
  assertBuildManifest(info, frozen);
  return { identity, info, directory, frozen };
}

async function request(url: string, init: RequestInit = {}): Promise<Response> {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${new URL(url).origin}${new URL(url).pathname}`);
  return response;
}

async function github<T>(path: string, body?: unknown, method = body === undefined ? "GET" : "POST"): Promise<T> {
  const response = await request(`https://api.github.com/repos/${repositorySlug}/${path}`, {
    method,
    headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${required("GITHUB_TOKEN")}`, "X-GitHub-Api-Version": apiVersion, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return await response.json() as T;
}

async function cloudflare<T>(account: string, path: string): Promise<T> {
  const response = await request(`https://api.cloudflare.com/client/v4/accounts/${account}/workers/${path}`, {
    headers: { Authorization: `Bearer ${required("CLOUDFLARE_API_TOKEN")}` },
  });
  const data = await response.json() as { success: boolean; result: T };
  if (!data.success || !data.result) throw new Error(`Cloudflare read-back failed for ${path}`);
  return data.result;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  return JSON.stringify(value);
}

function assertPreservedBindings(previous: WorkerVersion, candidate: WorkerVersion) {
  const select = (version: WorkerVersion, type: string) => version.resources.bindings.filter(binding => binding.type === type).sort((a, b) => a.name.localeCompare(b.name));
  if (canonical(select(previous, "durable_object_namespace")) !== canonical(select(candidate, "durable_object_namespace")))
    throw new Error("Automatic publication cannot change Durable Object namespaces or lifecycle");
  const secrets = (version: WorkerVersion) => select(version, "secret_text").map(binding => binding.name);
  if (canonical(secrets(previous)) !== canonical(secrets(candidate))) throw new Error("Automatic publication cannot add or remove secret bindings");
}

function wrangler(args: string[], env: NodeJS.ProcessEnv = {}) {
  // Only the version commands are used: routes, domains, schedules and secrets are never deployed here.
  execFileSync(resolve("node_modules/.bin/wrangler"), args, { stdio: "inherit", env: { ...process.env, ...env }, timeout: 300_000 });
}

export async function checkRuntime(origin: string, config: Pick<WranglerConfig, "vars">, requireLaunchPolicy = true) {
  const headers = { "Cache-Control": "no-cache" };
  // Keep the legacy Robinhood ingress checked. Older rollback versions do not
  // have scoped APIs, so only candidates must also pass both deployment scopes.
  const targets: (8453 | 4663 | null)[] = requireLaunchPolicy ? [null, 4663, 8453] : [null];
  for (const target of targets) {
    const chainId = target ?? 4663, prefix = target ? `/api/chains/${target}` : "/api";
    const readyPath = target ? `${prefix}/readyz` : "/readyz";
    const ready = await (await request(`${origin}${readyPath}`, { headers })).json() as { status: string; chainId: number; writesEnabled: boolean };
    const runtime = await (await request(`${origin}${prefix}/config`, { headers })).json() as { mode: string; chainId: number; deploymentChainId: number; treasury: string | null; writesEnabled: boolean; curvePolicy?: string; launchGuard?: string | null; launchLockAvailable?: boolean };
    const treasury = (config.vars[chainId === 8453 ? "BASE_PLATFORM_TREASURY" : "ROBINHOOD_PLATFORM_TREASURY"]
      ?? config.vars.PLATFORM_TREASURY) || null;
    const signingFlag = chainId === 8453 ? config.vars.ENABLE_BASE_TRANSACTIONS
      : config.vars.ENABLE_ROBINHOOD_TRANSACTIONS ?? config.vars.ENABLE_MAINNET_TRANSACTIONS;
    const writesEnabled = !!treasury && signingFlag === "true";
    if (ready.status !== "ready" || ready.chainId !== chainId || ready.writesEnabled !== writesEnabled ||
      runtime.mode !== (chainId === 8453 ? "base" : "robinhood") || runtime.chainId !== chainId ||
      runtime.deploymentChainId !== chainId || runtime.writesEnabled !== writesEnabled ||
      runtime.treasury?.toLowerCase() !== treasury?.toLowerCase())
      throw new Error(`Readiness/runtime configuration check failed for ${origin} (${chainId})`);
    assertLaunchRuntime(runtime, config.vars, requireLaunchPolicy, chainId);
  }
}

async function main() {
  const build = frozenBuild();
  if (process.argv.slice(2).length && process.argv[2] !== "--check-build") throw new Error("Usage: tsx scripts/release.ts [--check-build]");
  if (process.argv[2] === "--check-build") {
    console.log(`Frozen frontend manifest verified: ${build.identity.commit} (${Object.keys(build.info.files).length} files)`);
    return;
  }
  if (process.versions.node !== "24.11.1") throw new Error("Production publication requires the pinned Node 24.11.1 runtime");
  required("GITHUB_TOKEN"); required("CLOUDFLARE_API_TOKEN");
  const config = JSON.parse(readFileSync("wrangler.jsonc", "utf8")) as WranglerConfig;
  const account = required("CLOUDFLARE_ACCOUNT_ID");
  if (config.name !== workerName || config.account_id !== account || resolve(config.assets.directory) !== build.directory || config.build || config.exports)
    throw new Error("Automatic publication requires the existing Worker, frozen dist assets and no custom build/lifecycle step");
  const currentMaster = async () => (await github<{ object: { sha: string } }>("git/ref/heads/master")).object.sha;
  if (await currentMaster() !== build.identity.commit) {
    console.log("Skipped: master advanced; no candidate was uploaded or activated");
    return;
  }
  const activeVersion = async () => {
    const result = await cloudflare<{ deployments: { versions: { version_id: string; percentage: number }[] }[] }>(account, `scripts/${workerName}/deployments`);
    return requireSingleActiveVersion(result.deployments[0]);
  };
  const previousVersion = await activeVersion();
  const previous = await cloudflare<WorkerVersion>(account, `scripts/${workerName}/versions/${previousVersion}`);
  // Rollback is checked against the previous version's config, not this candidate's vars.
  const previousConfig: WranglerConfig = { ...config, vars: runtimeVarsFromBindings(previous.resources.bindings) };
  const service = await cloudflare<{ default_environment: { script: { migration_tag?: string } } }>(account, `services/${workerName}`);
  const migrationTag = service.default_environment.script.migration_tag;
  if ((config.migrations?.at(-1)?.tag ?? undefined) !== migrationTag)
    throw new Error("Pending Durable Object migration: apply it through a separately authorized migration release before using this workflow");

  const directory = mkdtempSync(join(tmpdir(), "musegod-release-"));
  const buildId = build.identity.buildId!, runUrl = build.identity.runUrl!, releaseUrl = build.identity.releaseUrl!;
  const archivePath = join(directory, "frontend.tar.gz");
  const manifestPath = join(directory, "build-info.json"), recordPath = join(directory, "release.json");
  writeFileSync(manifestPath, readFileSync(join(build.directory, "build-info.json")));
  execFileSync("tar", ["-czf", archivePath, "-C", build.directory, "."]);
  const manifestHash = sha256(readFileSync(manifestPath)), archiveHash = sha256(readFileSync(archivePath));
  let deploymentId: number | undefined;
  const describe = (message: string) => {
    console.log(message);
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${message}\n\n`);
  };
  const assertFrozen = () => {
    assertReleaseCheckout(build.identity.commit, git("rev-parse", "HEAD"), git("status", "--porcelain", "--untracked-files=all"));
    assertFrozenBuild(build.directory, build.frozen);
    if (sha256(readFileSync(manifestPath)) !== manifestHash || sha256(readFileSync(archivePath)) !== archiveHash)
      throw new Error("Frozen release attachment changed");
  };
  const activate = async (version: string) => {
    wrangler(["versions", "deploy", `${version}@100`, "--durable-objects-code-update-mode", "immediate", "--yes", "--message", `${version === previousVersion ? "Rollback" : "Publish"} ${buildId}`]);
  };
  try {
    const outcome = await publishCandidate({
      commit: build.identity.commit, previousVersion, currentMaster, activeVersion, assertFrozen,
      upload: async () => {
        const output = join(directory, "wrangler-upload.ndjson");
        wrangler(["versions", "upload", "--tag", build.identity.commit, "--message", buildId], { WRANGLER_OUTPUT_FILE_PATH: output });
        const records = readFileSync(output, "utf8").trim().split("\n").map(line => JSON.parse(line) as { type: string; worker_name: string; version_id?: string });
        const uploads = records.filter(record => record.type === "version-upload");
        if (uploads.length !== 1 || uploads[0].worker_name !== workerName || !/^[a-f0-9-]{36}$/.test(uploads[0].version_id || ""))
          throw new Error("Wrangler did not report exactly one candidate Worker version");
        const candidate = await cloudflare<WorkerVersion>(account, `scripts/${workerName}/versions/${uploads[0].version_id}`);
        if (candidate.id !== uploads[0].version_id || candidate.annotations?.["workers/tag"] !== build.identity.commit)
          throw new Error("Candidate version metadata does not match the source commit");
        assertPreservedBindings(previous, candidate);
        return candidate.id;
      },
      publishRelease: async (candidate) => {
        const record = {
          schemaVersion: 1, commit: build.identity.commit, buildId, worker: workerName,
          workerVersionId: candidate, previousWorkerVersionId: previousVersion,
          files: { "build-info.json": manifestHash, "frontend.tar.gz": archiveHash },
        };
        writeFileSync(recordPath, `${JSON.stringify(record, null, 2)}\n`);
        // Create the lightweight tag explicitly; never trust target_commitish when a tag already exists.
        await github("git/refs", { ref: `refs/tags/${buildId}`, sha: build.identity.commit });
        const draft = await github<GitHubRelease>("releases", {
          tag_name: buildId, target_commitish: build.identity.commit, name: buildId, draft: true, make_latest: "false",
          body: `Source: ${REPOSITORY}/commit/${build.identity.commit}\nBuild: ${runUrl}\nCloudflare candidate: ${candidate}\n\nThis is an immutable build record. Production status is recorded in GitHub Deployments after online verification.`,
        });
        const attachments = [manifestPath, archivePath, recordPath];
        for (const path of attachments) {
          const name = path.slice(path.lastIndexOf("/") + 1);
          const uploadUrl = new URL(draft.upload_url.replace(/\{.*$/, ""));
          if (uploadUrl.origin !== "https://uploads.github.com") throw new Error("Unexpected GitHub asset upload origin");
          uploadUrl.searchParams.set("name", name);
          const bytes = readFileSync(path);
          await request(uploadUrl.href, {
            method: "POST", headers: { Authorization: `Bearer ${required("GITHUB_TOKEN")}`, "X-GitHub-Api-Version": apiVersion, "Content-Type": name.endsWith(".gz") ? "application/gzip" : "application/json" }, body: bytes,
          });
        }
        await github(`releases/${draft.id}`, { draft: false, make_latest: "false" }, "PATCH");
        const published = await github<GitHubRelease>(`releases/tags/${buildId}`);
        const tag = await github<{ object: { type: string; sha: string } }>(`git/ref/tags/${buildId}`);
        if (published.draft || published.immutable !== true || published.tag_name !== buildId || published.html_url !== releaseUrl || tag.object.type !== "commit" || tag.object.sha !== build.identity.commit)
          throw new Error("Published Release must be immutable and its tag must lock the full source commit; enable repository Release immutability before publishing");
        if (published.assets.length !== attachments.length) throw new Error("Published Release asset inventory differs from the frozen build");
        for (const path of attachments) {
          const name = path.slice(path.lastIndexOf("/") + 1), hash = sha256(readFileSync(path));
          const asset = published.assets.find(item => item.name === name);
          if (!asset || asset.state !== "uploaded" || asset.digest !== `sha256:${hash}`) throw new Error(`Published Release digest mismatch: ${name}`);
          const url = new URL(asset.browser_download_url);
          if (url.origin !== "https://github.com" || !url.pathname.startsWith(`/${repositorySlug}/releases/download/${buildId}/`)) throw new Error("Unexpected public Release asset URL");
          const publicBytes = new Uint8Array(await (await request(url.href)).arrayBuffer());
          if (sha256(publicBytes) !== hash) throw new Error(`Public Release attachment byte mismatch: ${name}`);
        }
        describe(`Immutable build: ${releaseUrl}; candidate: ${candidate}; rollback point: ${previousVersion}`);
      },
      createDeployment: async (candidate) => {
        const deployment = await github<{ id: number }>("deployments", {
          ref: build.identity.commit, auto_merge: false, required_contexts: [], environment: "production", production_environment: true,
          description: `Publish ${buildId}`, payload: { buildId, releaseUrl, workerVersionId: candidate, previousWorkerVersionId: previousVersion },
        });
        deploymentId = deployment.id;
      },
      status: async (state, description) => {
        if (!deploymentId) throw new Error("GitHub Deployment was not created");
        await github(`deployments/${deploymentId}/statuses`, { state, description, log_url: runUrl, environment_url: origins[0], auto_inactive: state === "success" });
        describe(`Deployment ${deploymentId}: ${state}; ${description}`);
      },
      activate,
      verify: async (candidate) => verifyProductionCandidate(candidate, {
        activeVersion, assertFrozen, describe, wait: waitForPropagation,
        verifyOrigin: async (origin) => {
          execFileSync("npm", ["run", "verify:deployment", "--", "--release", buildId, "--origin", origin], { stdio: "inherit", timeout: 240_000 });
          await checkRuntime(origin, config);
        },
      }),
      verifyRollback: async (previous) => {
        for (const origin of origins) {
          const response = await request(`${origin}/`, { headers: { "Cache-Control": "no-cache" } });
          const version = response.headers.get("X-Worker-Version");
          if (version && version !== previous) throw new Error(`Rollback origin still serves a different Worker: ${origin}`);
          await checkRuntime(origin, previousConfig, false);
          describe(`Rollback origin checked: ${origin}; ${version ? `Worker ${version}` : "HTTP 200 (legacy version has no metadata header)"}`);
        }
      },
    });
    describe(outcome === "success" ? `Verified production deployment: ${buildId}` : `Skipped ${buildId}: master advanced; candidate was not activated`);
  } catch (error) {
    if (error instanceof ReleaseFailure) describe(`Release failure: rollback=${error.rollback}; previous=${previousVersion}; inspect the Deployment status and run logs`);
    throw error;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { await main(); }
  catch (error) {
    const describeError = (value: unknown) => {
      let text = value instanceof Error ? value.message : String(value);
      for (const secret of [process.env.GITHUB_TOKEN, process.env.CLOUDFLARE_API_TOKEN]) if (secret) text = text.replaceAll(secret, "[redacted]");
      console.error(text);
    };
    describeError(error);
    if (error instanceof ReleaseFailure) { describeError(error.cause); if (error.rollbackError) describeError(error.rollbackError); }
    process.exitCode = 1;
  }
}
