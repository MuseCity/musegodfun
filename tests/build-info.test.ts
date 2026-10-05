import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { readBuildIdentity, writeBuildInfo } from "../scripts/build-info";

function repository() {
  const cwd = mkdtempSync(join(tmpdir(), "musegod-build-info-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("init", "-b", "master");
  writeFileSync(join(cwd, "source.txt"), "committed source\n");
  git("add", ".");
  git("-c", "user.name=Build test", "-c", "user.email=build-test@example.invalid", "-c", "commit.gpgsign=false", "commit", "-m", "fixture");
  const env = {
    GITHUB_ACTIONS: "true", GITHUB_EVENT_NAME: "push", GITHUB_REF: "refs/heads/master",
    GITHUB_REPOSITORY: "MuseCity/musegodfun", GITHUB_SHA: git("rev-parse", "HEAD"),
    GITHUB_RUN_ID: "123", GITHUB_RUN_ATTEMPT: "2",
  };
  return { cwd, env, dispose: () => rmSync(cwd, { recursive: true, force: true }) };
}

test("release identity binds the actual clean checkout and exact run attempt", () => {
  const fixture = repository();
  try {
    const identity = readBuildIdentity(fixture.cwd, fixture.env);
    assert.equal(identity.commit, fixture.env.GITHUB_SHA);
    assert.equal(identity.buildId, "build-123-2");
    assert.equal(identity.releaseUrl, "https://github.com/MuseCity/musegodfun/releases/tag/build-123-2");
    assert.equal(identity.runUrl, "https://github.com/MuseCity/musegodfun/actions/runs/123/attempts/2");
    assert.equal(identity.dirty, false);
    assert.throws(() => readBuildIdentity(fixture.cwd, { ...fixture.env, GITHUB_SHA: "0".repeat(40) }), /clean event commit/);
    assert.throws(() => readBuildIdentity(fixture.cwd, { ...fixture.env, GITHUB_EVENT_NAME: "pull_request" }), /master push/);
    assert.throws(() => readBuildIdentity(fixture.cwd, { ...fixture.env, GITHUB_RUN_ATTEMPT: "../1" }), /identifiers/);
    writeFileSync(join(fixture.cwd, "untracked-source.ts"), "export const extra = true;");
    assert.throws(() => readBuildIdentity(fixture.cwd, fixture.env), /clean event commit/);
    const local = readBuildIdentity(fixture.cwd, {});
    assert.equal(local.source, "local");
    assert.equal(local.dirty, true);
    assert.equal(local.releaseUrl, null);
  } finally { fixture.dispose(); }
});

test("manifest hashes every final asset and avoids self-reference", () => {
  const fixture = repository();
  try {
    const identity = readBuildIdentity(fixture.cwd, fixture.env);
    const out = join(fixture.cwd, "dist");
    mkdirSync(join(out, "assets"), { recursive: true });
    writeFileSync(join(out, "index.html"), "<html>release</html>");
    writeFileSync(join(out, "assets", "logo with space.svg"), "<svg/>");
    writeFileSync(join(out, "build-info.json"), "stale manifest");
    const info = writeBuildInfo(out, identity);
    assert.deepEqual(Object.keys(info.files), ["/assets/logo%20with%20space.svg", "/index.html"]);
    assert.equal(info.files["/index.html"], createHash("sha256").update("<html>release</html>").digest("hex"));
    const bytes = readFileSync(join(out, "build-info.json"));
    assert.deepEqual(JSON.parse(bytes.toString()), info);
    writeBuildInfo(out, identity);
    assert.deepEqual(readFileSync(join(out, "build-info.json")), bytes);
    symlinkSync("index.html", join(out, "leaked-file"));
    assert.throws(() => writeBuildInfo(out, identity), /symbolic link/);
  } finally { fixture.dispose(); }
});
