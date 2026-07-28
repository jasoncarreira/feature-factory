import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const agentAssetDir = join(root, "assets", "agent");

export const FEATURE_FACTORY_AGENT_FILES = Object.freeze(
  readdirSync(agentAssetDir).filter((name) => name.endsWith(".md")).sort(),
);

export const SANCTIONED_GLOBAL_FEATURE_SKILL = `---
name: feature
description: Use when the user invokes /feature or asks to take a feature, Jira ticket, work item, or product idea end-to-end with the opencode feature-factory workflow. Delegates to the repo-seeded current workflow under .opencode/skills/feature.
---

# Feature Factory Delegator

This global skill is intentionally a small bootstrapper. The current feature-factory workflow is seeded into the target repository before \`feature-factory factory start\` launches \`opencode run\`.

Before creating, resuming, validating, or mutating any factory run state:

1. Read the target repository file \`.opencode/skills/feature/SKILL.md\`.
2. Read \`.opencode/skills/feature/SCHEMA.md\` if the workflow references schema or state shape details.
3. Follow those repo-local files as the authoritative instructions for this run.

If \`.opencode/skills/feature/SKILL.md\` is missing, stop and report that the feature-factory skill was not seeded into the target repository. Do not fall back to inventing a run-state shape.

Do not use older global instructions, old \`version\` manifests, \`status: intake\`, or object-shaped \`steps\`. Use only the repo-local workflow and schema.
`;

const SKILL_PATHS = Object.freeze([
  [".config", "opencode", "skills", "feature", "SKILL.md"],
  [".config", "opencode", "skill", "feature", "SKILL.md"],
  [".claude", "skills", "feature", "SKILL.md"],
  [".agents", "skills", "feature", "SKILL.md"],
]);
const AGENT_DIRECTORIES = Object.freeze([
  [".config", "opencode", "agent"],
  [".config", "opencode", "agents"],
]);
const EXTRA_RECOGNIZED_STALE_AGENT_FILES = Object.freeze(["feature-factory.md"]);

export class StaleGlobalDefinitionsError extends Error {
  constructor(inspection) {
    super(formatGlobalDefinitionsDetail(inspection));
    this.name = "StaleGlobalDefinitionsError";
    this.code = "ERR_STALE_GLOBAL_DEFINITIONS";
    this.inspection = inspection;
  }
}

export function inspectGlobalDefinitions(options = {}) {
  const home = resolve(options.home || homedir());
  const packagedSkill = readFileSync(join(root, "assets", "skills", "feature", "SKILL.md"));
  const sanctionedSkill = Buffer.from(SANCTIONED_GLOBAL_FEATURE_SKILL, "utf8");
  const packagedAgents = FEATURE_FACTORY_AGENT_FILES.map((name) => ({
    name,
    bytes: readFileSync(join(agentAssetDir, name)),
  }));
  const candidates = [
    ...SKILL_PATHS.map((segments) => ({
      kind: "skill",
      path: join(home, ...segments),
      expected: [packagedSkill, sanctionedSkill],
    })),
    ...AGENT_DIRECTORIES.flatMap((segments) => packagedAgents.map(({ name, bytes }) => ({
      kind: "agent",
      path: join(home, ...segments, name),
      expected: [bytes],
    }))),
    ...AGENT_DIRECTORIES.flatMap((segments) => EXTRA_RECOGNIZED_STALE_AGENT_FILES.map((name) => ({
      kind: "agent",
      path: join(home, ...segments, name),
      expected: [],
    }))),
  ];
  const definitions = candidates.map((candidate) => inspectCandidate(home, candidate));
  const findings = deduplicateFindings(definitions.filter((item) => !["absent", "exact"].includes(item.status)));
  return {
    ok: findings.length === 0,
    status: findings.length === 0 ? "healthy" : "stale",
    definitions,
    findings,
  };
}

export function assertGlobalDefinitionsCurrent(options = {}) {
  const inspection = typeof options.inspect === "function"
    ? options.inspect(options)
    : inspectGlobalDefinitions(options);
  if (!inspection?.ok) throw new StaleGlobalDefinitionsError(inspection);
  return inspection;
}

export function formatGlobalDefinitionsDetail(inspection) {
  if (inspection?.ok) return "absent or exact current global definitions";
  const findings = Array.isArray(inspection?.findings) ? inspection.findings : [];
  const summary = findings.length
    ? findings.map((item) => `${item.status}: ${item.path}`).join("; ")
    : "inspection could not establish current definitions";
  return `stale global feature-factory definitions detected (${summary}). Reconcile symlink, unreadable, or ambiguous paths; remove mismatched definition files or replace them with exact current packaged definitions; then restart opencode.`;
}

function inspectCandidate(home, candidate) {
  const segments = relative(home, candidate.path).split(/[\\/]/u).filter(Boolean);
  if (!segments.length || segments[0] === "..") return finding(candidate, candidate.path, "ambiguous");
  let current = home;
  for (let index = 0; index < segments.length; index += 1) {
    current = join(current, segments[index]);
    let entry;
    try {
      entry = lstatSync(current);
    } catch (error) {
      if (error?.code === "ENOENT") return { kind: candidate.kind, path: candidate.path, status: "absent" };
      return finding(candidate, current, inaccessibleStatus(error));
    }
    if (entry.isSymbolicLink()) return finding(candidate, current, "symlink");
    const final = index === segments.length - 1;
    if (!final && !entry.isDirectory()) return finding(candidate, current, "ambiguous");
    if (final && !entry.isFile()) return finding(candidate, current, "ambiguous");
  }

  let descriptor;
  let result;
  try {
    descriptor = openSync(candidate.path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    if (!fstatSync(descriptor).isFile()) result = finding(candidate, candidate.path, "ambiguous");
    else {
      const actual = readFileSync(descriptor);
      result = {
        kind: candidate.kind,
        path: candidate.path,
        status: candidate.expected.some((expected) => actual.equals(expected)) ? "exact" : "mismatch",
      };
    }
  } catch (error) {
    result = finding(candidate, candidate.path, error?.code === "ELOOP" ? "symlink" : inaccessibleStatus(error));
  }
  if (descriptor !== undefined) {
    try { closeSync(descriptor); } catch { return finding(candidate, candidate.path, "ambiguous"); }
  }
  return result;
}

function finding(candidate, path, status) {
  return { kind: candidate.kind, path, status };
}

function inaccessibleStatus(error) {
  return error?.code === "EACCES" || error?.code === "EPERM" ? "unreadable" : "ambiguous";
}

function deduplicateFindings(findings) {
  const seen = new Set();
  return findings.filter((item) => {
    const key = JSON.stringify([item.kind, item.path, item.status]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
