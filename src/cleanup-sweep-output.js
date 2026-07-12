import {
  CLEANUP_SWEEP_REFUSAL_REGISTRY,
  createCleanupSweepReport,
  parseCleanupSweepDigest,
} from "./cleanup-sweep-report.js";
import {
  freeformSegment,
  identitySegment,
  projectFreeformData,
  renderTerminalSegments,
  TRUSTED_SEGMENTS,
} from "./hardening/output-policy.js";
import { serializeTerminalJson } from "./hardening/terminal-encoding.js";

const CONFIRMATION_PREFIX = Object.freeze(["feature-factory", "factory", "cleanup", "--all", "--digest"]);

export function createCleanupSweepConfirmation(digest, repositoryRoot, options = {}) {
  parseCleanupSweepDigest(digest);
  if (typeof repositoryRoot !== "string" || repositoryRoot.length === 0) {
    throw new TypeError("cleanup sweep confirmation requires a physical repository root");
  }
  const argv = [...CONFIRMATION_PREFIX, digest, "--repo", repositoryRoot];
  if (options.json === true) argv.push("--json");
  return { argv, shell_command: shellQuoteArgv(argv) };
}

export function shellQuoteArgv(argv) {
  if (!Array.isArray(argv) || argv.length === 0 || argv.some((arg) => typeof arg !== "string")) {
    throw new TypeError("shell argv must be a non-empty array of strings");
  }
  return argv.map((arg) => `'${arg.replaceAll("'", `'"'"'`)}'`).join(" ");
}

export function renderCleanupSweepReport(report, options = {}) {
  return renderCleanupSweepReportLines(report, options).join("\n");
}

export function renderCleanupSweepReportLines(report, options = {}) {
  const normalized = createCleanupSweepReport(report);
  const confirmation = exactReportConfirmation(normalized);
  if (options.json === true) {
    const projected = projectReport(normalized);
    if (confirmation !== null) {
      projected.confirmation = createCleanupSweepConfirmation(
        normalized.authorization.digest,
        projected.repository.root_path,
        { json: confirmation.argv.at(-1) === "--json" },
      );
    }
    return [serializeTerminalJson(projected, { space: 2 })];
  }

  const lines = [
    keyValueLine("mode", identitySegment(normalized.mode)),
    keyValueLine("status", identitySegment(normalized.status)),
    keyValueLine("repository", normalized.repository === null
      ? identitySegment("-")
      : freeformSegment(normalized.repository.root_path)),
  ];

  if (normalized.authorization.digest !== null) {
    lines.push(keyValueLine("digest", identitySegment(normalized.authorization.digest)));
  }
  if (normalized.authorization.refusal_code !== null) {
    const refusal = CLEANUP_SWEEP_REFUSAL_REGISTRY[normalized.authorization.refusal_code];
    lines.push(renderTerminalSegments([
      identitySegment("refusal"), TRUSTED_SEGMENTS.COLON_SPACE,
      identitySegment(refusal.code), TRUSTED_SEGMENTS.DASH_SEPARATOR, freeformSegment(refusal.message),
    ]));
  }
  for (const error of normalized.report_errors) {
    lines.push(renderTerminalSegments([
      identitySegment("report-error"), TRUSTED_SEGMENTS.COLON_SPACE,
      identitySegment(error.code), TRUSTED_SEGMENTS.DASH_SEPARATOR, freeformSegment(error.message),
    ]));
  }
  for (const candidate of normalized.candidates) lines.push(candidateLine(candidate));

  lines.push(keyValueLine("counts", identitySegment([
    `eligible=${normalized.counts.eligible}`,
    `protected=${normalized.counts.protected}`,
    `skipped=${normalized.counts.skipped}`,
    `deleted=${normalized.counts.deleted}`,
    `failed=${normalized.counts.failed}`,
  ].join(" "))));
  lines.push(keyValueLine("attempted-cleanup-failures", identitySegment(normalized.attempted_cleanup_failures)));
  if (confirmation !== null) {
    lines.push(keyValueLine("confirmation", identitySegment(projectConfirmationCommand(confirmation.argv))));
  }
  return lines;
}

function exactReportConfirmation(report) {
  if (report.confirmation.argv === null) return null;
  const hasJson = report.confirmation.argv.at(-1) === "--json";
  const expected = createCleanupSweepConfirmation(
    report.authorization.digest,
    report.repository.root_path,
    { json: hasJson },
  );
  if (JSON.stringify(report.confirmation) !== JSON.stringify(expected)) {
    throw new TypeError("cleanup sweep preview confirmation does not match the report authorization");
  }
  return expected;
}

function candidateLine(candidate) {
  return renderTerminalSegments([
    identitySegment(candidate.classification), TRUSTED_SEGMENTS.TAB,
    freeformSegment(candidate.entry_name), TRUSTED_SEGMENTS.TAB,
    identitySegment(candidate.reason_codes.join(",")), TRUSTED_SEGMENTS.TAB,
    freeformSegment(candidate.reasons.map((reason) => reason.message).join(" | ")),
  ]);
}

function keyValueLine(key, valueSegment) {
  return renderTerminalSegments([identitySegment(key), TRUSTED_SEGMENTS.COLON_SPACE, valueSegment]);
}

function projectConfirmationCommand(argv) {
  const projected = argv.map((arg, index) => {
    if (index === 5) {
      parseCleanupSweepDigest(arg);
      return arg;
    }
    if (CONFIRMATION_PREFIX.includes(arg) || arg === "--repo" || arg === "--json") return arg;
    return projectFreeformData(arg);
  });
  return shellQuoteArgv(projected);
}

function projectReport(value, key = null) {
  if (typeof value === "string") {
    if ((key === "digest" || key === "provided_digest") && /^ff-cleanup-v1\.[0-9a-f]{64}\.[0-9a-f]{64}$/u.test(value)) return value;
    if (key === "evidence_digest" && /^sha256:[0-9a-f]{64}$/u.test(value)) return value;
    return projectFreeformData(value);
  }
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((item) => projectReport(item, key));
  const output = Object.create(null);
  for (const [childKey, childValue] of Object.entries(value)) output[childKey] = projectReport(childValue, childKey);
  return output;
}
