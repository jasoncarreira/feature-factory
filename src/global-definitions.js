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
const UNSUPPORTED_CONFIG_OVERRIDES = Object.freeze(["OPENCODE_CONFIG", "OPENCODE_CONFIG_CONTENT"]);
const STALE_DEFINITIONS_MESSAGE = "stale global feature-factory definitions detected. Reconcile symlink, unreadable, or ambiguous definition sources; remove mismatched definition files or replace them with exact current packaged definitions; unset unsupported OPENCODE_CONFIG or OPENCODE_CONFIG_CONTENT overrides for factory operation; then restart opencode.";

export class StaleGlobalDefinitionsError extends Error {
  constructor(inspection) {
    super(STALE_DEFINITIONS_MESSAGE);
    this.name = "StaleGlobalDefinitionsError";
    this.code = "ERR_STALE_GLOBAL_DEFINITIONS";
    Object.defineProperty(this, "inspection", { value: inspection });
  }
}

export function inspectGlobalDefinitions(options = {}) {
  const env = options.env ?? process.env;
  const home = resolve(options.home || env?.HOME || homedir());
  const cwd = resolve(options.cwd || process.cwd());
  const packagedSkill = readFileSync(join(root, "assets", "skills", "feature", "SKILL.md"));
  const sanctionedSkill = Buffer.from(SANCTIONED_GLOBAL_FEATURE_SKILL, "utf8");
  const packagedAgents = FEATURE_FACTORY_AGENT_FILES.map((name) => ({
    name,
    bytes: readFileSync(join(agentAssetDir, name)),
  }));
  const homeCandidates = [
    ...SKILL_PATHS.map((segments) => ({
      kind: "skill",
      root: home,
      path: join(home, ...segments),
      expected: [packagedSkill, sanctionedSkill],
    })),
    ...AGENT_DIRECTORIES.flatMap((segments) => packagedAgents.map(({ name, bytes }) => ({
      kind: "agent",
      root: home,
      path: join(home, ...segments, name),
      expected: [bytes],
    }))),
    ...AGENT_DIRECTORIES.flatMap((segments) => EXTRA_RECOGNIZED_STALE_AGENT_FILES.map((name) => ({
      kind: "agent",
      root: home,
      path: join(home, ...segments, name),
      expected: [],
    }))),
  ];
  const configDir = stringValue(env?.OPENCODE_CONFIG_DIR) ? resolve(cwd, env.OPENCODE_CONFIG_DIR) : null;
  const configCandidates = configDir ? [
    ...[["skills", "feature", "SKILL.md"], ["skill", "feature", "SKILL.md"]].map((segments) => ({
      kind: "skill",
      root: dirname(configDir),
      path: join(configDir, ...segments),
      expected: [packagedSkill, sanctionedSkill],
    })),
    ...[["agent"], ["agents"]].flatMap((segments) => packagedAgents.map(({ name, bytes }) => ({
      kind: "agent",
      root: dirname(configDir),
      path: join(configDir, ...segments, name),
      expected: [bytes],
    }))),
    ...[["agent"], ["agents"]].flatMap((segments) => EXTRA_RECOGNIZED_STALE_AGENT_FILES.map((name) => ({
      kind: "agent",
      root: dirname(configDir),
      path: join(configDir, ...segments, name),
      expected: [],
    }))),
  ] : [];
  const definitions = deduplicateCandidates([...homeCandidates, ...configCandidates])
    .map((candidate) => inspectCandidate(candidate.root, candidate));
  const overrideFindings = UNSUPPORTED_CONFIG_OVERRIDES
    .filter((source) => stringValue(env?.[source]))
    .map((source) => ({ kind: "override", source, path: env[source], status: "unsupported" }));
  const findings = deduplicateFindings([
    ...definitions.filter((item) => !["absent", "exact"].includes(item.status)),
    ...overrideFindings,
  ]);
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
  if (inspection?.ok !== true) throw new StaleGlobalDefinitionsError(inspection);
  return inspection;
}

export function formatGlobalDefinitionsDetail(inspection) {
  if (inspection?.ok === true) return "absent or exact current global definitions";
  return STALE_DEFINITIONS_MESSAGE;
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

function deduplicateCandidates(candidates) {
  const seen = new Set();
  return candidates.filter((item) => {
    const key = JSON.stringify([item.kind, item.path]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function stringValue(value) {
  return typeof value === "string" && value.length > 0;
}
