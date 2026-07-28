import { createHash } from "node:crypto";
import {
  accessSync,
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  opendirSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  statSync,
} from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, isAbsolute, join, parse, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync as defaultSpawnSync } from "node:child_process";
import { parseJsoncConfig } from "./config.js";
import { containsRecognizedSensitiveFragment, isSensitiveValue } from "./hardening/sensitive-data.js";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const PACKAGE_NAME = "opencode-feature-factory";
const DEFAULT_UNIX_EXECUTABLE_PATH = "/usr/bin:/bin";
const CONFIG_FILE_MAX = 1024 * 1024;
const RUNTIME_CLOSURE_MAX_ENTRIES = 1024;
const RUNTIME_CLOSURE_MAX_FILES = 512;
const RUNTIME_CLOSURE_MAX_BYTES = 16 * 1024 * 1024;
const RUNTIME_CLOSURE_DOMAIN = Buffer.from("opencode-feature-factory-runtime-closure-v1\0", "utf8");
const REQUIRED_RUNTIME_CLOSURE_PATHS = new Set([
  "package.json",
  "src/cli.js",
  "src/factory.js",
  "src/plugin.js",
  "src/opencode-plugin.js",
  "src/run-state.js",
  "src/validate.js",
  "assets/command/feature.md",
  "assets/skills/feature/SKILL.md",
  "assets/skills/feature/SCHEMA.md",
]);
const HASH_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const UNSAFE_TERMINAL_TEXT = /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u;
const UNSAFE_TERMINAL_TEXT_GLOBAL = /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/gu;
const SEPARATOR_FRAGMENT_RUN_PATTERN = /[A-Za-z0-9]+(?:[\s\p{P}\p{S}]+[A-Za-z0-9]+)+/gu;
export const RUNTIME_IDENTITY_SOURCE_MAX = 4096;
export const RUNTIME_IDENTITY_VERSION_MAX = 512;
export const RUNTIME_ADMISSION_ERROR_CODE = "RUNTIME_ADMISSION_FAILED";

export class RuntimeAdmissionError extends Error {
  constructor(message) {
    super(message);
    this.name = "RuntimeAdmissionError";
    this.code = RUNTIME_ADMISSION_ERROR_CODE;
  }
}

export function isRuntimeAdmissionError(error) {
  return error?.code === RUNTIME_ADMISSION_ERROR_CODE;
}

export function resolveRuntimeIdentity(options = {}) {
  return normalizeRuntimeIdentity(observeRuntimeIdentity(options));
}

export function admitRuntimeLaunch(options = {}) {
  const identity = observeRuntimeIdentity(options);
  assertMatchingConfiguredPackage(identity);
  assertMatchingPackageCli(identity);
  if (!completeFileIdentity(identity.opencode)) {
    throw admissionError("effective PATH opencode executable is unavailable; install OpenCode and ensure PATH resolves it before retrying");
  }
  return {
    package_plugin: { source: identity.package_plugin.source, hash: identity.package_plugin.hash },
    package_cli: { source: identity.package_cli.source, hash: identity.package_cli.hash },
    package_closure: { source: identity.package_closure.source, hash: identity.package_closure.hash },
    configured_plugin: { source: identity.configured_plugin.source, hash: identity.configured_plugin.hash },
    configured_package_cli: { source: identity.configured_package_cli.source, hash: identity.configured_package_cli.hash },
    configured_package_closure: { source: identity.configured_package_closure.source, hash: identity.configured_package_closure.hash },
    configured_local: identity.configured_local,
    opencode: { source: identity.opencode.source, hash: identity.opencode.hash },
  };
}

export function revalidateRuntimeLaunchBinding(binding, options = {}) {
  if (!completeFileIdentity(binding?.package_plugin)
    || !completeFileIdentity(binding?.package_cli)
    || !completeClosureIdentity(binding?.package_closure)
    || !completeFileIdentity(binding?.configured_plugin)
    || !completeFileIdentity(binding?.configured_package_cli)
    || !completeClosureIdentity(binding?.configured_package_closure)
    || typeof binding?.configured_local !== "boolean"
    || !completeFileIdentity(binding?.opencode)) {
    throw admissionError("launch identity binding is invalid");
  }
  const identity = observeRuntimeIdentity(options, { probeOpenCodeVersion: false });
  assertBoundIdentity(identity.package_plugin, binding.package_plugin, "package plugin implementation");
  if (identity.package_cli.source !== binding.package_cli.source) {
    throw admissionError(`package CLI source changed before spawn; accepted source=${publicSource(binding.package_cli)}, observed source=${publicSource(identity.package_cli)}; retry after restoring the accepted package installation`);
  }
  if (identity.package_cli.hash !== binding.package_cli.hash) {
    throw admissionError(`package CLI bytes changed before spawn at ${publicSource(binding.package_cli)}; retry after the package update is complete`);
  }
  assertBoundIdentity(identity.package_closure, binding.package_closure, "executing runtime package closure");
  if (identity.configured_local !== binding.configured_local) {
    throw admissionError("configured local opencode-feature-factory plugin registration changed or was removed before spawn; restore the accepted registration and retry");
  }
  assertBoundIdentity(identity.configured_plugin, binding.configured_plugin, "configured plugin implementation");
  assertBoundIdentity(identity.configured_package_cli, binding.configured_package_cli, "configured plugin package CLI");
  assertBoundIdentity(identity.configured_package_closure, binding.configured_package_closure, "configured runtime package closure");
  assertMatchingConfiguredPackage(identity);
  assertMatchingPackageCli(identity);
  if (!completeFileIdentity(identity.opencode)) {
    throw admissionError("effective PATH opencode executable became unavailable before spawn; retry after restoring the accepted OpenCode executable");
  }
  if (identity.opencode.source !== binding.opencode.source) {
    throw admissionError(`effective PATH opencode executable changed before spawn; accepted source=${publicSource(binding.opencode)}, observed source=${publicSource(identity.opencode)}; retry with PATH resolving the accepted executable`);
  }
  if (identity.opencode.hash !== binding.opencode.hash) {
    throw admissionError(`OpenCode executable bytes changed before spawn at ${publicSource(binding.opencode)}; retry after the executable update is complete`);
  }
  return binding.opencode.source;
}

function observeRuntimeIdentity(options = {}, { probeOpenCodeVersion = true } = {}) {
  const packageRoot = checkedPackageRoot(options.packageRoot || root);
  const pkg = readPackage(packageRoot);
  const packagePlugin = fileIdentity(join(packageRoot, "src", "plugin.js"), pkg.version);
  const packageCli = fileIdentity(join(packageRoot, "src", "cli.js"), pkg.version);
  let packageClosure;
  try {
    packageClosure = runtimePackageClosureIdentity(packageRoot);
  } catch {
    throw admissionError(`executing opencode-feature-factory runtime package closure is incomplete, unreadable, or unsafe; remediation: ${packageRemediation(packageRoot)}`);
  }
  const configured = configuredPluginPackage(options, { plugin: packagePlugin, cli: packageCli, closure: packageClosure, root: packageRoot });
  return {
    schema_version: 1,
    plugin: configured.plugin,
    package_plugin: packagePlugin,
    package_cli: packageCli,
    package_closure: packageClosure,
    configured_plugin: configured.plugin,
    configured_package_cli: configured.cli,
    configured_package_closure: configured.closure,
    configured_package_root: configured.root,
    configured_local: configured.local,
    cli: commandIdentity("feature-factory", options, false),
    opencode: commandIdentity("opencode", options, probeOpenCodeVersion),
  };
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

function assertMatchingConfiguredPackage(identity) {
  const remediation = packageRemediation(identity.configured_package_root);
  if (!completeFileIdentity(identity.package_plugin)
    || !completeFileIdentity(identity.package_cli)
    || !completeClosureIdentity(identity.package_closure)) {
    throw admissionError(`executing opencode-feature-factory package is incomplete; remediation: ${remediation}`);
  }
  if (!completeFileIdentity(identity.configured_plugin)
    || !completeFileIdentity(identity.configured_package_cli)
    || !completeClosureIdentity(identity.configured_package_closure)) {
    throw admissionError(`configured opencode-feature-factory plugin package is incomplete or unreadable; remediation: ${remediation}`);
  }
  if (identity.package_plugin.hash !== identity.configured_plugin.hash) {
    throw admissionError(`executing package plugin implementation bytes differ from the configured local plugin implementation; configured plugin source=${publicSource(identity.configured_plugin)}; executing plugin source=${publicSource(identity.package_plugin)}; remediation: ${remediation}`);
  }
  if (identity.package_cli.hash !== identity.configured_package_cli.hash) {
    throw admissionError(`executing package CLI bytes differ from the configured local plugin package CLI bytes; configured plugin source=${publicSource(identity.configured_plugin)}; executing package CLI source=${publicSource(identity.package_cli)}; remediation: ${remediation}`);
  }
  if (identity.package_closure.hash !== identity.configured_package_closure.hash) {
    throw admissionError(`executing runtime package closure differs from the configured local plugin package closure; configured package source=${publicSource(identity.configured_package_closure)}; executing package source=${publicSource(identity.package_closure)}; remediation: ${remediation}`);
  }
}

function assertMatchingPackageCli(identity) {
  const accepted = publicSource(identity.configured_package_cli);
  const remediation = packageRemediation(identity.configured_package_root);
  if (!completeFileIdentity(identity.cli)) {
    throw admissionError(`effective PATH feature-factory CLI is unavailable; accepted package CLI source=${accepted}; remediation: ${remediation}`);
  }
  if (identity.cli.hash !== identity.configured_package_cli.hash) {
    throw admissionError(`effective PATH feature-factory CLI bytes differ from the plugin/package CLI bytes; accepted package CLI source=${accepted}; observed PATH CLI source=${publicSource(identity.cli)}; remediation: ${remediation}`);
  }
}

function packageRemediation(packageRoot) {
  const installRoot = publicPath(realpathOrResolve(packageRoot));
  return `npm executable with exact argv [\"install\",\"--global\",\"--\",${JSON.stringify(installRoot)}], then ensure PATH feature-factory resolves to the accepted bytes`;
}

function assertBoundIdentity(observed, accepted, label) {
  if (!completeFileIdentity(observed)) throw admissionError(`${label} became unavailable before spawn; retry after restoring the accepted package installation`);
  if (observed.source !== accepted.source) {
    throw admissionError(`${label} source changed before spawn; accepted source=${publicSource(accepted)}, observed source=${publicSource(observed)}; retry after restoring the accepted package installation`);
  }
  if (observed.hash !== accepted.hash) {
    throw admissionError(`${label} bytes changed before spawn at ${publicSource(accepted)}; retry after the package update is complete`);
  }
}

function admissionError(message) {
  return new RuntimeAdmissionError(`runtime admission failed: ${message}`);
}

function completeFileIdentity(value) {
  return typeof value?.source === "string" && isAbsolute(value.source) && HASH_PATTERN.test(value.hash ?? "");
}

function completeClosureIdentity(value) {
  return completeFileIdentity(value);
}

function publicSource(value) {
  return normalizeCliIdentity(value).source ?? "[unavailable]";
}

function publicPath(value) {
  return normalizeCliIdentity({ source: value, hash: `sha256:${"0".repeat(64)}` }).source ?? "[unavailable]";
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

function configuredPluginPackage(options, fallback) {
  const local = [];
  try {
    for (const configPath of effectiveOpenCodeConfigFiles(options)) {
      for (const spec of pluginSpecs(configPath)) {
        const registration = localPluginRegistration(spec);
        if (registration) local.push(registration);
      }
    }
  } catch {
    throw admissionError("effective OpenCode plugin configuration is unreadable or ambiguous; reconcile opencode-feature-factory registrations and retry");
  }
  if (local.length > 1) {
    throw admissionError("multiple local opencode-feature-factory plugin registrations are effective; keep exactly one readable package registration and retry");
  }
  return local[0] ?? { ...fallback, local: false };
}

function effectiveOpenCodeConfigFiles(options) {
  const env = options.env ?? process.env;
  const cwd = resolve(options.cwd ?? process.cwd());
  const home = resolve(options.home || env?.HOME || homedir());
  const xdgConfigHome = stringValue(env?.XDG_CONFIG_HOME) ? resolve(cwd, env.XDG_CONFIG_HOME) : join(home, ".config");
  const globalConfig = join(xdgConfigHome, "opencode");
  const projectDirectories = projectConfigDirectories(cwd);
  const configDir = stringValue(env?.OPENCODE_CONFIG_DIR) ? resolve(cwd, env.OPENCODE_CONFIG_DIR) : null;
  const candidates = [
    ...["config.json", "opencode.json", "opencode.jsonc"].map((name) => join(globalConfig, name)),
    ...projectDirectories.flatMap((directory) => [
      join(directory, "opencode.jsonc"),
      join(directory, "opencode.json"),
      join(directory, ".opencode", "opencode.json"),
      join(directory, ".opencode", "opencode.jsonc"),
    ]),
    join(home, ".opencode", "opencode.json"),
    join(home, ".opencode", "opencode.jsonc"),
    ...(configDir ? [join(configDir, "opencode.json"), join(configDir, "opencode.jsonc")] : []),
  ];
  return [...new Set(candidates.map((candidate) => resolve(candidate)))];
}

function projectConfigDirectories(cwd) {
  const directories = [];
  let current = cwd;
  while (true) {
    directories.push(current);
    if (pathExists(join(current, ".git"))) return directories.reverse();
    const parent = dirname(current);
    if (parent === current) return [cwd];
    current = parent;
  }
}

function pluginSpecs(configPath) {
  let stat;
  try {
    stat = statSync(configPath);
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  if (!stat.isFile() || stat.size > CONFIG_FILE_MAX) throw new Error("unsafe OpenCode config file");
  const config = parseJsoncConfig(readFileSync(configPath, "utf8"), { label: "OpenCode config" });
  if (config.plugin === undefined) return [];
  if (!Array.isArray(config.plugin)) throw new Error("ambiguous OpenCode plugin registration");
  return config.plugin.map((entry) => {
    const spec = Array.isArray(entry) ? entry[0] : entry;
    if (typeof spec !== "string" || !spec) throw new Error("ambiguous OpenCode plugin registration");
    if (/\{(?:env|file):/u.test(spec)) throw new Error("dynamic OpenCode plugin registration");
    return spec;
  });
}

function localPluginRegistration(spec) {
  let url;
  try { url = new URL(spec); } catch { return null; }
  if (url.protocol !== "file:") return null;
  let requested;
  try { requested = fileURLToPath(url); } catch { requested = ""; }
  const looksRelevant = spec.includes(PACKAGE_NAME) || requested.includes(PACKAGE_NAME);
  if (!requested || url.search || url.hash) {
    if (looksRelevant) throw new Error("ambiguous local plugin registration");
    return null;
  }
  let target;
  try {
    if (lstatSync(requested).isSymbolicLink()) throw new Error("symlink local plugin registration");
    target = realpathSync(requested);
  } catch {
    if (looksRelevant) throw new Error("unreadable local plugin registration");
    return null;
  }
  const targetStat = statSync(target);
  let packageRoot;
  if (targetStat.isDirectory()) packageRoot = target;
  else if (targetStat.isFile() && ["src/opencode-plugin.js", "src/plugin.js"].includes(relative(dirname(dirname(target)), target).replaceAll("\\", "/"))) {
    packageRoot = dirname(dirname(target));
  } else {
    if (looksRelevant) throw new Error("ambiguous local plugin registration");
    return null;
  }
  const pkg = readPackage(packageRoot);
  if (pkg.name !== PACKAGE_NAME) {
    if (looksRelevant) throw new Error("ambiguous local plugin registration");
    return null;
  }
  const plugin = fileIdentity(join(packageRoot, "src", "plugin.js"), pkg.version);
  const cli = fileIdentity(join(packageRoot, "src", "cli.js"), pkg.version);
  const entrypoint = fileIdentity(join(packageRoot, "src", "opencode-plugin.js"), pkg.version);
  const closure = runtimePackageClosureIdentity(packageRoot);
  const acceptedTargets = [realpathOrNull(packageRoot), entrypoint.source, plugin.source].filter(Boolean);
  if (!acceptedTargets.includes(target) || !completeFileIdentity(plugin) || !completeFileIdentity(cli)) {
    throw new Error("incomplete local plugin registration");
  }
  return { root: realpathSync(packageRoot), plugin, cli, closure, local: true };
}

function checkedPackageRoot(path) {
  const requested = resolve(path);
  try {
    const entry = lstatSync(requested);
    if (entry.isSymbolicLink() || !entry.isDirectory()) throw new Error("unsafe package root");
    return realpathSync(requested);
  } catch {
    throw admissionError("executing opencode-feature-factory package root is unavailable, unreadable, or not a real directory");
  }
}

function runtimePackageClosureIdentity(packageRoot) {
  const source = realpathSync(packageRoot);
  const files = [];
  let entries = 0;
  let totalBytes = 0;
  const visit = (relativePath) => {
    const directory = join(source, relativePath);
    const names = [];
    const handle = opendirSync(directory);
    try {
      let child;
      while ((child = handle.readSync()) !== null) {
        entries += 1;
        if (entries > RUNTIME_CLOSURE_MAX_ENTRIES) throw new Error("runtime package closure has excessive entries");
        names.push(child.name);
      }
    } finally {
      handle.closeSync();
    }
    names.sort(compareUtf8);
    for (const name of names) {
      const childRelative = relativePath ? `${relativePath}/${name}` : name;
      const child = join(source, ...childRelative.split("/"));
      const entry = lstatSync(child);
      if (entry.isSymbolicLink()) throw new Error("runtime package closure contains a symlink");
      if (entry.isDirectory()) {
        visit(childRelative);
        continue;
      }
      if (!entry.isFile()) throw new Error("runtime package closure contains a nonregular entry");
      if (childRelative.startsWith("src/") && !childRelative.endsWith(".js")) continue;
      if (entry.size > RUNTIME_CLOSURE_MAX_BYTES - totalBytes) throw new Error("runtime package closure exceeds byte limits");
      const bytes = readStableRegularFile(child, entry, RUNTIME_CLOSURE_MAX_BYTES - totalBytes);
      totalBytes += bytes.length;
      if (files.length + 1 > RUNTIME_CLOSURE_MAX_FILES || totalBytes > RUNTIME_CLOSURE_MAX_BYTES) {
        throw new Error("runtime package closure exceeds file or byte limits");
      }
      files.push({ path: childRelative, bytes });
    }
  };

  const packageJson = readStableRegularFile(join(source, "package.json"), null, RUNTIME_CLOSURE_MAX_BYTES);
  totalBytes = packageJson.length;
  if (totalBytes > RUNTIME_CLOSURE_MAX_BYTES) throw new Error("runtime package closure exceeds byte limits");
  files.push({ path: "package.json", bytes: packageJson });
  for (const directory of ["src", "assets"]) {
    const entry = lstatSync(join(source, directory));
    if (entry.isSymbolicLink() || !entry.isDirectory()) throw new Error("runtime package closure is incomplete");
    visit(directory);
  }
  const paths = new Set(files.map((file) => file.path));
  if ([...REQUIRED_RUNTIME_CLOSURE_PATHS].some((path) => !paths.has(path))) {
    throw new Error("runtime package closure is incomplete");
  }
  files.sort((left, right) => compareUtf8(left.path, right.path));
  const hash = createHash("sha256").update(RUNTIME_CLOSURE_DOMAIN);
  hash.update(uint64(files.length));
  for (const file of files) {
    const pathBytes = Buffer.from(file.path, "utf8");
    hash.update(uint64(pathBytes.length));
    hash.update(pathBytes);
    hash.update(uint64(file.bytes.length));
    hash.update(file.bytes);
  }
  return { source, hash: `sha256:${hash.digest("hex")}` };
}

function readStableRegularFile(path, initial = null, maxBytes = Number.MAX_SAFE_INTEGER) {
  const beforePath = initial ?? lstatSync(path);
  if (beforePath.isSymbolicLink() || !beforePath.isFile()) throw new Error("runtime package closure contains an unreadable or nonregular file");
  if (beforePath.size > maxBytes) throw new Error("runtime package closure exceeds byte limits");
  const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
  const descriptor = openSync(path, constants.O_RDONLY | noFollow);
  try {
    const before = fstatSync(descriptor);
    if (!before.isFile() || before.dev !== beforePath.dev || before.ino !== beforePath.ino) {
      throw new Error("runtime package closure entry changed while reading");
    }
    if (before.size > maxBytes) throw new Error("runtime package closure exceeds byte limits");
    const bytes = Buffer.allocUnsafe(before.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(descriptor, bytes, offset, bytes.length - offset, offset);
      if (count === 0) break;
      offset += count;
    }
    const growthProbe = Buffer.allocUnsafe(1);
    const grew = readSync(descriptor, growthProbe, 0, 1, before.size) !== 0;
    const after = fstatSync(descriptor);
    if (before.dev !== after.dev
      || before.ino !== after.ino
      || before.size !== after.size
      || before.mtimeMs !== after.mtimeMs
      || before.ctimeMs !== after.ctimeMs
      || offset !== bytes.length
      || grew) {
      throw new Error("runtime package closure file changed while reading");
    }
    return bytes;
  } finally {
    closeSync(descriptor);
  }
}

function compareUtf8(left, right) {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function uint64(value) {
  const bytes = Buffer.allocUnsafe(8);
  bytes.writeBigUInt64BE(BigInt(value));
  return bytes;
}

function pathExists(path) {
  try { statSync(path); return true; } catch { return false; }
}

function realpathOrNull(path) {
  try { return realpathSync(path); } catch { return null; }
}

function stringValue(value) {
  return typeof value === "string" && value.length > 0;
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
      ? containsSensitiveSeparatorComposite(normalized, { recognizedOnly: true })
        || normalized.split(/[\\/]/u).some(sensitivePathSegment)
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

function containsSensitiveSeparatorComposite(value, { recognizedOnly = false } = {}) {
  for (const match of value.matchAll(SEPARATOR_FRAGMENT_RUN_PATTERN)) {
    const fragments = match[0].split(/[\s\p{P}\p{S}]+/u).filter(Boolean);
    if (!recognizedOnly && containsOpaqueFragmentWindow(fragments)) return true;
    const bearerIndex = fragments.findIndex((fragment) => fragment.toLowerCase() === "bearer");
    if (bearerIndex >= 0 && isSensitiveValue(`Bearer ${fragments.slice(bearerIndex + 1).join("")}`)) return true;
  }
  return false;
}

function containsOpaqueFragmentWindow(fragments) {
  const bounded = fragments.slice(0, 128);
  for (let start = 0; start < bounded.length; start += 1) {
    let candidate = "";
    for (let end = start; end < bounded.length && candidate.length <= RUNTIME_IDENTITY_VERSION_MAX; end += 1) {
      candidate += bounded[end];
      if (!/[a-z]/u.test(candidate)
        && /[A-Z]/u.test(candidate)
        && /[0-9]/u.test(candidate)
        && isSensitiveValue(candidate)) return true;
    }
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
