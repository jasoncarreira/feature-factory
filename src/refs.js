import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { assertContainedPath, physicalPath, requireNonEmptyString } from "./utils.js";

const DURABLE_ROOTS = Object.freeze(["artifacts", "evidence", "reviews", "gates"]);

export function hashFile(file, options = {}) {
  const mode = options.mode || "raw";
  const data = mode === "text" ? readFileSync(file, "utf8") : readFileSync(file);
  return `sha256:${createHash("sha256").update(data).digest("hex")}`;
}

export function hashValue(value) {
  return `sha256:${createHash("sha256").update(canonicalJson(value), "utf8").digest("hex")}`;
}

export function canonicalizeGithubPrUrl(value) {
  if (typeof value !== "string" || value.trim() === "") throw new Error("GitHub PR URL must be a non-empty string");
  let parsed;
  try {
    parsed = new URL(value.trim());
  } catch {
    throw new Error("GitHub PR URL must be a valid URL");
  }
  if (parsed.protocol !== "https:" || parsed.hostname !== "github.com") throw new Error("GitHub PR URL must use https://github.com");
  const segments = parsed.pathname.split("/").filter(Boolean);
  if (segments.length !== 4 || segments[2] !== "pull" || !/^\d+$/u.test(segments[3])) {
    throw new Error("GitHub PR URL must have shape https://github.com/OWNER/REPO/pull/NUMBER");
  }
  return `https://github.com/${segments[0]}/${segments[1]}/pull/${segments[3]}`;
}

export function githubPrUrlParts(value) {
  const canonical = canonicalizeGithubPrUrl(value);
  const segments = new URL(canonical).pathname.split("/").filter(Boolean);
  return {
    url: canonical,
    owner: segments[0],
    repo: segments[1],
    repository: `${segments[0]}/${segments[1]}`,
    number: Number(segments[3]),
  };
}

export function resolveDurableRoots(runDir) {
  const runRealPath = physicalPath(runDir, "runDir", { mustExist: true });
  const roots = { run_dir: runRealPath };
  for (const name of DURABLE_ROOTS) roots[name] = resolveDurableRoot(runRealPath, name, { mustExist: false });
  return roots;
}

export function resolveDurableRef(runDirOrRoots, ref, rootName, options = {}) {
  if (!DURABLE_ROOTS.includes(rootName)) throw new Error(`unknown durable root '${rootName}'`);
  const roots = typeof runDirOrRoots === "string" ? resolveDurableRoots(runDirOrRoots) : runDirOrRoots;
  if (!roots || typeof roots !== "object") throw new Error("durable roots must be an object");
  const root = roots[rootName];
  if (typeof root !== "string" || root.trim() === "") throw new Error(`missing durable root '${rootName}'`);
  const segments = normalizeDurableRefSegments(ref, rootName);
  const candidate = resolve(join(root, ...segments));
  const rootPhysical = resolveDurableRoot(roots.run_dir || root, rootName, { mustExist: false, rootOverride: root });
  assertContainedPath(rootPhysical, candidate, ref);
  if (options.mustExist !== false) {
    if (!existsSync(candidate)) throw new Error(`missing ${rootName} ref: ${ref}`);
    if (lstatSync(candidate).isSymbolicLink()) throw new Error(`${rootName} ref must not be a symlink: ${ref}`);
    return { ref, path: physicalPath(candidate, `${rootName} ref`, { mustExist: true }) };
  }
  if (existsSync(candidate) && lstatSync(candidate).isSymbolicLink()) throw new Error(`${rootName} ref must not be a symlink: ${ref}`);
  return { ref, path: resolveWritableDurablePath(rootPhysical, candidate, ref) };
}

export function resolveEvidenceRef(runDirOrRoots, ref, options = {}) {
  return resolveDurableRef(runDirOrRoots, ref, "evidence", options);
}

export function resolveReviewRef(runDirOrRoots, ref, options = {}) {
  return resolveDurableRef(runDirOrRoots, ref, "reviews", options);
}

export function resolveArtifactRef(runDirOrRoots, ref, options = {}) {
  return resolveDurableRef(runDirOrRoots, ref, "artifacts", options);
}

export function resolveGateRef(runDirOrRoots, ref, options = {}) {
  return resolveDurableRef(runDirOrRoots, ref, "gates", options);
}

function resolveDurableRoot(runDir, rootName, options = {}) {
  const rootPath = options.rootOverride ? resolve(options.rootOverride) : resolve(join(runDir, rootName));
  if (!existsSync(rootPath)) return rootPath;
  if (lstatSync(rootPath).isSymbolicLink()) throw new Error(`${rootName} root must not be a symlink: ${rootPath}`);
  const physical = physicalPath(rootPath, `${rootName} root`, { mustExist: true });
  if (!statSync(physical).isDirectory()) throw new Error(`${rootName} root must be a directory: ${rootPath}`);
  const runPhysical = existsSync(runDir) ? physicalPath(runDir, "runDir", { mustExist: true }) : resolve(runDir);
  assertContainedPath(runPhysical, physical, `${rootName}/`);
  return physical;
}

function normalizeDurableRefSegments(ref, rootName) {
  const value = requireNonEmptyString(ref, `${rootName} ref`);
  if (isAbsolute(value) || value.includes("\\")) throw new Error(`${rootName} ref must be a relative forward-slash path`);
  const segments = value.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new Error(`${rootName} ref must not contain empty, '.' or '..' path segments`);
  }
  if (segments[0] === rootName) return segments.slice(1);
  if (DURABLE_ROOTS.includes(segments[0]) && segments[0] !== rootName) throw new Error(`${rootName} ref must stay under ${rootName}/`);
  return segments;
}

function resolveWritableDurablePath(rootPhysical, candidate, label) {
  let existing = candidate;
  const missing = [];
  while (!existsSync(existing)) {
    missing.unshift(basename(existing));
    const parent = dirname(existing);
    if (parent === existing) break;
    existing = parent;
  }
  const existingPhysical = physicalPath(existing, label, { mustExist: true });
  assertWritableAncestor(rootPhysical, existingPhysical, label);
  if (missing.length > 0 && !statSync(existingPhysical).isDirectory()) throw new Error(`${label} parent must be a directory`);
  const writable = resolve(join(existingPhysical, ...missing));
  assertContainedPath(rootPhysical, writable, label);
  return writable;
}

function assertWritableAncestor(rootPhysical, existingPhysical, label) {
  try {
    assertContainedPath(rootPhysical, existingPhysical, label);
  } catch {
    assertContainedPath(existingPhysical, rootPhysical, label);
  }
}

function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}
