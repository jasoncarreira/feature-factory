// The package boundary, asserted rather than intended: the OpenCode 2.0 adapter registers definitions in
// memory and reads run state, and never writes a file or spawns a process. Every run state change goes
// through the `factory` CLI, driven by the agents it registers.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const pkg = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const FORBIDDEN = [
  "writeFileSync", "writeFile", "appendFile", "renameSync", "rename(", "mkdirSync", "mkdir(", "rmSync",
  "unlinkSync", "unlink(", "copyFile", "cpSync", "truncate", "child_process", "execFile", "spawnSync", "spawn(", "exec(",
  "node:fs/promises", "transition(", "withRunJsonLock",
];

function sources(dir, found = []) {
  for (const entry of readdirSync(dir)) {
    if (["node_modules", "test", "dist"].includes(entry) || entry.startsWith(".")) continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) sources(path, found);
    else if ([".js", ".mjs", ".jsx"].some((extension) => entry.endsWith(extension))) found.push(path);
  }
  return found;
}

describe("OpenCode 2.0 adapter boundary", () => {
  it("writes no file, spawns no process, and changes run state only through the CLI", () => {
    const files = sources(pkg);
    assert.ok(files.some((path) => path.endsWith("plugin/index.js")) && files.some((path) => path.endsWith("tui/index.jsx")), "the scan reaches both entrypoints");
    const offenders = files.flatMap((path) => FORBIDDEN.filter((token) => readFileSync(path, "utf8").includes(token))
      .map((token) => `${path.slice(pkg.length + 1)} :: ${token}`));
    assert.deepEqual(offenders, []);

    // The skill is the V2 one: its session id comes from the context tool, and the run-session association
    // from plugin storage, not from V1's shell export or session titles.
    const skill = readFileSync(join(pkg, "skills", "feature", "SKILL.md"), "utf8");
    for (const v1 of ["FACTORY_SESSION_ID", "titled session", "flat task allow"]) assert.equal(skill.includes(v1), false, `the skill must not keep V1's ${v1}`);
    for (const v2 of ["# /feature — OpenCode 2.0 adapter", "`feature_factory_context` tool once and use the `sessionID` it reports",
      "OpenCode 2.0 enforces this list: each driver's `subagent` permission denies every target and then allows"]) {
      assert.ok(skill.includes(v2), `the skill must say: ${v2}`);
    }
    assert.equal(readFileSync(join(pkg, "skills", "feature", "WORKFLOW.md"), "utf8"),
      readFileSync(join(pkg, "..", "feature-factory", "WORKFLOW.md"), "utf8"), "the packaged workflow is the canonical one, byte for byte");
  });
});
