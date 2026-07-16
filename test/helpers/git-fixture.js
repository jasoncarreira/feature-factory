import { ChildProcess, execFileSync, spawn, spawnSync } from "node:child_process";

export { ChildProcess, execFileSync, spawn, spawnSync };

// Every test process ignores host git configuration: host-level settings such
// as commit.gpgsign or init.defaultBranch must never change test behavior, and
// skipping the global/system config probes removes two file reads from every
// git spawn. Fixture git calls, production `git()` calls under test, and CLI
// subprocesses all inherit these through process.env.
process.env.GIT_CONFIG_GLOBAL = "/dev/null";
process.env.GIT_CONFIG_NOSYSTEM = "1";

export function runFixtureGit(cwd, args, { baseEnv = {} } = {}) {
  return spawnSync("git", ["-c", "commit.gpgsign=false", ...args], {
    cwd,
    encoding: "utf8",
    shell: false,
    env: {
      ...process.env,
      ...baseEnv,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
    },
  });
}
