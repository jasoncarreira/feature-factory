import {
  CLEANUP_SWEEP_REFUSAL_REGISTRY,
  createCleanupSweepReport,
} from "./cleanup-sweep-report.js";
import {
  freeformSegment,
  identitySegment,
  renderTerminalSegments,
  TRUSTED_SEGMENTS,
} from "./hardening/output-policy.js";
import { serializeTerminalJson } from "./hardening/terminal-encoding.js";

export function createCleanupSweepConfirmation(digest, physicalRoot, { json = false } = {}) {
  const argv = [
    "feature-factory", "factory", "cleanup", "--all", "--digest", digest,
    "--repo", physicalRoot,
  ];
  if (json) argv.push("--json");
  return { argv, shell_command: argv.map(shellQuote).join(" ") };
}

export function shellQuoteCleanupSweepArgument(value) {
  return shellQuote(value);
}

export function renderCleanupSweepReport(report, { json = false } = {}) {
  return json ? renderCleanupSweepJson(report) : renderCleanupSweepHuman(report);
}

export function renderCleanupSweepJson(report) {
  return serializeTerminalJson(createCleanupSweepReport(report), { space: 2 });
}

export function renderCleanupSweepHuman(report) {
  return renderCleanupSweepHumanLines(report).join("\n");
}

export function renderCleanupSweepHumanLines(report) {
  const normalized = createCleanupSweepReport(report);
  const lines = [];
  lines.push(row("mode/status", identitySegment(`${normalized.mode}/${normalized.status}`)));
  lines.push(row("repository", normalized.repository === null
    ? identitySegment("-")
    : freeformSegment(normalized.repository.root_path)));

  if (normalized.authorization.digest !== null) {
    lines.push(row("digest", identitySegment(normalized.authorization.digest)));
  }
  if (normalized.authorization.refusal_code !== null) {
    const refusal = CLEANUP_SWEEP_REFUSAL_REGISTRY[normalized.authorization.refusal_code];
    lines.push(detailRow("refusal", refusal.code, refusal.message));
  }
  for (const error of normalized.report_errors) {
    lines.push(detailRow("report error", error.code, error.message));
  }
  for (const candidate of normalized.candidates) lines.push(candidateRow(candidate));

  const counts = normalized.counts;
  lines.push(row("counts", identitySegment(
    `eligible=${counts.eligible} protected=${counts.protected} skipped=${counts.skipped} deleted=${counts.deleted} failed=${counts.failed}`,
  )));
  lines.push(row("attempted cleanup failures", identitySegment(normalized.attempted_cleanup_failures)));
  if (normalized.confirmation.shell_command !== null) {
    lines.push(row("confirmation", identitySegment(normalized.confirmation.shell_command)));
  }
  return lines;
}

function candidateRow(candidate) {
  return renderTerminalSegments([
    identitySegment(candidate.classification), TRUSTED_SEGMENTS.TAB,
    freeformSegment(candidate.entry_name), TRUSTED_SEGMENTS.TAB,
    identitySegment(candidate.reason_codes.length === 0 ? "-" : candidate.reason_codes.join(",")),
    TRUSTED_SEGMENTS.TAB,
    freeformSegment(candidate.reasons.length === 0 ? "-" : candidate.reasons.map(({ message }) => message).join("; ")),
  ]);
}

function detailRow(label, code, message) {
  return renderTerminalSegments([
    identitySegment(label), TRUSTED_SEGMENTS.COLON_SPACE,
    identitySegment(code), TRUSTED_SEGMENTS.DASH_SEPARATOR, freeformSegment(message),
  ]);
}

function row(label, valueSegment) {
  return renderTerminalSegments([identitySegment(label), TRUSTED_SEGMENTS.COLON_SPACE, valueSegment]);
}

function shellQuote(value) {
  if (typeof value !== "string") throw new TypeError("cleanup sweep shell arguments must be strings");
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}
