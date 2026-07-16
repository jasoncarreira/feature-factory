import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { execFileSync } from "./helpers/git-fixture.js";
import { createReviewRecord } from "./helpers/review-record-fixture.js";
import { createRunRecord } from "./helpers/run-record-fixture.js";
import {
  DURABLE_AUTHORITY_CATALOG,
  DURABLE_AUTHORITY_CANONICAL_SOURCE_MANIFEST,
  DURABLE_AUTHORITY_DESCRIPTOR_MANIFEST,
  DURABLE_AUTHORITY_EXCLUSIONS,
  DURABLE_AUTHORITY_METADATA_MANIFEST,
  DURABLE_AUTHORITY_REQUIRED_RECORD_IDS,
  DURABLE_MUTATION_FAMILIES,
  assertDurableAuthorityCatalogComplete,
  createDurableCatalogBaseline,
  createPostPrCatalogBaseline,
  createRepairCatalogBaseline,
  emitDurableRecordMutations,
} from "./helpers/durable-record-mutations.js";
import { checkRunConsistency, validateRun, validateSlicesPlan } from "../src/validate.js";
import { transitionMergedSliceRepair, transitionPostPrState } from "../src/run-state.js";

const AUTHORITY_CLASS_IDS = Object.freeze([
  "plan-slices-graph",
  "run-envelope-terminal-result",
  "gates-snapshot-handoff",
  "steps-acceptance-inheritance",
  "slices-review-evidence-bindings",
  "validator-security-pr-result",
  "continuation-planning-draft-reuse",
  "post-pr-nested-records",
  "pr79-merged-slice-repair",
]);

const TARGET_FIELDS_BY_FAMILY = Object.freeze({
  "missing-key": ["path", "label"],
  "unknown-key": ["path", "label", "key", "value"],
  "wrong-schema": ["path", "label", "value"],
  "wrong-kind": ["path", "label", "value"],
  "wrong-time": ["path", "label", "value"],
  "wrong-type": ["path", "label"],
  "wrong-ref": ["path", "label", "value", "sidecar"],
  "wrong-hash": ["path", "label", "value", "sidecar"],
  "wrong-bytes": ["path", "label", "value", "sidecar"],
  "descriptor-key-shape-drift": ["path", "label", "from", "to"],
  "stale-identity": ["path", "label", "value"],
  "cross-bound-identity": ["path", "label", "value"],
});

const FAMILIES_WITH_EXCLUSIONS = Object.freeze([
  "wrong-schema",
  "wrong-kind",
  "wrong-time",
  "wrong-ref",
  "wrong-hash",
  "wrong-bytes",
  "descriptor-key-shape-drift",
]);

describe("durable record mutation helper", () => {
  it("deep-clones its source and emits deterministic named adversarial cases", () => {
    const source = {
      schema_version: 1,
      kind: "binding",
      created_at: "2026-07-16T12:00:00.000Z",
      run_id: "run-a",
      descriptor: { kind: "artifact", ref: "artifacts/a.md", hash: `sha256:${"a".repeat(64)}`, bytes: 10 },
      child: { run_id: "run-a", enabled: true },
    };
    const sourceBefore = structuredClone(source);
    const descriptor = {
      record: "fixture.json",
      targets: [
        { family: "missing-key", path: ["descriptor", "kind"] },
        { family: "unknown-key", path: ["descriptor"], key: "record_kind", value: "artifact" },
        { family: "wrong-schema", path: ["schema_version"], value: 2 },
        { family: "wrong-kind", path: ["kind"], value: "unknown" },
        { family: "wrong-time", path: ["created_at"], value: "not-time" },
        { family: "wrong-type", path: ["child", "enabled"], value: "true" },
        { family: "wrong-ref", path: ["descriptor", "ref"], value: "../a.md" },
        { family: "wrong-hash", path: ["descriptor", "hash"], value: "sha256:short" },
        { family: "wrong-bytes", path: ["descriptor", "bytes"], value: 11 },
        { family: "descriptor-key-shape-drift", path: ["descriptor"], from: "ref", to: "artifact_ref" },
        { family: "stale-identity", path: ["run_id"], value: "stale-run" },
        { family: "cross-bound-identity", path: ["child", "run_id"], value: "other-run" },
      ],
      exclusions: {},
    };

    const first = emitDurableRecordMutations(source, descriptor);
    const second = emitDurableRecordMutations(source, descriptor);

    assert.deepEqual(first, second);
    assert.deepEqual(source, sourceBefore);
    assert.deepEqual(first.map(({ family }) => family), DURABLE_MUTATION_FAMILIES);
    assert.equal(first[0].name, "fixture.json: missing-key (descriptor.kind)");
    const records = Object.fromEntries(first.map((mutationCase) => [mutationCase.family, mutationCase.record]));
    assert.equal(Object.hasOwn(records["missing-key"].descriptor, "kind"), false);
    assert.equal(records["unknown-key"].descriptor.record_kind, "artifact");
    assert.equal(records["wrong-schema"].schema_version, 2);
    assert.equal(records["wrong-kind"].kind, "unknown");
    assert.equal(records["wrong-time"].created_at, "not-time");
    assert.equal(records["wrong-type"].child.enabled, "true");
    assert.equal(records["wrong-ref"].descriptor.ref, "../a.md");
    assert.equal(records["wrong-hash"].descriptor.hash, "sha256:short");
    assert.equal(records["wrong-bytes"].descriptor.bytes, 11);
    assert.equal(Object.hasOwn(records["descriptor-key-shape-drift"].descriptor, "ref"), false);
    assert.equal(records["descriptor-key-shape-drift"].descriptor.artifact_ref, "artifacts/a.md");
    assert.equal(records["stale-identity"].run_id, "stale-run");
    assert.equal(records["cross-bound-identity"].child.run_id, "other-run");
    first[0].record.child.run_id = "changed-after-generation";
    assert.equal(second[0].record.child.run_id, "run-a", "cases must not share nested source objects");
    assert.equal(source.child.run_id, "run-a", "generated cases must not mutate the source");
  });

  it("requires every family to be targeted or excluded with a non-empty record-specific reason", () => {
    const source = { required: true };
    const missingClassification = { record: "record.json", targets: [], exclusions: {} };
    assert.throws(
      () => emitDurableRecordMutations(source, missingClassification),
      /record\.json\.missing-key must have a target or a record-specific exclusion/u,
    );

    const emptyReason = {
      record: "record.json",
      targets: [],
      exclusions: Object.fromEntries(DURABLE_MUTATION_FAMILIES.map((family) => [family, family === "wrong-kind" ? " " : "Not present on this record."])),
    };
    assert.throws(
      () => emitDurableRecordMutations(source, emptyReason),
      /descriptor\.exclusions\.wrong-kind must be a non-empty string/u,
    );
  });
});

describe("finite durable-authority catalog", () => {
  it("registers exactly the nine authority classes and every required record/variant separately", () => {
    assert.deepEqual(DURABLE_AUTHORITY_CATALOG.map(({ id }) => id), AUTHORITY_CLASS_IDS);
    assert.equal(new Set(DURABLE_AUTHORITY_CATALOG.map(({ id }) => id)).size, 9);
    assert.equal(assertDurableAuthorityCatalogComplete(DURABLE_AUTHORITY_CATALOG), true);

    let recordCount = 0;
    for (const authorityClass of DURABLE_AUTHORITY_CATALOG) {
      assert.deepEqual(
        authorityClass.records.map(({ id }) => id),
        DURABLE_AUTHORITY_REQUIRED_RECORD_IDS[authorityClass.id],
        `${authorityClass.id} must not collapse sibling records or variants into one aggregate descriptor`,
      );
      for (const record of authorityClass.records) {
        recordCount += 1;
        assert.equal(record.authorityClassId, authorityClass.id);
        assert.ok(record.writer.trim().length > 0, `${record.id} must name its writer/checked transition`);
        assert.ok(record.readers.length > 0, `${record.id} must name every decision-making reader`);
        assert.ok(record.tests.length > 0, `${record.id} must name a test`);
        const cases = emitDurableRecordMutations(record.source, record.descriptor, record.externalSources);
        assert.ok(cases.length > 0, `${record.id} must emit adversarial cases`);
        assert.equal(new Set(cases.map(({ name }) => name)).size, cases.length, `${record.id} case names must be unique`);
        for (const family of DURABLE_MUTATION_FAMILIES) {
          const targets = record.descriptor.targets.filter((mutationTarget) => mutationTarget.family === family);
          const reason = record.descriptor.exclusions[family];
          assert.equal(targets.length > 0 || (typeof reason === "string" && reason.trim().length > 0), true, `${record.id} must classify ${family}`);
          assert.equal(targets.length > 0 && reason !== undefined, false, `${record.id} cannot target and exclude ${family}`);
        }
      }
    }
    assert.equal(recordCount, 108);
  });

  it("rejects aggregate, omitted, and substituted source-boundary entries", () => {
    const aggregateOnly = structuredClone(DURABLE_AUTHORITY_CATALOG);
    delete aggregateOnly[0].records;
    aggregateOnly[0].source = { slices: [] };
    aggregateOnly[0].descriptor = { record: "aggregate", targets: [], exclusions: {} };
    assert.throws(
      () => assertDurableAuthorityCatalogComplete(aggregateOnly),
      /records must register per-record entries/u,
      "one aggregate mutation list must not establish class completeness",
    );

    const missingSibling = structuredClone(DURABLE_AUTHORITY_CATALOG);
    missingSibling[0].records.pop();
    assert.throws(
      () => assertDurableAuthorityCatalogComplete(missingSibling),
      /must contain every required per-record and per-variant entry/u,
      "removing final.plan.json while retaining plan/slices.json must fail completeness",
    );

    const substitutedSibling = structuredClone(DURABLE_AUTHORITY_CATALOG);
    substitutedSibling[0].records[1].id = "plan-slices-json";
    assert.throws(
      () => assertDurableAuthorityCatalogComplete(substitutedSibling),
      /must contain every required per-record and per-variant entry/u,
      "substituting an aggregate or sibling entry must not satisfy the closed source boundary",
    );
  });

  it("uses an independent closed metadata oracle and rejects every metadata substitution", () => {
    const requiredIds = Object.values(DURABLE_AUTHORITY_REQUIRED_RECORD_IDS).flat();
    assert.deepEqual(DURABLE_AUTHORITY_METADATA_MANIFEST.map(([id]) => id), requiredIds);
    assert.equal(DURABLE_AUTHORITY_METADATA_MANIFEST.every(([, digest]) => /^[0-9a-f]{64}$/u.test(digest)), true);
    const helperSource = readFileSync(new URL("./helpers/durable-record-mutations.js", import.meta.url), "utf8");
    assert.doesNotMatch(helperSource, /RECORDS\.map\(\(record\).*writer/u, "the exact metadata oracle must not be produced from catalog records");
    assert.doesNotMatch(helperSource, /for \(const family of DURABLE_MUTATION_FAMILIES\)[\s\S]{0,300}completeExclusions/u, "completeDescriptor must not synthesize missing exclusions");

    for (const field of ["writer", "readers", "tests", "facts", "sidecars"]) {
      const substitutedMetadata = structuredClone(DURABLE_AUTHORITY_CATALOG);
      const plan = findRecord(substitutedMetadata, "plan-slices-json");
      plan[field] = field === "writer" ? "different writer" : field === "sidecars" ? [{ name: "invented", requiredFamilies: [] }] : [...plan[field], `invented-${field}`];
      assert.throws(
        () => assertDurableAuthorityCatalogComplete(substitutedMetadata),
        /must exactly match the independent metadata manifest/u,
        `${field} substitution must fail independently of RECORDS`,
      );
    }
  });

  it("uses an independent closed descriptor oracle for all 108 exact target/exclusion definitions", () => {
    const requiredIds = Object.values(DURABLE_AUTHORITY_REQUIRED_RECORD_IDS).flat();
    assert.deepEqual(DURABLE_AUTHORITY_DESCRIPTOR_MANIFEST.map(([id]) => id), requiredIds);
    assert.equal(DURABLE_AUTHORITY_DESCRIPTOR_MANIFEST.length, 108);
    assert.equal(DURABLE_AUTHORITY_DESCRIPTOR_MANIFEST.every(([, digest]) => /^[0-9a-f]{64}$/u.test(digest)), true);
    const helperSource = readFileSync(new URL("./helpers/durable-record-mutations.js", import.meta.url), "utf8");
    assert.doesNotMatch(helperSource, /RECORDS\.map\(\(record\).*descriptor/u, "descriptor expectations must not be produced from catalog records");
    assert.doesNotMatch(helperSource, /DURABLE_AUTHORITY_CATALOG[\s\S]{0,200}DESCRIPTOR_MANIFEST/u, "descriptor expectations must not be produced from the catalog export");
  });

  it("rejects both observed final.plan descriptor oracle bypasses", () => {
    const targetToExclusion = structuredClone(DURABLE_AUTHORITY_CATALOG);
    const excludedKind = findRecord(targetToExclusion, "final-plan-descriptor");
    excludedKind.descriptor.targets = excludedKind.descriptor.targets.filter(({ family }) => family !== "wrong-kind");
    excludedKind.descriptor.exclusions["wrong-kind"] = "Descriptor kind is intentionally excluded.";
    assert.throws(
      () => assertDurableAuthorityCatalogComplete(targetToExclusion),
      /wrong-kind target-or-exclusion disposition must exactly match the independent family disposition registry/u,
    );

    const changedPath = structuredClone(DURABLE_AUTHORITY_CATALOG);
    findRecord(changedPath, "final-plan-descriptor").descriptor.targets.find(({ family }) => family === "wrong-kind").path = ["kind"];
    assert.throws(
      () => assertDurableAuthorityCatalogComplete(changedPath),
      /mutation target definitions and exclusions must exactly match the independent descriptor manifest/u,
    );
  });

  it("rejects target deletion and target-to-exclusion substitution across all twelve families", () => {
    assert.deepEqual(Object.keys(TARGET_FIELDS_BY_FAMILY), DURABLE_MUTATION_FAMILIES);
    for (const family of DURABLE_MUTATION_FAMILIES) {
      const deletedTarget = structuredClone(DURABLE_AUTHORITY_CATALOG);
      const deletedRecord = findRecordWithTarget(deletedTarget, family);
      deletedRecord.descriptor.targets = deletedRecord.descriptor.targets.filter((targetDefinition) => targetDefinition.family !== family);
      assert.throws(
        () => assertDurableAuthorityCatalogComplete(deletedTarget),
        /target-or-exclusion disposition must exactly match the independent family disposition registry/u,
        `${family} target deletion must fail independently of the catalog descriptor`,
      );

      const substitutedExclusion = structuredClone(DURABLE_AUTHORITY_CATALOG);
      const substitutedRecord = findRecordWithTarget(substitutedExclusion, family);
      substitutedRecord.descriptor.targets = substitutedRecord.descriptor.targets.filter((targetDefinition) => targetDefinition.family !== family);
      substitutedRecord.descriptor.exclusions[family] = `${family} was incorrectly substituted with an exclusion.`;
      assert.throws(
        () => assertDurableAuthorityCatalogComplete(substitutedExclusion),
        /target-or-exclusion disposition must exactly match the independent family disposition registry/u,
        `${family} target-to-exclusion substitution must fail`,
      );
    }
  });

  it("rejects exclusion-to-target substitution for every family with record-specific exclusions", () => {
    for (const family of FAMILIES_WITH_EXCLUSIONS) {
      const substitutedTarget = structuredClone(DURABLE_AUTHORITY_CATALOG);
      const excludedRecord = findRecordWithExclusion(substitutedTarget, family);
      const targetTemplate = findTarget(DURABLE_AUTHORITY_CATALOG, family);
      delete excludedRecord.descriptor.exclusions[family];
      excludedRecord.descriptor.targets.push(structuredClone(targetTemplate));
      assert.throws(
        () => assertDurableAuthorityCatalogComplete(substitutedTarget),
        /target-or-exclusion disposition must exactly match the independent family disposition registry/u,
        `${family} exclusion-to-target substitution must fail`,
      );
    }
  });

  it("rejects every applicable target-field mutation across all twelve families", () => {
    let testedFields = 0;
    for (const [family, fields] of Object.entries(TARGET_FIELDS_BY_FAMILY)) {
      const observedFields = new Set(DURABLE_AUTHORITY_CATALOG.flatMap(({ records }) => records)
        .flatMap(({ descriptor }) => descriptor.targets)
        .filter((targetDefinition) => targetDefinition.family === family)
        .flatMap((targetDefinition) => Object.keys(targetDefinition).filter((field) => field !== "family")));
      assert.deepEqual([...observedFields].sort(), [...fields].sort(), `${family} field matrix must name every applicable target field`);
      for (const field of fields) {
        const mutatedCatalog = structuredClone(DURABLE_AUTHORITY_CATALOG);
        const targetDefinition = findTarget(mutatedCatalog, family, field);
        targetDefinition[field] = changedTargetFieldValue(field, targetDefinition[field]);
        assert.throws(
          () => assertDurableAuthorityCatalogComplete(mutatedCatalog),
          /mutation target definitions and exclusions must exactly match the independent descriptor manifest/u,
          `${family}.${field} mutation must fail independently of the catalog descriptor`,
        );
        testedFields += 1;
      }
    }
    assert.equal(testedFields, 39);
  });

  it("rejects per-record family and sidecar-byte omissions", () => {
    const missingFamily = structuredClone(DURABLE_AUTHORITY_CATALOG);
    const finalPlan = findRecord(missingFamily, "final-plan-descriptor");
    finalPlan.descriptor.targets = finalPlan.descriptor.targets.filter(({ family }) => family !== "wrong-kind");
    assert.throws(() => assertDurableAuthorityCatalogComplete(missingFamily), /wrong-kind target-or-exclusion disposition must exactly match the independent family disposition registry/u);

    const conflatedBytes = structuredClone(DURABLE_AUTHORITY_CATALOG);
    const approval = findRecord(conflatedBytes, "gate-approved-interactive");
    approval.descriptor.targets = approval.descriptor.targets.filter(({ family }) => family !== "wrong-bytes");
    approval.descriptor.exclusions["wrong-bytes"] = "Ref text was already mutated.";
    assert.throws(
      () => assertDurableAuthorityCatalogComplete(conflatedBytes),
      /wrong-bytes target-or-exclusion disposition must exactly match the independent family disposition registry/u,
      "ref drift must not stand in for referenced sidecar byte drift",
    );

    const omittedSidecar = structuredClone(DURABLE_AUTHORITY_CATALOG);
    findRecord(omittedSidecar, "post-pr-revalidation-bound").sidecars.pop();
    assert.throws(() => assertDurableAuthorityCatalogComplete(omittedSidecar), /must exactly match the independent metadata manifest/u);
  });

  it("mutates canonical refs, hashes, and separately modeled external bytes independently", () => {
    const approval = findRecord(DURABLE_AUTHORITY_CATALOG, "gate-approved-interactive");
    const cases = emitDurableRecordMutations(approval.source, approval.descriptor, approval.externalSources);
    const answerRef = cases.find(({ family, name }) => family === "wrong-ref" && name.includes("answer ref"));
    const answerHash = cases.find(({ family, name }) => family === "wrong-hash" && name.includes("answer hash"));
    const answerBytes = cases.find(({ family, name }) => family === "wrong-bytes" && name.includes("answer sidecar bytes"));
    assert.equal(answerRef.record.answer_ref, "../outside.json");
    assert.equal(answerRef.externalSources.answer.bytes, "approve\n");
    assert.equal(answerHash.record.handoff_receipt.answer_hash, "sha256:short");
    assert.equal(answerHash.externalSources.answer.bytes, "approve\n");
    assert.equal(answerBytes.record.answer_ref, "gates/story.answer.consumed-1");
    assert.match(answerBytes.record.handoff_receipt.answer_hash, /^sha256:[0-9a-f]{64}$/u);
    assert.equal(answerBytes.externalSources.answer.bytes, "tampered-sidecar-bytes");
  });

  it("binds every catalog row's source identity, placement, facts, and external bytes with an independent manifest", () => {
    const canonicalIds = DURABLE_AUTHORITY_CANONICAL_SOURCE_MANIFEST.map(([id]) => id);
    const requiredIds = Object.values(DURABLE_AUTHORITY_REQUIRED_RECORD_IDS).flat();
    assert.equal(canonicalIds.length, 108);
    assert.deepEqual(canonicalIds, requiredIds);
    assert.equal(DURABLE_AUTHORITY_CANONICAL_SOURCE_MANIFEST.every(([, digest]) => /^[0-9a-f]{64}$/u.test(digest)), true);
    const helperSource = readFileSync(new URL("./helpers/durable-record-mutations.js", import.meta.url), "utf8");
    assert.doesNotMatch(helperSource, /DURABLE_AUTHORITY_CANONICAL_SOURCE_MANIFEST\s*=\s*deepFreeze\([^\n]*\.map/u);

    for (const id of canonicalIds) {
      const record = findRecord(DURABLE_AUTHORITY_CATALOG, id);
      assert.ok(record, `${id} must have a canonical source row`);
      assert.equal(containsOwnKey(record.source, "sidecar_bytes"), false, `${id} must keep fixture bytes outside persisted source`);
      assert.equal(Array.isArray(record.canonicalPath), true, `${id} must bind its exact persisted path`);
      assert.equal(record.canonicalPath.length > 0 || ["run-envelope-running", "run-envelope-terminal"].includes(id), true, `${id} may use the empty path only for the run.json root`);
      assert.ok(record.facts.length > 0, `${id} must bind authority facts`);
      for (const declaration of record.facts) {
        assert.ok(Array.isArray(declaration.path) && declaration.path.length > 0, `${id} facts use path declarations`);
        assert.equal(Object.hasOwn(declaration, "expected"), true, `${id} facts bind exact expected values`);
      }
    }
  });

  it("rejects canonical source deletion/substitution, placement drift, fact drift, and synthetic keys", () => {
    const mutations = [
      ["source deletion", (catalog) => { delete findRecord(catalog, "gate-pending").source.status; }],
      ["source substitution", (catalog) => { findRecord(catalog, "gate-pending").source = structuredClone(findRecord(catalog, "gate-stopped").source); }],
      ["external source deletion", (catalog) => { delete findRecord(catalog, "gate-approved-interactive").externalSources.answer; }],
      ["external byte substitution", (catalog) => { findRecord(catalog, "gate-approved-interactive").externalSources.answer.bytes = "approve changed\n"; }],
      ["record relocation", (catalog) => { findRecord(catalog, "gate-pending").record = "run.json.steps[]"; }],
      ["variant relocation", (catalog) => { findRecord(catalog, "gate-pending").variant = "stopped"; }],
      ["fact deletion", (catalog) => { findRecord(catalog, "slice-review").facts.pop(); }],
      ["fact relocation", (catalog) => { findRecord(catalog, "slice-review").facts[0].path = ["status"]; }],
      ["fact contradiction", (catalog) => { findRecord(catalog, "slice-review").facts[0].expected = "frontend"; }],
      ["synthetic gate key", (catalog) => { findRecord(catalog, "gate-pending").source.gate = "story"; }],
      ["synthetic slice review binding", (catalog) => { findRecord(catalog, "slice-review").source.review_binding = {}; }],
      ["synthetic slice attempt history", (catalog) => { findRecord(catalog, "slice-review").source.attempt_reviews = []; }],
      ["synthetic panel commit", (catalog) => { findRecord(catalog, "validator-verdict-binding").source.reviewed_commit = "a".repeat(40); }],
    ];
    for (const [label, mutate] of mutations) {
      const catalog = structuredClone(DURABLE_AUTHORITY_CATALOG);
      mutate(catalog);
      assert.throws(() => assertDurableAuthorityCatalogComplete(catalog), /canonical source|contradicts|synthetic|does not resolve|metadata manifest/u, label);
    }
  });

  it("rejects deletion and substitution for every row that was outside the B0C canonical-source manifest", () => {
    const previouslyUncovered = [
      "plan-slices-json",
      "final-plan-descriptor",
      "run-envelope-running",
      "run-envelope-terminal",
      "terminal-result-completed",
      "terminal-result-blocked",
      "terminal-result-partial",
      "terminal-result-needs-human",
      "pr-created-result",
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
    ];
    assert.equal(previouslyUncovered.length, 20);
    for (const id of previouslyUncovered) {
      const deleted = structuredClone(DURABLE_AUTHORITY_CATALOG);
      const deletedRecord = findRecord(deleted, id);
      delete deletedRecord.source[Object.keys(deletedRecord.source)[0]];
      assert.throws(
        () => assertDurableAuthorityCatalogComplete(deleted),
        /canonical source|contradicts|does not resolve/u,
        `${id}: source-key deletion must fail completeness`,
      );

      const substituted = structuredClone(DURABLE_AUTHORITY_CATALOG);
      findRecord(substituted, id).variant = `${findRecord(substituted, id).variant}-substituted`;
      assert.throws(
        () => assertDurableAuthorityCatalogComplete(substituted),
        /canonical source/u,
        `${id}: variant substitution must fail completeness`,
      );
    }
  });

  it("closes the B0C run-envelope record, variant, and base-commit bypasses", () => {
    for (const [label, mutate] of [
      ["record", (record) => { record.record = "run.json.changed"; }],
      ["variant", (record) => { record.variant = "changed"; }],
      ["base_commit", (record) => { record.source.base_commit = "c".repeat(40); }],
    ]) {
      const catalog = structuredClone(DURABLE_AUTHORITY_CATALOG);
      mutate(findRecord(catalog, "run-envelope-running"));
      assert.throws(() => assertDurableAuthorityCatalogComplete(catalog), /canonical source|contradicts/u, label);
    }
  });

  it("routes every canonical baseline through the exported production validator or its named descriptor consumer", () => {
    const observedConsumers = new Map();
    for (const [id] of DURABLE_AUTHORITY_CANONICAL_SOURCE_MANIFEST) {
      const record = findRecord(DURABLE_AUTHORITY_CATALOG, id);
      const baseline = createDurableCatalogBaseline(record);
      observedConsumers.set(id, baseline.consumer);
      if (baseline.consumer === "validateSlicesPlan") {
        assert.equal(validateSlicesPlan(baseline.plan), baseline.plan, `${id} must pass the exported plan validator`);
      } else if (baseline.consumer === "final-plan-descriptor-contract") {
        assert.deepEqual(Object.keys(baseline.descriptor), ["schema_version", "kind", "created_at", "run_id", "descriptor"]);
        assert.deepEqual(Object.keys(baseline.descriptor.descriptor), ["kind", "ref", "hash"]);
        assert.equal(baseline.descriptor.descriptor.kind, "slices-graph");
        assert.equal(baseline.descriptor.descriptor.ref, baseline.externalSources.plan.ref);
        assert.equal(baseline.descriptor.descriptor.hash, `sha256:${createHash("sha256").update(baseline.externalSources.plan.bytes).digest("hex")}`);
      } else {
        assert.match(baseline.consumer, /^validateRun(?:\/checkRunConsistency)?$/u);
        assert.equal(validateRun(baseline.run), baseline.run, `${id} must use an actual validateRun-compatible persisted shape`);
      }
    }
    assert.equal(observedConsumers.size, 108);
    assert.equal(observedConsumers.get("final-plan-descriptor"), "final-plan-descriptor-contract", "future-only final.plan is a descriptor contract, not claimed as current validateRun input");
  });

  it("uses exact persisted gate, step, slice, panel, and steering variants without synthetic wrappers", () => {
    const gates = ["gate-pending", "gate-approved-without-receipt", "gate-approved-interactive", "gate-changes-requested", "gate-stopped"]
      .map((id) => findRecord(DURABLE_AUTHORITY_CATALOG, id));
    assert.deepEqual(gates.map(({ source }) => source.status), ["pending", "approved", "approved", "changes_requested", "stopped"]);
    assert.equal(gates.every(({ source }) => !Object.hasOwn(source, "gate") && !Object.hasOwn(source, "sidecar_bytes")), true);
    assert.equal(Object.hasOwn(gates[1].source, "handoff_receipt"), false);
    assert.deepEqual(Object.keys(gates[2].source.handoff_receipt), ["schema_version", "kind", "gate", "approval_fingerprint", "pending_snapshot_hash", "answer_hash", "steering_generation", "accepted_at"]);
    assert.deepEqual(gates.map(({ source }) => source.answer ?? null), [null, "approve", "approve", "changes: revise scope", "stop"]);
    assert.deepEqual(Object.keys(gates[2].externalSources), ["artifact", "question", "answer"]);

    const steps = ["step-running", "step-rejected", "step-blocked", "step-accepted", "step-inherited-acceptance"]
      .map((id) => findRecord(DURABLE_AUTHORITY_CATALOG, id));
    assert.deepEqual(steps.map(({ source }) => source.status), ["running", "rejected", "blocked", "accepted", "accepted"]);
    assert.deepEqual(Object.keys(steps[3].source.acceptance), ["artifact_ref", "artifact_hash", "review_ref", "review_hash"]);
    assert.deepEqual(Object.keys(steps[4].source.inherited_acceptance), ["from_run_id", "parent_spec_review_ref", "artifact_hash", "review_hash"]);

    const slices = ["slice-pending", "slice-running", "slice-review", "slice-merged", "slice-blocked"]
      .map((id) => findRecord(DURABLE_AUTHORITY_CATALOG, id));
    assert.deepEqual(slices.map(({ source }) => source.status), ["pending", "running", "review", "merged", "blocked"]);
    for (const { source } of slices) {
      for (const key of ["review_binding", "attempt_reviews", "reviewed_commit", "sidecar_bytes", "review_hash", "evidence_hash"]) assert.equal(Object.hasOwn(source, key), false);
    }
    assert.deepEqual(Object.keys(slices[2].source), ["id", "stack", "depends_on", "status", "attempts", "branch", "worktree", "evidence_ref", "review_ref"]);
    assert.deepEqual(Object.keys(slices[3].source), ["id", "stack", "depends_on", "status", "attempts", "branch", "worktree", "evidence_ref", "review_ref", "merge_commit", "updated_at"]);

    assert.deepEqual(findRecord(DURABLE_AUTHORITY_CATALOG, "validator-verdict-binding").source, { verdict: "GO", report: "artifacts/validation-report.md", review_ref: "reviews/implementation-validator.json" });
    assert.deepEqual(findRecord(DURABLE_AUTHORITY_CATALOG, "security-verdict-binding").source, { verdict: "PASS", review_ref: "reviews/security-reviewer.json" });
    const steering = ["steering-boundary", "steering-action-claim", "steering-last-action"].map((id) => findRecord(DURABLE_AUTHORITY_CATALOG, id));
    assert.deepEqual(steering.map(({ canonicalPath }) => canonicalPath.join(".")), ["steering.boundary", "steering.action_claim", "steering.last_action"]);
    assert.deepEqual(steering.map(({ source }) => source.token), ["dispatch-token-1", "dispatch-token-1", "dispatch-token-1"]);
  });

  it("generates the required kind mutation for the final.plan.json descriptor", () => {
    const planEntry = findRecord(DURABLE_AUTHORITY_CATALOG, "final-plan-descriptor");
    const sourceBefore = structuredClone(planEntry.source);
    const kindMutation = emitDurableRecordMutations(planEntry.source, planEntry.descriptor, planEntry.externalSources)
      .find(({ family, name }) => family === "wrong-kind" && name.includes("required descriptor.kind"));

    assert.equal(kindMutation.name, "final-plan-descriptor: wrong-kind (required descriptor.kind)");
    assert.equal(kindMutation.record.descriptor.kind, "unknown-graph");
    assert.equal(kindMutation.record.kind, "final-plan");
    assert.deepEqual(planEntry.source, sourceBefore);
  });

  it("registers every post_pr phase, dispatch state, nested authority, and bound job state exactly", () => {
    const postPr = DURABLE_AUTHORITY_CATALOG.find(({ id }) => id === "post-pr-nested-records");
    assert.deepEqual(postPr.records.map(({ id }) => id), DURABLE_AUTHORITY_REQUIRED_RECORD_IDS["post-pr-nested-records"]);
    const phases = ["disabled", "awaiting-pr", "observing", "failure-recording", "remediation-planned", "remediation-running", "changes-observed", "committed", "revalidating", "validated", "push-pending", "remote-confirmed", "succeeded", "blocked", "needs-human"];
    assert.deepEqual(phases.map((phase) => findRecord(DURABLE_AUTHORITY_CATALOG, `post-pr-phase-${phase}`).source.phase), phases);
    assert.deepEqual(phases.map((phase) => findFact(findRecord(DURABLE_AUTHORITY_CATALOG, `post-pr-phase-${phase}`), ["phase"])), phases);
    for (const phase of phases) {
      const source = findRecord(DURABLE_AUTHORITY_CATALOG, `post-pr-phase-${phase}`).source;
      assert.deepEqual(Object.keys(source), ["schema_version", "policy", "phase", "attempt", "observation", "remediation", "evidence_refs", "continuation_review", "terminal_fact"]);
      assert.equal(Object.hasOwn(source, "run_status"), false);
    }
    assert.deepEqual(["planned", "running", "returned"].map((state) => findRecord(DURABLE_AUTHORITY_CATALOG, `post-pr-dispatch-${state}`).source.status), ["planned", "running", "returned"]);
    assert.deepEqual(Object.keys(findRecord(DURABLE_AUTHORITY_CATALOG, "post-pr-policy-enabled").source), ["enabled", "wait_ms", "initial_poll_ms", "max_poll_ms", "check_start_grace_ms", "max_transient_errors", "review"]);
    assert.deepEqual(Object.keys(findRecord(DURABLE_AUTHORITY_CATALOG, "post-pr-observation-active").source), ["epoch", "expected_head_sha", "started_at", "deadline_at", "next_poll_at", "poll_count", "unchanged_count", "current_interval_ms", "consecutive_transient_errors", "last_observed_at", "last_fingerprint", "last_check_verdict", "last_review_verdict", "last_verdict", "last_error", "review_request", "snapshot"]);
    assert.deepEqual(Object.keys(findRecord(DURABLE_AUTHORITY_CATALOG, "post-pr-remediation-active").source), ["schema_version", "attempt", "reason_code", "failure_fingerprint", "failed_head_sha", "failure_evidence_ref", "failure_evidence_hash", "owner", "route", "lane", "stage", "baseline_head_sha", "dispatch", "changes", "candidate_head_sha", "remediation_evidence_ref", "remediation_evidence_hash", "revalidation", "push"]);
    assert.deepEqual(Object.keys(findRecord(DURABLE_AUTHORITY_CATALOG, "post-pr-remediation-owner").source), ["kind", "slice_id", "stack", "path_b64url", "method"]);
    assert.deepEqual(Object.keys(findRecord(DURABLE_AUTHORITY_CATALOG, "post-pr-remediation-changes").source), ["paths", "entries", "tree_hash"]);
    assert.deepEqual(Object.keys(findRecord(DURABLE_AUTHORITY_CATALOG, "post-pr-remediation-change-entry").source), ["source", "status", "index_status", "worktree_status", "path", "previous_path", "old_mode", "new_mode"]);
    assert.deepEqual(["planned", "running", "returned"].map((state) => findRecord(DURABLE_AUTHORITY_CATALOG, `post-pr-dispatch-${state}`).source.started_at), [null, "2026-07-16T12:00:00.000Z", "2026-07-16T12:00:00.000Z"]);
    assert.deepEqual(["planned", "running", "returned"].map((state) => findRecord(DURABLE_AUTHORITY_CATALOG, `post-pr-dispatch-${state}`).source.returned_at), [null, null, "2026-07-16T12:05:00.000Z"]);
    const emptyRevalidation = findRecord(DURABLE_AUTHORITY_CATALOG, "post-pr-revalidation-empty").source;
    assert.deepEqual(emptyRevalidation, { canonical_evidence_ref: null, canonical_evidence_hash: null, canonical_verdict: null, validator_review_ref: null, validator_review_hash: null, validator_verdict: null, security_review_ref: null, security_review_hash: null, security_verdict: null, jobs: {} });
    for (const activity of ["canonical", "validator", "security"]) {
      assert.deepEqual(["planned", "running", "retry-wait", "bound"].map((state) => findRecord(DURABLE_AUTHORITY_CATALOG, `post-pr-${activity}-job-${state}`).source.status), ["planned", "running", "retry-wait", "bound"]);
      assert.deepEqual(["planned", "running", "retry-wait", "bound"].map((state) => findRecord(DURABLE_AUTHORITY_CATALOG, `post-pr-${activity}-job-${state}`).source.action_token), [null, `${activity}-action-1`, `${activity}-action-1`, `${activity}-action-1`]);
      assert.deepEqual(["planned", "running", "retry-wait", "bound"].map((state) => findRecord(DURABLE_AUTHORITY_CATALOG, `post-pr-${activity}-job-${state}`).source.verdict), [null, null, null, activity === "canonical" ? "pass" : activity === "validator" ? "GO" : "PASS"]);
      const bound = findRecord(DURABLE_AUTHORITY_CATALOG, `post-pr-${activity}-job-bound`);
      assert.deepEqual(bound.sidecars.map(({ name }) => name), [`${activity}-result`]);
      assert.equal(bound.source.result_ref, `${activity === "canonical" ? "evidence" : "reviews"}/post-pr-${activity}.attempt-1.json`);
      assert.match(bound.source.result_hash, /^sha256:[0-9a-f]{64}$/u);
    }
    assert.deepEqual(
      ["post-pr-observation-last-error", "post-pr-observation-review-request", "post-pr-observation-snapshot", "post-pr-remediation-owner", "post-pr-remediation-changes", "post-pr-remediation-change-entry", "post-pr-push-last-error"].map((id) => findRecord(DURABLE_AUTHORITY_CATALOG, id).id),
      ["post-pr-observation-last-error", "post-pr-observation-review-request", "post-pr-observation-snapshot", "post-pr-remediation-owner", "post-pr-remediation-changes", "post-pr-remediation-change-entry", "post-pr-push-last-error"],
    );
    for (const [nullId, boundId] of [
      ["post-pr-observation-null", "post-pr-observation-active"],
      ["post-pr-remediation-null", "post-pr-remediation-active"],
      ["post-pr-revalidation-empty", "post-pr-revalidation-bound"],
      ["post-pr-continuation-review-null", "post-pr-continuation-review-bound"],
      ["post-pr-terminal-fact-null", "post-pr-terminal-fact-remote-head-diverged"],
    ]) {
      assert.equal(findRecord(DURABLE_AUTHORITY_CATALOG, nullId).variant.includes("null") || nullId.endsWith("empty"), true);
      assert.notEqual(findRecord(DURABLE_AUTHORITY_CATALOG, boundId).variant, "null");
    }
    assert.deepEqual(
      findRecord(DURABLE_AUTHORITY_CATALOG, "post-pr-revalidation-bound").sidecars.map(({ name }) => name),
      ["canonical", "validator", "security"],
    );
    assert.deepEqual(
      findRecord(DURABLE_AUTHORITY_CATALOG, "post-pr-push-confirmed").source,
      { status: "confirmed", remote_before_sha: "a".repeat(40), local_head_sha: "b".repeat(40), remote_after_sha: "b".repeat(40), consecutive_transient_errors: 0, next_retry_at: null, pushed_at: "2026-07-16T12:00:00.000Z", last_error: null },
    );
    assert.deepEqual(findRecord(DURABLE_AUTHORITY_CATALOG, "post-pr-push-not-ready").source, { status: "not-ready", remote_before_sha: null, local_head_sha: null, remote_after_sha: null, consecutive_transient_errors: 0, next_retry_at: null, pushed_at: null, last_error: null });
    assert.deepEqual(findRecord(DURABLE_AUTHORITY_CATALOG, "post-pr-push-pending").source, { status: "pending", remote_before_sha: "a".repeat(40), local_head_sha: "b".repeat(40), remote_after_sha: null, consecutive_transient_errors: 0, next_retry_at: null, pushed_at: null, last_error: null });
    assert.equal(typeof findRecord(DURABLE_AUTHORITY_CATALOG, "post-pr-push-last-error").source, "object");
    assert.equal(findRecord(DURABLE_AUTHORITY_CATALOG, "post-pr-remediation-changes").source.paths[0], "src/backend.js");
    assert.equal(findRecord(DURABLE_AUTHORITY_CATALOG, "post-pr-remediation-active").source.candidate_head_sha, "b".repeat(40));
    assert.equal(findRecord(DURABLE_AUTHORITY_CATALOG, "post-pr-remediation-active").source.remediation_evidence_ref, "evidence/post-pr-remediation.attempt-1.json");
    assert.equal(findRecord(DURABLE_AUTHORITY_CATALOG, "post-pr-remediation-changes").source.tree_hash, `sha256:${"a".repeat(64)}`);
    const changedPhaseRemediation = findRecord(DURABLE_AUTHORITY_CATALOG, "post-pr-phase-changes-observed").source.remediation;
    assert.equal(changedPhaseRemediation.candidate_head_sha, "b".repeat(40));
    assert.equal(changedPhaseRemediation.remediation_evidence_ref, "evidence/post-pr-remediation.attempt-1.json");
    assert.match(changedPhaseRemediation.remediation_evidence_hash, /^sha256:[0-9a-f]{64}$/u);
  });

  it("uses exact canonical post_pr records, external sidecars, and production validation baselines", () => {
    const postPrIds = DURABLE_AUTHORITY_REQUIRED_RECORD_IDS["post-pr-nested-records"];
    assert.deepEqual(DURABLE_AUTHORITY_CANONICAL_SOURCE_MANIFEST.map(([id]) => id).filter((id) => postPrIds.includes(id)), postPrIds);
    const transitionOnly = [];
    for (const id of postPrIds) {
      const record = findRecord(DURABLE_AUTHORITY_CATALOG, id);
      const baseline = createPostPrCatalogBaseline(record);
      assert.equal(validateRun(baseline.run), baseline.run, `${id} must embed at ${record.canonicalPath.join(".")} in a validateRun-compatible run`);
      assert.equal(containsOwnKey(record.source, "sidecar_bytes"), false, `${id} must keep bytes outside persisted state`);
      assert.equal(containsOwnKey(record.source, "run_status"), false, `${id} must not persist synthetic run_status`);
      if (baseline.transitionOnly) transitionOnly.push([id, baseline.transitionOnly]);
    }
    assert.deepEqual(transitionOnly.map(([id]) => id), [
      "post-pr-canonical-job-retry-wait",
      "post-pr-validator-job-retry-wait",
      "post-pr-security-job-retry-wait",
    ]);
    assert.equal(transitionOnly.every(([, note]) => /checked transition consumer state/u.test(note)), true);
  });

  it("checks every canonical post_pr external ref/hash against independently stored fixture bytes", () => {
    const root = mkdtempSync(join(tmpdir(), "post-pr-catalog-"));
    try {
      for (const id of DURABLE_AUTHORITY_REQUIRED_RECORD_IDS["post-pr-nested-records"]) {
        const record = findRecord(DURABLE_AUTHORITY_CATALOG, id);
        const { run, externalSources } = createPostPrCatalogBaseline(record);
        const runDir = join(root, id);
        mkdirSync(runDir, { recursive: true });
        for (const { ref, bytes } of Object.values(externalSources)) {
          const file = join(runDir, ref);
          mkdirSync(dirname(file), { recursive: true });
          writeFileSync(file, bytes);
        }
        const result = checkRunConsistency(runDir, run);
        assert.equal(result.ok, true, `${id}: ${result.checks.filter(({ ok }) => !ok).map(({ errors }) => errors.map(({ message }) => message).join(", ")).join("; ")}`);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("routes every retry-wait job shape through the exported checked transition consumer", async () => {
    const root = mkdtempSync(join(tmpdir(), "post-pr-transition-"));
    try {
      for (const activity of ["canonical", "validator", "security"]) {
        const running = createPostPrCatalogBaseline(findRecord(DURABLE_AUTHORITY_CATALOG, `post-pr-${activity}-job-running`));
        const waiting = createPostPrCatalogBaseline(findRecord(DURABLE_AUTHORITY_CATALOG, `post-pr-${activity}-job-retry-wait`));
        for (const fixture of [running, waiting]) {
          fixture.run.post_pr.remediation.candidate_head_sha = null;
          fixture.run.post_pr.remediation.remediation_evidence_ref = null;
          fixture.run.post_pr.remediation.remediation_evidence_hash = null;
        }
        const runDir = join(root, activity);
        mkdirSync(runDir, { recursive: true });
        for (const { ref, bytes } of Object.values(waiting.externalSources)) {
          const file = join(runDir, ref);
          mkdirSync(dirname(file), { recursive: true });
          writeFileSync(file, bytes);
        }
        writeFileSync(join(runDir, "run.json"), `${JSON.stringify(running.run, null, 2)}\n`);
        const result = await transitionPostPrState(runDir, waiting.run.post_pr, { now: "2026-07-16T12:06:00.000Z" });
        assert.equal(result.run.post_pr.remediation.revalidation.jobs[activity].status, "retry-wait");
        assert.equal(result.run.post_pr.remediation.revalidation.jobs[activity].transient_error_count, 1);
        assert.equal(result.run.post_pr.remediation.revalidation.jobs[activity].next_retry_at, "2026-07-16T12:06:00.000Z");
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("mutates post_pr refs, hashes, and external bytes independently without persisted byte wrappers", () => {
    const record = findRecord(DURABLE_AUTHORITY_CATALOG, "post-pr-revalidation-bound");
    const cases = emitDurableRecordMutations(record.source, record.descriptor, record.externalSources);
    const refCase = cases.find(({ family, name }) => family === "wrong-ref" && name.includes("canonical ref"));
    const hashCase = cases.find(({ family, name }) => family === "wrong-hash" && name.includes("canonical hash"));
    const bytesCase = cases.find(({ family, name }) => family === "wrong-bytes" && name.includes("canonical sidecar bytes"));
    assert.equal(refCase.record.canonical_evidence_ref, "../outside.json");
    assert.equal(refCase.externalSources.canonical.bytes, record.externalSources.canonical.bytes);
    assert.equal(hashCase.record.canonical_evidence_hash, "sha256:short");
    assert.equal(hashCase.externalSources.canonical.bytes, record.externalSources.canonical.bytes);
    assert.equal(bytesCase.record.canonical_evidence_ref, record.source.canonical_evidence_ref);
    assert.equal(bytesCase.record.canonical_evidence_hash, record.source.canonical_evidence_hash);
    assert.equal(bytesCase.externalSources.canonical.bytes, "tampered-sidecar-bytes");
  });

  it("emits explicit candidate-head and remediation-evidence mutations for every post-change and push phase", () => {
    const boundRows = ["post-pr-remediation-active", ...["changes-observed", "committed", "revalidating", "validated", "push-pending", "remote-confirmed"].map((phase) => `post-pr-phase-${phase}`)];
    for (const id of boundRows) {
      const record = findRecord(DURABLE_AUTHORITY_CATALOG, id);
      const authorityCases = emitDurableRecordMutations(record.source, record.descriptor, record.externalSources)
        .filter(({ name }) => /remediation (?:ref|hash|sidecar bytes)|candidate_head_sha|cross-bound candidate head/u.test(name));
      assert.deepEqual(
        authorityCases.map(({ family }) => family),
        ["wrong-ref", "wrong-hash", "wrong-bytes", "stale-identity", "cross-bound-identity"],
        `${id} must independently mutate ref, hash, bytes, stale candidate, and cross-bound candidate`,
      );
    }
  });

  it("rejects deletion and substitution of every new candidate/remediation binding target", () => {
    const boundRows = ["post-pr-remediation-active", ...["changes-observed", "committed", "revalidating", "validated", "push-pending", "remote-confirmed"].map((phase) => `post-pr-phase-${phase}`)];
    let testedTargets = 0;
    for (const id of boundRows) {
      const original = findRecord(DURABLE_AUTHORITY_CATALOG, id);
      const targets = original.descriptor.targets.filter((target) => target.sidecar === "remediation" || target.path.join(".").endsWith("candidate_head_sha"));
      assert.equal(targets.length, 5, `${id} must bind all five authority targets`);
      for (const target of targets) {
        const deleted = structuredClone(DURABLE_AUTHORITY_CATALOG);
        const deletedRecord = findRecord(deleted, id);
        deletedRecord.descriptor.targets.splice(deletedRecord.descriptor.targets.findIndex((candidate) => JSON.stringify(candidate) === JSON.stringify(target)), 1);
        assert.throws(() => assertDurableAuthorityCatalogComplete(deleted), /disposition|descriptor manifest/u, `${id}: ${target.family} deletion`);

        const substituted = structuredClone(DURABLE_AUTHORITY_CATALOG);
        const substitutedTarget = findRecord(substituted, id).descriptor.targets.find((candidate) => JSON.stringify(candidate) === JSON.stringify(target));
        substitutedTarget.label = `${substitutedTarget.label}-substituted`;
        assert.throws(() => assertDurableAuthorityCatalogComplete(substituted), /descriptor manifest/u, `${id}: ${target.family} substitution`);
        testedTargets += 1;
      }
    }
    assert.equal(testedTargets, 35);
  });

  it("executes every post-change and push phase remediation binding through its actual consumers", async () => {
    const phaseIds = [
      "post-pr-phase-changes-observed",
      "post-pr-phase-committed",
      "post-pr-phase-revalidating",
      "post-pr-phase-validated",
      "post-pr-phase-push-pending",
      "post-pr-phase-remote-confirmed",
    ];
    const root = mkdtempSync(join(tmpdir(), "post-pr-remediation-authority-"));
    let consistencyCases = 0;
    let transitionCases = 0;
    try {
      for (const id of phaseIds) {
        const record = findRecord(DURABLE_AUTHORITY_CATALOG, id);
        const authorityCases = emitDurableRecordMutations(record.source, record.descriptor, record.externalSources)
          .filter(({ name }) => /remediation (?:ref|hash|sidecar bytes)|candidate_head_sha|cross-bound candidate head/u.test(name));
        assert.equal(authorityCases.length, 5, `${id} must expose all five authority mutations`);
        for (const mutationCase of authorityCases) {
          const fixture = createPostPrCatalogBaseline(record);
          const runDir = join(root, id, mutationCase.family);
          materializeCatalogSources(runDir, mutationCase.externalSources);
          if (["wrong-ref", "wrong-hash", "wrong-bytes"].includes(mutationCase.family)) {
            const mutatedRun = structuredClone(fixture.run);
            mutatedRun.post_pr = structuredClone(mutationCase.record);
            const consistency = checkRunConsistency(runDir, mutatedRun);
            consistencyCases += 1;
            assert.equal(consistency.ok, false, `${mutationCase.name} must fail external-source consistency`);
          }

          if (mutationCase.family === "wrong-bytes" && id !== "post-pr-phase-changes-observed") continue;
          writeJson(join(runDir, "run.json"), fixture.run);
          const next = structuredClone(mutationCase.record);
          next.observation.poll_count += 1;
          next.observation.next_poll_at = "2026-07-16T12:01:00.000Z";
          transitionCases += 1;
          await assert.rejects(
            transitionPostPrState(runDir, next, { now: "2026-07-16T12:01:00.000Z" }),
            /cannot change once bound|ref\/hash invariant failed/u,
            mutationCase.name,
          );
        }
      }
      assert.equal(consistencyCases, 18, "six rows must each execute ref, hash, and actual file-byte drift through checkRunConsistency");
      assert.equal(transitionCases, 25, "six rows must execute ref/hash and both candidate mutations, retaining the changes-observed byte transition");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects post_pr source, placement, authority-fact, and external-byte relocation", () => {
    for (const [label, mutate] of [
      ["class", (record) => { record.authorityClassId = "validator-security-pr-result"; }],
      ["id", (record) => { record.id = "post-pr-phase-other"; }],
      ["source", (record) => { record.source.policy.wait_ms += 1; }],
      ["record", (record) => { record.record = "run.json.post_pr.observation"; }],
      ["variant", (record) => { record.variant = "other-phase"; }],
      ["path", (record) => { record.canonicalPath = ["post_pr", "phase"]; }],
      ["fact path", (record) => { record.facts[0].path = ["phase"]; }],
      ["fact value", (record) => { record.facts.find(({ path }) => path.join(".") === "phase").expected = "blocked"; }],
      ["external bytes", (record) => { record.externalSources[Object.keys(record.externalSources)[0]].bytes += "tampered"; }],
    ]) {
      const catalog = structuredClone(DURABLE_AUTHORITY_CATALOG);
      const id = label === "external bytes" ? "post-pr-revalidation-bound" : "post-pr-phase-observing";
      mutate(findRecord(catalog, id));
      assert.throws(() => assertDurableAuthorityCatalogComplete(catalog), /canonical source|contradicts|metadata manifest|authorityClassId|every required per-record/u, label);
    }
  });

  it("registers all eight post_pr terminal-fact forms including both account-switch forms", () => {
    const variants = ["account-switch-failed-github-auth", "account-switch-failed-push", "dispatch-start-unknown", "path-lane-violation", "remote-head-diverged", "panel-runner-result-malformed", "push-failed", "panel-attribution-unsafe"];
    const entries = variants.map((variant) => findRecord(DURABLE_AUTHORITY_CATALOG, `post-pr-terminal-fact-${variant}`));
    assert.deepEqual(entries.map(({ variant }) => variant), variants);
    assert.deepEqual(entries.map(({ source }) => source.kind), ["account-switch-failed", "account-switch-failed", "dispatch-start-unknown", "path-lane-violation", "remote-head-diverged", "panel-runner-result-malformed", "push-failed", "panel-attribution-unsafe"]);
    assert.equal(entries[0].source.operation, "gh-auth-switch");
    assert.equal(entries[0].source.github_account, "acme");
    assert.equal(entries[1].source.operation, "fast-forward-push");
    assert.equal(entries[1].source.classification, "permanent");
  });

  it("registers all PR79 repair states as canonical persisted sources with external authority facts", () => {
    const repairClass = DURABLE_AUTHORITY_CATALOG.find(({ id }) => id === "pr79-merged-slice-repair");
    assert.deepEqual(repairClass.records.map(({ id }) => id), ["repair-reported", "repair-repairing", "repair-review-approve", "repair-review-reject", "repair-merged", "repair-blocked-from-reported", "repair-blocked-from-repairing", "repair-blocked-from-review"]);
    assert.deepEqual(repairClass.records.map(({ variant }) => variant), ["reported", "repairing", "review:APPROVE", "review:REJECT", "merged", "blocked-from-reported", "blocked-from-repairing", "blocked-from-review"]);
    assert.equal(DURABLE_AUTHORITY_CANONICAL_SOURCE_MANIFEST.slice(-8).every(([id], index) => id === repairClass.records[index].id), true);
    assert.deepEqual(repairClass.records.map(({ canonicalPath }) => canonicalPath), Array.from({ length: 8 }, () => ["merged_slice_repair"]));
    assert.deepEqual(repairClass.records.map(({ source }) => source.status), ["reported", "repairing", "review", "review", "merged", "blocked", "blocked", "blocked"]);
    assert.deepEqual(repairClass.records.map(({ source }) => source.attempts), [0, 1, 1, 1, 1, 0, 1, 1]);
    const requiredReportedKeys = ["schema_version", "plan_hash", "owner_slice_id", "consumer_slice_id", "defect_path", "evidence_ref", "evidence_hash", "status", "attempts", "max_attempts", "created_at", "updated_at"];
    assert.deepEqual(Object.keys(findRecord(DURABLE_AUTHORITY_CATALOG, "repair-reported").source), requiredReportedKeys);
    assert.deepEqual(Object.keys(findRecord(DURABLE_AUTHORITY_CATALOG, "repair-repairing").source).sort(), [...requiredReportedKeys, "baseline_commit", "branch", "worktree"].sort());
    for (const id of ["repair-review-approve", "repair-review-reject"]) {
      assert.deepEqual(Object.keys(findRecord(DURABLE_AUTHORITY_CATALOG, id).source).sort(), [...requiredReportedKeys, "baseline_commit", "reviewed_commit", "review_ref", "review_hash", "repair_evidence_ref", "repair_evidence_hash"].sort());
    }
    assert.deepEqual(Object.keys(findRecord(DURABLE_AUTHORITY_CATALOG, "repair-merged").source).sort(), [...requiredReportedKeys, "baseline_commit", "reviewed_commit", "review_ref", "review_hash", "repair_evidence_ref", "repair_evidence_hash", "verification_ref", "verification_hash", "merge_commit"].sort());
    assert.deepEqual(Object.keys(findRecord(DURABLE_AUTHORITY_CATALOG, "repair-blocked-from-reported").source).sort(), [...requiredReportedKeys, "reason"].sort());
    assert.deepEqual(Object.keys(findRecord(DURABLE_AUTHORITY_CATALOG, "repair-blocked-from-repairing").source).sort(), [...requiredReportedKeys, "baseline_commit", "branch", "worktree", "reason"].sort());
    assert.deepEqual(Object.keys(findRecord(DURABLE_AUTHORITY_CATALOG, "repair-blocked-from-review").source).sort(), [...requiredReportedKeys, "baseline_commit", "reviewed_commit", "review_ref", "review_hash", "repair_evidence_ref", "repair_evidence_hash", "reason"].sort());
    for (const { source } of repairClass.records) {
      assert.equal(source.schema_version, 1);
      assert.equal(source.max_attempts, 2);
      assert.equal(source.owner_slice_id, "owner");
      assert.equal(source.consumer_slice_id, "consumer");
      assert.equal(source.defect_path, "src/owner/records.js");
      for (const synthetic of ["plan_ref", "owner_snapshot", "quiescent", "review_verdict", "reviewed_tree", "merge_tree", "sidecar_bytes", "blocked_from"]) assert.equal(containsOwnKey(source, synthetic), false, `${synthetic} must never be persisted`);
    }
    const approve = findRecord(DURABLE_AUTHORITY_CATALOG, "repair-review-approve");
    const reject = findRecord(DURABLE_AUTHORITY_CATALOG, "repair-review-reject");
    assert.equal(JSON.parse(approve.externalSources.review.bytes).verdict, "APPROVE");
    assert.equal(JSON.parse(reject.externalSources.review.bytes).verdict, "REJECT");
    assert.equal(Object.hasOwn(approve.source, "review_verdict"), false);
    assert.equal(Object.hasOwn(reject.source, "review_verdict"), false);
    const merged = findRecord(DURABLE_AUTHORITY_CATALOG, "repair-merged");
    assert.deepEqual(merged.sidecars.map(({ name }) => name), ["plan", "original-evidence", "repair-evidence", "review", "verification"]);
    assert.equal(Object.hasOwn(merged.source, "reviewed_tree"), false);
    assert.equal(Object.hasOwn(merged.source, "merge_tree"), false);
    assert.equal(merged.observations.some(({ name, source, expected, consumer }) => name === "reviewed-merge-tree-equality" && source === "re-observed" && expected === true && consumer.includes("transitionMergedSliceRepair merged")), true);
    assert.equal(findRecord(DURABLE_AUTHORITY_CATALOG, "repair-repairing").observations.some(({ name, expected }) => name === "quiescence" && expected === true), true);
    assert.deepEqual(["repair-blocked-from-reported", "repair-blocked-from-repairing", "repair-blocked-from-review"].map((id) => inferBlockedRepairOrigin(findRecord(DURABLE_AUTHORITY_CATALOG, id).source)), ["reported", "repairing", "review"]);
  });

  it("places every canonical PR79 repair source in a validator- and consistency-accepted run with separate fixture files", () => {
    const root = mkdtempSync(join(tmpdir(), "repair-catalog-"));
    try {
      for (const id of DURABLE_AUTHORITY_REQUIRED_RECORD_IDS["pr79-merged-slice-repair"]) {
        const record = findRecord(DURABLE_AUTHORITY_CATALOG, id);
        const fixture = createRepairCatalogBaseline(record);
        assert.equal(validateRun(fixture.run), fixture.run, `${id} must use the production persisted schema`);
        const runDir = join(root, id);
        materializeCatalogSources(runDir, fixture.externalSources, fixture.supportSources);
        const consistency = checkRunConsistency(runDir, fixture.run);
        assert.equal(consistency.ok, true, `${id}: ${failedConsistencyMessages(consistency)}`);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("mutates every PR79 plan/evidence/review/verification ref, hash, and file independently at the actual consistency seam", () => {
    const root = mkdtempSync(join(tmpdir(), "repair-sidecar-mutations-"));
    try {
      const record = findRecord(DURABLE_AUTHORITY_CATALOG, "repair-merged");
      const cases = emitDurableRecordMutations(record.source, record.descriptor, record.externalSources)
        .filter(({ family }) => ["wrong-ref", "wrong-hash", "wrong-bytes"].includes(family));
      assert.equal(cases.length, 15, "five external bindings must each expose independent ref/hash/bytes drift");
      for (const mutationCase of cases) {
        const fixture = createRepairCatalogBaseline(record);
        fixture.run.merged_slice_repair = mutationCase.record;
        const runDir = join(root, mutationCase.name.replaceAll(/[^a-z0-9]+/giu, "-"));
        materializeCatalogSources(runDir, mutationCase.externalSources, fixture.supportSources);
        const consistency = checkRunConsistency(runDir, fixture.run);
        assert.equal(consistency.ok, false, `${mutationCase.name} must fail a production consistency binding`);
        assert.match(failedConsistencyMessages(consistency), /merged_slice_repair\.(?:plan(?:_hash)?|evidence_(?:ref|hash)|review_(?:ref|hash)|repair_evidence_(?:ref|hash)|verification_(?:ref|hash))/u, mutationCase.name);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects PR79 source deletion, relocation, contradiction, external-byte substitution, and every synthetic persisted field", () => {
    const mutations = [
      ["source deletion", (record) => { delete record.source.plan_hash; }],
      ["record relocation", (record) => { record.record = "run.json.repair"; }],
      ["variant relocation", (record) => { record.variant = `${record.variant}-relocated`; }],
      ["canonical relocation", (record) => { record.canonicalPath = ["repair"]; }],
      ["fact deletion", (record) => { record.facts.pop(); }],
      ["fact relocation", (record) => { record.facts[0].path = ["attempts"]; }],
      ["fact contradiction", (record) => { record.facts[0].expected = { contradiction: true }; }],
      ["external deletion", (record) => { delete record.externalSources.plan; }],
      ["external bytes", (record) => { record.externalSources["original-evidence"].bytes += "tampered"; }],
      ...["plan_ref", "owner_snapshot", "quiescent", "review_verdict", "reviewed_tree", "merge_tree", "sidecar_bytes", "blocked_from"].map((key) => [`synthetic ${key}`, (record) => { record.source[key] = true; }]),
    ];
    for (const id of DURABLE_AUTHORITY_REQUIRED_RECORD_IDS["pr79-merged-slice-repair"]) {
      for (const [label, mutate] of mutations) {
        const catalog = structuredClone(DURABLE_AUTHORITY_CATALOG);
        mutate(findRecord(catalog, id));
        assert.throws(() => assertDurableAuthorityCatalogComplete(catalog), /canonical source|contradicts|synthetic|bound external source|does not resolve|metadata manifest/u, `${id}: ${label}`);
      }
    }
  });

  it("routes reported, repairing attempts 1 and 2, both review verdicts, merged, and all blocked origins through production consumers", async () => {
    const fixtures = [];
    try {
      const reportedBlocked = createRepairTransitionFixture(); fixtures.push(reportedBlocked);
      const reported = await transitionRepairReport(reportedBlocked);
      assert.deepEqual(Object.keys(reported.merged_slice_repair), ["schema_version", "plan_hash", "owner_slice_id", "consumer_slice_id", "defect_path", "evidence_ref", "evidence_hash", "status", "attempts", "max_attempts", "created_at", "updated_at"]);
      const blockedReported = await transitionMergedSliceRepair(reportedBlocked.runDir, { status: "blocked", reason: "reported blocker" });
      assert.equal(inferBlockedRepairOrigin(blockedReported.merged_slice_repair), "reported");

      const repairingBlocked = createRepairTransitionFixture(); fixtures.push(repairingBlocked);
      await transitionRepairReport(repairingBlocked);
      const repairing = await transitionMergedSliceRepair(repairingBlocked.runDir, { status: "repairing", attempts: 1, branch: "repair-owner", worktree: "/tmp/repair-owner" }, { repoRoot: repairingBlocked.repo });
      assert.equal(repairing.merged_slice_repair.attempts, 1);
      assert.equal(repairing.merged_slice_repair.baseline_commit, repairingBlocked.baselineCommit);
      const blockedRepairing = await transitionMergedSliceRepair(repairingBlocked.runDir, { status: "blocked", reason: "repairing blocker" });
      assert.equal(inferBlockedRepairOrigin(blockedRepairing.merged_slice_repair), "repairing");

      const rejected = createRepairTransitionFixture(); fixtures.push(rejected);
      await transitionRepairReport(rejected);
      await transitionMergedSliceRepair(rejected.runDir, { status: "repairing", attempts: 1 }, { repoRoot: rejected.repo });
      const rejectedHead = commitTransitionRepair(rejected, "reject");
      writeTransitionReview(rejected, "REJECT", rejectedHead);
      const rejectedReview = await transitionRepairReview(rejected, rejectedHead);
      assert.equal(JSON.parse(readFileSync(join(rejected.runDir, rejectedReview.merged_slice_repair.review_ref), "utf8")).verdict, "REJECT");
      assert.equal(Object.hasOwn(rejectedReview.merged_slice_repair, "review_verdict"), false);
      const secondAttempt = await transitionMergedSliceRepair(rejected.runDir, { status: "repairing", attempts: 2 }, { repoRoot: rejected.repo });
      assert.equal(secondAttempt.merged_slice_repair.attempts, 2);

      const reviewBlocked = createRepairTransitionFixture(); fixtures.push(reviewBlocked);
      await transitionRepairReport(reviewBlocked);
      await transitionMergedSliceRepair(reviewBlocked.runDir, { status: "repairing", attempts: 1 }, { repoRoot: reviewBlocked.repo });
      const reviewBlockedHead = commitTransitionRepair(reviewBlocked, "blocked");
      writeTransitionReview(reviewBlocked, "REJECT", reviewBlockedHead);
      await transitionRepairReview(reviewBlocked, reviewBlockedHead);
      const blockedReview = await transitionMergedSliceRepair(reviewBlocked.runDir, { status: "blocked", reason: "review blocker" });
      assert.equal(inferBlockedRepairOrigin(blockedReview.merged_slice_repair), "review");

      const approved = createRepairTransitionFixture(); fixtures.push(approved);
      await transitionRepairReport(approved);
      await transitionMergedSliceRepair(approved.runDir, { status: "repairing", attempts: 1 }, { repoRoot: approved.repo });
      const approvedHead = commitTransitionRepair(approved, "approve");
      writeTransitionReview(approved, "APPROVE", approvedHead);
      const approvedReview = await transitionRepairReview(approved, approvedHead);
      assert.equal(Object.hasOwn(approvedReview.merged_slice_repair, "review_verdict"), false);
      writeJson(join(approved.runDir, "evidence", "verification.json"), { subject: "consumer", status: "pass" });
      const merged = await transitionMergedSliceRepair(approved.runDir, { status: "merged", merge_commit: approvedHead, verification_ref: "evidence/verification.json" }, { repoRoot: approved.repo });
      assert.equal(merged.merged_slice_repair.status, "merged");
      assert.equal(merged.merged_slice_repair.reviewed_commit, approvedHead);
      assert.equal(merged.merged_slice_repair.merge_commit, approvedHead);
      assert.equal(Object.hasOwn(merged.merged_slice_repair, "reviewed_tree"), false);
      assert.equal(Object.hasOwn(merged.merged_slice_repair, "merge_tree"), false);
      assert.equal(checkRunConsistency(approved.runDir, merged.run).ok, true);
    } finally {
      for (const fixture of fixtures) rmSync(fixture.repo, { recursive: true, force: true });
    }
  });

  it("explicitly excludes diagnostics and liveness, lock, and process records with reasons", () => {
    const exclusions = Object.fromEntries(DURABLE_AUTHORITY_EXCLUSIONS.flatMap(({ records, reason }) => records.map((record) => [record, reason])));
    assert.deepEqual(Object.keys(exclusions), [
      "run.json.debug_snapshot",
      "run.json.provenance",
      "run.json.cost_attribution",
      "heartbeat.json",
      "run.json.heartbeat_at",
      "factory.lock",
      "run-json.lock/owner.json",
      "process-launch.lock/owner.json",
      "process.json",
      "processes/*.log",
    ]);
    for (const [record, reason] of Object.entries(exclusions)) {
      assert.ok(reason.trim().length > 0, `${record} exclusion must have a reason`);
    }

    const cataloged = new Set(DURABLE_AUTHORITY_CATALOG.flatMap(({ records }) => records.map(({ record }) => record)));
    for (const record of Object.keys(exclusions)) assert.equal(cataloged.has(record), false, `${record} must stay outside the authority catalog`);
  });
});

describe("per-record durable authority mutation matrices", () => {
  for (const authorityClass of DURABLE_AUTHORITY_CATALOG) {
    for (const record of authorityClass.records) {
      it(`${record.id} mutation matrix`, () => {
        assert.deepEqual(record.tests, [`test/durable-record-mutations.test.js: ${record.id} mutation matrix`]);
        const sourceBefore = structuredClone(record.source);
        const cases = emitDurableRecordMutations(record.source, record.descriptor, record.externalSources);
        assert.equal(cases.length, record.descriptor.targets.length);
        assert.deepEqual(cases.map(({ family }) => family).sort(), record.descriptor.targets.map(({ family }) => family).sort());
        assert.deepEqual(record.source, sourceBefore);
      });
    }
  }
});

function materializeCatalogSources(runDir, ...sourceGroups) {
  mkdirSync(runDir, { recursive: true });
  for (const sources of sourceGroups) {
    for (const { ref, bytes } of Object.values(sources ?? {})) {
      if (ref.startsWith("../") || ref.includes("/../")) continue;
      const file = join(runDir, ref);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, bytes);
    }
  }
}

function failedConsistencyMessages(result) {
  return result.checks.filter(({ ok }) => !ok).flatMap(({ name, errors }) => errors.map(({ path, message }) => `${name} ${path}: ${message}`)).join("; ");
}

function inferBlockedRepairOrigin(source) {
  assert.equal(source.status, "blocked");
  if (source.review_ref !== undefined || source.repair_evidence_ref !== undefined) return "review";
  if (source.baseline_commit !== undefined) return "repairing";
  return "reported";
}

function createRepairTransitionFixture() {
  const repo = mkdtempSync(join(tmpdir(), "repair-transition-catalog-"));
  const runDir = join(repo, ".opencode", "factory", "repair-run");
  for (const dir of ["evidence", "reviews", "plan"]) mkdirSync(join(runDir, dir), { recursive: true });
  fixtureGit(repo, ["init", "-q", "-b", "repair-feature"]);
  fixtureGit(repo, ["config", "user.email", "test@example.com"]);
  fixtureGit(repo, ["config", "user.name", "Test"]);
  writeFileSync(join(repo, "README.md"), "fixture\n");
  fixtureGit(repo, ["add", "README.md"]);
  fixtureGit(repo, ["commit", "-q", "-m", "baseline"]);
  const baselineCommit = fixtureGit(repo, ["rev-parse", "HEAD"]).trim();
  writeJson(join(runDir, "plan", "slices.json"), {
    slices: [
      { id: "owner", stack: "backend", paths: ["src/owner/**"], depends_on: [], acceptance: ["AC1"], test_plan: ["unit"] },
      { id: "consumer", stack: "backend", paths: ["src/consumer/**"], depends_on: ["owner"], acceptance: ["AC2"], test_plan: ["unit"] },
    ],
  });
  writeJson(join(runDir, "evidence", "consumer-failure.json"), { subject: "consumer", status: "fail" });
  writeJson(join(runDir, "evidence", "owner.json"), { subject: "owner", status: "pass" });
  writeJson(join(runDir, "reviews", "owner.json"), createReviewRecord({ subject: "owner" }));
  writeJson(join(runDir, "run.json"), createRunRecord({
    run_id: "repair-run",
    branch: "repair-feature",
    steps: [],
    slices: [
      { id: "owner", stack: "backend", depends_on: [], status: "merged", attempts: 1, evidence_ref: "evidence/owner.json", review_ref: "reviews/owner.json", merge_commit: baselineCommit },
      { id: "consumer", stack: "backend", depends_on: ["owner"], status: "blocked", attempts: 1, blocked_reason: "owner defect" },
    ],
  }));
  return { repo, runDir, baselineCommit };
}

function transitionRepairReport(fixture) {
  return transitionMergedSliceRepair(fixture.runDir, {
    status: "reported",
    owner_slice_id: "owner",
    consumer_slice_id: "consumer",
    defect_path: "src/owner/records.js",
    evidence_ref: "evidence/consumer-failure.json",
  }, { repoRoot: fixture.repo });
}

function commitTransitionRepair(fixture, label) {
  const path = join(fixture.repo, "src", "owner", "records.js");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `repair ${label}\n`);
  fixtureGit(fixture.repo, ["add", "src/owner/records.js"]);
  fixtureGit(fixture.repo, ["commit", "-q", "-m", `repair ${label}`]);
  const commit = fixtureGit(fixture.repo, ["rev-parse", "HEAD"]).trim();
  writeJson(join(fixture.runDir, "evidence", "repair-attempt.json"), { subject: "repair:owner", changed_paths: ["src/owner/records.js"] });
  return commit;
}

function writeTransitionReview(fixture, verdict, commit) {
  writeJson(join(fixture.runDir, "reviews", "repair.json"), createReviewRecord({
    subject: "repair:owner",
    verdict,
    required_fixes: verdict === "REJECT" ? ["correct owner record"] : [],
    attempt: 1,
    commit,
  }));
}

function transitionRepairReview(fixture, commit) {
  return transitionMergedSliceRepair(fixture.runDir, {
    status: "review",
    review_ref: "reviews/repair.json",
    repair_evidence_ref: "evidence/repair-attempt.json",
    reviewed_commit: commit,
  }, { repoRoot: fixture.repo });
}

function fixtureGit(repo, args) {
  return execFileSync("git", args, { cwd: repo, encoding: "utf8" });
}

function writeJson(file, value) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function findRecord(catalog, id) {
  return catalog.flatMap(({ records }) => records).find((record) => record.id === id);
}

function findFact(record, path) {
  const declaration = record.facts.find((fact) => fact.path.length === path.length && fact.path.every((segment, index) => segment === path[index]));
  assert.ok(declaration, `${record.id} must bind ${path.join(".")}`);
  return declaration.expected;
}

function containsOwnKey(value, key) {
  if (Array.isArray(value)) return value.some((item) => containsOwnKey(item, key));
  if (value === null || typeof value !== "object") return false;
  return Object.hasOwn(value, key) || Object.values(value).some((item) => containsOwnKey(item, key));
}

function findRecordWithTarget(catalog, family) {
  const record = catalog.flatMap(({ records }) => records)
    .find(({ descriptor }) => descriptor.targets.some((targetDefinition) => targetDefinition.family === family));
  assert.ok(record, `catalog must contain a ${family} target`);
  return record;
}

function findRecordWithExclusion(catalog, family) {
  const record = catalog.flatMap(({ records }) => records)
    .find(({ descriptor }) => Object.hasOwn(descriptor.exclusions, family));
  assert.ok(record, `catalog must contain a ${family} exclusion`);
  return record;
}

function findTarget(catalog, family, field) {
  const record = catalog.flatMap(({ records }) => records)
    .find(({ descriptor }) => descriptor.targets.some((targetDefinition) => (
      targetDefinition.family === family && (field === undefined || Object.hasOwn(targetDefinition, field))
    )));
  assert.ok(record, `catalog must contain a ${family} target${field === undefined ? "" : ` with ${field}`}`);
  return record.descriptor.targets.find((targetDefinition) => (
    targetDefinition.family === family && (field === undefined || Object.hasOwn(targetDefinition, field))
  ));
}

function changedTargetFieldValue(field, value) {
  if (field === "path") return [...value, "oracle-bypass"];
  if (typeof value === "string") return `${value}-oracle-bypass`;
  if (typeof value === "number") return value + 1;
  if (typeof value === "boolean") return !value;
  if (value === null) return "oracle-bypass";
  return { oracle_bypass: true };
}
