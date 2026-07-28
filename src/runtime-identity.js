import { createHash } from "node:crypto";
import { accessSync, constants, readFileSync, realpathSync, statSync } from "node:fs";
import { delimiter, dirname, isAbsolute, join, parse, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync as defaultSpawnSync } from "node:child_process";
import { containsRecognizedSensitiveFragment, isSensitiveValue } from "./hardening/sensitive-data.js";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const PACKAGE_NAME = "opencode-feature-factory";
const DEFAULT_UNIX_EXECUTABLE_PATH = "/usr/bin:/bin";
const HASH_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const UNSAFE_TERMINAL_TEXT = /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u;
const UNSAFE_TERMINAL_TEXT_GLOBAL = /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/gu;
// Short fragments are an obfuscation shape; longer release words delimit runs.
const SEPARATOR_FRAGMENT_RUN_PATTERN = /(?<![A-Za-z0-9])[A-Za-z0-9]{1,6}(?:[\s\p{P}\p{S}]+[A-Za-z0-9]{1,6})+(?![A-Za-z0-9])/gu;
export const RUNTIME_IDENTITY_SOURCE_MAX = 4096;
export const RUNTIME_IDENTITY_VERSION_MAX = 512;

export function resolveRuntimeIdentity(options = {}) {
  const packageRoot = realpathOrResolve(options.packageRoot || root);
  const pkg = readPackage(packageRoot);
  return normalizeRuntimeIdentity({
    schema_version: 1,
    plugin: fileIdentity(join(packageRoot, "src", "plugin.js"), pkg.version),
    package_cli: fileIdentity(join(packageRoot, "src", "cli.js"), pkg.version),
    cli: commandIdentity("feature-factory", options, false),
    opencode: commandIdentity("opencode", options, true),
  });
}

export function normalizeRuntimeIdentity(value = {}) {
  return {
    schema_version: 1,
    plugin: normalizeCliIdentity(value.plugin),
    package_cli: normalizeCliIdentity(value.package_cli),
    cli: normalizeCliIdentity(value.cli),
    opencode: normalizeCliIdentity(value.opencode),
  };
}

export function normalizeCliIdentity(value = {}) {
  const source = normalizeIdentityText(value?.source, RUNTIME_IDENTITY_SOURCE_MAX, { pathSegments: true });
  const hash = HASH_PATTERN.test(value?.hash ?? "") ? value.hash : null;
  if (source === null || hash === null) return { source: null, version: null, hash: null };
  return { source, version: normalizeRuntimeIdentityVersion(value?.version), hash };
}

export function normalizeRuntimeIdentityVersion(value) {
  return normalizeIdentityText(value, RUNTIME_IDENTITY_VERSION_MAX, { trim: true });
}

export function formatCliIdentity(value) {
  const identity = normalizeCliIdentity(value);
  return `source=${identity.source ?? "[unavailable]"} version=${identity.version ?? "[unavailable]"} hash=${identity.hash ?? "[unavailable]"}`;
}

export function isRuntimeIdentityTextSafe(value, maxLength) {
  return typeof value === "string"
    && value.length > 0
    && value.length <= maxLength
    && !UNSAFE_TERMINAL_TEXT.test(value)
    && value === value.normalize("NFC");
}

function fileIdentity(path, version) {
  try {
    const source = realpathSync(path);
    return { source, version, hash: hashFile(source) };
  } catch {
    return { source: null, version: normalizeIdentityText(version, RUNTIME_IDENTITY_VERSION_MAX, { trim: true }), hash: null };
  }
}

function commandIdentity(command, options, probeVersion) {
  const supplied = options.commandCandidates?.[command];
  const observed = supplied === undefined ? resolveCommand(command, options) : inspectExecutable(supplied, options.cwd);
  if (!observed) return { source: null, version: null, hash: null };
  return {
    source: observed.source,
    version: probeVersion ? commandVersion(observed.source, options) : packageVersionFor(observed.source),
    hash: observed.hash,
  };
}

function resolveCommand(command, options) {
  const env = options.env ?? process.env;
  const cwd = resolve(options.cwd ?? process.cwd());
  const path = Object.hasOwn(env, "PATH") && typeof env.PATH === "string"
    ? env.PATH
    : process.platform === "win32" ? process.env.PATH ?? "" : DEFAULT_UNIX_EXECUTABLE_PATH;
  for (const component of path.split(delimiter)) {
    const directory = component ? (isAbsolute(component) ? component : resolve(cwd, component)) : cwd;
    const suffixes = process.platform === "win32" ? String(env?.PATHEXT || ".EXE;.CMD;.BAT;.COM").split(";") : [""];
    for (const suffix of suffixes) {
      const candidate = join(directory, `${command}${suffix}`);
      const observed = inspectExecutable(candidate, cwd);
      if (observed) return observed;
    }
  }
  return null;
}

function inspectExecutable(candidate, cwd = process.cwd()) {
  if (typeof candidate !== "string" || !candidate) return null;
  try {
    const requested = isAbsolute(candidate) ? candidate : resolve(cwd, candidate);
    const source = realpathSync(requested);
    const stat = statSync(source);
    if (!stat.isFile()) return null;
    accessSync(source, constants.X_OK);
    return { source, hash: hashFile(source) };
  } catch {
    return null;
  }
}

function commandVersion(source, options) {
  try {
    const spawnSync = options.spawnSync ?? defaultSpawnSync;
    const result = spawnSync(source, ["--version"], {
      cwd: options.cwd ?? process.cwd(),
      encoding: "utf8",
      env: options.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: options.timeout ?? 10000,
      maxBuffer: options.maxBuffer ?? 1024 * 1024,
      shell: false,
    });
    if (result?.status !== 0) return null;
    return firstLine(result.stdout || result.stderr);
  } catch {
    return null;
  }
}

function packageVersionFor(source) {
  let directory = dirname(source);
  const filesystemRoot = parse(directory).root;
  while (directory !== filesystemRoot) {
    const pkg = readPackage(directory);
    if (pkg.name === PACKAGE_NAME) return pkg.version;
    directory = dirname(directory);
  }
  return null;
}

function readPackage(directory) {
  try {
    const path = join(directory, "package.json");
    if (statSync(path).size > 1024 * 1024) return { name: null, version: null };
    const value = JSON.parse(readFileSync(path, "utf8"));
    return {
      name: typeof value.name === "string" ? value.name : null,
      version: typeof value.version === "string" ? value.version : null,
    };
  } catch {
    return { name: null, version: null };
  }
}

function normalizeIdentityText(value, maxLength, { trim = false, pathSegments = false } = {}) {
  if (typeof value !== "string") return null;
  let normalized = value.normalize("NFC").replace(UNSAFE_TERMINAL_TEXT_GLOBAL, "?");
  if (trim) normalized = normalized.trim();
  if (!normalized || normalized.length > maxLength) return "[redacted]";
  const sensitive = isSensitiveValue(pathSegments ? `${normalized}#` : normalized)
    || containsSensitiveDelimitedToken(normalized)
    || (pathSegments
      ? normalized.split(/[\\/]/u).some(sensitivePathSegment)
      : containsSensitiveSeparatorComposite(normalized));
  return sensitive ? "[redacted]" : normalized;
}

function sensitivePathSegment(segment) {
  if (!segment) return false;
  if (containsSensitiveSeparatorComposite(segment)) return true;
  if (!isSensitiveValue(segment)) return false;
  return containsRecognizedSensitiveFragment(segment)
    || segment.split(/[-_.]+/u).some((part) => part && isSensitiveValue(part));
}

function containsSensitiveDelimitedToken(value) {
  return value.split(/[\s\p{P}\p{S}]+/u).some((token) => token && isSensitiveValue(token));
}

function containsSensitiveSeparatorComposite(value) {
  for (const match of value.matchAll(SEPARATOR_FRAGMENT_RUN_PATTERN)) {
    const reconstructed = match[0].split(/[\s\p{P}\p{S}]+/u).join("");
    if (isSensitiveValue(reconstructed)) return true;
  }
  return false;
}

function firstLine(value) {
  return String(value ?? "").split(/\r?\n/u).map((line) => line.trim()).find(Boolean) ?? null;
}

function realpathOrResolve(path) {
  try { return realpathSync(resolve(path)); } catch { return resolve(path); }
}

function hashFile(path) {
  return `sha256:${createHash("sha256").update(readFileSync(path)).digest("hex")}`;
}
