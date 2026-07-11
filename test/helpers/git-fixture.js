import { execFileSync, spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export { execFileSync, spawn, spawnSync };

export function runFixtureGit(cwd, args, { baseEnv = {} } = {}) {
  const fixtureConfigDirectory = mkdtempSync(join(tmpdir(), "feature-factory-git-fixture-"));
  const emptyGlobalConfigPath = join(fixtureConfigDirectory, "global.gitconfig");

  try {
    writeFileSync(emptyGlobalConfigPath, "", {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });

    return spawnSync("git", ["-c", "commit.gpgsign=false", ...args], {
      cwd,
      encoding: "utf8",
      shell: false,
      env: {
        ...process.env,
        ...baseEnv,
        GIT_CONFIG_GLOBAL: emptyGlobalConfigPath,
        GIT_CONFIG_NOSYSTEM: "1",
      },
    });
  } finally {
    rmSync(fixtureConfigDirectory, { recursive: true, force: true });
  }
}
