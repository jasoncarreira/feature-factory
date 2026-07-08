import { existsSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

export function requireNonEmptyString(value, label) {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${label} must be a non-empty string`);
  return value.trim();
}

export function timestamp(value, label = "timestamp") {
  if (value === undefined || value === null) return new Date().toISOString();
  const parsed = typeof value === "number" ? value : value instanceof Date ? value.getTime() : Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error(`invalid ${label}`);
  return new Date(parsed).toISOString();
}

export function physicalPath(path, label = "path", options = {}) {
  const resolved = resolve(requireNonEmptyString(path, label));
  if (!existsSync(resolved)) {
    if (options.mustExist) throw new Error(`${label} is unresolvable: ${resolved}`);
    return resolved;
  }
  return realpathSync.native(resolved);
}

export function isContainedPath(parent, child, options = {}) {
  const allowEqual = options.allowEqual !== false;
  const rel = relative(physicalPath(parent, "parent path"), physicalPath(child, "child path"));
  if (rel === "") return allowEqual;
  return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

export function assertContainedPath(parent, child, label, options = {}) {
  if (isContainedPath(parent, child, options)) return;
  throw new Error(`${label} must stay under ${physicalPath(parent, "parent path")}`);
}
