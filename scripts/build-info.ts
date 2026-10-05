import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { BuildIdentity, BuildInfo } from "../src/lib/build-info.ts";

export const REPOSITORY = "https://github.com/MuseCity/musegodfun";

export function readBuildIdentity(cwd = process.cwd(), env: NodeJS.ProcessEnv = process.env): BuildIdentity {
  const git = (...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
  const commit = git("rev-parse", "HEAD");
  if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error("Build requires a full Git commit SHA");
  const dirty = git("status", "--porcelain", "--untracked-files=all") !== "";
  if (env.GITHUB_ACTIONS === "true") {
    if (env.GITHUB_REPOSITORY !== "MuseCity/musegodfun" || env.GITHUB_REF !== "refs/heads/master" || env.GITHUB_EVENT_NAME !== "push")
      throw new Error("Release builds require a master push in MuseCity/musegodfun");
    if (commit !== env.GITHUB_SHA || dirty) throw new Error("Release source must be the clean event commit");
    if (!/^[1-9][0-9]*$/.test(env.GITHUB_RUN_ID || "") || !/^[1-9][0-9]*$/.test(env.GITHUB_RUN_ATTEMPT || ""))
      throw new Error("Release build requires valid GitHub run identifiers");
    const buildId = `build-${env.GITHUB_RUN_ID}-${env.GITHUB_RUN_ATTEMPT}`;
    return {
      schemaVersion: 1, repository: REPOSITORY, commit, source: "github-actions", dirty: false,
      buildId, runUrl: `${REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}/attempts/${env.GITHUB_RUN_ATTEMPT}`,
      releaseUrl: `${REPOSITORY}/releases/tag/${buildId}`,
    };
  }
  return { schemaVersion: 1, repository: REPOSITORY, commit, source: "local", dirty, buildId: null, runUrl: null, releaseUrl: null };
}

export function writeBuildInfo(directory: string, identity: BuildIdentity): BuildInfo {
  const files: Record<string, string> = {};
  const collect = (relative = "") => {
    for (const entry of readdirSync(join(directory, relative), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, "en"))) {
      const path = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) throw new Error(`Build output cannot contain a symbolic link: ${path}`);
      if (entry.isDirectory()) collect(path);
      else if (entry.isFile() && path !== "build-info.json") {
        // URI-encoded paths identify the exact public asset, including names with spaces.
        const urlPath = `/${path.split("/").map(encodeURIComponent).join("/")}`;
        files[urlPath] = createHash("sha256").update(readFileSync(join(directory, path))).digest("hex");
      }
    }
  };
  collect();
  if (!files["/index.html"]) throw new Error("Build output is missing index.html");
  const info: BuildInfo = { ...identity, files };
  writeFileSync(join(directory, "build-info.json"), `${JSON.stringify(info, null, 2)}\n`);
  return info;
}
