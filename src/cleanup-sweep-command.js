import { resolve } from "node:path";
import { parseCleanupSweepDigest } from "./cleanup-sweep-report.js";
import { identitySegment, StructuredOutputError } from "./hardening/output-policy.js";

const ALLOWED_FLAGS = new Set(["--all", "--dry-run", "--digest", "--repo", "--json"]);
const VALUE_FLAGS = new Set(["--digest", "--repo"]);

export function parseCleanupSweepCommand(args, options = {}) {
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== "string")) {
    throw commandError("factory cleanup sweep arguments must be an array of strings");
  }

  const seen = new Set();
  const values = new Map();
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!ALLOWED_FLAGS.has(arg)) {
      if (arg === "--force") throw commandError("factory cleanup --all does not support --force");
      if (!arg.startsWith("-")) throw commandError("factory cleanup --all does not accept a run ID");
      throw commandError("factory cleanup --all received an unsupported option");
    }
    if (seen.has(arg)) throw commandError(`factory cleanup --all does not allow repeated ${arg}`);
    seen.add(arg);
    if (!VALUE_FLAGS.has(arg)) continue;

    const value = args[index + 1];
    if (typeof value !== "string" || value.length === 0 || value.startsWith("-")) {
      throw commandError(`factory cleanup --all requires a value for ${arg}`);
    }
    values.set(arg, value);
    index += 1;
  }

  if (!seen.has("--all")) {
    if (seen.has("--digest")) throw commandError("factory cleanup --digest requires --all");
    throw commandError("factory cleanup sweep requires --all");
  }

  const dryRun = seen.has("--dry-run");
  const hasDigest = seen.has("--digest");
  if (dryRun === hasDigest) {
    throw commandError("factory cleanup --all requires exactly one of --dry-run or --digest");
  }

  let digest;
  if (hasDigest) {
    digest = values.get("--digest");
    try {
      parseCleanupSweepDigest(digest);
    } catch {
      throw commandError("factory cleanup --all requires a valid cleanup digest");
    }
  }

  const baseCwd = typeof options.cwd === "string" ? options.cwd : process.cwd();
  const cwd = seen.has("--repo") ? resolve(baseCwd, values.get("--repo")) : baseCwd;
  const command = { mode: dryRun ? "preview" : "execute", cwd, json: seen.has("--json") };
  if (hasDigest) command.digest = digest;
  return command;
}

export async function runCleanupSweepCommand(args, handlers = {}) {
  const command = parseCleanupSweepCommand(args, { cwd: handlers.cwd });
  const handler = command.mode === "preview" ? handlers.preview : handlers.execute;
  if (typeof handler !== "function") throw new TypeError(`cleanup sweep ${command.mode} handler is required`);
  const report = await handler(command);
  if (!report || typeof report !== "object" || (report.exit_code !== 0 && report.exit_code !== 1)) {
    throw new TypeError("cleanup sweep handler must return a report with exit_code 0 or 1");
  }
  return { report, exitCode: report.exit_code };
}

function commandError(message) {
  return new StructuredOutputError(message, [identitySegment(message)]);
}
