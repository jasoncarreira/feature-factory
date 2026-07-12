import { resolve } from "node:path";
import { parseCleanupSweepDigest } from "./cleanup-sweep-report.js";

export const CLEANUP_SWEEP_COMMAND_ERROR = "invalid cleanup sweep command";

export class CleanupSweepCommandError extends Error {
  constructor() {
    super(CLEANUP_SWEEP_COMMAND_ERROR);
    this.name = "CleanupSweepCommandError";
    this.code = "ERR_CLEANUP_SWEEP_COMMAND";
  }
}

export function parseCleanupSweepCommand(args) {
  if (!Array.isArray(args) || args.some((argument) => typeof argument !== "string")) fail();

  const seen = new Set();
  let cwd = process.cwd();
  let digest;

  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (!["--all", "--dry-run", "--digest", "--repo", "--json"].includes(flag)) fail();
    if (seen.has(flag)) fail();
    seen.add(flag);

    if (flag === "--digest" || flag === "--repo") {
      const value = args[index + 1];
      if (typeof value !== "string" || value.length === 0 || value.startsWith("-")) fail();
      index += 1;
      if (flag === "--digest") digest = value;
      else cwd = resolve(value);
    }
  }

  if (!seen.has("--all")) fail();
  const preview = seen.has("--dry-run");
  const execute = seen.has("--digest");
  if (preview === execute) fail();

  const json = seen.has("--json");
  if (preview) return { mode: "preview", cwd, json };
  try { parseCleanupSweepDigest(digest); } catch { fail(); }
  return { mode: "execute", cwd, json, digest };
}

export async function runCleanupSweepCommand(args, handlers) {
  const command = parseCleanupSweepCommand(args);
  if (!handlers || typeof handlers !== "object") fail();
  const handler = command.mode === "preview" ? handlers.preview : handlers.execute;
  if (typeof handler !== "function") fail();
  const report = await handler(command);
  return { report, exitCode: report.exit_code };
}

export function renderCleanupSweepCommandError() {
  return `error: ${CLEANUP_SWEEP_COMMAND_ERROR}`;
}

function fail() {
  throw new CleanupSweepCommandError();
}
