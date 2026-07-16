import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  DURABLE_AUTHORITY_CATALOG,
  DURABLE_AUTHORITY_EXCLUSIONS,
  DURABLE_AUTHORITY_REQUIRED_RECORD_IDS,
  DURABLE_MUTATION_FAMILIES,
  assertDurableAuthorityCatalogComplete,
  emitDurableRecordMutations,
} from "./helpers/durable-record-mutations.js";

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
        const cases = emitDurableRecordMutations(record.source, record.descriptor);
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
    assert.equal(recordCount, 65);
  });

  it("rejects the aggregate-class completeness bypass and omitted sibling records", () => {
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
  });

  it("rejects per-record family, metadata, and sidecar-byte omissions", () => {
    const missingFamily = structuredClone(DURABLE_AUTHORITY_CATALOG);
    const finalPlan = findRecord(missingFamily, "final-plan-descriptor");
    finalPlan.descriptor.targets = finalPlan.descriptor.targets.filter(({ family }) => family !== "wrong-kind");
    assert.throws(() => assertDurableAuthorityCatalogComplete(missingFamily), /wrong-kind must have a target or a record-specific exclusion/u);

    for (const field of ["writer", "readers", "tests"]) {
      const missingMetadata = structuredClone(DURABLE_AUTHORITY_CATALOG);
      const plan = findRecord(missingMetadata, "plan-slices-json");
      plan[field] = field === "writer" ? "" : field === "readers" ? plan.readers.slice(1) : [];
      assert.throws(() => assertDurableAuthorityCatalogComplete(missingMetadata), new RegExp(`${field}.*(?:non-empty|string|array|every registered)`, "u"));
    }

    const conflatedBytes = structuredClone(DURABLE_AUTHORITY_CATALOG);
    const review = findRecord(conflatedBytes, "slice-review-sidecar");
    review.descriptor.targets = review.descriptor.targets.filter(({ family }) => family !== "wrong-bytes");
    review.descriptor.exclusions["wrong-bytes"] = "Ref text was already mutated.";
    assert.throws(
      () => assertDurableAuthorityCatalogComplete(conflatedBytes),
      /sidecar sidecar must target wrong-bytes independently/u,
      "ref drift must not stand in for referenced sidecar byte drift",
    );

    const omittedSidecar = structuredClone(DURABLE_AUTHORITY_CATALOG);
    findRecord(omittedSidecar, "post-pr-revalidation-bound").sidecars.pop();
    assert.throws(() => assertDurableAuthorityCatalogComplete(omittedSidecar), /sidecars must contain every registered byte binding/u);
  });

  it("mutates sidecar ref, hash, and bytes as independent adversarial cases", () => {
    const review = findRecord(DURABLE_AUTHORITY_CATALOG, "slice-review-sidecar");
    const cases = Object.fromEntries(emitDurableRecordMutations(review.source, review.descriptor).map((mutationCase) => [mutationCase.family, mutationCase.record]));
    assert.equal(cases["wrong-ref"].ref, "../outside.json");
    assert.equal(cases["wrong-ref"].sidecar_bytes, "{\"verdict\":\"APPROVE\"}");
    assert.equal(cases["wrong-hash"].hash, "sha256:short");
    assert.equal(cases["wrong-hash"].sidecar_bytes, "{\"verdict\":\"APPROVE\"}");
    assert.equal(cases["wrong-bytes"].ref, "reviews/backend.attempt-2.json");
    assert.equal(cases["wrong-bytes"].hash, `sha256:${"a".repeat(64)}`);
    assert.equal(cases["wrong-bytes"].sidecar_bytes, "tampered-sidecar-bytes");
  });

  it("generates the required kind mutation for the final.plan.json descriptor", () => {
    const planEntry = findRecord(DURABLE_AUTHORITY_CATALOG, "final-plan-descriptor");
    const sourceBefore = structuredClone(planEntry.source);
    const kindMutation = emitDurableRecordMutations(planEntry.source, planEntry.descriptor)
      .find(({ family, name }) => family === "wrong-kind" && name.includes("required descriptor.kind"));

    assert.equal(kindMutation.name, "final-plan-descriptor: wrong-kind (required descriptor.kind)");
    assert.equal(kindMutation.record.descriptor.kind, "unknown-graph");
    assert.equal(kindMutation.record.kind, "final-plan");
    assert.deepEqual(planEntry.source, sourceBefore);
  });

  it("registers post_pr null/non-null variants and independent bound bytes", () => {
    const postPr = DURABLE_AUTHORITY_CATALOG.find(({ id }) => id === "post-pr-nested-records");
    assert.deepEqual(postPr.records.map(({ id }) => id), DURABLE_AUTHORITY_REQUIRED_RECORD_IDS["post-pr-nested-records"]);
    for (const [nullId, boundId] of [
      ["post-pr-observation-null", "post-pr-observation-active"],
      ["post-pr-remediation-null", "post-pr-remediation-active"],
      ["post-pr-revalidation-empty", "post-pr-revalidation-bound"],
      ["post-pr-continuation-review-null", "post-pr-continuation-review-bound"],
      ["post-pr-terminal-fact-null", "post-pr-terminal-fact-bound"],
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
      { status: "confirmed", remote_before_sha: "a".repeat(40), local_head_sha: "a".repeat(40), remote_after_sha: "b".repeat(40), consecutive_transient_errors: 0, next_retry_at: null, pushed_at: "2026-07-16T12:00:00.000Z" },
    );
  });

  it("registers all PR79 repair states and every required authority fact", () => {
    const repairClass = DURABLE_AUTHORITY_CATALOG.find(({ id }) => id === "pr79-merged-slice-repair");
    assert.deepEqual(repairClass.records.map(({ id }) => id), ["repair-reported", "repair-repairing", "repair-review", "repair-merged", "repair-blocked"]);
    const facts = new Set(repairClass.records.flatMap(({ facts: recordFacts }) => recordFacts));
    assert.deepEqual([...facts].sort(), [
      "attempts-quiescence",
      "baseline",
      "defect-path",
      "merge-commit-tree",
      "original-evidence",
      "owner-consumer",
      "plan-owner-snapshot",
      "repair-evidence",
      "reviewed-commit-review-bytes",
      "verification",
    ]);
    const merged = findRecord(DURABLE_AUTHORITY_CATALOG, "repair-merged");
    assert.deepEqual(merged.sidecars.map(({ name }) => name), ["plan-owner", "original-evidence", "repair-evidence", "review", "verification"]);
    assert.equal(merged.source.reviewed_tree, merged.source.merge_tree);
    assert.equal(merged.descriptor.targets.some(({ family, path }) => family === "cross-bound-identity" && path.join(".") === "merge_tree"), true);
    assert.equal(merged.descriptor.targets.some(({ family, path }) => family === "wrong-type" && path.join(".") === "quiescent"), true);
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
        const cases = emitDurableRecordMutations(record.source, record.descriptor);
        assert.equal(cases.length, record.descriptor.targets.length);
        assert.deepEqual(cases.map(({ family }) => family).sort(), record.descriptor.targets.map(({ family }) => family).sort());
        assert.deepEqual(record.source, sourceBefore);
      });
    }
  }
});

function findRecord(catalog, id) {
  return catalog.flatMap(({ records }) => records).find((record) => record.id === id);
}
