const HASH_A = `sha256:${"a".repeat(64)}`;
const HASH_B = `sha256:${"b".repeat(64)}`;
const NOW = "2026-07-16T12:00:00.000Z";

export const DURABLE_MUTATION_FAMILIES = Object.freeze([
  "missing-key",
  "unknown-key",
  "wrong-schema",
  "wrong-kind",
  "wrong-time",
  "wrong-type",
  "wrong-ref",
  "wrong-hash",
  "wrong-bytes",
  "descriptor-key-shape-drift",
  "stale-identity",
  "cross-bound-identity",
]);

export function emitDurableRecordMutations(source, descriptor) {
  requireRecord(source, "source");
  requireRecord(descriptor, "descriptor");
  const recordName = requireText(descriptor.record, "descriptor.record");
  if (!Array.isArray(descriptor.targets)) throw new TypeError("descriptor.targets must be an array");
  requireRecord(descriptor.exclusions, "descriptor.exclusions");

  const targetsByFamily = new Map(DURABLE_MUTATION_FAMILIES.map((family) => [family, []]));
  for (const [index, target] of descriptor.targets.entries()) {
    requireRecord(target, `descriptor.targets[${index}]`);
    if (!targetsByFamily.has(target.family)) throw new TypeError(`descriptor.targets[${index}].family is unknown`);
    requirePath(target.path, `descriptor.targets[${index}].path`);
    if (target.label !== undefined) requireText(target.label, `descriptor.targets[${index}].label`);
    targetsByFamily.get(target.family).push(target);
  }

  for (const key of Object.keys(descriptor.exclusions)) {
    if (!targetsByFamily.has(key)) throw new TypeError(`descriptor.exclusions.${key} is unknown`);
  }

  const cases = [];
  for (const family of DURABLE_MUTATION_FAMILIES) {
    const targets = targetsByFamily.get(family);
    const hasExclusion = Object.hasOwn(descriptor.exclusions, family);
    if (targets.length > 0 && hasExclusion) throw new TypeError(`${recordName}.${family} cannot be both targeted and excluded`);
    if (targets.length === 0) {
      if (!hasExclusion) throw new TypeError(`${recordName}.${family} must have a target or a record-specific exclusion`);
      requireText(descriptor.exclusions[family], `descriptor.exclusions.${family}`);
      continue;
    }

    for (const target of targets) {
      const record = structuredClone(source);
      applyMutation(record, family, target);
      const label = target.label ?? renderPath(target.path);
      cases.push({
        name: `${recordName}: ${family} (${label})`,
        family,
        recordName,
        record,
      });
    }
  }

  const names = cases.map(({ name }) => name);
  if (new Set(names).size !== names.length) throw new TypeError(`${recordName} mutation case names must be unique`);
  return cases;
}

export const DURABLE_AUTHORITY_CATALOG = deepFreeze([
  {
    id: "plan-slices-graph",
    authorityRecords: ["plan/slices.json", "final.plan.json descriptor"],
    source: {
      schema_version: 1,
      kind: "final-plan",
      created_at: NOW,
      run_id: "catalog-run",
      graph: { slices: [{ id: "B0.3", depends_on: ["B0.2"] }] },
      descriptor: { kind: "slices-graph", ref: "plan/slices.json", hash: HASH_A, bytes: "{\"slices\":[]}" },
    },
    descriptor: completeDescriptor("final.plan.json", [
      target("missing-key", ["descriptor", "kind"], "required descriptor.kind"),
      target("unknown-key", ["descriptor"], "descriptor unknown key", { key: "record_kind", value: "slices-graph" }),
      target("wrong-schema", ["schema_version"], "schema_version", { value: 2 }),
      target("wrong-kind", ["descriptor", "kind"], "required descriptor.kind", { value: "unknown-graph" }),
      target("wrong-time", ["created_at"], "created_at", { value: "not-an-iso-time" }),
      target("wrong-type", ["graph", "slices"], "graph.slices", { value: {} }),
      target("wrong-ref", ["descriptor", "ref"], "descriptor.ref", { value: "../slices.json" }),
      target("wrong-hash", ["descriptor", "hash"], "descriptor.hash", { value: "sha256:short" }),
      target("wrong-bytes", ["descriptor", "bytes"], "descriptor.bytes", { value: "{\"slices\":[{\"id\":\"tampered\"}]}" }),
      target("descriptor-key-shape-drift", ["descriptor"], "descriptor kind renamed", { from: "kind", to: "record_kind" }),
      target("stale-identity", ["run_id"], "run_id", { value: "stale-catalog-run" }),
      target("cross-bound-identity", ["graph", "slices", 0, "id"], "slice id", { value: "other-slice" }),
    ]),
  },
  {
    id: "run-envelope-terminal-result",
    authorityRecords: ["run.json envelope", "run.json.terminal_result"],
    source: {
      schema_version: 1,
      run_id: "catalog-run",
      status: "completed",
      updated_at: NOW,
      terminal_result: { status: "completed", run_id: "catalog-run", pr_url: "https://github.com/acme/repo/pull/7", artifacts: { test_report: "artifacts/test-report.md" } },
    },
    descriptor: completeDescriptor("run envelope and terminal_result", [
      target("missing-key", ["terminal_result", "status"]),
      target("unknown-key", ["terminal_result"], undefined, { key: "outcome", value: "completed" }),
      target("wrong-schema", ["schema_version"], undefined, { value: 0 }),
      target("wrong-time", ["updated_at"], undefined, { value: "yesterday" }),
      target("wrong-type", ["terminal_result"], undefined, { value: [] }),
      target("wrong-ref", ["terminal_result", "artifacts", "test_report"], undefined, { value: "../test-report.md" }),
      target("stale-identity", ["run_id"], undefined, { value: "stale-run" }),
      target("cross-bound-identity", ["terminal_result", "run_id"], undefined, { value: "other-run" }),
    ], {
      "wrong-kind": "Neither the run envelope nor terminal_result has a kind discriminator.",
      "wrong-hash": "This pair carries no hash field; byte bindings are cataloged at their owning records.",
      "wrong-bytes": "This pair has no separately bound artifact, evidence, or review bytes.",
      "descriptor-key-shape-drift": "This pair is a direct record shape, not an embedded descriptor shape.",
    }),
  },
  {
    id: "gates-snapshot-handoff",
    authorityRecords: ["run.json.gates[]", "pending_snapshot", "handoff_receipt"],
    source: {
      gate_key: "story",
      status: "approved",
      pending_snapshot: { question_ref: "gates/story.question.md", question_hash: HASH_A, artifact_ref: "artifacts/story.md", artifact_hash: HASH_B, created_at: NOW },
      handoff_receipt: { schema_version: 1, kind: "interactive-approval-handoff", gate: "story", pending_snapshot_hash: HASH_A, answer_hash: HASH_B, steering_generation: 0, accepted_at: NOW },
      bound_bytes: { artifact: "approved story bytes", answer: "approve\n" },
    },
    descriptor: completeDescriptor("gate snapshot and handoff receipt", [
      target("missing-key", ["pending_snapshot", "artifact_hash"]),
      target("unknown-key", ["handoff_receipt"], undefined, { key: "accepted_by", value: "operator" }),
      target("wrong-schema", ["handoff_receipt", "schema_version"], undefined, { value: 2 }),
      target("wrong-kind", ["handoff_receipt", "kind"], undefined, { value: "approval" }),
      target("wrong-time", ["handoff_receipt", "accepted_at"], undefined, { value: "now" }),
      target("wrong-type", ["handoff_receipt", "steering_generation"], undefined, { value: "0" }),
      target("wrong-ref", ["pending_snapshot", "question_ref"], undefined, { value: "artifacts/story.question.md" }),
      target("wrong-hash", ["handoff_receipt", "answer_hash"], undefined, { value: "sha256:short" }),
      target("wrong-bytes", ["bound_bytes", "answer"], undefined, { value: "changes_requested\n" }),
      target("descriptor-key-shape-drift", ["pending_snapshot"], undefined, { from: "artifact_ref", to: "artifact" }),
      target("stale-identity", ["pending_snapshot", "artifact_hash"], undefined, { value: HASH_A }),
      target("cross-bound-identity", ["handoff_receipt", "gate"], undefined, { value: "brief" }),
    ]),
  },
  {
    id: "steps-acceptance-inheritance",
    authorityRecords: ["run.json.steps[]", "steps[].acceptance", "steps[].inherited_acceptance"],
    source: {
      agent: "spec-writer",
      status: "accepted",
      attempts: 1,
      acceptance: { artifact_ref: "artifacts/technical-brief.md", artifact_hash: HASH_A, review_ref: "reviews/spec-writer.json", review_hash: HASH_B },
      inherited_acceptance: { from_run_id: "parent-run", parent_spec_review_ref: "reviews/spec-writer.json", artifact_hash: HASH_A, review_hash: HASH_B },
      bound_bytes: { artifact: "accepted brief bytes", review: "approving review bytes" },
    },
    descriptor: completeDescriptor("step acceptance and inherited_acceptance", [
      target("missing-key", ["acceptance", "artifact_hash"]),
      target("unknown-key", ["inherited_acceptance"], undefined, { key: "inherited", value: true }),
      target("wrong-type", ["attempts"], undefined, { value: "1" }),
      target("wrong-ref", ["acceptance", "review_ref"], undefined, { value: "evidence/spec-writer.json" }),
      target("wrong-hash", ["acceptance", "review_hash"], undefined, { value: "sha256:short" }),
      target("wrong-bytes", ["bound_bytes", "artifact"], undefined, { value: "changed brief bytes" }),
      target("descriptor-key-shape-drift", ["acceptance"], undefined, { from: "artifact_ref", to: "artifact" }),
      target("stale-identity", ["inherited_acceptance", "from_run_id"], undefined, { value: "stale-parent" }),
      target("cross-bound-identity", ["inherited_acceptance", "parent_spec_review_ref"], undefined, { value: "reviews/security-reviewer.json" }),
    ], {
      "wrong-schema": "Step and acceptance bindings have no schema_version field.",
      "wrong-kind": "Step and acceptance bindings have no kind discriminator.",
      "wrong-time": "Step acceptance authority has no timestamp field.",
    }),
  },
  {
    id: "slices-review-evidence-bindings",
    authorityRecords: ["run.json.slices[]", "slices[].review_binding", "slices[].attempt_reviews[]", "evidence/review byte bindings"],
    source: {
      id: "backend",
      status: "review",
      attempts: 2,
      review_binding: { attempt: 2, subject: "backend", review_ref: "reviews/backend.attempt-2.json", review_hash: HASH_A },
      attempt_reviews: [{ attempt: 1, review_ref: "reviews/backend.attempt-1.json", review_hash: HASH_B }],
      evidence_ref: "evidence/backend.attempt-2.json",
      evidence_hash: HASH_A,
      bound_bytes: {
        evidence: "{\"subject\":\"backend\",\"status\":\"pass\"}",
        review: "{\"subject\":\"backend\",\"verdict\":\"APPROVE\"}",
      },
    },
    descriptor: completeDescriptor("slice review and evidence bindings", [
      target("missing-key", ["review_binding", "review_hash"]),
      target("unknown-key", ["review_binding"], undefined, { key: "verdict", value: "APPROVE" }),
      target("wrong-type", ["attempt_reviews"], undefined, { value: {} }),
      target("wrong-ref", ["evidence_ref"], undefined, { value: "reviews/backend.attempt-2.json" }),
      target("wrong-hash", ["review_binding", "review_hash"], undefined, { value: "sha256:short" }),
      target("wrong-bytes", ["bound_bytes", "review"], "review bytes", { value: "{\"subject\":\"backend\",\"verdict\":\"REJECT\"}" }),
      target("wrong-bytes", ["bound_bytes", "evidence"], "evidence bytes", { value: "{\"subject\":\"backend\",\"status\":\"fail\"}" }),
      target("descriptor-key-shape-drift", ["review_binding"], undefined, { from: "review_ref", to: "ref" }),
      target("stale-identity", ["review_binding", "attempt"], undefined, { value: 1 }),
      target("cross-bound-identity", ["review_binding", "subject"], undefined, { value: "frontend" }),
    ], {
      "wrong-schema": "Slice review bindings have no schema_version field.",
      "wrong-kind": "Slice review bindings have no kind discriminator.",
      "wrong-time": "The cataloged slice review binding has no timestamp field.",
    }),
  },
  {
    id: "validator-security-pr-result",
    authorityRecords: ["run.json.validator", "run.json.security_review", "PR-created terminal_result"],
    source: {
      validator: { verdict: "GO", report: "artifacts/validation-report.md", review_ref: "reviews/implementation-validator.json" },
      security_review: { verdict: "PASS", review_ref: "reviews/security-reviewer.json" },
      terminal_result: { status: "completed", run_id: "catalog-run", pr_url: "https://github.com/acme/repo/pull/7", pr_number: 7, repository: "acme/repo" },
      bound_bytes: { validator_review: "{\"verdict\":\"GO\"}", security_review: "{\"verdict\":\"PASS\"}" },
    },
    descriptor: completeDescriptor("validator security and PR-created result", [
      target("missing-key", ["security_review", "verdict"]),
      target("unknown-key", ["validator"], undefined, { key: "approved", value: true }),
      target("wrong-type", ["terminal_result", "pr_number"], undefined, { value: "7" }),
      target("wrong-ref", ["validator", "report"], undefined, { value: "reviews/validation-report.md" }),
      target("wrong-bytes", ["bound_bytes", "security_review"], undefined, { value: "{\"verdict\":\"BLOCK\"}" }),
      target("descriptor-key-shape-drift", ["security_review"], undefined, { from: "review_ref", to: "ref" }),
      target("stale-identity", ["terminal_result", "pr_number"], undefined, { value: 6 }),
      target("cross-bound-identity", ["terminal_result", "run_id"], undefined, { value: "other-run" }),
    ], {
      "wrong-schema": "These nested verdict and result records have no schema_version field.",
      "wrong-kind": "These nested verdict and result records have no kind discriminator.",
      "wrong-time": "These nested verdict and result records have no timestamp field.",
      "wrong-hash": "Their byte-bound reviews are cataloged by the slice/review and continuation classes.",
    }),
  },
  {
    id: "continuation-planning-draft-reuse",
    authorityRecords: ["run.json.continuation", "continuation.planning_reuse", "continuation.draft_spec_reuse"],
    source: {
      schema_version: 1,
      kind: "blocked-run-continuation",
      created_at: NOW,
      parent: { run_id: "parent-run", run_ref: ".opencode/factory/parent-run/run.json", run_hash: HASH_A },
      target: { run_id: "child-run", branch: "child-run" },
      planning_reuse: { eligible: true, spec_review_ref: "reviews/spec-writer.json", spec_review_hash: HASH_A, spec_artifact_ref: "artifacts/technical-brief.md", spec_artifact_hash: HASH_B },
      draft_spec_reuse: { artifact_ref: "artifacts/technical-brief.md", artifact_hash: HASH_B, parent_step_attempts: 1, max_retries: 3, remaining_attempts: 2 },
      bound_bytes: { draft_spec: "unaccepted draft bytes" },
    },
    descriptor: completeDescriptor("continuation planning and draft reuse", [
      target("missing-key", ["parent", "run_hash"]),
      target("unknown-key", ["planning_reuse"], undefined, { key: "accepted", value: true }),
      target("wrong-schema", ["schema_version"], undefined, { value: 2 }),
      target("wrong-kind", ["kind"], undefined, { value: "resume" }),
      target("wrong-time", ["created_at"], undefined, { value: "not-time" }),
      target("wrong-type", ["planning_reuse", "eligible"], undefined, { value: "true" }),
      target("wrong-ref", ["draft_spec_reuse", "artifact_ref"], undefined, { value: "../technical-brief.md" }),
      target("wrong-hash", ["planning_reuse", "spec_review_hash"], undefined, { value: "sha256:short" }),
      target("wrong-bytes", ["bound_bytes", "draft_spec"], undefined, { value: "changed draft bytes" }),
      target("descriptor-key-shape-drift", ["planning_reuse"], undefined, { from: "spec_review_ref", to: "review_ref" }),
      target("stale-identity", ["parent", "run_id"], undefined, { value: "stale-parent" }),
      target("cross-bound-identity", ["target", "run_id"], undefined, { value: "parent-run" }),
    ]),
  },
  {
    id: "post-pr-nested-records",
    authorityRecords: ["run.json.post_pr", "post_pr.policy", "post_pr.observation", "post_pr.remediation", "post_pr.remediation.dispatch", "post_pr.remediation.revalidation", "post_pr.remediation.push", "post_pr.evidence_refs", "post_pr.continuation_review", "post_pr.terminal_fact"],
    source: {
      schema_version: 1,
      phase: "revalidating",
      attempt: 1,
      observation: { epoch: 1, expected_head_sha: "a".repeat(40), started_at: NOW },
      remediation: {
        schema_version: 1,
        attempt: 1,
        failure_evidence_ref: "evidence/post-pr-ci.attempt-1.json",
        failure_evidence_hash: HASH_A,
        dispatch: { id: "dispatch-1", status: "returned", subject: "backend", returned_at: NOW },
        revalidation: { validator_review_ref: "reviews/post-pr-validator.attempt-1.json", validator_review_hash: HASH_B },
        push: { status: "pending", local_head_sha: "b".repeat(40) },
      },
      evidence_refs: [{ ref: "evidence/post-pr-ci.attempt-1.json", hash: HASH_A }],
      continuation_review: null,
      terminal_fact: null,
      bound_bytes: { evidence: "{\"verdict\":\"red\"}" },
    },
    descriptor: completeDescriptor("post_pr nested records", [
      target("missing-key", ["remediation", "failure_evidence_hash"]),
      target("unknown-key", ["remediation", "dispatch"], undefined, { key: "owner", value: "backend" }),
      target("wrong-schema", ["remediation", "schema_version"], undefined, { value: 2 }),
      target("wrong-time", ["remediation", "dispatch", "returned_at"], undefined, { value: "returned" }),
      target("wrong-type", ["evidence_refs"], undefined, { value: {} }),
      target("wrong-ref", ["remediation", "revalidation", "validator_review_ref"], undefined, { value: "evidence/validator.json" }),
      target("wrong-hash", ["remediation", "revalidation", "validator_review_hash"], undefined, { value: "sha256:short" }),
      target("wrong-bytes", ["bound_bytes", "evidence"], undefined, { value: "{\"verdict\":\"green\"}" }),
      target("descriptor-key-shape-drift", ["evidence_refs", 0], undefined, { from: "ref", to: "evidence_ref" }),
      target("stale-identity", ["remediation", "attempt"], undefined, { value: 0 }),
      target("cross-bound-identity", ["remediation", "dispatch", "subject"], undefined, { value: "other-slice" }),
    ], { "wrong-kind": "The post_pr aggregate and remediation records have no common required kind discriminator." }),
  },
  {
    id: "pr79-merged-slice-repair",
    authorityRecords: ["run.json.merged_slice_repair (PR79)"],
    source: {
      schema_version: 1,
      plan_hash: HASH_A,
      owner_slice_id: "schema-model",
      consumer_slice_id: "critic-acceptance",
      evidence_ref: "evidence/critic-acceptance.attempt-1.json",
      evidence_hash: HASH_B,
      status: "review",
      attempts: 1,
      reviewed_commit: "a".repeat(40),
      review_ref: "reviews/repair-attempt-1.json",
      review_hash: HASH_A,
      repair_evidence_ref: "evidence/repair-attempt-1.json",
      repair_evidence_hash: HASH_B,
      bound_bytes: { review: "{\"verdict\":\"APPROVE\",\"attempt\":1}" },
      updated_at: NOW,
    },
    descriptor: completeDescriptor("PR79 merged_slice_repair", [
      target("missing-key", ["review_hash"]),
      target("unknown-key", [], "record root", { key: "repair_id", value: "repair-1" }),
      target("wrong-schema", ["schema_version"], undefined, { value: 2 }),
      target("wrong-time", ["updated_at"], undefined, { value: "later" }),
      target("wrong-type", ["attempts"], undefined, { value: "1" }),
      target("wrong-ref", ["repair_evidence_ref"], undefined, { value: "reviews/repair-attempt-1.json" }),
      target("wrong-hash", ["plan_hash"], undefined, { value: "sha256:short" }),
      target("wrong-bytes", ["bound_bytes", "review"], undefined, { value: "{\"verdict\":\"REJECT\",\"attempt\":1}" }),
      target("descriptor-key-shape-drift", [], "record root", { from: "owner_slice_id", to: "owner" }),
      target("stale-identity", ["attempts"], undefined, { value: 0 }),
      target("cross-bound-identity", ["consumer_slice_id"], undefined, { value: "schema-model" }),
    ], { "wrong-kind": "merged_slice_repair is discriminated by status and has no kind field." }),
  },
]);

export const DURABLE_AUTHORITY_EXCLUSIONS = deepFreeze([
  {
    records: ["run.json.debug_snapshot", "run.json.provenance", "run.json.cost_attribution"],
    reason: "Diagnostic records do not authorize workflow decisions and are outside the durable-authority integrity catalog.",
  },
  {
    records: ["heartbeat.json", "run.json.heartbeat_at"],
    reason: "Liveness records report activity only and do not authorize semantic state transitions.",
  },
  {
    records: ["factory.lock", "run-json.lock/owner.json", "process-launch.lock/owner.json"],
    reason: "Lock ownership records are transient coordination mechanisms, not records in this durable semantic-authority catalog.",
  },
  {
    records: ["process.json", "processes/*.log"],
    reason: "Process records and logs are sidecar execution evidence rather than durable semantic workflow authority.",
  },
]);

function completeDescriptor(record, targets, exclusions = {}) {
  const targeted = new Set(targets.map(({ family }) => family));
  const completeExclusions = { ...exclusions };
  for (const family of DURABLE_MUTATION_FAMILIES) {
    if (!targeted.has(family) && !Object.hasOwn(completeExclusions, family)) {
      throw new TypeError(`${record}.${family} is not classified by the catalog`);
    }
  }
  return { record, targets, exclusions: completeExclusions };
}

function target(family, path, label, options = {}) {
  return { family, path, ...(label === undefined ? {} : { label }), ...options };
}

function applyMutation(record, family, target) {
  if (family === "unknown-key") {
    const container = valueAt(record, target.path, family);
    requireRecord(container, `${family} target`);
    const key = requireText(target.key, `${family}.key`);
    if (Object.hasOwn(container, key)) throw new TypeError(`${family}.key must be absent from the source`);
    container[key] = cloneTargetValue(target, true);
    return;
  }

  if (family === "descriptor-key-shape-drift") {
    const container = valueAt(record, target.path, family);
    requireRecord(container, `${family} target`);
    const from = requireText(target.from, `${family}.from`);
    const to = requireText(target.to, `${family}.to`);
    if (!Object.hasOwn(container, from) || Object.hasOwn(container, to)) throw new TypeError(`${family} requires an existing from key and absent to key`);
    container[to] = container[from];
    delete container[from];
    return;
  }

  const { container, key } = parentAt(record, target.path, family);
  if (family === "missing-key") {
    delete container[key];
    return;
  }

  const current = container[key];
  const replacement = Object.hasOwn(target, "value")
    ? structuredClone(target.value)
    : defaultReplacement(family, current);
  if (Object.is(current, replacement)) throw new TypeError(`${family} replacement must differ from the source value`);
  container[key] = replacement;
}

function cloneTargetValue(target, fallback) {
  return structuredClone(Object.hasOwn(target, "value") ? target.value : fallback);
}

function defaultReplacement(family, current) {
  if (family === "wrong-schema") return current === 1 ? 2 : 1;
  if (family === "wrong-kind") return "unknown-kind";
  if (family === "wrong-time") return "not-an-iso-time";
  if (family === "wrong-ref") return "../outside.json";
  if (family === "wrong-hash") return "sha256:short";
  if (family === "wrong-bytes") {
    if (typeof current === "string") return `${current}-tampered`;
    if (typeof current === "number") return current + 1;
    if (Array.isArray(current)) return [...current, 0];
    return "tampered-bytes";
  }
  if (family === "stale-identity") return typeof current === "number" ? current - 1 : `stale-${String(current)}`;
  if (family === "cross-bound-identity") return typeof current === "number" ? current + 1 : "other-boundary";
  if (family === "wrong-type") {
    if (Array.isArray(current)) return {};
    if (current !== null && typeof current === "object") return [];
    if (typeof current === "string") return 1;
    if (typeof current === "number") return "not-a-number";
    if (typeof current === "boolean") return "not-a-boolean";
    return {};
  }
  throw new TypeError(`no mutation implementation for ${family}`);
}

function parentAt(root, path, label) {
  if (path.length === 0) throw new TypeError(`${label} requires a non-root value path`);
  const container = valueAt(root, path.slice(0, -1), label);
  const key = path.at(-1);
  if ((container === null || typeof container !== "object") || !Object.hasOwn(container, key)) {
    throw new TypeError(`${label} path ${renderPath(path)} does not resolve to an own property`);
  }
  return { container, key };
}

function valueAt(root, path, label) {
  let value = root;
  for (const key of path) {
    if ((value === null || typeof value !== "object") || !Object.hasOwn(value, key)) {
      throw new TypeError(`${label} path ${renderPath(path)} does not resolve`);
    }
    value = value[key];
  }
  return value;
}

function requirePath(path, label) {
  if (!Array.isArray(path)) throw new TypeError(`${label} must be an array`);
  for (const segment of path) {
    if (!(typeof segment === "string" && segment.length > 0) && !(Number.isInteger(segment) && segment >= 0)) {
      throw new TypeError(`${label} contains an invalid segment`);
    }
  }
}

function renderPath(path) {
  return path.length === 0 ? "<root>" : path.map(String).join(".");
}

function requireRecord(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${label} must be a record`);
  return value;
}

function requireText(value, label) {
  if (typeof value !== "string" || value.trim().length === 0) throw new TypeError(`${label} must be a non-empty string`);
  return value;
}

function deepFreeze(value) {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}
