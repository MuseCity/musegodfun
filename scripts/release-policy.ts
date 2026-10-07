import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { BuildInfo } from "../src/lib/build-info";
import { CURVE_POLICY } from "../src/lib/launch-curve";

export function assertReleaseCheckout(expected: string, actual: string, status: string): void {
  if (!/^[a-f0-9]{40}$/.test(expected) || actual !== expected)
    throw new Error("Release checkout must match the full event commit");
  if (status.trim()) throw new Error("Release checkout must be clean");
}

export const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

export function runtimeVarsFromBindings(bindings: { name: string; type: string; text?: unknown }[]): Record<string, string> {
  const actual: Record<string, string> = {};
  for (const binding of bindings.filter(binding => binding.type === "plain_text")) {
    if (typeof binding.text !== "string") throw new Error("Cannot inspect the existing Worker runtime variable configuration");
    actual[binding.name] = binding.text;
  }
  return actual;
}

export function assertLaunchRuntime(runtime: { curvePolicy?: string; launchGuard?: string | null; launchLockAvailable?: boolean },
  vars: Record<string, string>, required = true, chainId: 8453 | 4663 = 4663): void {
  const firstBuyGuard = chainId === 8453 ? vars.BASE_FIRST_BUY_GUARD_ADDRESS
    : vars.ROBINHOOD_FIRST_BUY_GUARD_ADDRESS ?? vars.FIRST_BUY_GUARD_ADDRESS;
  const fallbackGuard = chainId === 8453 ? vars.BASE_LAUNCH_GUARD_ADDRESS
    : vars.ROBINHOOD_LAUNCH_GUARD_ADDRESS ?? vars.LAUNCH_GUARD_ADDRESS;
  const expectedGuard = firstBuyGuard || fallbackGuard || null;
  // Older rollback versions can predate the curve handshake and guard support.
  if (!required && !expectedGuard) return;
  if (runtime.curvePolicy !== CURVE_POLICY || (expectedGuard
    ? runtime.launchGuard?.toLowerCase() !== expectedGuard.toLowerCase()
    : runtime.launchGuard !== null) || (firstBuyGuard && runtime.launchLockAvailable !== true))
    throw new Error(`Launch curve or verified guard runtime configuration does not match the release (${chainId}: expected guard ${expectedGuard ?? "none"}, received ${runtime.launchGuard ?? "none"}; lock ${runtime.launchLockAvailable ?? false})`);
}

export function snapshotBuild(directory: string): Record<string, string> {
  const files: Record<string, string> = {};
  const visit = (relative = "") => {
    for (const entry of readdirSync(join(directory, relative), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, "en"))) {
      const path = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) throw new Error(`Release artifact cannot contain a symbolic link: ${path}`);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) files[`/${path.split("/").map(encodeURIComponent).join("/")}`] = sha256(readFileSync(join(directory, path)));
      else throw new Error(`Release artifact is not a regular file: ${path}`);
    }
  };
  visit();
  return files;
}

export function assertFrozenBuild(directory: string, frozen: Record<string, string>): void {
  const actual = snapshotBuild(directory);
  if (JSON.stringify(actual) !== JSON.stringify(frozen)) throw new Error("Frozen frontend artifact changed; refusing publication or activation");
}

export function assertBuildManifest(info: BuildInfo, frozen: Record<string, string>): void {
  const expected = { ...frozen };
  delete expected["/build-info.json"];
  if (!expected["/index.html"] || JSON.stringify(info.files) !== JSON.stringify(expected))
    throw new Error("Build manifest does not describe every frozen frontend file");
}

export function requireSingleActiveVersion(deployment: { versions: { version_id: string; percentage: number }[] } | undefined): string {
  if (!deployment || deployment.versions.length !== 1 || deployment.versions[0].percentage !== 100 || !/^[a-f0-9-]{36}$/.test(deployment.versions[0].version_id))
    throw new Error("Automatic release requires one existing Worker version serving 100% traffic for rollback");
  return deployment.versions[0].version_id;
}


// Live emergency edits must not be silently overwritten by the unchanged Git default.
// Intentional changes committed on master remain fully automatic; the persistent
// pause record is independent and no release is allowed to update it.
export function assertSecurityTransition(previous: Record<string,string>, candidate: Record<string,string>, previousSource: Record<string,string>) {
  const values=(vars:Record<string,string>)=>({
    base:vars.ENABLE_BASE_TRANSACTIONS === "true" ? "true" : "false", robinhood:(vars.ENABLE_ROBINHOOD_TRANSACTIONS ?? vars.ENABLE_MAINNET_TRANSACTIONS) === "true" ? "true" : "false",
    baseTreasury:vars.BASE_PLATFORM_TREASURY ?? vars.PLATFORM_TREASURY ?? "", robinhoodTreasury:vars.ROBINHOOD_PLATFORM_TREASURY ?? vars.PLATFORM_TREASURY ?? "",
    baseGuard:vars.BASE_LAUNCH_GUARD_ADDRESS ?? "", robinhoodGuard:vars.ROBINHOOD_LAUNCH_GUARD_ADDRESS ?? vars.LAUNCH_GUARD_ADDRESS ?? "",
    baseFirstBuy:vars.BASE_FIRST_BUY_GUARD_ADDRESS ?? "", robinhoodFirstBuy:vars.ROBINHOOD_FIRST_BUY_GUARD_ADDRESS ?? vars.FIRST_BUY_GUARD_ADDRESS ?? "",
    feeEngine:vars.FEE_ENGINE_ADDRESS ?? "",
  });
  const live=values(previous),next=values(candidate),source=values(previousSource);
  for(const key of Object.keys(live) as (keyof typeof live)[]) {
    if(live[key].toLowerCase()!==source[key].toLowerCase() && next[key].toLowerCase()===source[key].toLowerCase())
      throw new Error(`Live security configuration drift would be overwritten: ${key}. Commit the intended configuration explicitly.`);
  }
}

// A rollback must understand the persisted stop record and cannot undo a
// newly committed emergency signing disable by selecting a more permissive build.
export function rollbackPreservesSafety(previous: Record<string,string>, candidate: Record<string,string>): boolean {
  if(previous.RUNTIME_SECURITY_PROTOCOL !== "1")return false;
  const enabled=(vars:Record<string,string>,chain:8453|4663)=>chain===8453 ? vars.ENABLE_BASE_TRANSACTIONS === "true"
    : (vars.ENABLE_ROBINHOOD_TRANSACTIONS ?? vars.ENABLE_MAINNET_TRANSACTIONS) === "true";
  return ([8453,4663] as const).every(chain=>!enabled(previous,chain) || enabled(candidate,chain));
}

export interface ReleaseLifecycle {
  commit: string;
  previousVersion: string;
  currentMaster(): Promise<string>;
  activeVersion(): Promise<string>;
  assertFrozen(): void;
  upload(): Promise<string>;
  publishRelease(candidate: string): Promise<void>;
  createDeployment(candidate: string): Promise<void>;
  status(state: "in_progress" | "success" | "failure" | "inactive", description: string): Promise<void>;
  activate(version: string): Promise<void>;
  verify(candidate: string): Promise<void>;
  verifyRollback(previous: string): Promise<void>;
  rollbackAllowed?(previous: string): Promise<boolean>;
}

export type RollbackStatus = "not_needed" | "verified" | "failed" | "external_change" | "blocked_by_safety";

export class ReleaseFailure extends Error {
  constructor(public readonly rollback: RollbackStatus, cause: unknown, public readonly rollbackError?: unknown) {
    super(`Release failed; rollback=${rollback}`, { cause });
  }
}

// Kept separate from API/CLI IO so ordering, stale pushes and rollback failure modes are testable.
export async function publishCandidate(flow: ReleaseLifecycle): Promise<"success" | "skipped"> {
  flow.assertFrozen();
  if (await flow.currentMaster() !== flow.commit) return "skipped";
  // A first protocol migration must establish a compatible paused baseline
  // before this automatic pipeline can replace all public traffic. Discovering
  // an unsafe rollback only after candidate activation leaves a broken site.
  if (flow.rollbackAllowed && !await flow.rollbackAllowed(flow.previousVersion))
    throw new ReleaseFailure("blocked_by_safety", new Error("Prepare and verify a protocol-compatible paused rollback baseline before uploading this release; production was not changed."));
  const candidate = await flow.upload();
  flow.assertFrozen();
  await flow.publishRelease(candidate);
  flow.assertFrozen();
  if (await flow.currentMaster() !== flow.commit) return "skipped";

  let deploymentCreated = false, activationAttempted = false;
  try {
    await flow.createDeployment(candidate);
    deploymentCreated = true;
    await flow.status("in_progress", "Immutable build published; activating Worker candidate");
    flow.assertFrozen();
    if (await flow.activeVersion() !== flow.previousVersion) throw new Error("Active Worker changed since the rollback point was captured");
    // Recheck immediately before activation, including pushes that arrived during publication/status IO.
    if (await flow.currentMaster() !== flow.commit) {
      await flow.status("inactive", "Skipped: master advanced before activation; production unchanged");
      return "skipped";
    }
    if (flow.rollbackAllowed && !await flow.rollbackAllowed(flow.previousVersion))
      throw new Error("The compatible rollback baseline is no longer safe; candidate activation was cancelled.");
    activationAttempted = true;
    await flow.activate(candidate);
    if (await flow.activeVersion() !== candidate) throw new Error("Candidate is not the single active Worker version");
    await flow.verify(candidate);
    await flow.status("success", "Both origins match the immutable build; readiness and runtime config passed");
    return "success";
  } catch (cause) {
    let rollback: RollbackStatus = "not_needed", rollbackError: unknown;
    if (activationAttempted) {
      try {
        const active = await flow.activeVersion();
        if (active === candidate && flow.rollbackAllowed && !await flow.rollbackAllowed(flow.previousVersion)) {
          rollback = "blocked_by_safety";
        } else if (active === candidate) {
          await flow.activate(flow.previousVersion);
          if (await flow.activeVersion() !== flow.previousVersion) throw new Error("Rollback version is not active at 100%");
          await flow.verifyRollback(flow.previousVersion);
          rollback = "verified";
        } else if (active !== flow.previousVersion) {
          // Do not overwrite an unrelated manual/external deployment.
          rollback = "external_change";
        }
      } catch (error) {
        rollback = "failed";
        rollbackError = error;
      }
    }
    if (deploymentCreated) {
      try {
        await flow.status("failure", `Release failed; rollback=${rollback}; previous=${flow.previousVersion}`);
      } catch (error) {
        rollbackError = rollbackError ?? error;
      }
    }
    throw new ReleaseFailure(rollback, cause, rollbackError);
  }
}
