import { spawnSync } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { posix } from "node:path";

// Resolves argv[0] the way observe's shell-free spawn does, so a passing seed check cannot be followed by a
// spawn that fails for the same reason. POSIX only, and that boundary is enforced here rather than inferred:
// a first version approximated Windows lookup and did not match it, and simply deleting the branch was worse
// -- `observe` spawns cross-platform, nothing declares this package POSIX-only, so on Windows the check would
// have split `PATH` on `:` and disagreed with the spawn it exists to predict. A guard that cannot establish
// its claim must refuse, not guess.
export function resolveSpawnExecutable(argv0, options = {}) {
  const platform = options.platform ?? process.platform;
  if (platform === "win32") return { ok: false, reason: "unsupported-platform", platform };
  const cwd = options.cwd ?? process.cwd(), env = options.env ?? process.env;
  const stat = options.stat ?? statSync, access = options.access ?? accessSync;
  const defaultPath = options.posixDefaultPath ?? "/usr/bin:/bin", direct = argv0.includes("/");
  const searchPath = Object.hasOwn(env, "PATH") ? env.PATH : null;
  const source = searchPath === null ? `the POSIX default search path ${defaultPath}` : "POSIX PATH";
  // An empty PATH entry means the current directory, which is why `entry || "."` is not a no-op.
  const candidates = direct ? [posix.isAbsolute(argv0) ? argv0 : posix.resolve(cwd, argv0)]
    : (searchPath ?? defaultPath).split(":").map((entry) => posix.join(posix.resolve(cwd, entry || "."), argv0));
  for (const candidate of candidates) {
    try {
      if (!stat(candidate).isFile()) continue;
      access(candidate, constants.X_OK);
      return { ok: true, path: candidate, source: direct ? "its direct path" : source };
    } catch {}
  }
  return { ok: false, reason: "not-executable", source: direct ? "its direct path" : source };
}

// Whether `sh` would run the very executable a shell-free spawn of argv0 runs. `command -v` prints a path for an
// external command and only the bare word for a builtin, reserved word, or function, and a builtin can shadow an
// executable of the same name with different behaviour: GNU `printf --version` exits 0 and the `sh` builtin rejects
// it (review of #412). Anything the probe cannot establish answers false, which keeps two separate executions.
export function shellRunsSameExecutable(argv0, options = {}) {
  if (!argv0 || argv0.startsWith("-")) return false;
  const found = resolveSpawnExecutable(argv0, options);
  if (!found.ok) return false;
  const cwd = options.cwd ?? process.cwd();
  const probe = (options.spawn ?? spawnSync)("/bin/sh", ["-c", 'command -v "$1"', "sh", argv0],
    { cwd, env: options.env ?? process.env, encoding: "utf8" });
  const named = probe.status === 0 ? String(probe.stdout ?? "").trim() : "";
  return named.includes("/") && posix.resolve(cwd, named) === found.path;
}
