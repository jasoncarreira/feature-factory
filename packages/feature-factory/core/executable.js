import { accessSync, constants, statSync } from "node:fs";
import { posix } from "node:path";

// Resolves argv[0] the way observe's shell-free spawn does, so a passing seed check cannot be followed by a
// spawn that fails for the same reason. POSIX only, deliberately: a first version approximated Windows
// lookup and review was right that it did not match, and nothing else under `bin/`, `core/`, `state/` or
// `observe/` references `win32` with CI on ubuntu -- there is no Windows spawn here to be equivalent to, and
// a guard must not claim an equivalence it cannot establish.
export function resolveSpawnExecutable(argv0, options = {}) {
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
