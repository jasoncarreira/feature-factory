export function withDeliveryEnvelope(plan) {
  const current = structuredClone(plan);
  current.delivery_envelope = deliveryEnvelopeForSlices(current.slices);
  return current;
}

export function deliveryEnvelopeForSlices(slices) {
  return {
    schema_version: 1,
    delivery_units: slices.map((slice, index) => {
      const ordinal = index + 1;
      const familyId = `fixture-family-${ordinal}`;
      const artifactId = `fixture-artifact-${ordinal}`;
      return {
        id: `fixture-unit-${ordinal}`,
        slice_id: slice.id,
        invariant_families: [{ id: familyId, description: `Verify ${slice.id} behavior` }],
        obligations: [{
          id: `fixture-obligation-${ordinal}`,
          description: `Prove ${slice.id} behavior`,
          invariant_family_id: familyId,
          verification_artifact_id: artifactId,
        }],
        verification_artifacts: [{
          id: artifactId,
          test_plan_index: 0,
          test_plan_entry: slice.test_plan[0],
        }],
      };
    }),
  };
}

export function passingInvariantFamilyLedger({ plan, sliceId, reviewedCommit, evidenceRef, evidenceHash }) {
  const unit = plan.delivery_envelope.delivery_units.find((candidate) => candidate.slice_id === sliceId);
  if (!unit) throw new Error(`delivery envelope fixture has no unit for slice '${sliceId}'`);
  return {
    schema_version: 1,
    delivery_unit_id: unit.id,
    dispositions: unit.invariant_families.map((family) => {
      const obligation = unit.obligations.find((candidate) => candidate.invariant_family_id === family.id);
      return {
        invariant_family_id: family.id,
        verification_artifact_id: obligation.verification_artifact_id,
        evidence_ref: evidenceRef,
        evidence_hash: evidenceHash,
        probe: { type: "verification-artifact", verification_artifact_id: obligation.verification_artifact_id },
        result: { type: "verification-result", outcome: "pass", summary: `${family.description} passed` },
        reviewed_commit: reviewedCommit,
        unresolved_findings: [],
      };
    }),
  };
}

export function writeVerificationArtifactReceipt({ runDir, runId, plan, sliceId, attempt, reviewedCommit, artifactId, result, evidenceRef }) {
  const unit = plan.delivery_envelope.delivery_units.find((candidate) => candidate.slice_id === sliceId);
  const artifact = unit?.verification_artifacts.find((candidate) => candidate.id === artifactId);
  if (!artifact) throw new Error(`delivery envelope fixture has no artifact '${artifactId}' for slice '${sliceId}'`);
  const [program, ...args] = artifact.test_plan_entry.split(" ");
  const outcome = result.outcome;
  const receipt = {
    schema_version: 1,
    kind: "checked-verification-artifact-execution-receipt",
    subject: sliceId,
    run_id: runId,
    slice_id: sliceId,
    attempt,
    claim_nonce: "123e4567-e89b-42d3-a456-426614174000",
    plan_ref: "plan/slices.json",
    plan_hash: hashBytes(`${JSON.stringify(plan, null, 2)}\n`),
    head_sha: reviewedCommit,
    verification_artifact_id: artifact.id,
    probe: {
      type: "verification-artifact",
      verification_artifact_id: artifact.id,
      test_plan_index: artifact.test_plan_index,
      test_plan_entry: artifact.test_plan_entry,
      program,
      args,
    },
    started_at: "2026-07-19T10:00:00.000Z",
    completed_at: "2026-07-19T10:00:01.000Z",
    duration_ms: 1000,
    status: outcome,
    review_ready: outcome === "pass",
    commands: outcome === "skipped" ? [] : [{
      index: 0, program, args, outcome: "exited", status: outcome, exit_code: outcome === "pass" ? 0 : 1,
      signal: null, error_code: null, duration_ms: 1000, stdout: emptyStream(), stderr: emptyStream(),
    }],
    result: structuredClone(result),
  };
  const bytes = `${JSON.stringify(receipt, null, 2)}\n`;
  mkdirSync(dirname(join(runDir, evidenceRef)), { recursive: true });
  writeFileSync(join(runDir, evidenceRef), bytes);
  const hash = hashBytes(bytes);
  const claim = {
    schema_version: 1,
    kind: "checked-verification-artifact-execution-claim",
    state: "completed",
    nonce: receipt.claim_nonce,
    run_id: receipt.run_id,
    slice_id: receipt.slice_id,
    attempt: receipt.attempt,
    plan_ref: receipt.plan_ref,
    plan_hash: receipt.plan_hash,
    head_sha: receipt.head_sha,
    verification_artifact_id: receipt.verification_artifact_id,
    probe: receipt.probe,
    receipt_ref: evidenceRef,
    claimed_at: "2026-07-19T09:59:59.000Z",
    completed_at: receipt.completed_at,
    status: receipt.status,
    receipt_hash: hash,
  };
  const claimRef = `${evidenceRef.slice(0, -5)}.claim.json`;
  writeFileSync(join(runDir, claimRef), `${JSON.stringify(claim, null, 2)}\n`);
  return { ref: evidenceRef, hash, receipt, claim_ref: claimRef, claim };
}

function emptyStream() {
  return { captured_bytes: 0, sha256: hashBytes(""), truncated: false };
}

function hashBytes(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
