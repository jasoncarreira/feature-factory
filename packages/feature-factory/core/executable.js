import { accessSync, constants, statSync } from "node:fs";
import { posix, win32 } from "node:path";

export function resolveSpawnExecutable(argv0, options = {}) {
  const windows = (options.platform ?? process.platform) === "win32", path = windows ? win32 : posix;
  const cwd = options.cwd ?? process.cwd(), env = options.env ?? process.env;
  const stat = options.stat ?? statSync, access = options.access ?? accessSync;
  const presentPath = windows ? Object.keys(env).find((key) => key.toLowerCase() === "path")
    : Object.hasOwn(env, "PATH") ? "PATH" : null;
  const source = windows ? (presentPath ? "Windows cwd and PATH" : "Windows cwd") : (presentPath ? "POSIX PATH" : `the POSIX default search path ${options.posixDefaultPath ?? "/usr/bin:/bin"}`);
  const direct = windows ? /[\\/]/u.test(argv0) : argv0.includes("/");
  const locations = direct ? [path.isAbsolute(argv0) ? argv0 : path.resolve(cwd, argv0)]
    : windows ? [cwd, ...(presentPath ? env[presentPath].split(";").map((entry) => path.resolve(cwd, entry || ".")) : [])]
      : (presentPath ? env.PATH : options.posixDefaultPath ?? "/usr/bin:/bin").split(":").map((entry) => path.resolve(cwd, entry || "."));
  const candidates = (direct ? locations : locations.map((location) => path.join(location, argv0))).flatMap((exact) =>
    windows && !path.extname(argv0) ? [exact, `${exact}.com`, `${exact}.exe`] : [exact]);
  for (const candidate of candidates) {
    if (windows && /\.(?:bat|cmd)$/iu.test(candidate)) continue;
    try {
      if (!stat(candidate).isFile()) continue;
      if (!windows) access(candidate, constants.X_OK);
      return { ok: true, path: candidate, source: direct ? "its direct path" : source };
    } catch {}
  }
  return { ok: false, reason: "not-executable", source: direct ? "its direct path" : source };
}
