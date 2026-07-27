import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { DURABLE_AUTHORITY_CATALOG, DURABLE_AUTHORITY_REQUIRED_RECORD_IDS, emitDurableRecordMutations } from "./helpers/durable-record-mutations.js";
import { validateIntegrationAmendment } from "../src/validate.js";
import { PR79_GENERIC_PARITY, blocked, buildingAttempt, cleanupFixtures, exerciseAmendmentReviewMutations, exerciseBuilderDispatchMutations, exerciseExecutionClaimMutations, exerciseExecutionReceiptMutations, exerciseGenericParity, exerciseManifestMutations, integrationFixture, manifestFixture, publicationFixture, reviewedAttempt, verificationBinding } from "./helpers/integration-amendment/fixture.js";

after(cleanupFixtures);

describe("generic integration amendment catalog coverage", () => {
  it("ports all 28 PR #79 adversarial categories through their generic production sinks", async (t) => {
    assert.deepEqual(PR79_GENERIC_PARITY.map(({ id }) => id), Array.from({ length: 28 }, (_, index) => index + 1));
    assert.equal(new Set(PR79_GENERIC_PARITY.map(({ category }) => category)).size, 28);
    assert.equal(new Set(PR79_GENERIC_PARITY.map(({ sink }) => sink)).size, 28);
    for (const row of PR79_GENERIC_PARITY) {
      await t.test(`${row.id}. ${row.category} -> ${row.sink}`, () => exerciseGenericParity(row.id));
    }
  });

  it("routes every emitted mutation for all 46 activated amendment rows through exact production consumers", async () => {
    const ids = DURABLE_AUTHORITY_REQUIRED_RECORD_IDS["pr79-merged-slice-repair"]
      .filter((id) => id.startsWith("amendment-") && !id.startsWith("amendment-review-dispatch-"));
    const records = DURABLE_AUTHORITY_CATALOG.flatMap(({ records: rows }) => rows);
    const executed = new Set();
    assert.equal(ids.length, 46);

    for (const id of ids) {
      const record = records.find((row) => row.id === id);
      assert.ok(record, `${id} registered catalog row`);
      const cases = emitDurableRecordMutations(record.source, record.descriptor, record.externalSources);
      const rejected = id.startsWith("amendment-report-claim-") || id.startsWith("amendment-verify-claim-")
        ? await exerciseExecutionClaimMutations(record, cases)
        : id.startsWith("amendment-report-receipt-") || id.startsWith("amendment-verify-receipt-")
          ? await exerciseExecutionReceiptMutations(record, cases)
          : id === "amendment-review-approve" || id === "amendment-review-reject"
            ? await exerciseAmendmentReviewMutations(record, cases)
            : id.startsWith("amendment-dispatch-")
              ? await exerciseBuilderDispatchMutations(record, cases)
              : await exerciseManifestMutations(record, cases);
      assert.deepEqual(rejected, cases.map(({ name }) => name), `${id} exact generated rejection inventory`);
      for (const name of rejected) {
        assert.equal(executed.has(name), false, `duplicate production mutation execution ${name}`);
        executed.add(name);
      }
    }

    const expected = ids.flatMap((id) => {
      const record = records.find((row) => row.id === id);
      return emitDurableRecordMutations(record.source, record.descriptor, record.externalSources).map(({ name }) => name);
    });
    assert.equal(expected.length, 788, "closed 46-row emitted mutation count");
    assert.equal(executed.size, 788, "every emitted mutation must reach a rejecting production consumer");
    assert.deepEqual([...executed], expected);
  });

  it("validates all 16 closed manifest variants", () => {
    const base = manifestFixture();
    const building1 = buildingAttempt(1, base.admission.baseline_commit);
    const approve1 = reviewedAttempt(1, base.admission.baseline_commit);
    const reject1 = reviewedAttempt(1, base.admission.baseline_commit);
    const building2 = buildingAttempt(2, reject1.reviewed_commit);
    const approve2 = reviewedAttempt(2, reject1.reviewed_commit);
    const reject2 = reviewedAttempt(2, reject1.reviewed_commit);
    const variants = [
      { ...base, status: "reported", attempts: [] },
      { ...base, status: "building", attempts: [building1] },
      { ...base, status: "building", attempts: [reject1, building2] },
      { ...base, status: "reviewed", attempts: [approve1] },
      { ...base, status: "reviewed", attempts: [reject1] },
      { ...base, status: "reviewed", attempts: [reject1, reject2] },
      { ...base, status: "reviewed", attempts: [reject1, approve2] },
      { ...base, status: "integrated", attempts: [approve1], integration: integrationFixture(base, approve1) },
      { ...base, status: "verified", attempts: [approve1], integration: integrationFixture(base, approve1), verification: verificationBinding(base.amendment_id) },
      { ...base, status: "merged", attempts: [approve1], integration: integrationFixture(base, approve1), verification: verificationBinding(base.amendment_id), publication: publicationFixture(base) },
      blocked(base, [], "reported"),
      blocked(base, [building1], "building"),
      blocked(base, [approve1], "reviewed-approve"),
      blocked(base, [reject1], "reviewed-reject"),
      { ...blocked(base, [approve1], "integrated"), integration: integrationFixture(base, approve1) },
      { ...blocked(base, [approve1], "verified"), integration: integrationFixture(base, approve1), verification: verificationBinding(base.amendment_id) },
    ];
    assert.equal(variants.length, 16);
    for (const variant of variants) assert.equal(validateIntegrationAmendment(variant), variant);
    assert.throws(() => validateIntegrationAmendment({ ...base, unknown: true }), /unknown: is not allowed/u);
    assert.throws(() => validateIntegrationAmendment({ ...base, attempts: [buildingAttempt(2, base.admission.baseline_commit)], status: "building" }), /must equal 1/u);
    assert.throws(() => validateIntegrationAmendment({ ...blocked(base, [], "integrated"), integration: integrationFixture(base, approve1) }), /requires a reviewed APPROVE-capable attempt/u);
    assert.throws(() => validateIntegrationAmendment({ ...blocked(base, [], "verified"), integration: integrationFixture(base, approve1), verification: verificationBinding(base.amendment_id) }), /requires a reviewed APPROVE-capable attempt/u);
  });

});
