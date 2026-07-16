const HASH_A = `sha256:${"a".repeat(64)}`;
const HASH_B = `sha256:${"b".repeat(64)}`;
const HASH_C = `sha256:${"c".repeat(64)}`;
const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const SHA_C = "c".repeat(40);
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

const AUTHORITY_CLASSES = Object.freeze([
  ["plan-slices-graph", "Plan and slices graph"],
  ["run-envelope-terminal-result", "Run envelope and terminal result"],
  ["gates-snapshot-handoff", "Gates, pending snapshot, and handoff receipt"],
  ["steps-acceptance-inheritance", "Steps and acceptance inheritance"],
  ["slices-review-evidence-bindings", "Slices and review/evidence bindings"],
  ["validator-security-pr-result", "Validator, security, and PR-created result"],
  ["continuation-planning-draft-reuse", "Continuation and planning/draft reuse"],
  ["post-pr-nested-records", "Post-PR nested records"],
  ["pr79-merged-slice-repair", "PR79 merged slice repair"],
]);

export const DURABLE_AUTHORITY_REQUIRED_RECORD_IDS = deepFreeze({
  "plan-slices-graph": [
    "plan-slices-json",
    "final-plan-descriptor",
  ],
  "run-envelope-terminal-result": [
    "run-envelope-running",
    "run-envelope-terminal",
    "terminal-result-completed",
    "terminal-result-blocked",
    "terminal-result-partial",
    "terminal-result-needs-human",
  ],
  "gates-snapshot-handoff": [
    "gate-pending",
    "gate-decided",
    "pending-snapshot",
    "handoff-receipt",
  ],
  "steps-acceptance-inheritance": [
    "step-running",
    "step-unaccepted",
    "step-accepted",
    "step-acceptance-binding",
    "step-inherited-acceptance",
  ],
  "slices-review-evidence-bindings": [
    "slice-pending-running",
    "slice-review",
    "slice-terminal",
    "slice-review-binding",
    "slice-attempt-review",
    "slice-evidence-sidecar",
    "slice-review-sidecar",
  ],
  "validator-security-pr-result": [
    "validator-verdict-binding",
    "security-verdict-binding",
    "pr-created-result",
  ],
  "continuation-planning-draft-reuse": [
    "continuation-envelope",
    "continuation-parent-binding",
    "continuation-selected-review",
    "continuation-target-binding",
    "continuation-parent-artifact-sidecar",
    "continuation-parent-evidence-sidecar",
    "continuation-parent-review-sidecar",
    "continuation-planning-reuse-ineligible",
    "continuation-planning-reuse-eligible",
    "continuation-draft-reuse",
    "continuation-post-pr-binding",
  ],
  "post-pr-nested-records": [
    "post-pr-envelope-disabled",
    "post-pr-envelope-active",
    "post-pr-policy-disabled",
    "post-pr-policy-enabled",
    "post-pr-observation-null",
    "post-pr-observation-active",
    "post-pr-remediation-null",
    "post-pr-remediation-active",
    "post-pr-dispatch-planned",
    "post-pr-dispatch-running-returned",
    "post-pr-revalidation",
    "post-pr-revalidation-empty",
    "post-pr-revalidation-bound",
    "post-pr-push",
    "post-pr-push-not-ready",
    "post-pr-push-pending",
    "post-pr-push-confirmed",
    "post-pr-evidence-sidecar",
    "post-pr-continuation-review-null",
    "post-pr-continuation-review-bound",
    "post-pr-terminal-fact-null",
    "post-pr-terminal-fact-bound",
  ],
  "pr79-merged-slice-repair": [
    "repair-reported",
    "repair-repairing",
    "repair-review",
    "repair-merged",
    "repair-blocked",
  ],
});

export function emitDurableRecordMutations(source, descriptor) {
  requireRecord(source, "source");
  requireRecord(descriptor, "descriptor");
  const recordName = requireText(descriptor.record, "descriptor.record");
  if (!Array.isArray(descriptor.targets)) throw new TypeError("descriptor.targets must be an array");
  requireRecord(descriptor.exclusions, "descriptor.exclusions");

  const targetsByFamily = new Map(DURABLE_MUTATION_FAMILIES.map((family) => [family, []]));
  for (const [index, mutationTarget] of descriptor.targets.entries()) {
    requireRecord(mutationTarget, `descriptor.targets[${index}]`);
    if (!targetsByFamily.has(mutationTarget.family)) throw new TypeError(`descriptor.targets[${index}].family is unknown`);
    requirePath(mutationTarget.path, `descriptor.targets[${index}].path`);
    if (mutationTarget.label !== undefined) requireText(mutationTarget.label, `descriptor.targets[${index}].label`);
    targetsByFamily.get(mutationTarget.family).push(mutationTarget);
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

    for (const mutationTarget of targets) {
      const record = structuredClone(source);
      try {
        applyMutation(record, family, mutationTarget);
      } catch (error) {
        throw new TypeError(`${recordName}: ${error.message}`, { cause: error });
      }
      const label = mutationTarget.label ?? renderPath(mutationTarget.path);
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

export function assertDurableAuthorityCatalogComplete(catalog) {
  if (!Array.isArray(catalog)) throw new TypeError("durable authority catalog must be an array");
  const expectedClassIds = AUTHORITY_CLASSES.map(([id]) => id);
  const actualClassIds = catalog.map(({ id }) => id);
  if (!sameList(actualClassIds, expectedClassIds)) throw new TypeError("durable authority catalog must contain exactly the nine registered authority classes in order");

  const seenRecordIds = new Set();
  for (const authorityClass of catalog) {
    requireText(authorityClass.name, `${authorityClass.id}.name`);
    if (!Array.isArray(authorityClass.records)) throw new TypeError(`${authorityClass.id}.records must register per-record entries`);
    const expectedRecordIds = DURABLE_AUTHORITY_REQUIRED_RECORD_IDS[authorityClass.id];
    const actualRecordIds = authorityClass.records.map(({ id }) => id);
    if (!sameList(actualRecordIds, expectedRecordIds)) throw new TypeError(`${authorityClass.id} must contain every required per-record and per-variant entry in order`);

    for (const record of authorityClass.records) {
      const path = `${authorityClass.id}.${record.id}`;
      if (seenRecordIds.has(record.id)) throw new TypeError(`${path} duplicates a record id`);
      seenRecordIds.add(record.id);
      if (record.authorityClassId !== authorityClass.id) throw new TypeError(`${path}.authorityClassId must match its containing class`);
      requireText(record.record, `${path}.record`);
      requireText(record.variant, `${path}.variant`);
      requireText(record.writer, `${path}.writer`);
      requireTextArray(record.readers, `${path}.readers`);
      requireTextArray(record.tests, `${path}.tests`);
      const requiredContract = REQUIRED_RECORD_CONTRACTS.get(record.id);
      if (!requiredContract || record.writer !== requiredContract.writer) throw new TypeError(`${path}.writer must match the registered checked writer`);
      if (!sameList(record.readers, requiredContract.readers)) throw new TypeError(`${path}.readers must contain every registered decision-making consumer in order`);
      if (!sameList(record.tests, requiredContract.tests)) throw new TypeError(`${path}.tests must contain every registered named test in order`);
      if (!sameList(record.facts, requiredContract.facts)) throw new TypeError(`${path}.facts must contain every registered authority fact in order`);
      if (JSON.stringify(record.sidecars) !== JSON.stringify(requiredContract.sidecars)) throw new TypeError(`${path}.sidecars must contain every registered byte binding`);
      requireRecord(record.source, `${path}.source`);
      requireRecord(record.descriptor, `${path}.descriptor`);
      if (record.descriptor.record !== record.id) throw new TypeError(`${path}.descriptor.record must equal the record id`);
      emitDurableRecordMutations(record.source, record.descriptor);
      validateRecordSidecars(record, path);
    }
  }
  return true;
}

const RECORDS = [
  recordEntry({
    authorityClassId: "plan-slices-graph", id: "plan-slices-json", record: "plan/slices.json", variant: "accepted graph",
    writer: "factory slices-seed (checked plan validation and seed transition)",
    readers: ["validateSlicesPlan", "factory slices-seed", "transitionRunSlice and transitionSliceMerged", "transitionMergedSliceRepair owner-lane checks"],
    source: { slices: [{ id: "B0.3", stack: "backend", paths: ["test/**"], depends_on: ["B0.2"], acceptance: ["AC3"], test_plan: ["node --test"] }] },
    requiredPath: ["slices"], typePath: ["slices"],
    targets: [drift(["slices", 0], "depends_on", "dependencies"), stale(["slices", 0, "id"], "stale-slice"), cross(["slices", 0, "depends_on", 0], "other-wave")],
  }),
  recordEntry({
    authorityClassId: "plan-slices-graph", id: "final-plan-descriptor", record: "final.plan.json descriptor", variant: "required descriptor",
    writer: "work-decomposer final plan write followed by reviewed planning acceptance",
    readers: ["work-reviewer decomposition review", "factory slices-seed descriptor consumption"],
    source: { schema_version: 1, kind: "final-plan", created_at: NOW, run_id: "catalog-run", descriptor: { kind: "slices-graph", ref: "plan/slices.json", hash: HASH_A }, sidecar_bytes: "{\"slices\":[]}" },
    requiredPath: ["descriptor", "kind"], typePath: ["descriptor"], sidecars: [sidecar("plan", ["descriptor", "ref"], ["descriptor", "hash"], ["sidecar_bytes"])],
    targets: [schema(["schema_version"]), kind(["descriptor", "kind"], "unknown-graph", "required descriptor.kind"), time(["created_at"]), ref(["descriptor", "ref"], "plan"), hash(["descriptor", "hash"], "plan"), bytes(["sidecar_bytes"], "plan"), drift(["descriptor"], "kind", "record_kind"), stale(["run_id"], "stale-run"), cross(["descriptor", "kind"], "other-boundary-kind", "descriptor boundary")],
  }),

  recordEntry({
    authorityClassId: "run-envelope-terminal-result", id: "run-envelope-running", record: "run.json", variant: "running",
    writer: "manifest bootstrap and transitionRunJson checked locked writers",
    readers: ["validateRun", "resumeFactory", "all checked run-state transitions through transitionRunJson", "factory status/list/watch eligibility readers"],
    source: { schema_version: 1, run_id: "catalog-run", status: "running", updated_at: NOW, base_commit: SHA_A, branch: "catalog-run", worktree: "/tmp/catalog-run", terminal_result: null },
    requiredPath: ["run_id"], typePath: ["status"], targets: [schema(["schema_version"]), time(["updated_at"]), ref(["worktree"]), stale(["base_commit"], SHA_B), cross(["run_id"], "other-run")],
  }),
  recordEntry({
    authorityClassId: "run-envelope-terminal-result", id: "run-envelope-terminal", record: "run.json", variant: "terminal envelope",
    writer: "transitionTerminalResult, transitionPrCreated, or transitionPostPrTerminal",
    readers: ["validateRun", "resumeFactory terminal check", "factory status/list/watch terminal readers", "cleanup eligibility readers"],
    source: { schema_version: 1, run_id: "catalog-run", status: "blocked", updated_at: NOW, terminal_result: { status: "blocked", run_id: "catalog-run", reason: "review-blocked" } },
    requiredPath: ["terminal_result"], typePath: ["status"], targets: [schema(["schema_version"]), time(["updated_at"]), stale(["status"], "running"), cross(["terminal_result", "run_id"], "other-run")],
  }),
  terminalResultEntry("terminal-result-completed", "completed", { pr_url: "https://github.com/acme/repo/pull/7", pr_number: 7, repository: "acme/repo", draft: false, artifacts: { test_report: "artifacts/test-report.md" } }, [ref(["artifacts", "test_report"]), stale(["pr_number"], 6)]),
  terminalResultEntry("terminal-result-blocked", "blocked", { reason: "review-blocked", summary: "Review blocked." }),
  terminalResultEntry("terminal-result-partial", "partial", { reason: "partial-completion", summary: "Some work completed." }),
  terminalResultEntry("terminal-result-needs-human", "needs-human", { reason: "operator-reconciliation", summary: "Operator action required." }),

  recordEntry({
    authorityClassId: "gates-snapshot-handoff", id: "gate-pending", record: "run.json.gates.<gate>", variant: "pending",
    writer: "transitionGateDecision pending transition",
    readers: ["validateRun gate validation", "transitionGateDecision decision admission", "approval handoff eligibility", "resume and protected-gate readers"],
    source: { gate: "story", status: "pending", artifact: "artifacts/story.md", question_ref: "gates/story.question.md", answer_ref: "gates/story.answer", pending_snapshot: {} },
    requiredPath: ["status"], typePath: ["pending_snapshot"], targets: [ref(["artifact"]), stale(["status"], "approved"), cross(["gate"], "brief"), drift([], "question_ref", "question")],
  }),
  recordEntry({
    authorityClassId: "gates-snapshot-handoff", id: "gate-decided", record: "run.json.gates.<gate>", variant: "approved/changes_requested/stopped",
    writer: "transitionGateDecision checked decision transition",
    readers: ["validateRun gate validation", "assertPrCreatedReadiness", "approval handoff eligibility", "step and terminal boundary guards"],
    source: { gate: "story", status: "approved", answer: "approve", approval_source: "external-driver", answered_at: NOW, handoff_receipt: null },
    requiredPath: ["status"], typePath: ["approval_source"], targets: [time(["answered_at"]), stale(["status"], "pending"), cross(["gate"], "pre_pr")],
  }),
  recordEntry({
    authorityClassId: "gates-snapshot-handoff", id: "pending-snapshot", record: "pending_snapshot", variant: "question/artifact/answer bindings",
    writer: "createPendingGateSnapshot inside transitionGateDecision",
    readers: ["validatePendingSnapshot", "transitionGateDecision fresh byte recheck", "validateApprovalHandoffReceipt"],
    source: { question_ref: "gates/story.question.md", question_hash: HASH_A, artifact_ref: "artifacts/story.md", artifact_hash: HASH_B, answer_ref: "gates/story.answer", answer_hash: HASH_C, created_at: NOW, sidecar_bytes: { question: "question", artifact: "story", answer: "approve\n" } },
    requiredPath: ["question_ref"], typePath: ["answer_hash"], sidecars: [sidecar("question", ["question_ref"], ["question_hash"], ["sidecar_bytes", "question"]), sidecar("artifact", ["artifact_ref"], ["artifact_hash"], ["sidecar_bytes", "artifact"]), sidecar("answer", ["answer_ref"], ["answer_hash"], ["sidecar_bytes", "answer"])],
    targets: [time(["created_at"]), ...sidecarTargets("question", ["question_ref"], ["question_hash"], ["sidecar_bytes", "question"]), ...sidecarTargets("artifact", ["artifact_ref"], ["artifact_hash"], ["sidecar_bytes", "artifact"]), ...sidecarTargets("answer", ["answer_ref"], ["answer_hash"], ["sidecar_bytes", "answer"]), drift([], "artifact_ref", "artifact"), stale(["answer_hash"], HASH_A), cross(["question_ref"], "gates/brief.question.md")],
  }),
  recordEntry({
    authorityClassId: "gates-snapshot-handoff", id: "handoff-receipt", record: "handoff_receipt", variant: "interactive approval bound",
    writer: "createApprovalHandoffReceipt inside transitionGateDecision",
    readers: ["validateGateHandoffReceipt", "validateApprovalHandoffReceipt", "transitionGateDecisionAndHandoff launch admission"],
    source: { schema_version: 1, kind: "interactive-approval-handoff", gate: "story", approval_fingerprint: HASH_A, pending_snapshot_hash: HASH_B, answer_hash: HASH_C, steering_generation: 0, accepted_at: NOW, sidecar_bytes: { pending_snapshot: "snapshot", answer: "approve\n" } },
    requiredPath: ["kind"], typePath: ["steering_generation"], sidecars: [sidecar("pending-snapshot", null, ["pending_snapshot_hash"], ["sidecar_bytes", "pending_snapshot"]), sidecar("answer", null, ["answer_hash"], ["sidecar_bytes", "answer"])],
    targets: [schema(["schema_version"]), kind(["kind"], "approval"), time(["accepted_at"]), hash(["pending_snapshot_hash"], "pending-snapshot"), bytes(["sidecar_bytes", "pending_snapshot"], "pending-snapshot"), hash(["answer_hash"], "answer"), bytes(["sidecar_bytes", "answer"], "answer"), stale(["steering_generation"], -1), cross(["gate"], "brief")],
  }),

  stepEntry("step-running", "running", null, null),
  stepEntry("step-unaccepted", "rejected/blocked", null, null),
  stepEntry("step-accepted", "accepted", { artifact_ref: "artifacts/technical-brief.md", review_ref: "reviews/spec-writer.json" }, null),
  recordEntry({
    authorityClassId: "steps-acceptance-inheritance", id: "step-acceptance-binding", record: "steps[].acceptance", variant: "artifact and optional review bound",
    writer: "transitionRunStep accepted transition",
    readers: ["validateRun step acceptance validation", "continuationPlanningReuse", "adoptContinuationPlanning", "accepted planning consumers"],
    source: { artifact_ref: "artifacts/technical-brief.md", artifact_hash: HASH_A, review_ref: "reviews/spec-writer.json", review_hash: HASH_B, sidecar_bytes: { artifact: "brief", review: "approve" } },
    requiredPath: ["artifact_ref"], typePath: ["artifact_hash"], sidecars: [sidecar("artifact", ["artifact_ref"], ["artifact_hash"], ["sidecar_bytes", "artifact"]), sidecar("review", ["review_ref"], ["review_hash"], ["sidecar_bytes", "review"])],
    targets: [...sidecarTargets("artifact", ["artifact_ref"], ["artifact_hash"], ["sidecar_bytes", "artifact"]), ...sidecarTargets("review", ["review_ref"], ["review_hash"], ["sidecar_bytes", "review"]), drift([], "artifact_ref", "artifact"), stale(["artifact_hash"], HASH_C), cross(["review_ref"], "reviews/security-reviewer.json")],
  }),
  recordEntry({
    authorityClassId: "steps-acceptance-inheritance", id: "step-inherited-acceptance", record: "steps[].inherited_acceptance", variant: "parent acceptance adopted",
    writer: "adoptContinuationPlanning checked adoption transition",
    readers: ["validateStepInheritedAcceptance", "continuation planning consumers", "blocked-run continuation audit readers"],
    source: { from_run_id: "parent-run", parent_spec_review_ref: "reviews/spec-writer.json", artifact_hash: HASH_A, review_hash: HASH_B, sidecar_bytes: { artifact: "brief", review: "approve" } },
    requiredPath: ["from_run_id"], typePath: ["artifact_hash"], sidecars: [sidecar("artifact", null, ["artifact_hash"], ["sidecar_bytes", "artifact"]), sidecar("review", ["parent_spec_review_ref"], ["review_hash"], ["sidecar_bytes", "review"])],
    targets: [hash(["artifact_hash"], "artifact"), bytes(["sidecar_bytes", "artifact"], "artifact"), ...sidecarTargets("review", ["parent_spec_review_ref"], ["review_hash"], ["sidecar_bytes", "review"]), stale(["from_run_id"], "stale-parent"), cross(["parent_spec_review_ref"], "reviews/other-run.json")],
  }),

  sliceEntry("slice-pending-running", "pending/running", { status: "running", attempts: 1 }),
  sliceEntry("slice-review", "review", { status: "review", attempts: 1, evidence_ref: "evidence/backend.json", review_ref: "reviews/backend.json" }),
  sliceEntry("slice-terminal", "merged/blocked", { status: "merged", attempts: 1, merge_commit: SHA_B }),
  recordEntry({
    authorityClassId: "slices-review-evidence-bindings", id: "slice-review-binding", record: "slices[].review_binding", variant: "current attempt review bound",
    writer: "transitionRunSlice review transition",
    readers: ["validateRun slice validation", "transitionSliceMerged", "slice remediation/review replay readers"],
    source: { attempt: 2, subject: "backend", reviewed_commit: SHA_B, review_ref: "reviews/backend.attempt-2.json", review_hash: HASH_A, sidecar_bytes: "approve" },
    requiredPath: ["attempt"], typePath: ["reviewed_commit"], sidecars: [sidecar("review", ["review_ref"], ["review_hash"], ["sidecar_bytes"])],
    targets: [...sidecarTargets("review", ["review_ref"], ["review_hash"], ["sidecar_bytes"]), drift([], "review_ref", "ref"), stale(["attempt"], 1), cross(["subject"], "frontend")],
  }),
  recordEntry({
    authorityClassId: "slices-review-evidence-bindings", id: "slice-attempt-review", record: "slices[].attempt_reviews[]", variant: "append-only prior attempt",
    writer: "transitionRunSlice review/rejection transition",
    readers: ["validateRun slice attempt history", "work-review remediation routing", "transitionSliceMerged current-attempt checks"],
    source: { attempt: 1, subject: "backend", review_ref: "reviews/backend.attempt-1.json", review_hash: HASH_A, verdict: "REJECT", sidecar_bytes: "reject" },
    requiredPath: ["attempt"], typePath: ["verdict"], sidecars: [sidecar("review", ["review_ref"], ["review_hash"], ["sidecar_bytes"])],
    targets: [...sidecarTargets("review", ["review_ref"], ["review_hash"], ["sidecar_bytes"]), stale(["attempt"], 0), cross(["subject"], "other-slice")],
  }),
  sidecarRecord("slices-review-evidence-bindings", "slice-evidence-sidecar", "evidence/<slice>.json", "slice evidence", "transitionRunSlice review transition", ["transitionRunSlice review admission", "work-reviewer evidence truth checks", "transitionSliceMerged"], "evidence/backend.attempt-2.json", "{\"status\":\"pass\"}"),
  sidecarRecord("slices-review-evidence-bindings", "slice-review-sidecar", "reviews/<slice>.json", "slice review", "transitionRunSlice review binding", ["transitionRunSlice review admission", "transitionSliceMerged", "remediation attempt routing"], "reviews/backend.attempt-2.json", "{\"verdict\":\"APPROVE\"}"),

  panelEntry("validator-verdict-binding", "run.json.validator", "implementation-validator", "GO", "artifacts/validation-report.md", "reviews/implementation-validator.json", "factory verdicts checked transition", ["assertPrCreatedReadiness", "post-PR revalidation", "terminal/panel remediation routing"]),
  panelEntry("security-verdict-binding", "run.json.security_review", "security-reviewer", "PASS", null, "reviews/security-reviewer.json", "factory verdicts checked transition", ["assertPrCreatedReadiness", "post-PR revalidation", "terminal/panel remediation routing"]),
  recordEntry({
    authorityClassId: "validator-security-pr-result", id: "pr-created-result", record: "PR-created terminal_result", variant: "completed external PR",
    writer: "transitionPrCreated after fenced external PR creation/re-observation",
    readers: ["validateRun terminal consistency", "resumeFactory terminal reader", "cleanup eligibility", "post-PR initialization and continuation admission"],
    source: { status: "completed", run_id: "catalog-run", pr_url: "https://github.com/acme/repo/pull/7", pr_number: 7, repository: "acme/repo", draft: false, head_sha: SHA_B },
    requiredPath: ["pr_url"], typePath: ["pr_number"], targets: [ref(["pr_url"]), stale(["head_sha"], SHA_A), cross(["repository"], "other/repo")],
  }),

  continuationEnvelopeEntry(),
  continuationParentEntry(),
  continuationReviewEntry(),
  continuationTargetEntry(),
  continuationContextEntry("continuation-parent-artifact-sidecar", "parent_artifacts[]", "artifact", "artifacts/story.md"),
  continuationContextEntry("continuation-parent-evidence-sidecar", "parent_evidence[]", "evidence", "evidence/test-verifier.json"),
  continuationContextEntry("continuation-parent-review-sidecar", "parent_reviews[]", "review", "reviews/implementation-validator.json"),
  recordEntry({
    authorityClassId: "continuation-planning-draft-reuse", id: "continuation-planning-reuse-ineligible", record: "continuation.planning_reuse", variant: "eligible false",
    writer: "factory continue planning reuse assessment",
    readers: ["validateContinuationPlanningReuse", "feature command payload normalization", "adoptContinuationPlanning refusal path"],
    source: { eligible: false }, requiredPath: ["eligible"], typePath: ["eligible"], targets: [stale(["eligible"], true), cross(["eligible"], "parent-accepted")],
  }),
  recordEntry({
    authorityClassId: "continuation-planning-draft-reuse", id: "continuation-planning-reuse-eligible", record: "continuation.planning_reuse", variant: "eligible true with accepted bytes",
    writer: "factory continue planning reuse assessment",
    readers: ["validateContinuationPlanningReuse", "feature command payload normalization", "adoptContinuationPlanning checked adoption"],
    source: { eligible: true, spec_review_ref: "reviews/spec-writer.json", spec_review_hash: HASH_A, spec_artifact_ref: "artifacts/technical-brief.md", spec_artifact_hash: HASH_B, sidecar_bytes: { review: "approve", artifact: "brief" } },
    requiredPath: ["eligible"], typePath: ["spec_review_hash"], sidecars: [sidecar("review", ["spec_review_ref"], ["spec_review_hash"], ["sidecar_bytes", "review"]), sidecar("artifact", ["spec_artifact_ref"], ["spec_artifact_hash"], ["sidecar_bytes", "artifact"])],
    targets: [...sidecarTargets("review", ["spec_review_ref"], ["spec_review_hash"], ["sidecar_bytes", "review"]), ...sidecarTargets("artifact", ["spec_artifact_ref"], ["spec_artifact_hash"], ["sidecar_bytes", "artifact"]), stale(["eligible"], false), cross(["spec_review_ref"], "reviews/other-run.json")],
  }),
  recordEntry({
    authorityClassId: "continuation-planning-draft-reuse", id: "continuation-draft-reuse", record: "continuation.draft_spec_reuse", variant: "unaccepted draft with remaining retry budget",
    writer: "factory continue draft reuse admission",
    readers: ["validateContinuationDraftSpecReuse", "feature command payload normalization", "spec-writer attempt/budget initialization"],
    source: { artifact_ref: "artifacts/technical-brief.md", artifact_hash: HASH_A, parent_step_status: "rejected", parent_step_attempts: 1, max_retries: 3, remaining_attempts: 2, sidecar_bytes: "draft" },
    requiredPath: ["artifact_ref"], typePath: ["remaining_attempts"], sidecars: [sidecar("draft", ["artifact_ref"], ["artifact_hash"], ["sidecar_bytes"])],
    targets: [...sidecarTargets("draft", ["artifact_ref"], ["artifact_hash"], ["sidecar_bytes"]), stale(["parent_step_attempts"], 0), cross(["remaining_attempts"], 3)] ,
  }),
  recordEntry({
    authorityClassId: "continuation-planning-draft-reuse", id: "continuation-post-pr-binding", record: "continuation.post_pr", variant: "blocked post-PR continuation context",
    writer: "factory continue post-PR continuation admission",
    readers: ["validateContinuationPostPr", "feature command payload normalization", "post-PR continuation workflow routing"],
    source: { pr_url: "https://github.com/acme/repo/pull/7", repository: "acme/repo", pr_number: 7, head_sha: SHA_A, disposition: "leave-unchanged", post_pr_hash: HASH_A, evidence_ref: "evidence/post-pr.json", evidence_hash: HASH_B, continuation_review_ref: "reviews/post-pr.json", continuation_review_hash: HASH_C, sidecar_bytes: { evidence: "red", review: "blocked" } },
    requiredPath: ["pr_url"], typePath: ["pr_number"], sidecars: [sidecar("evidence", ["evidence_ref"], ["evidence_hash"], ["sidecar_bytes", "evidence"]), sidecar("review", ["continuation_review_ref"], ["continuation_review_hash"], ["sidecar_bytes", "review"])],
    targets: [...sidecarTargets("evidence", ["evidence_ref"], ["evidence_hash"], ["sidecar_bytes", "evidence"]), ...sidecarTargets("review", ["continuation_review_ref"], ["continuation_review_hash"], ["sidecar_bytes", "review"]), ref(["pr_url"]), hash(["post_pr_hash"]), stale(["head_sha"], SHA_B), cross(["repository"], "other/repo")],
  }),

  postPrEnvelopeEntry("post-pr-envelope-disabled", "disabled", false),
  postPrEnvelopeEntry("post-pr-envelope-active", "revalidating", true),
  postPrPolicyEntry("post-pr-policy-disabled", false),
  postPrPolicyEntry("post-pr-policy-enabled", true),
  postPrNullEntry("post-pr-observation-null", "post_pr.observation", "observation", "awaiting-pr", "transitionPrCreated initializes observation", ["validatePostPrObservation", "transitionPostPrState monotonic observation checks", "transitionPostPrTerminal observation preconditions"]),
  postPrObservationEntry(),
  postPrNullEntry("post-pr-remediation-null", "post_pr.remediation", "remediation", "observing", "transitionPostPrFailure creates remediation", ["validatePostPrRemediation", "transitionPostPrFailure replay checks", "transitionPostPrTerminal failure preconditions"]),
  postPrRemediationEntry(),
  postPrDispatchEntry("post-pr-dispatch-planned", "planned", null, null),
  postPrDispatchEntry("post-pr-dispatch-running-returned", "running/returned", NOW, null),
  postPrRevalidationContractEntry(),
  postPrRevalidationEntry("post-pr-revalidation-empty", false),
  postPrRevalidationEntry("post-pr-revalidation-bound", true),
  postPrPushContractEntry(),
  postPrPushEntry("post-pr-push-not-ready", "not-ready", null, null),
  postPrPushEntry("post-pr-push-pending", "pending", SHA_A, null),
  postPrPushEntry("post-pr-push-confirmed", "confirmed", SHA_A, SHA_B),
  sidecarRecord("post-pr-nested-records", "post-pr-evidence-sidecar", "post_pr.evidence_refs[]", "failure/remediation evidence", "transitionPostPrFailure or transitionPostPrState append", ["assertPostPrRefsConsistent", "bindPostPrContinuationReview", "transitionPostPrTerminal"], "evidence/post-pr-ci.attempt-1.json", "{\"verdict\":\"red\"}"),
  postPrNullEntry("post-pr-continuation-review-null", "post_pr.continuation_review", "continuation_review", "observing", "transitionPostPrTerminal binds only retry exhaustion", ["validatePostPr", "transitionPostPrTerminal retry-exhaustion checks", "factory continue post-PR admission"]),
  postPrContinuationReviewEntry(),
  postPrNullEntry("post-pr-terminal-fact-null", "post_pr.terminal_fact", "terminal_fact", "succeeded", "transitionPostPrTerminal writes null for non-fact terminal reasons", ["validatePostPrTerminalFact", "terminal status/readers"]),
  postPrTerminalFactEntry(),

  repairEntry("repair-reported", "reported", 0, {
    facts: ["defect-path", "owner-consumer", "plan-owner-snapshot", "original-evidence", "attempts-quiescence"],
    record: { defect_path: "src/owner/records.js" },
    sidecars: ["plan-owner", "original-evidence"],
  }),
  repairEntry("repair-repairing", "repairing", 1, {
    facts: ["defect-path", "owner-consumer", "plan-owner-snapshot", "baseline", "original-evidence", "attempts-quiescence"],
    record: { defect_path: "src/owner/records.js", baseline_commit: SHA_A, branch: "repair", worktree: "/tmp/repair" },
    sidecars: ["plan-owner", "original-evidence"],
  }),
  repairEntry("repair-review", "review", 1, {
    facts: ["defect-path", "owner-consumer", "plan-owner-snapshot", "baseline", "original-evidence", "repair-evidence", "reviewed-commit-review-bytes", "attempts-quiescence"],
    record: { defect_path: "src/owner/records.js", baseline_commit: SHA_A, reviewed_commit: SHA_B, review_ref: "reviews/repair-attempt-1.json", review_hash: HASH_C, repair_evidence_ref: "evidence/repair-attempt-1.json", repair_evidence_hash: HASH_C },
    sidecars: ["plan-owner", "original-evidence", "repair-evidence", "review"],
  }),
  repairEntry("repair-merged", "merged", 1, {
    facts: ["defect-path", "owner-consumer", "plan-owner-snapshot", "baseline", "original-evidence", "repair-evidence", "reviewed-commit-review-bytes", "verification", "merge-commit-tree", "attempts-quiescence"],
    record: { defect_path: "src/owner/records.js", baseline_commit: SHA_A, reviewed_commit: SHA_B, review_ref: "reviews/repair-attempt-1.json", review_hash: HASH_C, repair_evidence_ref: "evidence/repair-attempt-1.json", repair_evidence_hash: HASH_C, verification_ref: "evidence/repair-verification.json", verification_hash: HASH_B, merge_commit: SHA_C, reviewed_tree: HASH_A, merge_tree: HASH_A },
    sidecars: ["plan-owner", "original-evidence", "repair-evidence", "review", "verification"],
  }),
  repairEntry("repair-blocked", "blocked", 1, {
    facts: ["defect-path", "owner-consumer", "plan-owner-snapshot", "original-evidence", "attempts-quiescence"],
    record: { defect_path: "src/owner/records.js", reason: "repair rejected" },
    sidecars: ["plan-owner", "original-evidence"],
  }),
];

const REQUIRED_RECORD_CONTRACTS = new Map(RECORDS.map((record) => [record.id, deepFreeze({
  writer: record.writer,
  readers: [...record.readers],
  tests: [...record.tests],
  facts: [...record.facts],
  sidecars: structuredClone(record.sidecars),
})]));

const mutableCatalog = AUTHORITY_CLASSES.map(([id, name]) => ({
  id,
  name,
  records: RECORDS.filter(({ authorityClassId }) => authorityClassId === id),
}));

assertDurableAuthorityCatalogComplete(mutableCatalog);
export const DURABLE_AUTHORITY_CATALOG = deepFreeze(mutableCatalog);

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

function terminalResultEntry(id, status, extras, targets = []) {
  return recordEntry({
    authorityClassId: "run-envelope-terminal-result", id, record: "run.json.terminal_result", variant: status,
    writer: status === "completed" ? "transitionPrCreated" : "transitionTerminalResult or transitionPostPrTerminal",
    readers: ["validateRun terminal consistency", "resumeFactory terminal check", "factory status/list/watch terminal readers", "cleanup eligibility readers"],
    source: { status, run_id: "catalog-run", reason: status === "completed" ? null : extras.reason, summary: extras.summary ?? "PR created.", ...extras },
    requiredPath: ["status"], typePath: ["run_id"], targets: [...targets, stale(["status"], "running"), cross(["run_id"], "other-run")],
  });
}

function stepEntry(id, variant, acceptance, inheritedAcceptance) {
  const status = id === "step-running" ? "running" : id === "step-accepted" ? "accepted" : "rejected";
  return recordEntry({
    authorityClassId: "steps-acceptance-inheritance", id, record: "run.json.steps[]", variant,
    writer: "transitionRunStep checked step transition",
    readers: ["validateRun step validation", "workflow dispatch/acceptance routing", "test-verifier and continuation eligibility readers"],
    source: { agent: "spec-writer", status, attempts: 1, artifact_ref: "artifacts/technical-brief.md", review_ref: status === "running" ? null : "reviews/spec-writer.json", acceptance, inherited_acceptance: inheritedAcceptance },
    requiredPath: ["agent"], typePath: ["attempts"], targets: [ref(["artifact_ref"]), stale(["attempts"], 0), cross(["agent"], "security-reviewer")],
  });
}

function sliceEntry(id, variant, extras) {
  return recordEntry({
    authorityClassId: "slices-review-evidence-bindings", id, record: "run.json.slices[]", variant,
    writer: "transitionRunSlice and transitionSliceMerged checked transitions",
    readers: ["validateRun slice validation", "builder-wave dependency scheduler", "transitionSliceMerged", "PR readiness and repair admission readers"],
    source: { id: "backend", stack: "backend", depends_on: ["schema"], branch: "feature--backend", worktree: "/tmp/backend", ...extras },
    requiredPath: ["id"], typePath: ["attempts"], targets: [ref(["worktree"]), stale(["attempts"], 0), cross(["id"], "frontend")],
  });
}

function sidecarRecord(authorityClassId, id, record, variant, writer, readers, refValue, sidecarBytes) {
  return recordEntry({
    authorityClassId, id, record, variant, writer, readers,
    source: { subject: "backend", attempt: 1, ref: refValue, hash: HASH_A, sidecar_bytes: sidecarBytes },
    requiredPath: ["subject"], typePath: ["attempt"], sidecars: [sidecar("sidecar", ["ref"], ["hash"], ["sidecar_bytes"])],
    targets: [...sidecarTargets("sidecar", ["ref"], ["hash"], ["sidecar_bytes"]), stale(["attempt"], 0), cross(["subject"], "other-subject")],
  });
}

function panelEntry(id, record, subject, verdict, reportRef, reviewRef, writer, readers) {
  const source = { subject, attempt: 1, verdict, report_ref: reportRef, review_ref: reviewRef, review_hash: HASH_A, reviewed_commit: SHA_B, sidecar_bytes: { review: `{\"verdict\":\"${verdict}\"}`, report: "panel report" } };
  const sidecars = [sidecar("review", ["review_ref"], ["review_hash"], ["sidecar_bytes", "review"])];
  const targets = [...sidecarTargets("review", ["review_ref"], ["review_hash"], ["sidecar_bytes", "review"]), stale(["attempt"], 0), cross(["subject"], "other-panel")];
  if (reportRef) {
    source.report_hash = HASH_B;
    sidecars.push(sidecar("report", ["report_ref"], ["report_hash"], ["sidecar_bytes", "report"]));
    targets.push(...sidecarTargets("report", ["report_ref"], ["report_hash"], ["sidecar_bytes", "report"]));
  }
  return recordEntry({ authorityClassId: "validator-security-pr-result", id, record, variant: `${verdict} bound`, writer, readers, source, requiredPath: ["verdict"], typePath: ["attempt"], sidecars, targets });
}

function continuationEnvelopeEntry() {
  return recordEntry({
    authorityClassId: "continuation-planning-draft-reuse", id: "continuation-envelope", record: "run.json.continuation", variant: "blocked-run continuation",
    writer: "factory continue checked child-run admission",
    readers: ["validateContinuation", "feature command payload normalization", "continuation workflow routing", "adoptContinuationPlanning"],
    source: { schema_version: 1, kind: "blocked-run-continuation", created_at: NOW, operator_summary: "Continue blocked run." },
    requiredPath: ["kind"], typePath: ["operator_summary"], targets: [schema(["schema_version"]), kind(["kind"], "resume"), time(["created_at"]), stale(["kind"], "existing-run-resume"), cross(["operator_summary"], "other run")],
  });
}

function continuationParentEntry() {
  return recordEntry({
    authorityClassId: "continuation-planning-draft-reuse", id: "continuation-parent-binding", record: "continuation.parent", variant: "blocked parent",
    writer: "factory continue checked parent admission",
    readers: ["validateContinuationParent", "factory continue source revalidation", "adoptContinuationPlanning"],
    source: { run_id: "parent-run", status: "blocked", run_ref: ".opencode/factory/parent-run/run.json", run_hash: HASH_A, branch: "parent", commit: SHA_A, worktree: ".opencode/worktrees/parent", sidecar_bytes: "parent run bytes" },
    requiredPath: ["run_id"], typePath: ["status"], sidecars: [sidecar("parent-run", ["run_ref"], ["run_hash"], ["sidecar_bytes"])],
    targets: [...sidecarTargets("parent-run", ["run_ref"], ["run_hash"], ["sidecar_bytes"]), stale(["commit"], SHA_B), cross(["run_id"], "child-run")],
  });
}

function continuationReviewEntry() {
  return recordEntry({
    authorityClassId: "continuation-planning-draft-reuse", id: "continuation-selected-review", record: "continuation.review", variant: "approved blocking review",
    writer: "factory continue selected-review admission",
    readers: ["validateContinuationReview", "validateContinuationSelectedReview", "continuation remediation decomposition"],
    source: { kind: "validator", ref: "reviews/remediation-review.json", hash: HASH_A, subject: "parent", verdict: "APPROVE", source: "run.validator.review_ref", required_fixes: ["fix"], sidecar_bytes: "approved review" },
    requiredPath: ["kind"], typePath: ["required_fixes"], sidecars: [sidecar("selected-review", ["ref"], ["hash"], ["sidecar_bytes"])],
    targets: [kind(["kind"], "unknown-review"), ...sidecarTargets("selected-review", ["ref"], ["hash"], ["sidecar_bytes"]), stale(["verdict"], "REJECT"), cross(["subject"], "other-branch")],
  });
}

function continuationTargetEntry() {
  return recordEntry({
    authorityClassId: "continuation-planning-draft-reuse", id: "continuation-target-binding", record: "continuation.target", variant: "fresh child target",
    writer: "factory continue checked child target allocation",
    readers: ["validateContinuationTarget", "feature command payload normalization", "child bootstrap and Git/worktree creation"],
    source: { run_id: "child-run", branch: "child", worktree: ".opencode/worktrees/child", base_ref: "main", base_commit: SHA_B },
    requiredPath: ["run_id"], typePath: ["base_commit"], targets: [ref(["worktree"]), stale(["base_commit"], SHA_A), cross(["run_id"], "parent-run")],
  });
}

function continuationContextEntry(id, record, kindValue, refValue) {
  return recordEntry({
    authorityClassId: "continuation-planning-draft-reuse", id, record: `continuation.${record}`, variant: `${kindValue} context binding`,
    writer: "factory continue parent context inventory",
    readers: ["validateContinuationRefHashArray", "feature command payload normalization", "continuation planning/remediation context loader"],
    source: { kind: kindValue, ref: refValue, hash: HASH_A, sidecar_bytes: `${kindValue} bytes` },
    requiredPath: ["kind"], typePath: ["kind"], sidecars: [sidecar(kindValue, ["ref"], ["hash"], ["sidecar_bytes"])],
    targets: [kind(["kind"], "other-kind"), ...sidecarTargets(kindValue, ["ref"], ["hash"], ["sidecar_bytes"]), stale(["hash"], HASH_B), cross(["ref"], `reviews/other-${kindValue}.json`)],
  });
}

function postPrEnvelopeEntry(id, phase, enabled) {
  return recordEntry({
    authorityClassId: "post-pr-nested-records", id, record: "run.json.post_pr", variant: phase,
    writer: enabled ? "transitionPrCreated initialization and transitionPostPrState" : "createPostPrState persisted policy initialization",
    readers: ["validatePostPr", "assertPostPrGenericMutation", "transitionPostPrState", "transitionPostPrFailure", "transitionPostPrTerminal", "resume eligibility"],
    source: { schema_version: 1, policy: { enabled }, phase, attempt: enabled ? 1 : 0, observation: enabled ? {} : null, remediation: enabled ? {} : null, evidence_refs: [], continuation_review: null, terminal_fact: null },
    requiredPath: ["phase"], typePath: ["attempt"], targets: [schema(["schema_version"]), stale(["attempt"], -1), cross(["phase"], enabled ? "disabled" : "observing")],
  });
}

function postPrPolicyEntry(id, enabled) {
  return recordEntry({
    authorityClassId: "post-pr-nested-records", id, record: "post_pr.policy", variant: enabled ? "enabled" : "disabled",
    writer: "createPostPrState from effective start-time policy",
    readers: ["validatePostPrPolicy", "transitionPrCreated observation initialization", "all post-PR timing/retry/review decisions", "assertPostPrPhaseTransition immutable policy check"],
    source: { enabled, wait_ms: 3_600_000, initial_poll_ms: 30_000, max_poll_ms: 120_000, check_start_grace_ms: 300_000, max_transient_errors: 12, review: { required: enabled, reviewer_login: enabled ? "reviewer" : null, source: enabled ? "driver" : "none" } },
    requiredPath: ["enabled"], typePath: ["wait_ms"], targets: [stale(["max_transient_errors"], 0), cross(["review", "required"], !enabled), drift(["review"], "reviewer_login", "login")],
  });
}

function postPrNullEntry(id, record, key, phase, writer, readers) {
  return recordEntry({
    authorityClassId: "post-pr-nested-records", id, record, variant: "null",
    writer, readers,
    source: { phase, [key]: null }, requiredPath: [key], typePath: [key], targets: [stale(["phase"], "stale-phase"), cross([key], { from_other_attempt: true })],
  });
}

function postPrObservationEntry() {
  return recordEntry({
    authorityClassId: "post-pr-nested-records", id: "post-pr-observation-active", record: "post_pr.observation", variant: "active non-null epoch",
    writer: "transitionPrCreated initialization and transitionPostPrState observations",
    readers: ["validatePostPrObservation", "assertPostPrMonotonicState", "transitionPostPrFailure source/replay checks", "transitionPostPrTerminal preconditions"],
    source: { epoch: 1, expected_head_sha: SHA_A, started_at: NOW, deadline_at: "2026-07-16T13:00:00.000Z", next_poll_at: NOW, poll_count: 0, unchanged_count: 0, current_interval_ms: 30_000, consecutive_transient_errors: 0, last_observed_at: null, last_fingerprint: null, last_check_verdict: "pending", last_review_verdict: "pending", last_verdict: "pending", last_error: null },
    requiredPath: ["epoch"], typePath: ["poll_count"], targets: [time(["started_at"]), stale(["epoch"], 0), cross(["expected_head_sha"], SHA_B), drift([], "expected_head_sha", "head_sha")],
  });
}

function postPrRemediationEntry() {
  return recordEntry({
    authorityClassId: "post-pr-nested-records", id: "post-pr-remediation-active", record: "post_pr.remediation", variant: "active non-null attempt",
    writer: "transitionPostPrFailure and transitionPostPrState",
    readers: ["validatePostPrRemediation", "assertPostPrAttemptTransition", "assertPostPrMonotonicState", "post-PR revalidation/push/terminal decisions"],
    source: { schema_version: 1, attempt: 1, reason_code: "check-red", failure_fingerprint: HASH_A, failed_head_sha: SHA_A, failure_evidence_ref: "evidence/post-pr.json", failure_evidence_hash: HASH_B, owner: { kind: "slice", slice_id: "backend" }, route: "backend-builder", lane: "slice", stage: "planned", baseline_head_sha: SHA_A, sidecar_bytes: "failure evidence" },
    requiredPath: ["attempt"], typePath: ["owner"], sidecars: [sidecar("failure-evidence", ["failure_evidence_ref"], ["failure_evidence_hash"], ["sidecar_bytes"])],
    targets: [schema(["schema_version"]), ...sidecarTargets("failure-evidence", ["failure_evidence_ref"], ["failure_evidence_hash"], ["sidecar_bytes"]), kind(["owner", "kind"], "other-owner"), stale(["attempt"], 0), cross(["owner", "slice_id"], "frontend")],
  });
}

function postPrDispatchEntry(id, variant, startedAt, returnedAt) {
  return recordEntry({
    authorityClassId: "post-pr-nested-records", id, record: "post_pr.remediation.dispatch", variant,
    writer: "transitionPostPrState dispatch phase transition",
    readers: ["validatePostPrDispatch", "assertPostPrMonotonicState", "transitionPostPrTerminal dispatch-start reconciliation"],
    source: { id: "dispatch-1", status: variant === "planned" ? "planned" : "running", role: "backend-builder", subject: "backend", started_at: startedAt, returned_at: returnedAt },
    requiredPath: ["id"], typePath: ["status"], targets: [time(["started_at"], "not-started"), stale(["status"], variant === "planned" ? "running" : "planned"), cross(["subject"], "other-slice")],
  });
}

function postPrRevalidationEntry(id, bound) {
  const source = bound
    ? { canonical_evidence_ref: "evidence/canonical.json", canonical_evidence_hash: HASH_A, canonical_verdict: "pass", validator_review_ref: "reviews/validator.json", validator_review_hash: HASH_B, validator_verdict: "GO", security_review_ref: "reviews/security.json", security_review_hash: HASH_C, security_verdict: "PASS", sidecar_bytes: { canonical: "pass", validator: "go", security: "pass" } }
    : { canonical_evidence_ref: null, canonical_evidence_hash: null, canonical_verdict: null, validator_review_ref: null, validator_review_hash: null, validator_verdict: null, security_review_ref: null, security_review_hash: null, security_verdict: null };
  const sidecars = bound ? [sidecar("canonical", ["canonical_evidence_ref"], ["canonical_evidence_hash"], ["sidecar_bytes", "canonical"]), sidecar("validator", ["validator_review_ref"], ["validator_review_hash"], ["sidecar_bytes", "validator"]), sidecar("security", ["security_review_ref"], ["security_review_hash"], ["sidecar_bytes", "security"])] : [];
  const targets = bound ? [...sidecarTargets("canonical", ["canonical_evidence_ref"], ["canonical_evidence_hash"], ["sidecar_bytes", "canonical"]), ...sidecarTargets("validator", ["validator_review_ref"], ["validator_review_hash"], ["sidecar_bytes", "validator"]), ...sidecarTargets("security", ["security_review_ref"], ["security_review_hash"], ["sidecar_bytes", "security"]), stale(["canonical_verdict"], "fail"), cross(["security_verdict"], "BLOCK")] : [stale(["canonical_verdict"], "pass"), cross(["validator_verdict"], "GO")];
  return recordEntry({
    authorityClassId: "post-pr-nested-records", id, record: "post_pr.remediation.revalidation", variant: bound ? "bound panel results" : "empty/unbound",
    writer: "transitionPostPrState revalidation transition",
    readers: ["validatePostPrRevalidation", "assertPostPrMonotonicState once-bound checks", "post-PR validated/push admission", "transitionPostPrTerminal panel-failure decisions"],
    source, requiredPath: ["canonical_verdict"], typePath: ["validator_verdict"], sidecars, targets,
  });
}

function postPrRevalidationContractEntry() {
  return recordEntry({
    authorityClassId: "post-pr-nested-records", id: "post-pr-revalidation", record: "post_pr.remediation.revalidation", variant: "nested record contract",
    writer: "transitionPostPrState revalidation transition",
    readers: ["validatePostPrRevalidation", "assertPostPrMonotonicState once-bound checks", "post-PR validated/push admission", "transitionPostPrTerminal panel-failure decisions"],
    source: { canonical_evidence_ref: null, canonical_evidence_hash: null, validator_review_ref: null, validator_review_hash: null, security_review_ref: null, security_review_hash: null, jobs: {} },
    requiredPath: ["jobs"], typePath: ["jobs"], targets: [drift([], "canonical_evidence_ref", "canonical_ref"), stale(["canonical_evidence_hash"], HASH_A), cross(["validator_review_ref"], "reviews/other-run.json")],
  });
}

function postPrPushContractEntry() {
  return recordEntry({
    authorityClassId: "post-pr-nested-records", id: "post-pr-push", record: "post_pr.remediation.push", variant: "nested record contract",
    writer: "transitionPostPrState checked push transition",
    readers: ["validatePostPrPush", "assertPostPrMonotonicState", "transitionPostPrTerminal push reconciliation", "remote-confirmed observation restart"],
    source: { status: "not-ready", remote_before_sha: null, local_head_sha: null, remote_after_sha: null, consecutive_transient_errors: 0, next_retry_at: null, pushed_at: null },
    requiredPath: ["status"], typePath: ["consecutive_transient_errors"], targets: [drift([], "remote_before_sha", "remote_before"), stale(["status"], "pending"), cross(["local_head_sha"], SHA_C)],
  });
}

function postPrPushEntry(id, status, localHead, remoteAfter) {
  return recordEntry({
    authorityClassId: "post-pr-nested-records", id, record: "post_pr.remediation.push", variant: status,
    writer: "transitionPostPrState checked push transition",
    readers: ["validatePostPrPush", "assertPostPrMonotonicState", "transitionPostPrTerminal push reconciliation", "remote-confirmed observation restart"],
    source: { status, remote_before_sha: SHA_A, local_head_sha: localHead, remote_after_sha: remoteAfter, consecutive_transient_errors: 0, next_retry_at: null, pushed_at: status === "confirmed" ? NOW : null },
    requiredPath: ["status"], typePath: ["consecutive_transient_errors"], targets: [time(["pushed_at"], "not-time"), stale(["remote_before_sha"], SHA_C), cross(["local_head_sha"], SHA_C)],
  });
}

function postPrContinuationReviewEntry() {
  return recordEntry({
    authorityClassId: "post-pr-nested-records", id: "post-pr-continuation-review-bound", record: "post_pr.continuation_review", variant: "retry-exhaustion ref/hash bound",
    writer: "bindPostPrContinuationReview inside transitionPostPrTerminal",
    readers: ["validatePostPr retry-exhaustion consistency", "factory continue post-PR admission", "post-PR terminal audit readers"],
    source: { ref: "reviews/post-pr-continuation.json", hash: HASH_A, sidecar_bytes: "blocked review" },
    requiredPath: ["ref"], typePath: ["hash"], sidecars: [sidecar("continuation-review", ["ref"], ["hash"], ["sidecar_bytes"])],
    targets: [...sidecarTargets("continuation-review", ["ref"], ["hash"], ["sidecar_bytes"]), stale(["hash"], HASH_B), cross(["ref"], "reviews/other-run.json")],
  });
}

function postPrTerminalFactEntry() {
  return recordEntry({
    authorityClassId: "post-pr-nested-records", id: "post-pr-terminal-fact-bound", record: "post_pr.terminal_fact", variant: "fact-bound terminal reason",
    writer: "normalizedPostPrTerminalFact inside transitionPostPrTerminal",
    readers: ["validatePostPrTerminalFact", "transitionPostPrTerminal idempotent replay", "terminal diagnostics/audit readers"],
    source: { schema_version: 1, kind: "remote-head-diverged", observed_at: NOW, attempt: 1, expected_remote_sha: SHA_A, candidate_head_sha: SHA_B, observed_remote_sha: SHA_C },
    requiredPath: ["kind"], typePath: ["attempt"], targets: [schema(["schema_version"]), kind(["kind"], "other-fact"), time(["observed_at"]), stale(["attempt"], 0), cross(["candidate_head_sha"], SHA_C)],
  });
}

function repairEntry(id, status, attempts, options) {
  const source = {
    schema_version: 1,
    plan_ref: "plan/slices.json",
    plan_hash: HASH_A,
    owner_slice_id: "owner",
    consumer_slice_id: "consumer",
    owner_snapshot: { paths: ["src/owner/**"], depends_on: [] },
    evidence_ref: "evidence/consumer-fail.json",
    evidence_hash: HASH_B,
    status,
    attempts,
    max_attempts: 2,
    quiescent: true,
    created_at: NOW,
    updated_at: NOW,
    sidecar_bytes: {
      "plan-owner": "owner plan bytes",
      "original-evidence": "failing reproduction",
      "repair-evidence": "changed paths",
      review: "approving review",
      verification: "passing reproduction",
    },
    ...options.record,
  };
  const definitions = {
    "plan-owner": sidecar("plan-owner", ["plan_ref"], ["plan_hash"], ["sidecar_bytes", "plan-owner"]),
    "original-evidence": sidecar("original-evidence", ["evidence_ref"], ["evidence_hash"], ["sidecar_bytes", "original-evidence"]),
    "repair-evidence": sidecar("repair-evidence", ["repair_evidence_ref"], ["repair_evidence_hash"], ["sidecar_bytes", "repair-evidence"]),
    review: sidecar("review", ["review_ref"], ["review_hash"], ["sidecar_bytes", "review"]),
    verification: sidecar("verification", ["verification_ref"], ["verification_hash"], ["sidecar_bytes", "verification"]),
  };
  const sidecars = options.sidecars.map((name) => definitions[name]);
  const targets = sidecars.flatMap((binding) => sidecarTargets(binding.name, binding.refPath, binding.hashPath, binding.bytesPath));
  targets.push(schema(["schema_version"]), time(["updated_at"]), ref(["defect_path"], undefined, "defect path"), stale(["attempts"], attempts === 0 ? 1 : attempts - 1), cross(["consumer_slice_id"], "owner"), drift(["owner_snapshot"], "paths", "owner_paths"));
  if (source.baseline_commit) targets.push(stale(["baseline_commit"], SHA_C));
  if (source.reviewed_commit) targets.push(cross(["reviewed_commit"], SHA_C));
  if (source.merge_commit) targets.push(stale(["merge_commit"], SHA_B), cross(["merge_tree"], HASH_C));
  return recordEntry({
    authorityClassId: "pr79-merged-slice-repair", id, record: "run.json.merged_slice_repair", variant: status,
    writer: `transitionMergedSliceRepair ${status} transition`,
    readers: ["validateMergedSliceRepair", "transitionMergedSliceRepair next-state checks", "mergedSliceRepairFence and resume eligibility", "slice/step/panel/gate/PR lifecycle fences"],
    source, requiredPath: ["status"], typePath: ["quiescent"], sidecars, facts: options.facts, targets,
  });
}

function recordEntry({ authorityClassId, id, record, variant, writer, readers, source, requiredPath, typePath, targets = [], sidecars = [], facts = [] }) {
  const commonTargets = [
    target("missing-key", requiredPath, "required field"),
    target("unknown-key", [], "record root", { key: "unexpected_authority_key", value: true }),
    target("wrong-type", typePath, "typed field"),
  ];
  return {
    authorityClassId,
    id,
    record,
    variant,
    writer,
    readers,
    tests: [`test/durable-record-mutations.test.js: ${id} mutation matrix`],
    sidecars,
    facts,
    source,
    descriptor: completeDescriptor(id, [...commonTargets, ...targets]),
  };
}

function completeDescriptor(record, targets, exclusions = {}) {
  const targeted = new Set(targets.map(({ family }) => family));
  const completeExclusions = { ...exclusions };
  for (const family of DURABLE_MUTATION_FAMILIES) {
    if (!targeted.has(family) && !Object.hasOwn(completeExclusions, family)) {
      completeExclusions[family] = `${record}: ${family} is not applicable because this record variant has no corresponding contract field or bound sidecar.`;
    }
  }
  return { record, targets, exclusions: completeExclusions };
}

function validateRecordSidecars(record, path) {
  if (!Array.isArray(record.sidecars)) throw new TypeError(`${path}.sidecars must be an array`);
  for (const binding of record.sidecars) {
    requireText(binding.name, `${path}.sidecars.name`);
    requireTextArray(binding.requiredFamilies, `${path}.sidecars.${binding.name}.requiredFamilies`);
    for (const family of binding.requiredFamilies) {
      if (!record.descriptor.targets.some((mutationTarget) => mutationTarget.family === family && mutationTarget.sidecar === binding.name)) {
        throw new TypeError(`${path} sidecar ${binding.name} must target ${family} independently`);
      }
    }
  }
}

function sidecar(name, refPath, hashPath, bytesPath) {
  return {
    name,
    refPath,
    hashPath,
    bytesPath,
    requiredFamilies: [refPath === null ? null : "wrong-ref", hashPath === null ? null : "wrong-hash", "wrong-bytes"].filter(Boolean),
  };
}

function sidecarTargets(name, refPath, hashPath, bytesPath) {
  return [
    ...(refPath === null ? [] : [ref(refPath, name)]),
    ...(hashPath === null ? [] : [hash(hashPath, name)]),
    bytes(bytesPath, name),
  ];
}

function target(family, path, label, options = {}) {
  return { family, path, ...(label === undefined ? {} : { label }), ...options };
}

function schema(path) { return target("wrong-schema", path, "schema version", { value: 2 }); }
function kind(path, value = "unknown-kind", label = "kind") { return target("wrong-kind", path, label, { value }); }
function time(path, value = "not-an-iso-time") { return target("wrong-time", path, `timestamp ${renderPath(path)}`, { value }); }
function ref(path, sidecarName, label = `ref ${renderPath(path)}`) { return target("wrong-ref", path, sidecarName ? `${sidecarName} ref` : label, { value: "../outside.json", ...(sidecarName ? { sidecar: sidecarName } : {}) }); }
function hash(path, sidecarName) { return target("wrong-hash", path, sidecarName ? `${sidecarName} hash` : `hash ${renderPath(path)}`, { value: "sha256:short", ...(sidecarName ? { sidecar: sidecarName } : {}) }); }
function bytes(path, sidecarName) { return target("wrong-bytes", path, `${sidecarName} sidecar bytes`, { value: "tampered-sidecar-bytes", sidecar: sidecarName }); }
function drift(path, from, to) { return target("descriptor-key-shape-drift", path, `${from} renamed`, { from, to }); }
function stale(path, value) { return target("stale-identity", path, `stale ${renderPath(path)}`, { value }); }
function cross(path, value, label = `cross-bound ${renderPath(path)}`) { return target("cross-bound-identity", path, label, { value }); }

function applyMutation(record, family, mutationTarget) {
  if (family === "unknown-key") {
    const container = valueAt(record, mutationTarget.path, family);
    requireRecord(container, `${family} target`);
    const key = requireText(mutationTarget.key, `${family}.key`);
    if (Object.hasOwn(container, key)) throw new TypeError(`${family}.key must be absent from the source`);
    container[key] = cloneTargetValue(mutationTarget, true);
    return;
  }

  if (family === "descriptor-key-shape-drift") {
    const container = valueAt(record, mutationTarget.path, family);
    requireRecord(container, `${family} target`);
    const from = requireText(mutationTarget.from, `${family}.from`);
    const to = requireText(mutationTarget.to, `${family}.to`);
    if (!Object.hasOwn(container, from) || Object.hasOwn(container, to)) throw new TypeError(`${family} requires an existing from key and absent to key`);
    container[to] = container[from];
    delete container[from];
    return;
  }

  const { container, key } = parentAt(record, mutationTarget.path, family);
  if (family === "missing-key") {
    delete container[key];
    return;
  }

  const current = container[key];
  const replacement = Object.hasOwn(mutationTarget, "value")
    ? structuredClone(mutationTarget.value)
    : defaultReplacement(family, current);
  if (Object.is(current, replacement)) throw new TypeError(`${family} replacement must differ from the source value`);
  container[key] = replacement;
}

function cloneTargetValue(mutationTarget, fallback) {
  return structuredClone(Object.hasOwn(mutationTarget, "value") ? mutationTarget.value : fallback);
}

function defaultReplacement(family, current) {
  if (family === "wrong-schema") return current === 1 ? 2 : 1;
  if (family === "wrong-kind") return "unknown-kind";
  if (family === "wrong-time") return "not-an-iso-time";
  if (family === "wrong-ref") return "../outside.json";
  if (family === "wrong-hash") return "sha256:short";
  if (family === "wrong-bytes") return typeof current === "string" ? `${current}-tampered` : "tampered-bytes";
  if (family === "stale-identity") return typeof current === "number" ? current - 1 : `stale-${String(current)}`;
  if (family === "cross-bound-identity") return typeof current === "number" ? current + 1 : "other-boundary";
  if (family === "wrong-type") {
    if (Array.isArray(current)) return {};
    if (current !== null && typeof current === "object") return [];
    if (typeof current === "string") return 1;
    if (typeof current === "number") return "not-a-number";
    if (typeof current === "boolean") return "not-a-boolean";
    if (current === null) return {};
    return null;
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

function requireTextArray(value, label) {
  if (!Array.isArray(value) || value.length === 0) throw new TypeError(`${label} must be a non-empty array`);
  for (const [index, item] of value.entries()) requireText(item, `${label}[${index}]`);
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

function sameList(actual, expected) {
  return actual.length === expected.length && actual.every((value, index) => value === expected[index]);
}

function deepFreeze(value) {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}
