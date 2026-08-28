import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_BOOTSTRAP_TIMEOUT_MS, DEFAULT_REPOSITORY_VERIFY_TIMEOUT_MS } from "./index.js";

export class RepositoryConfigError extends Error {}

export function parseRepositoryConfig(bytes) {
  let config;
  try {
    config = JSON.parse(Buffer.isBuffer(bytes) ? bytes.toString("utf8") : bytes);
  } catch {
    throw new RepositoryConfigError("invalid .factory.json");
  }
  // 0.8.0 dropped `publishing_identity`: the account a run publishes as belongs to the environment it runs
  // in, not to a tracked file that can hold one value for a repository published from two of them. It is
  // resolved by `init` from a flag or the environment and recorded in `run.json`. The allowed set below is
  // closed, so a file still carrying the key is malformed rather than silently ignored -- which is what
  // makes the removal visible to whoever has to edit it.
  const requiredKeys = ["publish", "resolve", "verify"];
  const allowedKeys = [...requiredKeys, "pr_draft", "verify_timeout_ms", "bootstrap", "bootstrap_timeout_ms"];
  if (!config || typeof config !== "object" || Array.isArray(config)
    || Object.keys(config).some((keyName) => !allowedKeys.includes(keyName))) {
    throw new RepositoryConfigError("invalid .factory.json");
  }
  if (Object.hasOwn(config, "pr_draft") && typeof config.pr_draft !== "boolean") {
    throw new RepositoryConfigError("invalid .factory.json: entry 'pr_draft' must be a boolean");
  }
  const hasBootstrap = Object.hasOwn(config, "bootstrap");
  const hasBootstrapTimeout = Object.hasOwn(config, "bootstrap_timeout_ms");
  if (hasBootstrap && (typeof config.bootstrap !== "string" || !config.bootstrap.trim())) {
    throw new RepositoryConfigError("invalid .factory.json: entry 'bootstrap' must be a non-empty string");
  }
  if (!hasBootstrap && hasBootstrapTimeout) {
    throw new RepositoryConfigError("invalid .factory.json: entry 'bootstrap_timeout_ms' requires a declared bootstrap command");
  }
  if (hasBootstrapTimeout && (!Number.isSafeInteger(config.bootstrap_timeout_ms) || config.bootstrap_timeout_ms <= 0)) {
    throw new RepositoryConfigError("invalid .factory.json: entry 'bootstrap_timeout_ms' must be a positive integer");
  }
  if (Object.hasOwn(config, "verify_timeout_ms")
    && (!Number.isSafeInteger(config.verify_timeout_ms) || config.verify_timeout_ms <= 0)) {
    throw new RepositoryConfigError("invalid .factory.json: entry 'verify_timeout_ms' must be a positive integer");
  }
  if (requiredKeys.some((keyName) => typeof config[keyName] !== "string" || !config[keyName].trim())) {
    throw new RepositoryConfigError("invalid .factory.json");
  }
  const parsed = { command: config.verify, timeoutMs: config.verify_timeout_ms ?? DEFAULT_REPOSITORY_VERIFY_TIMEOUT_MS,
    prDraft: config.pr_draft ?? true };
  return hasBootstrap ? { ...parsed, bootstrapCommand: config.bootstrap,
    bootstrapTimeoutMs: config.bootstrap_timeout_ms ?? DEFAULT_BOOTSTRAP_TIMEOUT_MS } : parsed;
}

export function readRepositoryConfig(worktree, { optional = false } = {}) {
  let bytes;
  try {
    bytes = readFileSync(join(worktree, ".factory.json"), "utf8");
  } catch (error) {
    if (optional && error?.code === "ENOENT") return null;
    throw new RepositoryConfigError("invalid .factory.json");
  }
  return parseRepositoryConfig(bytes);
}
