import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "./helpers/git-fixture.js";
import { publishSyntheticV2Parent } from "./helpers/v2-parent-fixture.js";
import { createRunRecord } from "./helpers/run-record-fixture.js";
import { passingInvariantFamilyLedger, withDeliveryEnvelope, writeVerificationArtifactReceipt } from "./helpers/delivery-envelope-fixture.js";
import {
  DURABLE_AUTHORITY_CATALOG,
  DURABLE_AUTHORITY_CANONICAL_SOURCE_MANIFEST,
  DURABLE_AUTHORITY_DESCRIPTOR_MANIFEST,
  DURABLE_AUTHORITY_EXCLUSIONS,
  DURABLE_AUTHORITY_METADATA_MANIFEST,
  DURABLE_AUTHORITY_PRODUCTION_COVERED_RECORD_IDS,
  DURABLE_AUTHORITY_REQUIRED_RECORD_IDS,
  DURABLE_MUTATION_FAMILIES,
  ISSUE128_BASELINE_ROUTE_INVENTORY,
  ISSUE128_FINISH_AND_DISCLOSE_AUTHORITY_CATALOG,
  ISSUE128_FINISH_AND_DISCLOSE_RECORD_IDS,
  assertDurableAuthorityCatalogComplete,
  createIssue128DurableRunBaseline,
  createDurableCatalogBaseline,
  createPostPrCatalogBaseline,
  emitDurableRecordMutations,
  emitIssue128FinishAndDiscloseMutations,
  issue128FinishAndDiscloseAuthorityOracle,
  renderDurableAuthorityOracleReviewSnapshot,
} from "./helpers/durable-record-mutations.js";
import { assertIntegrationAmendmentConsistency, checkRunConsistency, integrationAmendmentId, validateCheckpointChildPublication, validateCheckpointProgress, validateCheckpointSource, validateDeliveryCheckpointFinalClosure, validateIntegrationAmendment, validateIntegrationAmendmentExecutionClaim, validateIntegrationAmendmentExecutionReceipt, validateIntegrationAmendmentReview, validateIntegrationAmendmentReviewDispatchClaim, validateIntegrationAmendmentReviewDispatchClosure, validateRun, validateSlicesPlan, validateTestExecutionReceipt, validateVerificationArtifactExecutionClaim, validateVerificationArtifactExecutionReceipt } from "../src/validate.js";
import { cleanupRun } from "../src/factory.js";
import { executeCheckedTestExecution } from "../src/test-execution.js";
import { hashValue } from "../src/refs.js";
import { evaluateInvariantFamilyReview } from "../src/delivery-envelope/review-extension.js";
import { buildCheckpointRoutingManifest, validateCheckpointRoutingManifest, validateReviewedCheckpointPlan } from "../src/delivery-envelope/checkpoint-routing.js";
import {
  assertNoUnresolvedSliceDispatches,
  assertSliceAttemptHistoryCurrent,
  claimCheckedTestExecution,
  completeSpecialBuilderTaskDispatch,
  completeCheckedTestExecution,
  markCheckedTestExecutionUnknown,
  observeAcceptedDecompositionAuthority,
  observeReviewedMergeProof,
  prepareSpecialBuilderTaskDispatch,
  transitionPanelVerdicts,
  transitionGateDecision,
  transitionIntegrationAmendment,
  transitionPostPrState,
  transitionPrCreated,
  transitionPrePrFenceCleared,
  transitionPrePrFenceEstablished,
  transitionRecoverOrphan,
  transitionRunJson,
  transitionRunSlice,
  transitionRunStep,
  transitionSliceMerged,
  transitionSlicesSeed,
  transitionSteeringActionClosed,
  transitionSteeringActionStarted,
  transitionSteeringBoundaryCrossed,
  transitionSteeringBoundaryOpened,
} from "../src/run-state.js";

const AUTHORITY_CLASS_IDS = Object.freeze([
  "plan-slices-graph",
  "run-envelope-terminal-result",
  "gates-snapshot-handoff",
  "steps-acceptance-inheritance",
  "slices-review-evidence-bindings",
  "validator-security-pr-result",
  "continuation-v2-carry-forward",
  "post-pr-nested-records",
  "pr79-merged-slice-repair",
]);
const CLAIM_NOW = "2026-07-16T12:00:00.000Z";
const CLAIM_NONCE = "123e4567-e89b-42d3-a456-426614174000";
const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const ISSUE128_EMPTY_AUTHORITY_RECORD_IDS = Object.freeze([
  "slice-attempt-review-v2-reject",
  "slice-attempt-review-v2-approve-empty",
  "slice-running-with-v2-history",
  "slice-review-v2-reject",
  "slice-review-v2-approve-empty",
  "slice-merged-v2-approve-empty",
  "slice-blocked-ordinary-v2-history",
  "slice-blocked-nonconvergent-v2-history",
  "terminal-nonconvergence-v2-source-review",
]);
const ISSUE128_EXPECTED_SOURCE_COUNT = 20;
const ISSUE128_EXPECTED_MUTATION_COUNTS = Object.freeze([
  ["slice-attempt-review-v2-reject", 41],
  ["slice-attempt-review-v2-approve-empty", 41],
  ["slice-attempt-review-v2-approve-unowned", 54],
  ["slice-attempt-review-v2-approve-sibling", 156],
  ["slice-modified-extension-unowned-v2", 54],
  ["slice-modified-extension-sibling-v2", 156],
  ["slice-running-with-v2-history", 57],
  ["slice-review-v2-reject", 76],
  ["slice-review-v2-approve-empty", 76],
  ["slice-review-v2-approve-unowned", 89],
  ["slice-review-v2-approve-sibling", 191],
  ["slice-merged-v2-approve-empty", 78],
  ["slice-merged-v2-unowned", 91],
  ["slice-merged-v2-sibling", 193],
  ["slice-blocked-ordinary-v2-history", 58],
  ["slice-blocked-nonconvergent-v2-history", 58],
  ["terminal-nonconvergence-v2-source-review", 56],
  ["continuation-carry-forward-accepted-slice-v2", 178],
  ["checkpoint-carry-forward-accepted-slice-v2", 178],
  ["amendment-owner-snapshot-v2-history", 80],
]);
const ISSUE128_EXPECTED_MUTATION_COUNT = 1961;

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

const B0M4_EXACT_CASES = Object.freeze([
  { name: "post-pr-phase-disabled: missing-key (required field)", record_id: "post-pr-phase-disabled", family: "missing-key", target_label: "required field", consumer: "validateRun", rejector: "validatePostPr :: run.post_pr.phase :: must be one of disabled, awaiting-pr, observing, failure-recording, remediation-planned, remediation-running, changes-observed, committed, revalidating, validated, push-pending, remote-confirmed, succeeded, blocked, needs-human" },
  { name: "post-pr-phase-disabled: unknown-key (record root)", record_id: "post-pr-phase-disabled", family: "unknown-key", target_label: "record root", consumer: "validateRun", rejector: "validatePostPr :: run.post_pr.unexpected_authority_key :: is not allowed" },
  { name: "post-pr-phase-disabled: wrong-schema (schema version)", record_id: "post-pr-phase-disabled", family: "wrong-schema", target_label: "schema version", consumer: "validateRun", rejector: "validatePostPr :: run.post_pr.schema_version :: must equal 1" },
  { name: "post-pr-phase-disabled: wrong-type (typed field)", record_id: "post-pr-phase-disabled", family: "wrong-type", target_label: "typed field", consumer: "validateRun", rejector: "validatePostPr :: run.post_pr.attempt :: must be a non-negative integer" },
  { name: "post-pr-phase-disabled: stale-identity (stale attempt)", record_id: "post-pr-phase-disabled", family: "stale-identity", target_label: "stale attempt", consumer: "transitionPostPrState", rejector: "transitionPostPrState :: Error :: post-PR transition requires enabled persisted post-PR policy" },
  { name: "post-pr-phase-disabled: cross-bound-identity (cross-bound phase)", record_id: "post-pr-phase-disabled", family: "cross-bound-identity", target_label: "cross-bound phase", consumer: "validateRun", rejector: "validatePostPr :: run.post_pr.phase :: disabled policy requires disabled phase" },
  { name: "post-pr-phase-awaiting-pr: missing-key (required field)", record_id: "post-pr-phase-awaiting-pr", family: "missing-key", target_label: "required field", consumer: "validateRun", rejector: "validatePostPr :: run.post_pr.phase :: must be one of disabled, awaiting-pr, observing, failure-recording, remediation-planned, remediation-running, changes-observed, committed, revalidating, validated, push-pending, remote-confirmed, succeeded, blocked, needs-human" },
  { name: "post-pr-phase-awaiting-pr: unknown-key (record root)", record_id: "post-pr-phase-awaiting-pr", family: "unknown-key", target_label: "record root", consumer: "validateRun", rejector: "validatePostPr :: run.post_pr.unexpected_authority_key :: is not allowed" },
  { name: "post-pr-phase-awaiting-pr: wrong-schema (schema version)", record_id: "post-pr-phase-awaiting-pr", family: "wrong-schema", target_label: "schema version", consumer: "validateRun", rejector: "validatePostPr :: run.post_pr.schema_version :: must equal 1" },
  { name: "post-pr-phase-awaiting-pr: wrong-type (typed field)", record_id: "post-pr-phase-awaiting-pr", family: "wrong-type", target_label: "typed field", consumer: "validateRun", rejector: "validatePostPr :: run.post_pr.attempt :: must be a non-negative integer" },
  { name: "post-pr-phase-awaiting-pr: stale-identity (stale attempt)", record_id: "post-pr-phase-awaiting-pr", family: "stale-identity", target_label: "stale attempt", consumer: "transitionPostPrState", rejector: "transitionPostPrState :: Error :: post-PR attempt changes must use transitionPostPrFailure" },
  { name: "post-pr-phase-awaiting-pr: cross-bound-identity (cross-bound phase)", record_id: "post-pr-phase-awaiting-pr", family: "cross-bound-identity", target_label: "cross-bound phase", consumer: "validateRun", rejector: "validatePostPr :: run.post_pr.phase :: enabled policy cannot use disabled phase" },
  { name: "post-pr-phase-observing: missing-key (required field)", record_id: "post-pr-phase-observing", family: "missing-key", target_label: "required field", consumer: "validateRun", rejector: "validatePostPr :: run.post_pr.phase :: must be one of disabled, awaiting-pr, observing, failure-recording, remediation-planned, remediation-running, changes-observed, committed, revalidating, validated, push-pending, remote-confirmed, succeeded, blocked, needs-human" },
  { name: "post-pr-phase-observing: unknown-key (record root)", record_id: "post-pr-phase-observing", family: "unknown-key", target_label: "record root", consumer: "validateRun", rejector: "validatePostPr :: run.post_pr.unexpected_authority_key :: is not allowed" },
  { name: "post-pr-phase-observing: wrong-schema (schema version)", record_id: "post-pr-phase-observing", family: "wrong-schema", target_label: "schema version", consumer: "validateRun", rejector: "validatePostPr :: run.post_pr.schema_version :: must equal 1" },
  { name: "post-pr-phase-observing: wrong-type (typed field)", record_id: "post-pr-phase-observing", family: "wrong-type", target_label: "typed field", consumer: "validateRun", rejector: "validatePostPr :: run.post_pr.attempt :: must be a non-negative integer" },
  { name: "post-pr-phase-observing: stale-identity (stale attempt)", record_id: "post-pr-phase-observing", family: "stale-identity", target_label: "stale attempt", consumer: "transitionPostPrState", rejector: "transitionPostPrState :: Error :: post-PR attempt changes must use transitionPostPrFailure" },
  { name: "post-pr-phase-observing: cross-bound-identity (cross-bound phase)", record_id: "post-pr-phase-observing", family: "cross-bound-identity", target_label: "cross-bound phase", consumer: "validateRun", rejector: "validatePostPr :: run.post_pr.phase :: enabled policy cannot use disabled phase" },
  { name: "post-pr-phase-failure-recording: missing-key (required field)", record_id: "post-pr-phase-failure-recording", family: "missing-key", target_label: "required field", consumer: "validateRun", rejector: "validatePostPr :: run.post_pr.phase :: must be one of disabled, awaiting-pr, observing, failure-recording, remediation-planned, remediation-running, changes-observed, committed, revalidating, validated, push-pending, remote-confirmed, succeeded, blocked, needs-human" },
  { name: "post-pr-phase-failure-recording: unknown-key (record root)", record_id: "post-pr-phase-failure-recording", family: "unknown-key", target_label: "record root", consumer: "validateRun", rejector: "validatePostPr :: run.post_pr.unexpected_authority_key :: is not allowed" },
  { name: "post-pr-phase-failure-recording: wrong-schema (schema version)", record_id: "post-pr-phase-failure-recording", family: "wrong-schema", target_label: "schema version", consumer: "validateRun", rejector: "validatePostPr :: run.post_pr.schema_version :: must equal 1" },
  { name: "post-pr-phase-failure-recording: wrong-type (typed field)", record_id: "post-pr-phase-failure-recording", family: "wrong-type", target_label: "typed field", consumer: "validateRun", rejector: "validatePostPr :: run.post_pr.attempt :: must be a non-negative integer" },
  { name: "post-pr-phase-failure-recording: stale-identity (stale attempt)", record_id: "post-pr-phase-failure-recording", family: "stale-identity", target_label: "stale attempt", consumer: "validateRun", rejector: "validatePostPr :: run.post_pr.remediation.attempt :: must equal run.post_pr.attempt" },
  { name: "post-pr-phase-failure-recording: cross-bound-identity (cross-bound phase)", record_id: "post-pr-phase-failure-recording", family: "cross-bound-identity", target_label: "cross-bound phase", consumer: "validateRun", rejector: "validatePostPr :: run.post_pr.phase :: enabled policy cannot use disabled phase" },
  { name: "post-pr-phase-remediation-planned: missing-key (required field)", record_id: "post-pr-phase-remediation-planned", family: "missing-key", target_label: "required field", consumer: "validateRun", rejector: "validatePostPr :: run.post_pr.phase :: must be one of disabled, awaiting-pr, observing, failure-recording, remediation-planned, remediation-running, changes-observed, committed, revalidating, validated, push-pending, remote-confirmed, succeeded, blocked, needs-human" },
  { name: "post-pr-phase-remediation-planned: unknown-key (record root)", record_id: "post-pr-phase-remediation-planned", family: "unknown-key", target_label: "record root", consumer: "validateRun", rejector: "validatePostPr :: run.post_pr.unexpected_authority_key :: is not allowed" },
  { name: "post-pr-phase-remediation-planned: wrong-schema (schema version)", record_id: "post-pr-phase-remediation-planned", family: "wrong-schema", target_label: "schema version", consumer: "validateRun", rejector: "validatePostPr :: run.post_pr.schema_version :: must equal 1" },
  { name: "post-pr-phase-remediation-planned: wrong-type (typed field)", record_id: "post-pr-phase-remediation-planned", family: "wrong-type", target_label: "typed field", consumer: "validateRun", rejector: "validatePostPr :: run.post_pr.attempt :: must be a non-negative integer" },
  { name: "post-pr-phase-remediation-planned: stale-identity (stale attempt)", record_id: "post-pr-phase-remediation-planned", family: "stale-identity", target_label: "stale attempt", consumer: "validateRun", rejector: "validatePostPr :: run.post_pr.remediation.attempt :: must equal run.post_pr.attempt" },
  { name: "post-pr-phase-remediation-planned: cross-bound-identity (cross-bound phase)", record_id: "post-pr-phase-remediation-planned", family: "cross-bound-identity", target_label: "cross-bound phase", consumer: "validateRun", rejector: "validatePostPr :: run.post_pr.phase :: enabled policy cannot use disabled phase" },
  { name: "post-pr-phase-remediation-running: missing-key (required field)", record_id: "post-pr-phase-remediation-running", family: "missing-key", target_label: "required field", consumer: "validateRun", rejector: "validatePostPr :: run.post_pr.phase :: must be one of disabled, awaiting-pr, observing, failure-recording, remediation-planned, remediation-running, changes-observed, committed, revalidating, validated, push-pending, remote-confirmed, succeeded, blocked, needs-human" },
  { name: "post-pr-phase-remediation-running: unknown-key (record root)", record_id: "post-pr-phase-remediation-running", family: "unknown-key", target_label: "record root", consumer: "validateRun", rejector: "validatePostPr :: run.post_pr.unexpected_authority_key :: is not allowed" },
  { name: "post-pr-phase-remediation-running: wrong-schema (schema version)", record_id: "post-pr-phase-remediation-running", family: "wrong-schema", target_label: "schema version", consumer: "validateRun", rejector: "validatePostPr :: run.post_pr.schema_version :: must equal 1" },
  { name: "post-pr-phase-remediation-running: wrong-type (typed field)", record_id: "post-pr-phase-remediation-running", family: "wrong-type", target_label: "typed field", consumer: "validateRun", rejector: "validatePostPr :: run.post_pr.attempt :: must be a non-negative integer" },
  { name: "post-pr-phase-remediation-running: stale-identity (stale attempt)", record_id: "post-pr-phase-remediation-running", family: "stale-identity", target_label: "stale attempt", consumer: "validateRun", rejector: "validatePostPr :: run.post_pr.remediation.attempt :: must equal run.post_pr.attempt" },
  { name: "post-pr-phase-remediation-running: cross-bound-identity (cross-bound phase)", record_id: "post-pr-phase-remediation-running", family: "cross-bound-identity", target_label: "cross-bound phase", consumer: "validateRun", rejector: "validatePostPr :: run.post_pr.phase :: enabled policy cannot use disabled phase" },
  { name: "post-pr-phase-changes-observed: missing-key (required field)", record_id: "post-pr-phase-changes-observed", family: "missing-key", target_label: "required field", consumer: "validateRun", rejector: "validatePostPr :: run.post_pr.phase :: must be one of disabled, awaiting-pr, observing, failure-recording, remediation-planned, remediation-running, changes-observed, committed, revalidating, validated, push-pending, remote-confirmed, succeeded, blocked, needs-human" },
  { name: "post-pr-phase-changes-observed: unknown-key (record root)", record_id: "post-pr-phase-changes-observed", family: "unknown-key", target_label: "record root", consumer: "validateRun", rejector: "validatePostPr :: run.post_pr.unexpected_authority_key :: is not allowed" },
  { name: "post-pr-phase-changes-observed: wrong-schema (schema version)", record_id: "post-pr-phase-changes-observed", family: "wrong-schema", target_label: "schema version", consumer: "validateRun", rejector: "validatePostPr :: run.post_pr.schema_version :: must equal 1" },
  { name: "post-pr-phase-changes-observed: wrong-type (typed field)", record_id: "post-pr-phase-changes-observed", family: "wrong-type", target_label: "typed field", consumer: "validateRun", rejector: "validatePostPr :: run.post_pr.attempt :: must be a non-negative integer" },
  { name: "post-pr-phase-changes-observed: wrong-ref (remediation ref)", record_id: "post-pr-phase-changes-observed", family: "wrong-ref", target_label: "remediation ref", consumer: "checkRunConsistency", rejector: "checkRunConsistency :: run.post_pr.remediation.remediation_evidence_ref :: run.post_pr.remediation.remediation_evidence_ref :: evidence ref must not contain empty, '.' or '..' path segments" },
  { name: "post-pr-phase-changes-observed: wrong-hash (remediation hash)", record_id: "post-pr-phase-changes-observed", family: "wrong-hash", target_label: "remediation hash", consumer: "checkRunConsistency", rejector: "checkRunConsistency :: run.post_pr.remediation.remediation_evidence_ref :: run.post_pr.remediation.remediation_evidence_ref.hash :: must match referenced file" },
  { name: "post-pr-phase-changes-observed: wrong-bytes (remediation sidecar bytes)", record_id: "post-pr-phase-changes-observed", family: "wrong-bytes", target_label: "remediation sidecar bytes", consumer: "checkRunConsistency", rejector: "checkRunConsistency :: run.post_pr.remediation.remediation_evidence_ref :: run.post_pr.remediation.remediation_evidence_ref.hash :: must match referenced file" },
  { name: "post-pr-phase-changes-observed: stale-identity (stale attempt)", record_id: "post-pr-phase-changes-observed", family: "stale-identity", target_label: "stale attempt", consumer: "validateRun", rejector: "validatePostPr :: run.post_pr.remediation.attempt :: must equal run.post_pr.attempt" },
  { name: "post-pr-phase-changes-observed: stale-identity (stale remediation.candidate_head_sha)", record_id: "post-pr-phase-changes-observed", family: "stale-identity", target_label: "stale remediation.candidate_head_sha", consumer: "transitionPostPrState", rejector: "transitionPostPrState :: Error :: post-PR remediation candidate_head_sha cannot change once bound" },
  { name: "post-pr-phase-changes-observed: cross-bound-identity (cross-bound phase)", record_id: "post-pr-phase-changes-observed", family: "cross-bound-identity", target_label: "cross-bound phase", consumer: "validateRun", rejector: "validatePostPr :: run.post_pr.phase :: enabled policy cannot use disabled phase" },
  { name: "post-pr-phase-changes-observed: cross-bound-identity (cross-bound candidate head)", record_id: "post-pr-phase-changes-observed", family: "cross-bound-identity", target_label: "cross-bound candidate head", consumer: "validateRun", rejector: "validatePostPr :: run.post_pr.remediation.candidate_head_sha :: must differ from failed_head_sha" },
  { name: "post-pr-phase-committed: missing-key (required field)", record_id: "post-pr-phase-committed", family: "missing-key", target_label: "required field", consumer: "validateRun", rejector: "validatePostPr :: run.post_pr.phase :: must be one of disabled, awaiting-pr, observing, failure-recording, remediation-planned, remediation-running, changes-observed, committed, revalidating, validated, push-pending, remote-confirmed, succeeded, blocked, needs-human" },
  { name: "post-pr-phase-committed: unknown-key (record root)", record_id: "post-pr-phase-committed", family: "unknown-key", target_label: "record root", consumer: "validateRun", rejector: "validatePostPr :: run.post_pr.unexpected_authority_key :: is not allowed" },
  { name: "post-pr-phase-committed: wrong-schema (schema version)", record_id: "post-pr-phase-committed", family: "wrong-schema", target_label: "schema version", consumer: "validateRun", rejector: "validatePostPr :: run.post_pr.schema_version :: must equal 1" },
  { name: "post-pr-phase-committed: wrong-type (typed field)", record_id: "post-pr-phase-committed", family: "wrong-type", target_label: "typed field", consumer: "validateRun", rejector: "validatePostPr :: run.post_pr.attempt :: must be a non-negative integer" },
  { name: "post-pr-phase-committed: wrong-ref (remediation ref)", record_id: "post-pr-phase-committed", family: "wrong-ref", target_label: "remediation ref", consumer: "checkRunConsistency", rejector: "checkRunConsistency :: run.post_pr.remediation.remediation_evidence_ref :: run.post_pr.remediation.remediation_evidence_ref :: evidence ref must not contain empty, '.' or '..' path segments" },
  { name: "post-pr-phase-committed: wrong-hash (remediation hash)", record_id: "post-pr-phase-committed", family: "wrong-hash", target_label: "remediation hash", consumer: "checkRunConsistency", rejector: "checkRunConsistency :: run.post_pr.remediation.remediation_evidence_ref :: run.post_pr.remediation.remediation_evidence_ref.hash :: must match referenced file" },
  { name: "post-pr-phase-committed: wrong-bytes (remediation sidecar bytes)", record_id: "post-pr-phase-committed", family: "wrong-bytes", target_label: "remediation sidecar bytes", consumer: "checkRunConsistency", rejector: "checkRunConsistency :: run.post_pr.remediation.remediation_evidence_ref :: run.post_pr.remediation.remediation_evidence_ref.hash :: must match referenced file" },
  { name: "post-pr-phase-committed: stale-identity (stale attempt)", record_id: "post-pr-phase-committed", family: "stale-identity", target_label: "stale attempt", consumer: "validateRun", rejector: "validatePostPr :: run.post_pr.remediation.attempt :: must equal run.post_pr.attempt" },
  { name: "post-pr-phase-committed: stale-identity (stale remediation.candidate_head_sha)", record_id: "post-pr-phase-committed", family: "stale-identity", target_label: "stale remediation.candidate_head_sha", consumer: "transitionPostPrState", rejector: "transitionPostPrState :: Error :: post-PR remediation candidate_head_sha cannot change once bound" },
  { name: "post-pr-phase-committed: cross-bound-identity (cross-bound phase)", record_id: "post-pr-phase-committed", family: "cross-bound-identity", target_label: "cross-bound phase", consumer: "validateRun", rejector: "validatePostPr :: run.post_pr.phase :: enabled policy cannot use disabled phase" },
  { name: "post-pr-phase-committed: cross-bound-identity (cross-bound candidate head)", record_id: "post-pr-phase-committed", family: "cross-bound-identity", target_label: "cross-bound candidate head", consumer: "validateRun", rejector: "validatePostPr :: run.post_pr.remediation.candidate_head_sha :: must differ from failed_head_sha" },
  { name: "post-pr-phase-revalidating: missing-key (required field)", record_id: "post-pr-phase-revalidating", family: "missing-key", target_label: "required field", consumer: "validateRun", rejector: "validatePostPr :: run.post_pr.phase :: must be one of disabled, awaiting-pr, observing, failure-recording, remediation-planned, remediation-running, changes-observed, committed, revalidating, validated, push-pending, remote-confirmed, succeeded, blocked, needs-human" },
  { name: "post-pr-phase-revalidating: unknown-key (record root)", record_id: "post-pr-phase-revalidating", family: "unknown-key", target_label: "record root", consumer: "validateRun", rejector: "validatePostPr :: run.post_pr.unexpected_authority_key :: is not allowed" },
  { name: "post-pr-phase-revalidating: wrong-schema (schema version)", record_id: "post-pr-phase-revalidating", family: "wrong-schema", target_label: "schema version", consumer: "validateRun", rejector: "validatePostPr :: run.post_pr.schema_version :: must equal 1" },
  { name: "post-pr-phase-revalidating: wrong-type (typed field)", record_id: "post-pr-phase-revalidating", family: "wrong-type", target_label: "typed field", consumer: "validateRun", rejector: "validatePostPr :: run.post_pr.attempt :: must be a non-negative integer" },
  { name: "post-pr-phase-revalidating: wrong-ref (remediation ref)", record_id: "post-pr-phase-revalidating", family: "wrong-ref", target_label: "remediation ref", consumer: "checkRunConsistency", rejector: "checkRunConsistency :: run.post_pr.remediation.remediation_evidence_ref :: run.post_pr.remediation.remediation_evidence_ref :: evidence ref must not contain empty, '.' or '..' path segments" },
  { name: "post-pr-phase-revalidating: wrong-hash (remediation hash)", record_id: "post-pr-phase-revalidating", family: "wrong-hash", target_label: "remediation hash", consumer: "checkRunConsistency", rejector: "checkRunConsistency :: run.post_pr.remediation.remediation_evidence_ref :: run.post_pr.remediation.remediation_evidence_ref.hash :: must match referenced file" },
  { name: "post-pr-phase-revalidating: wrong-bytes (remediation sidecar bytes)", record_id: "post-pr-phase-revalidating", family: "wrong-bytes", target_label: "remediation sidecar bytes", consumer: "checkRunConsistency", rejector: "checkRunConsistency :: run.post_pr.remediation.remediation_evidence_ref :: run.post_pr.remediation.remediation_evidence_ref.hash :: must match referenced file" },
  { name: "post-pr-phase-revalidating: stale-identity (stale attempt)", record_id: "post-pr-phase-revalidating", family: "stale-identity", target_label: "stale attempt", consumer: "validateRun", rejector: "validatePostPr :: run.post_pr.remediation.attempt :: must equal run.post_pr.attempt" },
  { name: "post-pr-phase-revalidating: stale-identity (stale remediation.candidate_head_sha)", record_id: "post-pr-phase-revalidating", family: "stale-identity", target_label: "stale remediation.candidate_head_sha", consumer: "transitionPostPrState", rejector: "transitionPostPrState :: Error :: post-PR remediation candidate_head_sha cannot change once bound" },
  { name: "post-pr-phase-revalidating: cross-bound-identity (cross-bound phase)", record_id: "post-pr-phase-revalidating", family: "cross-bound-identity", target_label: "cross-bound phase", consumer: "validateRun", rejector: "validatePostPr :: run.post_pr.phase :: enabled policy cannot use disabled phase" },
  { name: "post-pr-phase-revalidating: cross-bound-identity (cross-bound candidate head)", record_id: "post-pr-phase-revalidating", family: "cross-bound-identity", target_label: "cross-bound candidate head", consumer: "validateRun", rejector: "validatePostPr :: run.post_pr.remediation.candidate_head_sha :: must differ from failed_head_sha" },
  { name: "post-pr-phase-validated: missing-key (required field)", record_id: "post-pr-phase-validated", family: "missing-key", target_label: "required field", consumer: "validateRun", rejector: "validatePostPr :: run.post_pr.phase :: must be one of disabled, awaiting-pr, observing, failure-recording, remediation-planned, remediation-running, changes-observed, committed, revalidating, validated, push-pending, remote-confirmed, succeeded, blocked, needs-human" },
  { name: "post-pr-phase-validated: unknown-key (record root)", record_id: "post-pr-phase-validated", family: "unknown-key", target_label: "record root", consumer: "validateRun", rejector: "validatePostPr :: run.post_pr.unexpected_authority_key :: is not allowed" },
  { name: "post-pr-phase-validated: wrong-schema (schema version)", record_id: "post-pr-phase-validated", family: "wrong-schema", target_label: "schema version", consumer: "validateRun", rejector: "validatePostPr :: run.post_pr.schema_version :: must equal 1" },
  { name: "post-pr-phase-validated: wrong-type (typed field)", record_id: "post-pr-phase-validated", family: "wrong-type", target_label: "typed field", consumer: "validateRun", rejector: "validatePostPr :: run.post_pr.attempt :: must be a non-negative integer" },
  { name: "post-pr-phase-validated: wrong-ref (remediation ref)", record_id: "post-pr-phase-validated", family: "wrong-ref", target_label: "remediation ref", consumer: "checkRunConsistency", rejector: "checkRunConsistency :: run.post_pr.remediation.remediation_evidence_ref :: run.post_pr.remediation.remediation_evidence_ref :: evidence ref must not contain empty, '.' or '..' path segments" },
  { name: "post-pr-phase-validated: wrong-hash (remediation hash)", record_id: "post-pr-phase-validated", family: "wrong-hash", target_label: "remediation hash", consumer: "checkRunConsistency", rejector: "checkRunConsistency :: run.post_pr.remediation.remediation_evidence_ref :: run.post_pr.remediation.remediation_evidence_ref.hash :: must match referenced file" },
  { name: "post-pr-phase-validated: wrong-bytes (remediation sidecar bytes)", record_id: "post-pr-phase-validated", family: "wrong-bytes", target_label: "remediation sidecar bytes", consumer: "checkRunConsistency", rejector: "checkRunConsistency :: run.post_pr.remediation.remediation_evidence_ref :: run.post_pr.remediation.remediation_evidence_ref.hash :: must match referenced file" },
  { name: "post-pr-phase-validated: stale-identity (stale attempt)", record_id: "post-pr-phase-validated", family: "stale-identity", target_label: "stale attempt", consumer: "validateRun", rejector: "validatePostPr :: run.post_pr.remediation.attempt :: must equal run.post_pr.attempt" },
  { name: "post-pr-phase-validated: stale-identity (stale remediation.candidate_head_sha)", record_id: "post-pr-phase-validated", family: "stale-identity", target_label: "stale remediation.candidate_head_sha", consumer: "transitionPostPrState", rejector: "transitionPostPrState :: Error :: post-PR remediation candidate_head_sha cannot change once bound" },
  { name: "post-pr-phase-validated: cross-bound-identity (cross-bound phase)", record_id: "post-pr-phase-validated", family: "cross-bound-identity", target_label: "cross-bound phase", consumer: "validateRun", rejector: "validatePostPr :: run.post_pr.phase :: enabled policy cannot use disabled phase" },
  { name: "post-pr-phase-validated: cross-bound-identity (cross-bound candidate head)", record_id: "post-pr-phase-validated", family: "cross-bound-identity", target_label: "cross-bound candidate head", consumer: "validateRun", rejector: "validatePostPr :: run.post_pr.remediation.candidate_head_sha :: must differ from failed_head_sha" },
  { name: "post-pr-phase-push-pending: missing-key (required field)", record_id: "post-pr-phase-push-pending", family: "missing-key", target_label: "required field", consumer: "validateRun", rejector: "validatePostPr :: run.post_pr.phase :: must be one of disabled, awaiting-pr, observing, failure-recording, remediation-planned, remediation-running, changes-observed, committed, revalidating, validated, push-pending, remote-confirmed, succeeded, blocked, needs-human" },
  { name: "post-pr-phase-push-pending: unknown-key (record root)", record_id: "post-pr-phase-push-pending", family: "unknown-key", target_label: "record root", consumer: "validateRun", rejector: "validatePostPr :: run.post_pr.unexpected_authority_key :: is not allowed" },
  { name: "post-pr-phase-push-pending: wrong-schema (schema version)", record_id: "post-pr-phase-push-pending", family: "wrong-schema", target_label: "schema version", consumer: "validateRun", rejector: "validatePostPr :: run.post_pr.schema_version :: must equal 1" },
  { name: "post-pr-phase-push-pending: wrong-type (typed field)", record_id: "post-pr-phase-push-pending", family: "wrong-type", target_label: "typed field", consumer: "validateRun", rejector: "validatePostPr :: run.post_pr.attempt :: must be a non-negative integer" },
  { name: "post-pr-phase-push-pending: wrong-ref (remediation ref)", record_id: "post-pr-phase-push-pending", family: "wrong-ref", target_label: "remediation ref", consumer: "checkRunConsistency", rejector: "checkRunConsistency :: run.post_pr.remediation.remediation_evidence_ref :: run.post_pr.remediation.remediation_evidence_ref :: evidence ref must not contain empty, '.' or '..' path segments" },
  { name: "post-pr-phase-push-pending: wrong-hash (remediation hash)", record_id: "post-pr-phase-push-pending", family: "wrong-hash", target_label: "remediation hash", consumer: "checkRunConsistency", rejector: "checkRunConsistency :: run.post_pr.remediation.remediation_evidence_ref :: run.post_pr.remediation.remediation_evidence_ref.hash :: must match referenced file" },
  { name: "post-pr-phase-push-pending: wrong-bytes (remediation sidecar bytes)", record_id: "post-pr-phase-push-pending", family: "wrong-bytes", target_label: "remediation sidecar bytes", consumer: "checkRunConsistency", rejector: "checkRunConsistency :: run.post_pr.remediation.remediation_evidence_ref :: run.post_pr.remediation.remediation_evidence_ref.hash :: must match referenced file" },
  { name: "post-pr-phase-push-pending: stale-identity (stale attempt)", record_id: "post-pr-phase-push-pending", family: "stale-identity", target_label: "stale attempt", consumer: "validateRun", rejector: "validatePostPr :: run.post_pr.remediation.attempt :: must equal run.post_pr.attempt" },
  { name: "post-pr-phase-push-pending: stale-identity (stale remediation.candidate_head_sha)", record_id: "post-pr-phase-push-pending", family: "stale-identity", target_label: "stale remediation.candidate_head_sha", consumer: "validateRun", rejector: "validatePostPr :: run.post_pr.remediation.push.local_head_sha :: must equal candidate_head_sha while push is pending" },
  { name: "post-pr-phase-push-pending: cross-bound-identity (cross-bound phase)", record_id: "post-pr-phase-push-pending", family: "cross-bound-identity", target_label: "cross-bound phase", consumer: "validateRun", rejector: "validatePostPr :: run.post_pr.phase :: enabled policy cannot use disabled phase" },
  { name: "post-pr-phase-push-pending: cross-bound-identity (cross-bound candidate head)", record_id: "post-pr-phase-push-pending", family: "cross-bound-identity", target_label: "cross-bound candidate head", consumer: "validateRun", rejector: "validatePostPr :: run.post_pr.remediation.candidate_head_sha :: must differ from failed_head_sha" },
  { name: "post-pr-phase-remote-confirmed: missing-key (required field)", record_id: "post-pr-phase-remote-confirmed", family: "missing-key", target_label: "required field", consumer: "validateRun", rejector: "validatePostPr :: run.post_pr.phase :: must be one of disabled, awaiting-pr, observing, failure-recording, remediation-planned, remediation-running, changes-observed, committed, revalidating, validated, push-pending, remote-confirmed, succeeded, blocked, needs-human" },
  { name: "post-pr-phase-remote-confirmed: unknown-key (record root)", record_id: "post-pr-phase-remote-confirmed", family: "unknown-key", target_label: "record root", consumer: "validateRun", rejector: "validatePostPr :: run.post_pr.unexpected_authority_key :: is not allowed" },
  { name: "post-pr-phase-remote-confirmed: wrong-schema (schema version)", record_id: "post-pr-phase-remote-confirmed", family: "wrong-schema", target_label: "schema version", consumer: "validateRun", rejector: "validatePostPr :: run.post_pr.schema_version :: must equal 1" },
  { name: "post-pr-phase-remote-confirmed: wrong-type (typed field)", record_id: "post-pr-phase-remote-confirmed", family: "wrong-type", target_label: "typed field", consumer: "validateRun", rejector: "validatePostPr :: run.post_pr.attempt :: must be a non-negative integer" },
  { name: "post-pr-phase-remote-confirmed: wrong-ref (remediation ref)", record_id: "post-pr-phase-remote-confirmed", family: "wrong-ref", target_label: "remediation ref", consumer: "checkRunConsistency", rejector: "checkRunConsistency :: run.post_pr.remediation.remediation_evidence_ref :: run.post_pr.remediation.remediation_evidence_ref :: evidence ref must not contain empty, '.' or '..' path segments" },
  { name: "post-pr-phase-remote-confirmed: wrong-hash (remediation hash)", record_id: "post-pr-phase-remote-confirmed", family: "wrong-hash", target_label: "remediation hash", consumer: "checkRunConsistency", rejector: "checkRunConsistency :: run.post_pr.remediation.remediation_evidence_ref :: run.post_pr.remediation.remediation_evidence_ref.hash :: must match referenced file" },
  { name: "post-pr-phase-remote-confirmed: wrong-bytes (remediation sidecar bytes)", record_id: "post-pr-phase-remote-confirmed", family: "wrong-bytes", target_label: "remediation sidecar bytes", consumer: "checkRunConsistency", rejector: "checkRunConsistency :: run.post_pr.remediation.remediation_evidence_ref :: run.post_pr.remediation.remediation_evidence_ref.hash :: must match referenced file" },
  { name: "post-pr-phase-remote-confirmed: stale-identity (stale attempt)", record_id: "post-pr-phase-remote-confirmed", family: "stale-identity", target_label: "stale attempt", consumer: "validateRun", rejector: "validatePostPr :: run.post_pr.remediation.attempt :: must equal run.post_pr.attempt" },
  { name: "post-pr-phase-remote-confirmed: stale-identity (stale remediation.candidate_head_sha)", record_id: "post-pr-phase-remote-confirmed", family: "stale-identity", target_label: "stale remediation.candidate_head_sha", consumer: "validateRun", rejector: "validatePostPr :: run.post_pr.remediation.push :: remote-confirmed requires confirmed remote_after_sha equal to candidate_head_sha" },
  { name: "post-pr-phase-remote-confirmed: cross-bound-identity (cross-bound phase)", record_id: "post-pr-phase-remote-confirmed", family: "cross-bound-identity", target_label: "cross-bound phase", consumer: "validateRun", rejector: "validatePostPr :: run.post_pr.phase :: enabled policy cannot use disabled phase" },
  { name: "post-pr-phase-remote-confirmed: cross-bound-identity (cross-bound candidate head)", record_id: "post-pr-phase-remote-confirmed", family: "cross-bound-identity", target_label: "cross-bound candidate head", consumer: "validateRun", rejector: "validatePostPr :: run.post_pr.remediation.candidate_head_sha :: must differ from failed_head_sha" },
  { name: "post-pr-phase-succeeded: missing-key (required field)", record_id: "post-pr-phase-succeeded", family: "missing-key", target_label: "required field", consumer: "validateRun", rejector: "validatePostPr :: run.post_pr.phase :: must be one of disabled, awaiting-pr, observing, failure-recording, remediation-planned, remediation-running, changes-observed, committed, revalidating, validated, push-pending, remote-confirmed, succeeded, blocked, needs-human" },
  { name: "post-pr-phase-succeeded: unknown-key (record root)", record_id: "post-pr-phase-succeeded", family: "unknown-key", target_label: "record root", consumer: "validateRun", rejector: "validatePostPr :: run.post_pr.unexpected_authority_key :: is not allowed" },
  { name: "post-pr-phase-succeeded: wrong-schema (schema version)", record_id: "post-pr-phase-succeeded", family: "wrong-schema", target_label: "schema version", consumer: "validateRun", rejector: "validatePostPr :: run.post_pr.schema_version :: must equal 1" },
  { name: "post-pr-phase-succeeded: wrong-type (typed field)", record_id: "post-pr-phase-succeeded", family: "wrong-type", target_label: "typed field", consumer: "validateRun", rejector: "validatePostPr :: run.post_pr.attempt :: must be a non-negative integer" },
  { name: "post-pr-phase-succeeded: stale-identity (stale attempt)", record_id: "post-pr-phase-succeeded", family: "stale-identity", target_label: "stale attempt", consumer: "transitionPostPrState", rejector: "transitionPostPrState :: Error :: post-PR transition rejected: terminal run 'completed'" },
  { name: "post-pr-phase-succeeded: cross-bound-identity (cross-bound phase)", record_id: "post-pr-phase-succeeded", family: "cross-bound-identity", target_label: "cross-bound phase", consumer: "validateRun", rejector: "validatePostPr :: run.post_pr.phase :: enabled policy cannot use disabled phase" },
  { name: "post-pr-phase-blocked: missing-key (required field)", record_id: "post-pr-phase-blocked", family: "missing-key", target_label: "required field", consumer: "validateRun", rejector: "validatePostPr :: run.post_pr.phase :: must be one of disabled, awaiting-pr, observing, failure-recording, remediation-planned, remediation-running, changes-observed, committed, revalidating, validated, push-pending, remote-confirmed, succeeded, blocked, needs-human" },
  { name: "post-pr-phase-blocked: unknown-key (record root)", record_id: "post-pr-phase-blocked", family: "unknown-key", target_label: "record root", consumer: "validateRun", rejector: "validatePostPr :: run.post_pr.unexpected_authority_key :: is not allowed" },
  { name: "post-pr-phase-blocked: wrong-schema (schema version)", record_id: "post-pr-phase-blocked", family: "wrong-schema", target_label: "schema version", consumer: "validateRun", rejector: "validatePostPr :: run.post_pr.schema_version :: must equal 1" },
  { name: "post-pr-phase-blocked: wrong-type (typed field)", record_id: "post-pr-phase-blocked", family: "wrong-type", target_label: "typed field", consumer: "validateRun", rejector: "validatePostPr :: run.post_pr.attempt :: must be a non-negative integer" },
  { name: "post-pr-phase-blocked: stale-identity (stale attempt)", record_id: "post-pr-phase-blocked", family: "stale-identity", target_label: "stale attempt", consumer: "transitionPostPrState", rejector: "transitionPostPrState :: Error :: post-PR transition rejected: terminal run 'blocked'" },
  { name: "post-pr-phase-blocked: cross-bound-identity (cross-bound phase)", record_id: "post-pr-phase-blocked", family: "cross-bound-identity", target_label: "cross-bound phase", consumer: "validateRun", rejector: "validatePostPr :: run.post_pr.phase :: enabled policy cannot use disabled phase" },
  { name: "post-pr-phase-needs-human: missing-key (required field)", record_id: "post-pr-phase-needs-human", family: "missing-key", target_label: "required field", consumer: "validateRun", rejector: "validatePostPr :: run.post_pr.phase :: must be one of disabled, awaiting-pr, observing, failure-recording, remediation-planned, remediation-running, changes-observed, committed, revalidating, validated, push-pending, remote-confirmed, succeeded, blocked, needs-human" },
  { name: "post-pr-phase-needs-human: unknown-key (record root)", record_id: "post-pr-phase-needs-human", family: "unknown-key", target_label: "record root", consumer: "validateRun", rejector: "validatePostPr :: run.post_pr.unexpected_authority_key :: is not allowed" },
  { name: "post-pr-phase-needs-human: wrong-schema (schema version)", record_id: "post-pr-phase-needs-human", family: "wrong-schema", target_label: "schema version", consumer: "validateRun", rejector: "validatePostPr :: run.post_pr.schema_version :: must equal 1" },
  { name: "post-pr-phase-needs-human: wrong-type (typed field)", record_id: "post-pr-phase-needs-human", family: "wrong-type", target_label: "typed field", consumer: "validateRun", rejector: "validatePostPr :: run.post_pr.attempt :: must be a non-negative integer" },
  { name: "post-pr-phase-needs-human: stale-identity (stale attempt)", record_id: "post-pr-phase-needs-human", family: "stale-identity", target_label: "stale attempt", consumer: "transitionPostPrState", rejector: "transitionPostPrState :: Error :: post-PR transition rejected: terminal run 'needs-human'" },
  { name: "post-pr-phase-needs-human: cross-bound-identity (cross-bound phase)", record_id: "post-pr-phase-needs-human", family: "cross-bound-identity", target_label: "cross-bound phase", consumer: "validateRun", rejector: "validatePostPr :: run.post_pr.phase :: enabled policy cannot use disabled phase" },
  { name: "post-pr-policy-disabled: missing-key (required field)", record_id: "post-pr-policy-disabled", family: "missing-key", target_label: "required field", consumer: "validateRun", rejector: "validatePostPr :: run.post_pr.policy.enabled :: must be a boolean" },
  { name: "post-pr-policy-disabled: unknown-key (record root)", record_id: "post-pr-policy-disabled", family: "unknown-key", target_label: "record root", consumer: "validateRun", rejector: "validatePostPr :: run.post_pr.policy.unexpected_authority_key :: is not allowed" },
  { name: "post-pr-policy-disabled: wrong-type (typed field)", record_id: "post-pr-policy-disabled", family: "wrong-type", target_label: "typed field", consumer: "validateRun", rejector: "validatePostPr :: run.post_pr.policy.wait_ms :: must be an integer from 1800000 to 86400000" },
  { name: "post-pr-policy-disabled: descriptor-key-shape-drift (reviewer_login renamed)", record_id: "post-pr-policy-disabled", family: "descriptor-key-shape-drift", target_label: "reviewer_login renamed", consumer: "validateRun", rejector: "validatePostPr :: run.post_pr.policy.review.login :: is not allowed" },
  { name: "post-pr-policy-disabled: stale-identity (stale max_transient_errors)", record_id: "post-pr-policy-disabled", family: "stale-identity", target_label: "stale max_transient_errors", consumer: "transitionPostPrState", rejector: "transitionPostPrState :: Error :: post-PR transition requires enabled persisted post-PR policy" },
  { name: "post-pr-policy-disabled: cross-bound-identity (cross-bound review.required)", record_id: "post-pr-policy-disabled", family: "cross-bound-identity", target_label: "cross-bound review.required", consumer: "validateRun", rejector: "validatePostPr :: run.post_pr.policy.review.reviewer_login :: must be a non-empty string" },
  { name: "post-pr-policy-enabled: missing-key (required field)", record_id: "post-pr-policy-enabled", family: "missing-key", target_label: "required field", consumer: "validateRun", rejector: "validatePostPr :: run.post_pr.policy.enabled :: must be a boolean" },
  { name: "post-pr-policy-enabled: unknown-key (record root)", record_id: "post-pr-policy-enabled", family: "unknown-key", target_label: "record root", consumer: "validateRun", rejector: "validatePostPr :: run.post_pr.policy.unexpected_authority_key :: is not allowed" },
  { name: "post-pr-policy-enabled: wrong-type (typed field)", record_id: "post-pr-policy-enabled", family: "wrong-type", target_label: "typed field", consumer: "validateRun", rejector: "validatePostPr :: run.post_pr.policy.wait_ms :: must be an integer from 1800000 to 86400000" },
  { name: "post-pr-policy-enabled: descriptor-key-shape-drift (reviewer_login renamed)", record_id: "post-pr-policy-enabled", family: "descriptor-key-shape-drift", target_label: "reviewer_login renamed", consumer: "validateRun", rejector: "validatePostPr :: run.post_pr.policy.review.login :: is not allowed" },
  { name: "post-pr-policy-enabled: stale-identity (stale max_transient_errors)", record_id: "post-pr-policy-enabled", family: "stale-identity", target_label: "stale max_transient_errors", consumer: "transitionPostPrState", rejector: "transitionPostPrState :: Error :: persisted post-PR schema and policy are immutable" },
  { name: "post-pr-policy-enabled: cross-bound-identity (cross-bound review.required)", record_id: "post-pr-policy-enabled", family: "cross-bound-identity", target_label: "cross-bound review.required", consumer: "validateRun", rejector: "validatePostPr :: run.post_pr.policy.review.reviewer_login :: must be null when review is not required" },
  { name: "post-pr-observation-null: missing-key (required field)", record_id: "post-pr-observation-null", family: "missing-key", target_label: "required field", consumer: "transitionPostPrState", rejector: "transitionPostPrState :: ValidationError :: run.post_pr.observation: is required, using null when unbound" },
  { name: "post-pr-observation-null: unknown-key (record root)", record_id: "post-pr-observation-null", family: "unknown-key", target_label: "record root", consumer: "validateRun", rejector: "validatePostPr :: run.post_pr.unexpected_authority_key :: is not allowed" },
  { name: "post-pr-observation-null: wrong-type (typed field)", record_id: "post-pr-observation-null", family: "wrong-type", target_label: "typed field", consumer: "validateRun", rejector: "validatePostPr :: run.post_pr.observation.epoch :: must be an integer from 1 to 9007199254740991" },
  { name: "post-pr-observation-null: stale-identity (stale phase)", record_id: "post-pr-observation-null", family: "stale-identity", target_label: "stale phase", consumer: "validateRun", rejector: "validatePostPr :: run.pr_url :: is required while post-PR phase is observing" },
  { name: "post-pr-observation-null: cross-bound-identity (cross-bound observation)", record_id: "post-pr-observation-null", family: "cross-bound-identity", target_label: "cross-bound observation", consumer: "validateRun", rejector: "validatePostPr :: run.post_pr.observation.from_other_attempt :: is not allowed" },
  { name: "post-pr-observation-active: missing-key (required field)", record_id: "post-pr-observation-active", family: "missing-key", target_label: "required field", consumer: "validateRun", rejector: "validatePostPr :: run.post_pr.observation.epoch :: must be an integer from 1 to 9007199254740991" },
  { name: "post-pr-observation-active: unknown-key (record root)", record_id: "post-pr-observation-active", family: "unknown-key", target_label: "record root", consumer: "validateRun", rejector: "validatePostPr :: run.post_pr.observation.unexpected_authority_key :: is not allowed" },
  { name: "post-pr-observation-active: wrong-time (timestamp started_at)", record_id: "post-pr-observation-active", family: "wrong-time", target_label: "timestamp started_at", consumer: "transitionPostPrState", rejector: "transitionPostPrState :: Error :: post-PR observation started_at is immutable within an epoch" },
  { name: "post-pr-observation-active: wrong-type (typed field)", record_id: "post-pr-observation-active", family: "wrong-type", target_label: "typed field", consumer: "validateRun", rejector: "validatePostPr :: run.post_pr.observation.poll_count :: must be an integer from 0 to 9007199254740991" },
  { name: "post-pr-observation-active: descriptor-key-shape-drift (expected_head_sha renamed)", record_id: "post-pr-observation-active", family: "descriptor-key-shape-drift", target_label: "expected_head_sha renamed", consumer: "validateRun", rejector: "validatePostPr :: run.post_pr.observation.head_sha :: is not allowed" },
  { name: "post-pr-observation-active: stale-identity (stale epoch)", record_id: "post-pr-observation-active", family: "stale-identity", target_label: "stale epoch", consumer: "validateRun", rejector: "validatePostPr :: run.post_pr.observation.epoch :: must be an integer from 1 to 9007199254740991" },
  { name: "post-pr-observation-active: cross-bound-identity (cross-bound expected_head_sha)", record_id: "post-pr-observation-active", family: "cross-bound-identity", target_label: "cross-bound expected_head_sha", consumer: "transitionPostPrState", rejector: "transitionPostPrState :: Error :: post-PR observation expected_head_sha is immutable within an epoch" },
  { name: "post-pr-observation-last-error: missing-key (required field)", record_id: "post-pr-observation-last-error", family: "missing-key", target_label: "required field", consumer: "validateRun", rejector: "validatePostPr :: run.post_pr.observation.last_error.class :: must be one of timeout, network, rate-limit, server, account-auth, permission, not-found, protocol, command" },
  { name: "post-pr-observation-last-error: unknown-key (record root)", record_id: "post-pr-observation-last-error", family: "unknown-key", target_label: "record root", consumer: "validateRun", rejector: "validatePostPr :: run.post_pr.observation.last_error.unexpected_authority_key :: is not allowed" },
  { name: "post-pr-observation-last-error: wrong-time (timestamp occurred_at)", record_id: "post-pr-observation-last-error", family: "wrong-time", target_label: "timestamp occurred_at", consumer: "transitionPostPrState", rejector: "transitionPostPrState :: Error :: post-PR observation result changes must advance poll_count" },
  { name: "post-pr-observation-last-error: wrong-type (typed field)", record_id: "post-pr-observation-last-error", family: "wrong-type", target_label: "typed field", consumer: "validateRun", rejector: "validatePostPr :: run.post_pr.observation.last_error.exit_code :: must be a non-negative integer" },
  { name: "post-pr-observation-last-error: stale-identity (stale next_retry_at)", record_id: "post-pr-observation-last-error", family: "stale-identity", target_label: "stale next_retry_at", consumer: "transitionPostPrState", rejector: "transitionPostPrState :: Error :: post-PR observation result changes must advance poll_count" },
  { name: "post-pr-observation-last-error: cross-bound-identity (cross-bound class)", record_id: "post-pr-observation-last-error", family: "cross-bound-identity", target_label: "cross-bound class", consumer: "transitionPostPrState", rejector: "transitionPostPrState :: Error :: post-PR observation result changes must advance poll_count" },
  { name: "post-pr-observation-review-request: missing-key (required field)", record_id: "post-pr-observation-review-request", family: "missing-key", target_label: "required field", consumer: "validateRun", rejector: "validatePostPr :: run.post_pr.observation.review_request.status :: must be one of pending, requested" },
  { name: "post-pr-observation-review-request: unknown-key (record root)", record_id: "post-pr-observation-review-request", family: "unknown-key", target_label: "record root", consumer: "validateRun", rejector: "validatePostPr :: run.post_pr.observation.review_request.unexpected_authority_key :: is not allowed" },
  { name: "post-pr-observation-review-request: wrong-time (timestamp requested_at)", record_id: "post-pr-observation-review-request", family: "wrong-time", target_label: "timestamp requested_at", consumer: "transitionPostPrState", rejector: "transitionPostPrState :: Error :: post-PR reviewer requested_at cannot change once bound" },
  { name: "post-pr-observation-review-request: wrong-type (typed field)", record_id: "post-pr-observation-review-request", family: "wrong-type", target_label: "typed field", consumer: "validateRun", rejector: "validatePostPr :: run.post_pr.observation.review_request.attempts :: must be an integer from 0 to 9007199254740991" },
  { name: "post-pr-observation-review-request: stale-identity (stale attempts)", record_id: "post-pr-observation-review-request", family: "stale-identity", target_label: "stale attempts", consumer: "transitionPostPrState", rejector: "transitionPostPrState :: Error :: post-PR reviewer request attempts cannot decrease" },
  { name: "post-pr-observation-review-request: cross-bound-identity (cross-bound status)", record_id: "post-pr-observation-review-request", family: "cross-bound-identity", target_label: "cross-bound status", consumer: "transitionPostPrState", rejector: "transitionPostPrState :: Error :: post-PR reviewer request status cannot move backwards" },
  { name: "post-pr-observation-snapshot: missing-key (required field)", record_id: "post-pr-observation-snapshot", family: "missing-key", target_label: "required field", consumer: "transitionPostPrState", rejector: "transitionPostPrState :: Error :: post-PR observation result changes must advance poll_count" },
  { name: "post-pr-observation-snapshot: unknown-key (record root)", record_id: "post-pr-observation-snapshot", family: "unknown-key", target_label: "record root", consumer: "transitionPostPrState", rejector: "transitionPostPrState :: Error :: post-PR observation result changes must advance poll_count" },
  { name: "post-pr-observation-snapshot: wrong-type (typed field)", record_id: "post-pr-observation-snapshot", family: "wrong-type", target_label: "typed field", consumer: "transitionPostPrState", rejector: "transitionPostPrState :: Error :: post-PR observation result changes must advance poll_count" },
  { name: "post-pr-observation-snapshot: descriptor-key-shape-drift (checks renamed)", record_id: "post-pr-observation-snapshot", family: "descriptor-key-shape-drift", target_label: "checks renamed", consumer: "transitionPostPrState", rejector: "transitionPostPrState :: Error :: post-PR observation result changes must advance poll_count" },
  { name: "post-pr-observation-snapshot: stale-identity (stale checks.0.verdict)", record_id: "post-pr-observation-snapshot", family: "stale-identity", target_label: "stale checks.0.verdict", consumer: "transitionPostPrState", rejector: "transitionPostPrState :: Error :: post-PR observation result changes must advance poll_count" },
  { name: "post-pr-observation-snapshot: cross-bound-identity (cross-bound reviews.0.login)", record_id: "post-pr-observation-snapshot", family: "cross-bound-identity", target_label: "cross-bound reviews.0.login", consumer: "transitionPostPrState", rejector: "transitionPostPrState :: Error :: post-PR observation result changes must advance poll_count" },
  { name: "post-pr-remediation-null: missing-key (required field)", record_id: "post-pr-remediation-null", family: "missing-key", target_label: "required field", consumer: "transitionPostPrState", rejector: "transitionPostPrState :: ValidationError :: run.post_pr.remediation: is required, using null when unbound" },
  { name: "post-pr-remediation-null: unknown-key (record root)", record_id: "post-pr-remediation-null", family: "unknown-key", target_label: "record root", consumer: "validateRun", rejector: "validatePostPr :: run.post_pr.unexpected_authority_key :: is not allowed" },
  { name: "post-pr-remediation-null: wrong-type (typed field)", record_id: "post-pr-remediation-null", family: "wrong-type", target_label: "typed field", consumer: "validateRun", rejector: "validatePostPr :: run.post_pr.remediation.schema_version :: must be a non-negative integer" },
  { name: "post-pr-remediation-null: stale-identity (stale phase)", record_id: "post-pr-remediation-null", family: "stale-identity", target_label: "stale phase", consumer: "transitionPostPrState", rejector: "transitionPostPrState :: Error :: invalid post-PR phase transition 'observing' -> 'awaiting-pr'" },
  { name: "post-pr-remediation-null: cross-bound-identity (cross-bound remediation)", record_id: "post-pr-remediation-null", family: "cross-bound-identity", target_label: "cross-bound remediation", consumer: "validateRun", rejector: "validatePostPr :: run.post_pr.remediation.from_other_attempt :: is not allowed" },
  { name: "post-pr-remediation-active: missing-key (required field)", record_id: "post-pr-remediation-active", family: "missing-key", target_label: "required field", consumer: "validateRun", rejector: "validatePostPr :: run.post_pr.remediation.attempt :: must be an integer from 1 to 9007199254740991" },
  { name: "post-pr-remediation-active: unknown-key (record root)", record_id: "post-pr-remediation-active", family: "unknown-key", target_label: "record root", consumer: "validateRun", rejector: "validatePostPr :: run.post_pr.remediation.unexpected_authority_key :: is not allowed" },
  { name: "post-pr-remediation-active: wrong-schema (schema version)", record_id: "post-pr-remediation-active", family: "wrong-schema", target_label: "schema version", consumer: "validateRun", rejector: "validatePostPr :: run.post_pr.remediation.schema_version :: must equal 1" },
  { name: "post-pr-remediation-active: wrong-kind (kind)", record_id: "post-pr-remediation-active", family: "wrong-kind", target_label: "kind", consumer: "validateRun", rejector: "validatePostPr :: run.post_pr.remediation.owner.kind :: must be one of slice, integration" },
  { name: "post-pr-remediation-active: wrong-type (typed field)", record_id: "post-pr-remediation-active", family: "wrong-type", target_label: "typed field", consumer: "validateRun", rejector: "validatePostPr :: run.post_pr.remediation.owner :: must be an object" },
  { name: "post-pr-remediation-active: wrong-ref (failure-evidence ref)", record_id: "post-pr-remediation-active", family: "wrong-ref", target_label: "failure-evidence ref", consumer: "validateRun", rejector: "validatePostPr :: run.post_pr.evidence_refs :: must bind the current failure evidence ref/hash" },
  { name: "post-pr-remediation-active: wrong-ref (remediation ref)", record_id: "post-pr-remediation-active", family: "wrong-ref", target_label: "remediation ref", consumer: "checkRunConsistency", rejector: "checkRunConsistency :: run.post_pr.remediation.remediation_evidence_ref :: run.post_pr.remediation.remediation_evidence_ref :: evidence ref must not contain empty, '.' or '..' path segments" },
  { name: "post-pr-remediation-active: wrong-hash (failure-evidence hash)", record_id: "post-pr-remediation-active", family: "wrong-hash", target_label: "failure-evidence hash", consumer: "validateRun", rejector: "validatePostPr :: run.post_pr.evidence_refs :: must bind the current failure evidence ref/hash" },
  { name: "post-pr-remediation-active: wrong-hash (remediation hash)", record_id: "post-pr-remediation-active", family: "wrong-hash", target_label: "remediation hash", consumer: "checkRunConsistency", rejector: "checkRunConsistency :: run.post_pr.remediation.remediation_evidence_ref :: run.post_pr.remediation.remediation_evidence_ref.hash :: must match referenced file" },
  { name: "post-pr-remediation-active: wrong-bytes (failure-evidence sidecar bytes)", record_id: "post-pr-remediation-active", family: "wrong-bytes", target_label: "failure-evidence sidecar bytes", consumer: "checkRunConsistency", rejector: "checkRunConsistency :: run.post_pr.evidence_refs[0] :: run.post_pr.evidence_refs[0].hash :: must match referenced file" },
  { name: "post-pr-remediation-active: wrong-bytes (remediation sidecar bytes)", record_id: "post-pr-remediation-active", family: "wrong-bytes", target_label: "remediation sidecar bytes", consumer: "checkRunConsistency", rejector: "checkRunConsistency :: run.post_pr.remediation.remediation_evidence_ref :: run.post_pr.remediation.remediation_evidence_ref.hash :: must match referenced file" },
  { name: "post-pr-remediation-active: stale-identity (stale candidate_head_sha)", record_id: "post-pr-remediation-active", family: "stale-identity", target_label: "stale candidate_head_sha", consumer: "transitionPostPrState", rejector: "transitionPostPrState :: Error :: post-PR remediation candidate_head_sha cannot change once bound" },
  { name: "post-pr-remediation-active: cross-bound-identity (cross-bound candidate head)", record_id: "post-pr-remediation-active", family: "cross-bound-identity", target_label: "cross-bound candidate head", consumer: "validateRun", rejector: "validatePostPr :: run.post_pr.remediation.candidate_head_sha :: must differ from failed_head_sha" },
  { name: "post-pr-remediation-owner: missing-key (required field)", record_id: "post-pr-remediation-owner", family: "missing-key", target_label: "required field", consumer: "validateRun", rejector: "validatePostPr :: run.post_pr.remediation.owner.kind :: must be one of slice, integration" },
  { name: "post-pr-remediation-owner: unknown-key (record root)", record_id: "post-pr-remediation-owner", family: "unknown-key", target_label: "record root", consumer: "validateRun", rejector: "validatePostPr :: run.post_pr.remediation.owner.unexpected_authority_key :: is not allowed" },
  { name: "post-pr-remediation-owner: wrong-kind (kind)", record_id: "post-pr-remediation-owner", family: "wrong-kind", target_label: "kind", consumer: "validateRun", rejector: "validatePostPr :: run.post_pr.remediation.owner :: integration owner requires test lane and test-verifier route" },
  { name: "post-pr-remediation-owner: wrong-type (typed field)", record_id: "post-pr-remediation-owner", family: "wrong-type", target_label: "typed field", consumer: "validateRun", rejector: "validatePostPr :: run.post_pr.remediation.owner.slice_id :: must be a non-empty string" },
  { name: "post-pr-remediation-owner: stale-identity (stale slice_id)", record_id: "post-pr-remediation-owner", family: "stale-identity", target_label: "stale slice_id", consumer: "transitionPostPrState", rejector: "transitionPostPrState :: Error :: post-PR remediation owner is immutable within an attempt" },
  { name: "post-pr-remediation-owner: cross-bound-identity (cross-bound stack)", record_id: "post-pr-remediation-owner", family: "cross-bound-identity", target_label: "cross-bound stack", consumer: "validateRun", rejector: "validatePostPr :: run.post_pr.remediation.owner :: slice owner requires matching slice lane and builder route" },
  { name: "post-pr-remediation-changes: missing-key (required field)", record_id: "post-pr-remediation-changes", family: "missing-key", target_label: "required field", consumer: "validateRun", rejector: "validatePostPr :: run.post_pr.remediation.changes.paths :: must be an array" },
  { name: "post-pr-remediation-changes: unknown-key (record root)", record_id: "post-pr-remediation-changes", family: "unknown-key", target_label: "record root", consumer: "validateRun", rejector: "validatePostPr :: run.post_pr.remediation.changes.unexpected_authority_key :: is not allowed" },
  { name: "post-pr-remediation-changes: wrong-type (typed field)", record_id: "post-pr-remediation-changes", family: "wrong-type", target_label: "typed field", consumer: "validateRun", rejector: "validatePostPr :: run.post_pr.remediation.changes.entries :: must be an array" },
  { name: "post-pr-remediation-changes: wrong-hash (hash tree_hash)", record_id: "post-pr-remediation-changes", family: "wrong-hash", target_label: "hash tree_hash", consumer: "checkRunConsistency", rejector: "checkRunConsistency :: run.post_pr.evidence_refs[0] :: run.post_pr.evidence_refs[0] :: missing evidence ref: evidence/post-pr-ci.attempt-1.json" },
  { name: "post-pr-remediation-changes: descriptor-key-shape-drift (paths renamed)", record_id: "post-pr-remediation-changes", family: "descriptor-key-shape-drift", target_label: "paths renamed", consumer: "validateRun", rejector: "validatePostPr :: run.post_pr.remediation.changes.changed_paths :: is not allowed" },
  { name: "post-pr-remediation-changes: stale-identity (stale tree_hash)", record_id: "post-pr-remediation-changes", family: "stale-identity", target_label: "stale tree_hash", consumer: "transitionPostPrState", rejector: "transitionPostPrState :: Error :: post-PR observed remediation changes are immutable" },
  { name: "post-pr-remediation-changes: cross-bound-identity (cross-bound paths.0)", record_id: "post-pr-remediation-changes", family: "cross-bound-identity", target_label: "cross-bound paths.0", consumer: "transitionPostPrState", rejector: "transitionPostPrState :: Error :: post-PR observed remediation changes are immutable" },
  { name: "post-pr-remediation-change-entry: missing-key (required field)", record_id: "post-pr-remediation-change-entry", family: "missing-key", target_label: "required field", consumer: "validateRun", rejector: "validatePostPr :: run.post_pr.remediation.changes.entries[0].path :: must be a non-empty string" },
  { name: "post-pr-remediation-change-entry: unknown-key (record root)", record_id: "post-pr-remediation-change-entry", family: "unknown-key", target_label: "record root", consumer: "validateRun", rejector: "validatePostPr :: run.post_pr.remediation.changes.entries[0].unexpected_authority_key :: is not allowed" },
  { name: "post-pr-remediation-change-entry: wrong-type (typed field)", record_id: "post-pr-remediation-change-entry", family: "wrong-type", target_label: "typed field", consumer: "validateRun", rejector: "validatePostPr :: run.post_pr.remediation.changes.entries[0].status :: must be one of modified, added, untracked, deleted, renamed, copied" },
  { name: "post-pr-remediation-change-entry: wrong-ref (changed path)", record_id: "post-pr-remediation-change-entry", family: "wrong-ref", target_label: "changed path", consumer: "checkRunConsistency", rejector: "checkRunConsistency :: run.post_pr.evidence_refs[0] :: run.post_pr.evidence_refs[0] :: missing evidence ref: evidence/post-pr-ci.attempt-1.json" },
  { name: "post-pr-remediation-change-entry: descriptor-key-shape-drift (previous_path renamed)", record_id: "post-pr-remediation-change-entry", family: "descriptor-key-shape-drift", target_label: "previous_path renamed", consumer: "validateRun", rejector: "validatePostPr :: run.post_pr.remediation.changes.entries[0].old_path :: is not allowed" },
  { name: "post-pr-remediation-change-entry: stale-identity (stale old_mode)", record_id: "post-pr-remediation-change-entry", family: "stale-identity", target_label: "stale old_mode", consumer: "transitionPostPrState", rejector: "transitionPostPrState :: Error :: post-PR observed remediation changes are immutable" },
  { name: "post-pr-remediation-change-entry: cross-bound-identity (cross-bound path)", record_id: "post-pr-remediation-change-entry", family: "cross-bound-identity", target_label: "cross-bound path", consumer: "transitionPostPrState", rejector: "transitionPostPrState :: Error :: post-PR observed remediation changes are immutable" },
  { name: "post-pr-dispatch-planned: missing-key (required field)", record_id: "post-pr-dispatch-planned", family: "missing-key", target_label: "required field", consumer: "validateRun", rejector: "validatePostPr :: run.post_pr.remediation.dispatch.id :: must be a non-empty string" },
  { name: "post-pr-dispatch-planned: unknown-key (record root)", record_id: "post-pr-dispatch-planned", family: "unknown-key", target_label: "record root", consumer: "validateRun", rejector: "validatePostPr :: run.post_pr.remediation.dispatch.unexpected_authority_key :: is not allowed" },
  { name: "post-pr-dispatch-planned: wrong-time (timestamp started_at)", record_id: "post-pr-dispatch-planned", family: "wrong-time", target_label: "timestamp started_at", consumer: "transitionPostPrState", rejector: "transitionPostPrState :: ValidationError :: run.post_pr.remediation.dispatch.started_at: must be an ISO timestamp or null; run.post_pr.remediation.dispatch: planned dispatch requires null start and return times" },
  { name: "post-pr-dispatch-planned: wrong-type (typed field)", record_id: "post-pr-dispatch-planned", family: "wrong-type", target_label: "typed field", consumer: "validateRun", rejector: "validatePostPr :: run.post_pr.remediation.dispatch.status :: must be one of planned, running, returned" },
  { name: "post-pr-dispatch-planned: stale-identity (stale status)", record_id: "post-pr-dispatch-planned", family: "stale-identity", target_label: "stale status", consumer: "transitionPostPrState", rejector: "transitionPostPrState :: ValidationError :: run.post_pr.remediation.dispatch: running dispatch requires a start time and null return time" },
  { name: "post-pr-dispatch-planned: cross-bound-identity (cross-bound subject)", record_id: "post-pr-dispatch-planned", family: "cross-bound-identity", target_label: "cross-bound subject", consumer: "transitionPostPrState", rejector: "transitionPostPrState :: Error :: post-PR remediation dispatch.subject is immutable within an attempt" },
  { name: "post-pr-dispatch-running: missing-key (required field)", record_id: "post-pr-dispatch-running", family: "missing-key", target_label: "required field", consumer: "validateRun", rejector: "validatePostPr :: run.post_pr.remediation.dispatch.id :: must be a non-empty string" },
  { name: "post-pr-dispatch-running: unknown-key (record root)", record_id: "post-pr-dispatch-running", family: "unknown-key", target_label: "record root", consumer: "validateRun", rejector: "validatePostPr :: run.post_pr.remediation.dispatch.unexpected_authority_key :: is not allowed" },
  { name: "post-pr-dispatch-running: wrong-time (timestamp started_at)", record_id: "post-pr-dispatch-running", family: "wrong-time", target_label: "timestamp started_at", consumer: "transitionPostPrState", rejector: "transitionPostPrState :: ValidationError :: run.post_pr.remediation.dispatch.started_at: must be an ISO timestamp or null; run.post_pr.remediation.dispatch: running dispatch requires a start time and null return time" },
  { name: "post-pr-dispatch-running: wrong-type (typed field)", record_id: "post-pr-dispatch-running", family: "wrong-type", target_label: "typed field", consumer: "validateRun", rejector: "validatePostPr :: run.post_pr.remediation.dispatch.status :: must be one of planned, running, returned" },
  { name: "post-pr-dispatch-running: stale-identity (stale status)", record_id: "post-pr-dispatch-running", family: "stale-identity", target_label: "stale status", consumer: "transitionPostPrState", rejector: "transitionPostPrState :: Error :: post-PR remediation dispatch status cannot move backwards" },
  { name: "post-pr-dispatch-running: cross-bound-identity (cross-bound subject)", record_id: "post-pr-dispatch-running", family: "cross-bound-identity", target_label: "cross-bound subject", consumer: "transitionPostPrState", rejector: "transitionPostPrState :: Error :: post-PR remediation dispatch.subject is immutable within an attempt" },
  { name: "post-pr-dispatch-returned: missing-key (required field)", record_id: "post-pr-dispatch-returned", family: "missing-key", target_label: "required field", consumer: "validateRun", rejector: "validatePostPr :: run.post_pr.remediation.dispatch.id :: must be a non-empty string" },
  { name: "post-pr-dispatch-returned: unknown-key (record root)", record_id: "post-pr-dispatch-returned", family: "unknown-key", target_label: "record root", consumer: "validateRun", rejector: "validatePostPr :: run.post_pr.remediation.dispatch.unexpected_authority_key :: is not allowed" },
  { name: "post-pr-dispatch-returned: wrong-time (timestamp returned_at)", record_id: "post-pr-dispatch-returned", family: "wrong-time", target_label: "timestamp returned_at", consumer: "transitionPostPrState", rejector: "transitionPostPrState :: ValidationError :: run.post_pr.remediation.dispatch.returned_at: must be an ISO timestamp or null; run.post_pr.remediation.dispatch: returned dispatch requires start and return times" },
  { name: "post-pr-dispatch-returned: wrong-type (typed field)", record_id: "post-pr-dispatch-returned", family: "wrong-type", target_label: "typed field", consumer: "validateRun", rejector: "validatePostPr :: run.post_pr.remediation.dispatch.status :: must be one of planned, running, returned" },
  { name: "post-pr-dispatch-returned: stale-identity (stale status)", record_id: "post-pr-dispatch-returned", family: "stale-identity", target_label: "stale status", consumer: "transitionPostPrState", rejector: "transitionPostPrState :: Error :: post-PR remediation dispatch status cannot move backwards" },
  { name: "post-pr-dispatch-returned: cross-bound-identity (cross-bound subject)", record_id: "post-pr-dispatch-returned", family: "cross-bound-identity", target_label: "cross-bound subject", consumer: "transitionPostPrState", rejector: "transitionPostPrState :: Error :: post-PR remediation dispatch.subject is immutable within an attempt" },
  { name: "post-pr-revalidation-empty: missing-key (required field)", record_id: "post-pr-revalidation-empty", family: "missing-key", target_label: "required field", consumer: "transitionPostPrState", rejector: "transitionPostPrState :: ValidationError :: run.post_pr.remediation.revalidation.canonical_verdict: canonical authority keys must be all absent or all present" },
  { name: "post-pr-revalidation-empty: unknown-key (record root)", record_id: "post-pr-revalidation-empty", family: "unknown-key", target_label: "record root", consumer: "validateRun", rejector: "validatePostPr :: run.post_pr.remediation.revalidation.unexpected_authority_key :: is not allowed" },
  { name: "post-pr-revalidation-empty: wrong-type (typed field)", record_id: "post-pr-revalidation-empty", family: "wrong-type", target_label: "typed field", consumer: "validateRun", rejector: "validatePostPr :: run.post_pr.remediation.revalidation.validator_verdict :: must be one of GO, GO-WITH-NITS, NO-GO" },
  { name: "post-pr-revalidation-empty: stale-identity (stale canonical_verdict)", record_id: "post-pr-revalidation-empty", family: "stale-identity", target_label: "stale canonical_verdict", consumer: "transitionPostPrState", rejector: "transitionPostPrState :: ValidationError :: run.post_pr.remediation.revalidation.canonical_verdict: canonical authority ref/hash/verdict must be a complete tuple" },
  { name: "post-pr-revalidation-empty: cross-bound-identity (cross-bound validator_verdict)", record_id: "post-pr-revalidation-empty", family: "cross-bound-identity", target_label: "cross-bound validator_verdict", consumer: "transitionPostPrState", rejector: "transitionPostPrState :: ValidationError :: run.post_pr.remediation.revalidation.validator_verdict: validator authority ref/hash/verdict must be a complete tuple" },
  { name: "post-pr-revalidation-bound: missing-key (required field)", record_id: "post-pr-revalidation-bound", family: "missing-key", target_label: "required field", consumer: "validateRun", rejector: "validatePostPr :: run.post_pr.remediation.revalidation.jobs.canonical.verdict :: must equal revalidation.canonical_verdict for a bound canonical job" },
  { name: "post-pr-revalidation-bound: unknown-key (record root)", record_id: "post-pr-revalidation-bound", family: "unknown-key", target_label: "record root", consumer: "validateRun", rejector: "validatePostPr :: run.post_pr.remediation.revalidation.unexpected_authority_key :: is not allowed" },
  { name: "post-pr-revalidation-bound: wrong-type (typed field)", record_id: "post-pr-revalidation-bound", family: "wrong-type", target_label: "typed field", consumer: "validateRun", rejector: "validatePostPr :: run.post_pr.remediation.revalidation.validator_verdict :: must be one of GO, GO-WITH-NITS, NO-GO" },
  { name: "post-pr-revalidation-bound: wrong-ref (canonical ref)", record_id: "post-pr-revalidation-bound", family: "wrong-ref", target_label: "canonical ref", consumer: "validateRun", rejector: "validatePostPr :: run.post_pr.remediation.revalidation.jobs.canonical.result_ref :: must equal revalidation.canonical_evidence_ref for a bound canonical job" },
  { name: "post-pr-revalidation-bound: wrong-ref (validator ref)", record_id: "post-pr-revalidation-bound", family: "wrong-ref", target_label: "validator ref", consumer: "validateRun", rejector: "validatePostPr :: run.post_pr.remediation.revalidation.jobs.validator.result_ref :: must equal revalidation.validator_review_ref for a bound validator job" },
  { name: "post-pr-revalidation-bound: wrong-ref (security ref)", record_id: "post-pr-revalidation-bound", family: "wrong-ref", target_label: "security ref", consumer: "validateRun", rejector: "validatePostPr :: run.post_pr.remediation.revalidation.jobs.security.result_ref :: must equal revalidation.security_review_ref for a bound security job" },
  { name: "post-pr-revalidation-bound: wrong-hash (canonical hash)", record_id: "post-pr-revalidation-bound", family: "wrong-hash", target_label: "canonical hash", consumer: "validateRun", rejector: "validatePostPr :: run.post_pr.remediation.revalidation.jobs.canonical.result_hash :: must equal revalidation.canonical_evidence_hash for a bound canonical job" },
  { name: "post-pr-revalidation-bound: wrong-hash (validator hash)", record_id: "post-pr-revalidation-bound", family: "wrong-hash", target_label: "validator hash", consumer: "validateRun", rejector: "validatePostPr :: run.post_pr.remediation.revalidation.jobs.validator.result_hash :: must equal revalidation.validator_review_hash for a bound validator job" },
  { name: "post-pr-revalidation-bound: wrong-hash (security hash)", record_id: "post-pr-revalidation-bound", family: "wrong-hash", target_label: "security hash", consumer: "validateRun", rejector: "validatePostPr :: run.post_pr.remediation.revalidation.jobs.security.result_hash :: must equal revalidation.security_review_hash for a bound security job" },
  { name: "post-pr-revalidation-bound: wrong-bytes (canonical sidecar bytes)", record_id: "post-pr-revalidation-bound", family: "wrong-bytes", target_label: "canonical sidecar bytes", consumer: "checkRunConsistency", rejector: "checkRunConsistency :: run.post_pr.evidence_refs[0] :: run.post_pr.evidence_refs[0] :: missing evidence ref: evidence/post-pr-ci.attempt-1.json" },
  { name: "post-pr-revalidation-bound: wrong-bytes (validator sidecar bytes)", record_id: "post-pr-revalidation-bound", family: "wrong-bytes", target_label: "validator sidecar bytes", consumer: "checkRunConsistency", rejector: "checkRunConsistency :: run.post_pr.evidence_refs[0] :: run.post_pr.evidence_refs[0] :: missing evidence ref: evidence/post-pr-ci.attempt-1.json" },
  { name: "post-pr-revalidation-bound: wrong-bytes (security sidecar bytes)", record_id: "post-pr-revalidation-bound", family: "wrong-bytes", target_label: "security sidecar bytes", consumer: "checkRunConsistency", rejector: "checkRunConsistency :: run.post_pr.evidence_refs[0] :: run.post_pr.evidence_refs[0] :: missing evidence ref: evidence/post-pr-ci.attempt-1.json" },
  { name: "post-pr-revalidation-bound: stale-identity (stale canonical_verdict)", record_id: "post-pr-revalidation-bound", family: "stale-identity", target_label: "stale canonical_verdict", consumer: "validateRun", rejector: "validatePostPr :: run.post_pr.remediation.revalidation.jobs.canonical.verdict :: must equal revalidation.canonical_verdict for a bound canonical job" },
  { name: "post-pr-revalidation-bound: cross-bound-identity (cross-bound security_verdict)", record_id: "post-pr-revalidation-bound", family: "cross-bound-identity", target_label: "cross-bound security_verdict", consumer: "validateRun", rejector: "validatePostPr :: run.post_pr.remediation.revalidation.jobs.security.verdict :: must equal revalidation.security_verdict for a bound security job" },
  { name: "post-pr-canonical-job-planned: missing-key (required field)", record_id: "post-pr-canonical-job-planned", family: "missing-key", target_label: "required field", consumer: "validateRun", rejector: "validatePostPr :: run.post_pr.remediation.revalidation.jobs.canonical.dispatch_id :: must be a non-empty string" },
  { name: "post-pr-canonical-job-planned: unknown-key (record root)", record_id: "post-pr-canonical-job-planned", family: "unknown-key", target_label: "record root", consumer: "validateRun", rejector: "validatePostPr :: run.post_pr.remediation.revalidation.jobs.canonical.unexpected_authority_key :: is not allowed" },
  { name: "post-pr-canonical-job-planned: wrong-time (timestamp started_at)", record_id: "post-pr-canonical-job-planned", family: "wrong-time", target_label: "timestamp started_at", consumer: "transitionPostPrState", rejector: "transitionPostPrState :: ValidationError :: run.post_pr.remediation.revalidation.jobs.canonical.started_at: must be an ISO timestamp or null; run.post_pr.remediation.revalidation.jobs.canonical: planned job must not carry started steering authority" },
  { name: "post-pr-canonical-job-planned: wrong-type (typed field)", record_id: "post-pr-canonical-job-planned", family: "wrong-type", target_label: "typed field", consumer: "validateRun", rejector: "validatePostPr :: run.post_pr.remediation.revalidation.jobs.canonical.status :: must be one of planned, running, retry-wait, bound" },
  { name: "post-pr-canonical-job-planned: stale-identity (stale steering_generation)", record_id: "post-pr-canonical-job-planned", family: "stale-identity", target_label: "stale steering_generation", consumer: "transitionPostPrState", rejector: "transitionPostPrState :: ValidationError :: run.post_pr.remediation.revalidation.jobs.canonical: planned job must not carry started steering authority" },
  { name: "post-pr-canonical-job-planned: cross-bound-identity (cross-bound dispatch_id)", record_id: "post-pr-canonical-job-planned", family: "cross-bound-identity", target_label: "cross-bound dispatch_id", consumer: "transitionPostPrState", rejector: "transitionPostPrState :: Error :: post-PR canonical dispatch id is immutable" },
  { name: "post-pr-canonical-job-running: missing-key (required field)", record_id: "post-pr-canonical-job-running", family: "missing-key", target_label: "required field", consumer: "validateRun", rejector: "validatePostPr :: run.post_pr.remediation.revalidation.jobs.canonical.dispatch_id :: must be a non-empty string" },
  { name: "post-pr-canonical-job-running: unknown-key (record root)", record_id: "post-pr-canonical-job-running", family: "unknown-key", target_label: "record root", consumer: "validateRun", rejector: "validatePostPr :: run.post_pr.remediation.revalidation.jobs.canonical.unexpected_authority_key :: is not allowed" },
  { name: "post-pr-canonical-job-running: wrong-time (timestamp started_at)", record_id: "post-pr-canonical-job-running", family: "wrong-time", target_label: "timestamp started_at", consumer: "transitionPostPrState", rejector: "transitionPostPrState :: ValidationError :: run.post_pr.remediation.revalidation.jobs.canonical.started_at: must be an ISO timestamp or null" },
  { name: "post-pr-canonical-job-running: wrong-type (typed field)", record_id: "post-pr-canonical-job-running", family: "wrong-type", target_label: "typed field", consumer: "validateRun", rejector: "validatePostPr :: run.post_pr.remediation.revalidation.jobs.canonical.status :: must be one of planned, running, retry-wait, bound" },
  { name: "post-pr-canonical-job-running: stale-identity (stale steering_generation)", record_id: "post-pr-canonical-job-running", family: "stale-identity", target_label: "stale steering_generation", consumer: "transitionPostPrState", rejector: "transitionPostPrState :: Error :: post-PR canonical job steering_generation cannot change once bound" },
  { name: "post-pr-canonical-job-running: cross-bound-identity (cross-bound dispatch_id)", record_id: "post-pr-canonical-job-running", family: "cross-bound-identity", target_label: "cross-bound dispatch_id", consumer: "transitionPostPrState", rejector: "transitionPostPrState :: Error :: post-PR canonical dispatch id is immutable" },
  { name: "post-pr-canonical-job-retry-wait: missing-key (required field)", record_id: "post-pr-canonical-job-retry-wait", family: "missing-key", target_label: "required field", consumer: "validateRun", rejector: "validatePostPr :: run.post_pr.remediation.revalidation.jobs.canonical.dispatch_id :: must be a non-empty string" },
  { name: "post-pr-canonical-job-retry-wait: unknown-key (record root)", record_id: "post-pr-canonical-job-retry-wait", family: "unknown-key", target_label: "record root", consumer: "validateRun", rejector: "validatePostPr :: run.post_pr.remediation.revalidation.jobs.canonical.unexpected_authority_key :: is not allowed" },
  { name: "post-pr-canonical-job-retry-wait: wrong-time (timestamp next_retry_at)", record_id: "post-pr-canonical-job-retry-wait", family: "wrong-time", target_label: "timestamp next_retry_at", consumer: "transitionPostPrState", rejector: "transitionPostPrState :: ValidationError :: run.post_pr.remediation.revalidation.jobs.canonical.next_retry_at: must be an ISO timestamp or null" },
  { name: "post-pr-canonical-job-retry-wait: wrong-type (typed field)", record_id: "post-pr-canonical-job-retry-wait", family: "wrong-type", target_label: "typed field", consumer: "validateRun", rejector: "validatePostPr :: run.post_pr.remediation.revalidation.jobs.canonical.status :: must be one of planned, running, retry-wait, bound" },
  { name: "post-pr-canonical-job-retry-wait: stale-identity (stale steering_generation)", record_id: "post-pr-canonical-job-retry-wait", family: "stale-identity", target_label: "stale steering_generation", consumer: "transitionPostPrState", rejector: "transitionPostPrState :: Error :: post-PR canonical job steering_generation cannot change once bound" },
  { name: "post-pr-canonical-job-retry-wait: cross-bound-identity (cross-bound dispatch_id)", record_id: "post-pr-canonical-job-retry-wait", family: "cross-bound-identity", target_label: "cross-bound dispatch_id", consumer: "transitionPostPrState", rejector: "transitionPostPrState :: Error :: post-PR canonical dispatch id is immutable" },
  { name: "post-pr-canonical-job-bound: missing-key (required field)", record_id: "post-pr-canonical-job-bound", family: "missing-key", target_label: "required field", consumer: "validateRun", rejector: "validatePostPr :: run.post_pr.remediation.revalidation.jobs.canonical.dispatch_id :: must be a non-empty string" },
  { name: "post-pr-canonical-job-bound: unknown-key (record root)", record_id: "post-pr-canonical-job-bound", family: "unknown-key", target_label: "record root", consumer: "validateRun", rejector: "validatePostPr :: run.post_pr.remediation.revalidation.jobs.canonical.unexpected_authority_key :: is not allowed" },
  { name: "post-pr-canonical-job-bound: wrong-type (typed field)", record_id: "post-pr-canonical-job-bound", family: "wrong-type", target_label: "typed field", consumer: "validateRun", rejector: "validatePostPr :: run.post_pr.remediation.revalidation.jobs.canonical.status :: must be one of planned, running, retry-wait, bound" },
  { name: "post-pr-canonical-job-bound: wrong-ref (canonical-result ref)", record_id: "post-pr-canonical-job-bound", family: "wrong-ref", target_label: "canonical-result ref", consumer: "validateRun", rejector: "validatePostPr :: run.post_pr.remediation.revalidation.jobs.canonical.result_ref :: must equal revalidation.canonical_evidence_ref for a bound canonical job" },
  { name: "post-pr-canonical-job-bound: wrong-hash (canonical-result hash)", record_id: "post-pr-canonical-job-bound", family: "wrong-hash", target_label: "canonical-result hash", consumer: "validateRun", rejector: "validatePostPr :: run.post_pr.remediation.revalidation.jobs.canonical.result_hash :: must equal revalidation.canonical_evidence_hash for a bound canonical job" },
  { name: "post-pr-canonical-job-bound: wrong-bytes (canonical-result sidecar bytes)", record_id: "post-pr-canonical-job-bound", family: "wrong-bytes", target_label: "canonical-result sidecar bytes", consumer: "checkRunConsistency", rejector: "checkRunConsistency :: run.post_pr.evidence_refs[0] :: run.post_pr.evidence_refs[0] :: missing evidence ref: evidence/post-pr-ci.attempt-1.json" },
  { name: "post-pr-canonical-job-bound: stale-identity (stale verdict)", record_id: "post-pr-canonical-job-bound", family: "stale-identity", target_label: "stale verdict", consumer: "validateRun", rejector: "validatePostPr :: run.post_pr.remediation.revalidation.jobs.canonical.verdict :: must equal revalidation.canonical_verdict for a bound canonical job" },
  { name: "post-pr-canonical-job-bound: cross-bound-identity (cross-bound dispatch_id)", record_id: "post-pr-canonical-job-bound", family: "cross-bound-identity", target_label: "cross-bound dispatch_id", consumer: "transitionPostPrState", rejector: "transitionPostPrState :: Error :: post-PR canonical dispatch id is immutable" },
  { name: "post-pr-validator-job-planned: missing-key (required field)", record_id: "post-pr-validator-job-planned", family: "missing-key", target_label: "required field", consumer: "validateRun", rejector: "validatePostPr :: run.post_pr.remediation.revalidation.jobs.validator.dispatch_id :: must be a non-empty string" },
  { name: "post-pr-validator-job-planned: unknown-key (record root)", record_id: "post-pr-validator-job-planned", family: "unknown-key", target_label: "record root", consumer: "validateRun", rejector: "validatePostPr :: run.post_pr.remediation.revalidation.jobs.validator.unexpected_authority_key :: is not allowed" },
  { name: "post-pr-validator-job-planned: wrong-time (timestamp started_at)", record_id: "post-pr-validator-job-planned", family: "wrong-time", target_label: "timestamp started_at", consumer: "transitionPostPrState", rejector: "transitionPostPrState :: ValidationError :: run.post_pr.remediation.revalidation.jobs.validator.started_at: must be an ISO timestamp or null; run.post_pr.remediation.revalidation.jobs.validator: planned job must not carry started steering authority" },
  { name: "post-pr-validator-job-planned: wrong-type (typed field)", record_id: "post-pr-validator-job-planned", family: "wrong-type", target_label: "typed field", consumer: "validateRun", rejector: "validatePostPr :: run.post_pr.remediation.revalidation.jobs.validator.status :: must be one of planned, running, retry-wait, bound" },
  { name: "post-pr-validator-job-planned: stale-identity (stale steering_generation)", record_id: "post-pr-validator-job-planned", family: "stale-identity", target_label: "stale steering_generation", consumer: "transitionPostPrState", rejector: "transitionPostPrState :: ValidationError :: run.post_pr.remediation.revalidation.jobs.validator: planned job must not carry started steering authority" },
  { name: "post-pr-validator-job-planned: cross-bound-identity (cross-bound dispatch_id)", record_id: "post-pr-validator-job-planned", family: "cross-bound-identity", target_label: "cross-bound dispatch_id", consumer: "transitionPostPrState", rejector: "transitionPostPrState :: Error :: post-PR validator dispatch id is immutable" },
  { name: "post-pr-validator-job-running: missing-key (required field)", record_id: "post-pr-validator-job-running", family: "missing-key", target_label: "required field", consumer: "validateRun", rejector: "validatePostPr :: run.post_pr.remediation.revalidation.jobs.validator.dispatch_id :: must be a non-empty string" },
  { name: "post-pr-validator-job-running: unknown-key (record root)", record_id: "post-pr-validator-job-running", family: "unknown-key", target_label: "record root", consumer: "validateRun", rejector: "validatePostPr :: run.post_pr.remediation.revalidation.jobs.validator.unexpected_authority_key :: is not allowed" },
  { name: "post-pr-validator-job-running: wrong-time (timestamp started_at)", record_id: "post-pr-validator-job-running", family: "wrong-time", target_label: "timestamp started_at", consumer: "transitionPostPrState", rejector: "transitionPostPrState :: ValidationError :: run.post_pr.remediation.revalidation.jobs.validator.started_at: must be an ISO timestamp or null" },
  { name: "post-pr-validator-job-running: wrong-type (typed field)", record_id: "post-pr-validator-job-running", family: "wrong-type", target_label: "typed field", consumer: "validateRun", rejector: "validatePostPr :: run.post_pr.remediation.revalidation.jobs.validator.status :: must be one of planned, running, retry-wait, bound" },
  { name: "post-pr-validator-job-running: stale-identity (stale steering_generation)", record_id: "post-pr-validator-job-running", family: "stale-identity", target_label: "stale steering_generation", consumer: "transitionPostPrState", rejector: "transitionPostPrState :: Error :: post-PR validator job steering_generation cannot change once bound" },
  { name: "post-pr-validator-job-running: cross-bound-identity (cross-bound dispatch_id)", record_id: "post-pr-validator-job-running", family: "cross-bound-identity", target_label: "cross-bound dispatch_id", consumer: "transitionPostPrState", rejector: "transitionPostPrState :: Error :: post-PR validator dispatch id is immutable" },
  { name: "post-pr-validator-job-retry-wait: missing-key (required field)", record_id: "post-pr-validator-job-retry-wait", family: "missing-key", target_label: "required field", consumer: "validateRun", rejector: "validatePostPr :: run.post_pr.remediation.revalidation.jobs.validator.dispatch_id :: must be a non-empty string" },
  { name: "post-pr-validator-job-retry-wait: unknown-key (record root)", record_id: "post-pr-validator-job-retry-wait", family: "unknown-key", target_label: "record root", consumer: "validateRun", rejector: "validatePostPr :: run.post_pr.remediation.revalidation.jobs.validator.unexpected_authority_key :: is not allowed" },
  { name: "post-pr-validator-job-retry-wait: wrong-time (timestamp next_retry_at)", record_id: "post-pr-validator-job-retry-wait", family: "wrong-time", target_label: "timestamp next_retry_at", consumer: "transitionPostPrState", rejector: "transitionPostPrState :: ValidationError :: run.post_pr.remediation.revalidation.jobs.validator.next_retry_at: must be an ISO timestamp or null" },
  { name: "post-pr-validator-job-retry-wait: wrong-type (typed field)", record_id: "post-pr-validator-job-retry-wait", family: "wrong-type", target_label: "typed field", consumer: "validateRun", rejector: "validatePostPr :: run.post_pr.remediation.revalidation.jobs.validator.status :: must be one of planned, running, retry-wait, bound" },
  { name: "post-pr-validator-job-retry-wait: stale-identity (stale steering_generation)", record_id: "post-pr-validator-job-retry-wait", family: "stale-identity", target_label: "stale steering_generation", consumer: "transitionPostPrState", rejector: "transitionPostPrState :: Error :: post-PR validator job steering_generation cannot change once bound" },
  { name: "post-pr-validator-job-retry-wait: cross-bound-identity (cross-bound dispatch_id)", record_id: "post-pr-validator-job-retry-wait", family: "cross-bound-identity", target_label: "cross-bound dispatch_id", consumer: "transitionPostPrState", rejector: "transitionPostPrState :: Error :: post-PR validator dispatch id is immutable" },
  { name: "post-pr-validator-job-bound: missing-key (required field)", record_id: "post-pr-validator-job-bound", family: "missing-key", target_label: "required field", consumer: "validateRun", rejector: "validatePostPr :: run.post_pr.remediation.revalidation.jobs.validator.dispatch_id :: must be a non-empty string" },
  { name: "post-pr-validator-job-bound: unknown-key (record root)", record_id: "post-pr-validator-job-bound", family: "unknown-key", target_label: "record root", consumer: "validateRun", rejector: "validatePostPr :: run.post_pr.remediation.revalidation.jobs.validator.unexpected_authority_key :: is not allowed" },
  { name: "post-pr-validator-job-bound: wrong-type (typed field)", record_id: "post-pr-validator-job-bound", family: "wrong-type", target_label: "typed field", consumer: "validateRun", rejector: "validatePostPr :: run.post_pr.remediation.revalidation.jobs.validator.status :: must be one of planned, running, retry-wait, bound" },
  { name: "post-pr-validator-job-bound: wrong-ref (validator-result ref)", record_id: "post-pr-validator-job-bound", family: "wrong-ref", target_label: "validator-result ref", consumer: "validateRun", rejector: "validatePostPr :: run.post_pr.remediation.revalidation.jobs.validator.result_ref :: must equal revalidation.validator_review_ref for a bound validator job" },
  { name: "post-pr-validator-job-bound: wrong-hash (validator-result hash)", record_id: "post-pr-validator-job-bound", family: "wrong-hash", target_label: "validator-result hash", consumer: "validateRun", rejector: "validatePostPr :: run.post_pr.remediation.revalidation.jobs.validator.result_hash :: must equal revalidation.validator_review_hash for a bound validator job" },
  { name: "post-pr-validator-job-bound: wrong-bytes (validator-result sidecar bytes)", record_id: "post-pr-validator-job-bound", family: "wrong-bytes", target_label: "validator-result sidecar bytes", consumer: "checkRunConsistency", rejector: "checkRunConsistency :: run.post_pr.evidence_refs[0] :: run.post_pr.evidence_refs[0] :: missing evidence ref: evidence/post-pr-ci.attempt-1.json" },
  { name: "post-pr-validator-job-bound: stale-identity (stale verdict)", record_id: "post-pr-validator-job-bound", family: "stale-identity", target_label: "stale verdict", consumer: "validateRun", rejector: "validatePostPr :: run.post_pr.remediation.revalidation.jobs.validator.verdict :: must equal revalidation.validator_verdict for a bound validator job" },
  { name: "post-pr-validator-job-bound: cross-bound-identity (cross-bound dispatch_id)", record_id: "post-pr-validator-job-bound", family: "cross-bound-identity", target_label: "cross-bound dispatch_id", consumer: "transitionPostPrState", rejector: "transitionPostPrState :: Error :: post-PR validator dispatch id is immutable" },
  { name: "post-pr-security-job-planned: missing-key (required field)", record_id: "post-pr-security-job-planned", family: "missing-key", target_label: "required field", consumer: "validateRun", rejector: "validatePostPr :: run.post_pr.remediation.revalidation.jobs.security.dispatch_id :: must be a non-empty string" },
  { name: "post-pr-security-job-planned: unknown-key (record root)", record_id: "post-pr-security-job-planned", family: "unknown-key", target_label: "record root", consumer: "validateRun", rejector: "validatePostPr :: run.post_pr.remediation.revalidation.jobs.security.unexpected_authority_key :: is not allowed" },
  { name: "post-pr-security-job-planned: wrong-time (timestamp started_at)", record_id: "post-pr-security-job-planned", family: "wrong-time", target_label: "timestamp started_at", consumer: "transitionPostPrState", rejector: "transitionPostPrState :: ValidationError :: run.post_pr.remediation.revalidation.jobs.security.started_at: must be an ISO timestamp or null; run.post_pr.remediation.revalidation.jobs.security: planned job must not carry started steering authority" },
  { name: "post-pr-security-job-planned: wrong-type (typed field)", record_id: "post-pr-security-job-planned", family: "wrong-type", target_label: "typed field", consumer: "validateRun", rejector: "validatePostPr :: run.post_pr.remediation.revalidation.jobs.security.status :: must be one of planned, running, retry-wait, bound" },
  { name: "post-pr-security-job-planned: stale-identity (stale steering_generation)", record_id: "post-pr-security-job-planned", family: "stale-identity", target_label: "stale steering_generation", consumer: "transitionPostPrState", rejector: "transitionPostPrState :: ValidationError :: run.post_pr.remediation.revalidation.jobs.security: planned job must not carry started steering authority" },
  { name: "post-pr-security-job-planned: cross-bound-identity (cross-bound dispatch_id)", record_id: "post-pr-security-job-planned", family: "cross-bound-identity", target_label: "cross-bound dispatch_id", consumer: "transitionPostPrState", rejector: "transitionPostPrState :: Error :: post-PR security dispatch id is immutable" },
  { name: "post-pr-security-job-running: missing-key (required field)", record_id: "post-pr-security-job-running", family: "missing-key", target_label: "required field", consumer: "validateRun", rejector: "validatePostPr :: run.post_pr.remediation.revalidation.jobs.security.dispatch_id :: must be a non-empty string" },
  { name: "post-pr-security-job-running: unknown-key (record root)", record_id: "post-pr-security-job-running", family: "unknown-key", target_label: "record root", consumer: "validateRun", rejector: "validatePostPr :: run.post_pr.remediation.revalidation.jobs.security.unexpected_authority_key :: is not allowed" },
  { name: "post-pr-security-job-running: wrong-time (timestamp started_at)", record_id: "post-pr-security-job-running", family: "wrong-time", target_label: "timestamp started_at", consumer: "transitionPostPrState", rejector: "transitionPostPrState :: ValidationError :: run.post_pr.remediation.revalidation.jobs.security.started_at: must be an ISO timestamp or null" },
  { name: "post-pr-security-job-running: wrong-type (typed field)", record_id: "post-pr-security-job-running", family: "wrong-type", target_label: "typed field", consumer: "validateRun", rejector: "validatePostPr :: run.post_pr.remediation.revalidation.jobs.security.status :: must be one of planned, running, retry-wait, bound" },
  { name: "post-pr-security-job-running: stale-identity (stale steering_generation)", record_id: "post-pr-security-job-running", family: "stale-identity", target_label: "stale steering_generation", consumer: "transitionPostPrState", rejector: "transitionPostPrState :: Error :: post-PR security job steering_generation cannot change once bound" },
  { name: "post-pr-security-job-running: cross-bound-identity (cross-bound dispatch_id)", record_id: "post-pr-security-job-running", family: "cross-bound-identity", target_label: "cross-bound dispatch_id", consumer: "transitionPostPrState", rejector: "transitionPostPrState :: Error :: post-PR security dispatch id is immutable" },
  { name: "post-pr-security-job-retry-wait: missing-key (required field)", record_id: "post-pr-security-job-retry-wait", family: "missing-key", target_label: "required field", consumer: "validateRun", rejector: "validatePostPr :: run.post_pr.remediation.revalidation.jobs.security.dispatch_id :: must be a non-empty string" },
  { name: "post-pr-security-job-retry-wait: unknown-key (record root)", record_id: "post-pr-security-job-retry-wait", family: "unknown-key", target_label: "record root", consumer: "validateRun", rejector: "validatePostPr :: run.post_pr.remediation.revalidation.jobs.security.unexpected_authority_key :: is not allowed" },
  { name: "post-pr-security-job-retry-wait: wrong-time (timestamp next_retry_at)", record_id: "post-pr-security-job-retry-wait", family: "wrong-time", target_label: "timestamp next_retry_at", consumer: "transitionPostPrState", rejector: "transitionPostPrState :: ValidationError :: run.post_pr.remediation.revalidation.jobs.security.next_retry_at: must be an ISO timestamp or null" },
  { name: "post-pr-security-job-retry-wait: wrong-type (typed field)", record_id: "post-pr-security-job-retry-wait", family: "wrong-type", target_label: "typed field", consumer: "validateRun", rejector: "validatePostPr :: run.post_pr.remediation.revalidation.jobs.security.status :: must be one of planned, running, retry-wait, bound" },
  { name: "post-pr-security-job-retry-wait: stale-identity (stale steering_generation)", record_id: "post-pr-security-job-retry-wait", family: "stale-identity", target_label: "stale steering_generation", consumer: "transitionPostPrState", rejector: "transitionPostPrState :: Error :: post-PR security job steering_generation cannot change once bound" },
  { name: "post-pr-security-job-retry-wait: cross-bound-identity (cross-bound dispatch_id)", record_id: "post-pr-security-job-retry-wait", family: "cross-bound-identity", target_label: "cross-bound dispatch_id", consumer: "transitionPostPrState", rejector: "transitionPostPrState :: Error :: post-PR security dispatch id is immutable" },
  { name: "post-pr-security-job-bound: missing-key (required field)", record_id: "post-pr-security-job-bound", family: "missing-key", target_label: "required field", consumer: "validateRun", rejector: "validatePostPr :: run.post_pr.remediation.revalidation.jobs.security.dispatch_id :: must be a non-empty string" },
  { name: "post-pr-security-job-bound: unknown-key (record root)", record_id: "post-pr-security-job-bound", family: "unknown-key", target_label: "record root", consumer: "validateRun", rejector: "validatePostPr :: run.post_pr.remediation.revalidation.jobs.security.unexpected_authority_key :: is not allowed" },
  { name: "post-pr-security-job-bound: wrong-type (typed field)", record_id: "post-pr-security-job-bound", family: "wrong-type", target_label: "typed field", consumer: "validateRun", rejector: "validatePostPr :: run.post_pr.remediation.revalidation.jobs.security.status :: must be one of planned, running, retry-wait, bound" },
  { name: "post-pr-security-job-bound: wrong-ref (security-result ref)", record_id: "post-pr-security-job-bound", family: "wrong-ref", target_label: "security-result ref", consumer: "validateRun", rejector: "validatePostPr :: run.post_pr.remediation.revalidation.jobs.security.result_ref :: must equal revalidation.security_review_ref for a bound security job" },
  { name: "post-pr-security-job-bound: wrong-hash (security-result hash)", record_id: "post-pr-security-job-bound", family: "wrong-hash", target_label: "security-result hash", consumer: "validateRun", rejector: "validatePostPr :: run.post_pr.remediation.revalidation.jobs.security.result_hash :: must equal revalidation.security_review_hash for a bound security job" },
  { name: "post-pr-security-job-bound: wrong-bytes (security-result sidecar bytes)", record_id: "post-pr-security-job-bound", family: "wrong-bytes", target_label: "security-result sidecar bytes", consumer: "checkRunConsistency", rejector: "checkRunConsistency :: run.post_pr.evidence_refs[0] :: run.post_pr.evidence_refs[0] :: missing evidence ref: evidence/post-pr-ci.attempt-1.json" },
  { name: "post-pr-security-job-bound: stale-identity (stale verdict)", record_id: "post-pr-security-job-bound", family: "stale-identity", target_label: "stale verdict", consumer: "validateRun", rejector: "validatePostPr :: run.post_pr.remediation.revalidation.jobs.security.verdict :: must equal revalidation.security_verdict for a bound security job" },
  { name: "post-pr-security-job-bound: cross-bound-identity (cross-bound dispatch_id)", record_id: "post-pr-security-job-bound", family: "cross-bound-identity", target_label: "cross-bound dispatch_id", consumer: "transitionPostPrState", rejector: "transitionPostPrState :: Error :: post-PR security dispatch id is immutable" },
  { name: "post-pr-push-not-ready: missing-key (required field)", record_id: "post-pr-push-not-ready", family: "missing-key", target_label: "required field", consumer: "validateRun", rejector: "validatePostPr :: run.post_pr.remediation.push.status :: must be one of not-ready, pending, confirmed" },
  { name: "post-pr-push-not-ready: unknown-key (record root)", record_id: "post-pr-push-not-ready", family: "unknown-key", target_label: "record root", consumer: "validateRun", rejector: "validatePostPr :: run.post_pr.remediation.push.unexpected_authority_key :: is not allowed" },
  { name: "post-pr-push-not-ready: wrong-time (timestamp pushed_at)", record_id: "post-pr-push-not-ready", family: "wrong-time", target_label: "timestamp pushed_at", consumer: "transitionPostPrState", rejector: "transitionPostPrState :: ValidationError :: run.post_pr.remediation.push.pushed_at: must be an ISO timestamp or null; run.post_pr.remediation.push: not-ready push must not carry remote, local, or publication authority" },
  { name: "post-pr-push-not-ready: wrong-type (typed field)", record_id: "post-pr-push-not-ready", family: "wrong-type", target_label: "typed field", consumer: "validateRun", rejector: "validatePostPr :: run.post_pr.remediation.push.consecutive_transient_errors :: must be an integer from 0 to 9007199254740991" },
  { name: "post-pr-push-not-ready: stale-identity (stale remote_before_sha)", record_id: "post-pr-push-not-ready", family: "stale-identity", target_label: "stale remote_before_sha", consumer: "transitionPostPrState", rejector: "transitionPostPrState :: ValidationError :: run.post_pr.remediation.push: not-ready push must not carry remote, local, or publication authority" },
  { name: "post-pr-push-not-ready: cross-bound-identity (cross-bound local_head_sha)", record_id: "post-pr-push-not-ready", family: "cross-bound-identity", target_label: "cross-bound local_head_sha", consumer: "transitionPostPrState", rejector: "transitionPostPrState :: ValidationError :: run.post_pr.remediation.push: not-ready push must not carry remote, local, or publication authority" },
  { name: "post-pr-push-pending: missing-key (required field)", record_id: "post-pr-push-pending", family: "missing-key", target_label: "required field", consumer: "validateRun", rejector: "validatePostPr :: run.post_pr.remediation.push.status :: must be one of not-ready, pending, confirmed" },
  { name: "post-pr-push-pending: unknown-key (record root)", record_id: "post-pr-push-pending", family: "unknown-key", target_label: "record root", consumer: "validateRun", rejector: "validatePostPr :: run.post_pr.remediation.push.unexpected_authority_key :: is not allowed" },
  { name: "post-pr-push-pending: wrong-time (timestamp pushed_at)", record_id: "post-pr-push-pending", family: "wrong-time", target_label: "timestamp pushed_at", consumer: "transitionPostPrState", rejector: "transitionPostPrState :: ValidationError :: run.post_pr.remediation.push.pushed_at: must be an ISO timestamp or null; run.post_pr.remediation.push: pending push must bind remote_before and the current candidate only" },
  { name: "post-pr-push-pending: wrong-type (typed field)", record_id: "post-pr-push-pending", family: "wrong-type", target_label: "typed field", consumer: "validateRun", rejector: "validatePostPr :: run.post_pr.remediation.push.consecutive_transient_errors :: must be an integer from 0 to 9007199254740991" },
  { name: "post-pr-push-pending: stale-identity (stale remote_before_sha)", record_id: "post-pr-push-pending", family: "stale-identity", target_label: "stale remote_before_sha", consumer: "transitionPostPrState", rejector: "transitionPostPrState :: Error :: post-PR remediation push.remote_before_sha cannot change once bound" },
  { name: "post-pr-push-pending: cross-bound-identity (cross-bound local_head_sha)", record_id: "post-pr-push-pending", family: "cross-bound-identity", target_label: "cross-bound local_head_sha", consumer: "validateRun", rejector: "validatePostPr :: run.post_pr.remediation.push.local_head_sha :: must equal candidate_head_sha while push is pending" },
  { name: "post-pr-push-confirmed: missing-key (required field)", record_id: "post-pr-push-confirmed", family: "missing-key", target_label: "required field", consumer: "validateRun", rejector: "validatePostPr :: run.post_pr.remediation.push.status :: must be one of not-ready, pending, confirmed" },
  { name: "post-pr-push-confirmed: unknown-key (record root)", record_id: "post-pr-push-confirmed", family: "unknown-key", target_label: "record root", consumer: "validateRun", rejector: "validatePostPr :: run.post_pr.remediation.push.unexpected_authority_key :: is not allowed" },
  { name: "post-pr-push-confirmed: wrong-time (timestamp pushed_at)", record_id: "post-pr-push-confirmed", family: "wrong-time", target_label: "timestamp pushed_at", consumer: "transitionPostPrState", rejector: "transitionPostPrState :: Error :: post-PR remediation push.pushed_at cannot change once bound" },
  { name: "post-pr-push-confirmed: wrong-type (typed field)", record_id: "post-pr-push-confirmed", family: "wrong-type", target_label: "typed field", consumer: "validateRun", rejector: "validatePostPr :: run.post_pr.remediation.push.consecutive_transient_errors :: must be an integer from 0 to 9007199254740991" },
  { name: "post-pr-push-confirmed: stale-identity (stale remote_before_sha)", record_id: "post-pr-push-confirmed", family: "stale-identity", target_label: "stale remote_before_sha", consumer: "transitionPostPrState", rejector: "transitionPostPrState :: Error :: post-PR remediation push.remote_before_sha cannot change once bound" },
  { name: "post-pr-push-confirmed: cross-bound-identity (cross-bound local_head_sha)", record_id: "post-pr-push-confirmed", family: "cross-bound-identity", target_label: "cross-bound local_head_sha", consumer: "transitionPostPrState", rejector: "transitionPostPrState :: Error :: post-PR remediation push.local_head_sha cannot change once bound" },
  { name: "post-pr-push-last-error: missing-key (required field)", record_id: "post-pr-push-last-error", family: "missing-key", target_label: "required field", consumer: "validateRun", rejector: "validatePostPr :: run.post_pr.remediation.push.last_error.operation :: must be one of remote-head, fast-forward-push, remote-confirmation" },
  { name: "post-pr-push-last-error: unknown-key (record root)", record_id: "post-pr-push-last-error", family: "unknown-key", target_label: "record root", consumer: "validateRun", rejector: "validatePostPr :: run.post_pr.remediation.push.last_error.unexpected_authority_key :: is not allowed" },
  { name: "post-pr-push-last-error: wrong-time (timestamp observed_at)", record_id: "post-pr-push-last-error", family: "wrong-time", target_label: "timestamp observed_at", consumer: "transitionPostPrState", rejector: "transitionPostPrState :: ValidationError :: run.post_pr.remediation.push.last_error.observed_at: must be an ISO timestamp" },
  { name: "post-pr-push-last-error: wrong-type (typed field)", record_id: "post-pr-push-last-error", family: "wrong-type", target_label: "typed field", consumer: "transitionPostPrState", rejector: "transitionPostPrState :: ValidationError :: run.post_pr.remediation.push.last_error.exit_code: must be a non-negative integer" },
  { name: "post-pr-push-last-error: stale-identity (stale next_retry_at)", record_id: "post-pr-push-last-error", family: "stale-identity", target_label: "stale next_retry_at", consumer: "transitionPostPrState", rejector: "transitionPostPrState :: ValidationError :: run.post_pr.remediation.push.last_error.next_retry_at: must equal push.next_retry_at" },
  { name: "post-pr-push-last-error: cross-bound-identity (cross-bound candidate_head_sha)", record_id: "post-pr-push-last-error", family: "cross-bound-identity", target_label: "cross-bound candidate_head_sha", consumer: "transitionPostPrState", rejector: "transitionPostPrState :: ValidationError :: run.post_pr.remediation.push.last_error.candidate_head_sha: must equal remediation candidate_head_sha" },
  { name: "post-pr-evidence-sidecar: missing-key (required field)", record_id: "post-pr-evidence-sidecar", family: "missing-key", target_label: "required field", consumer: "validateRun", rejector: "validatePostPr :: run.post_pr.evidence_refs[0].ref :: must be a non-empty string" },
  { name: "post-pr-evidence-sidecar: unknown-key (record root)", record_id: "post-pr-evidence-sidecar", family: "unknown-key", target_label: "record root", consumer: "validateRun", rejector: "validatePostPr :: run.post_pr.evidence_refs[0].unexpected_authority_key :: is not allowed" },
  { name: "post-pr-evidence-sidecar: wrong-type (typed field)", record_id: "post-pr-evidence-sidecar", family: "wrong-type", target_label: "typed field", consumer: "validateRun", rejector: "validatePostPr :: run.post_pr.evidence_refs[0].hash :: must be a sha256 hash" },
  { name: "post-pr-evidence-sidecar: wrong-ref (sidecar ref)", record_id: "post-pr-evidence-sidecar", family: "wrong-ref", target_label: "sidecar ref", consumer: "validateRun", rejector: "validatePostPr :: run.post_pr.evidence_refs :: must bind the current failure evidence ref/hash" },
  { name: "post-pr-evidence-sidecar: wrong-hash (sidecar hash)", record_id: "post-pr-evidence-sidecar", family: "wrong-hash", target_label: "sidecar hash", consumer: "validateRun", rejector: "validatePostPr :: run.post_pr.evidence_refs :: must bind the current failure evidence ref/hash" },
  { name: "post-pr-evidence-sidecar: wrong-bytes (sidecar sidecar bytes)", record_id: "post-pr-evidence-sidecar", family: "wrong-bytes", target_label: "sidecar sidecar bytes", consumer: "checkRunConsistency", rejector: "checkRunConsistency :: run.post_pr.evidence_refs[0] :: run.post_pr.evidence_refs[0].hash :: must match referenced file" },
  { name: "post-pr-evidence-sidecar: stale-identity (stale hash)", record_id: "post-pr-evidence-sidecar", family: "stale-identity", target_label: "stale hash", consumer: "validateRun", rejector: "validatePostPr :: run.post_pr.evidence_refs :: must bind the current failure evidence ref/hash" },
  { name: "post-pr-evidence-sidecar: cross-bound-identity (cross-bound ref)", record_id: "post-pr-evidence-sidecar", family: "cross-bound-identity", target_label: "cross-bound ref", consumer: "validateRun", rejector: "validatePostPr :: run.post_pr.evidence_refs :: must bind the current failure evidence ref/hash" },
  { name: "post-pr-continuation-review-null: missing-key (required field)", record_id: "post-pr-continuation-review-null", family: "missing-key", target_label: "required field", consumer: "transitionPostPrState", rejector: "transitionPostPrState :: Error :: post-PR transition rejected: terminal run 'completed'" },
  { name: "post-pr-continuation-review-null: unknown-key (record root)", record_id: "post-pr-continuation-review-null", family: "unknown-key", target_label: "record root", consumer: "validateRun", rejector: "validatePostPr :: run.post_pr.unexpected_authority_key :: is not allowed" },
  { name: "post-pr-continuation-review-null: wrong-type (typed field)", record_id: "post-pr-continuation-review-null", family: "wrong-type", target_label: "typed field", consumer: "validateRun", rejector: "validatePostPr :: run.post_pr.continuation_review.ref :: must be a non-empty string" },
  { name: "post-pr-continuation-review-null: stale-identity (stale phase)", record_id: "post-pr-continuation-review-null", family: "stale-identity", target_label: "stale phase", consumer: "validateRun", rejector: "validatePostPr :: run.status :: must be blocked when post-PR phase is blocked" },
  { name: "post-pr-continuation-review-null: cross-bound-identity (cross-bound continuation_review)", record_id: "post-pr-continuation-review-null", family: "cross-bound-identity", target_label: "cross-bound continuation_review", consumer: "validateRun", rejector: "validatePostPr :: run.post_pr.continuation_review.from_other_attempt :: is not allowed" },
  { name: "post-pr-continuation-review-bound: missing-key (required field)", record_id: "post-pr-continuation-review-bound", family: "missing-key", target_label: "required field", consumer: "validateRun", rejector: "validatePostPr :: run.post_pr.continuation_review.ref :: must be a non-empty string" },
  { name: "post-pr-continuation-review-bound: unknown-key (record root)", record_id: "post-pr-continuation-review-bound", family: "unknown-key", target_label: "record root", consumer: "validateRun", rejector: "validatePostPr :: run.post_pr.continuation_review.unexpected_authority_key :: is not allowed" },
  { name: "post-pr-continuation-review-bound: wrong-type (typed field)", record_id: "post-pr-continuation-review-bound", family: "wrong-type", target_label: "typed field", consumer: "validateRun", rejector: "validatePostPr :: run.post_pr.continuation_review.hash :: must be a sha256 hash" },
  { name: "post-pr-continuation-review-bound: wrong-ref (continuation-review ref)", record_id: "post-pr-continuation-review-bound", family: "wrong-ref", target_label: "continuation-review ref", consumer: "checkRunConsistency", rejector: "checkRunConsistency :: run.post_pr.evidence_refs[0] :: run.post_pr.evidence_refs[0] :: missing evidence ref: evidence/post-pr-ci.attempt-1.json" },
  { name: "post-pr-continuation-review-bound: wrong-hash (continuation-review hash)", record_id: "post-pr-continuation-review-bound", family: "wrong-hash", target_label: "continuation-review hash", consumer: "checkRunConsistency", rejector: "checkRunConsistency :: run.post_pr.evidence_refs[0] :: run.post_pr.evidence_refs[0] :: missing evidence ref: evidence/post-pr-ci.attempt-1.json" },
  { name: "post-pr-continuation-review-bound: wrong-bytes (continuation-review sidecar bytes)", record_id: "post-pr-continuation-review-bound", family: "wrong-bytes", target_label: "continuation-review sidecar bytes", consumer: "checkRunConsistency", rejector: "checkRunConsistency :: run.post_pr.evidence_refs[0] :: run.post_pr.evidence_refs[0] :: missing evidence ref: evidence/post-pr-ci.attempt-1.json" },
  { name: "post-pr-continuation-review-bound: stale-identity (stale hash)", record_id: "post-pr-continuation-review-bound", family: "stale-identity", target_label: "stale hash", consumer: "transitionPostPrState", rejector: "transitionPostPrState :: Error :: post-PR transition rejected: terminal run 'blocked'" },
  { name: "post-pr-continuation-review-bound: cross-bound-identity (cross-bound ref)", record_id: "post-pr-continuation-review-bound", family: "cross-bound-identity", target_label: "cross-bound ref", consumer: "transitionPostPrState", rejector: "transitionPostPrState :: Error :: post-PR transition rejected: terminal run 'blocked'" },
  { name: "post-pr-terminal-fact-null: missing-key (required field)", record_id: "post-pr-terminal-fact-null", family: "missing-key", target_label: "required field", consumer: "transitionPostPrState", rejector: "transitionPostPrState :: Error :: post-PR transition rejected: terminal run 'completed'" },
  { name: "post-pr-terminal-fact-null: unknown-key (record root)", record_id: "post-pr-terminal-fact-null", family: "unknown-key", target_label: "record root", consumer: "validateRun", rejector: "validatePostPr :: run.post_pr.unexpected_authority_key :: is not allowed" },
  { name: "post-pr-terminal-fact-null: wrong-type (typed field)", record_id: "post-pr-terminal-fact-null", family: "wrong-type", target_label: "typed field", consumer: "validateRun", rejector: "validatePostPr :: run.post_pr.terminal_fact :: is allowed only for fact-bound post-PR terminal reasons" },
  { name: "post-pr-terminal-fact-null: stale-identity (stale phase)", record_id: "post-pr-terminal-fact-null", family: "stale-identity", target_label: "stale phase", consumer: "validateRun", rejector: "validatePostPr :: run.status :: must be blocked when post-PR phase is blocked" },
  { name: "post-pr-terminal-fact-null: cross-bound-identity (cross-bound terminal_fact)", record_id: "post-pr-terminal-fact-null", family: "cross-bound-identity", target_label: "cross-bound terminal_fact", consumer: "validateRun", rejector: "validatePostPr :: run.post_pr.terminal_fact :: is allowed only for fact-bound post-PR terminal reasons" },
  { name: "post-pr-terminal-fact-account-switch-failed-github-auth: missing-key (required field)", record_id: "post-pr-terminal-fact-account-switch-failed-github-auth", family: "missing-key", target_label: "required field", consumer: "validateRun", rejector: "validatePostPr :: run.post_pr.terminal_fact.kind :: must be one of account-switch-failed" },
  { name: "post-pr-terminal-fact-account-switch-failed-github-auth: unknown-key (record root)", record_id: "post-pr-terminal-fact-account-switch-failed-github-auth", family: "unknown-key", target_label: "record root", consumer: "validateRun", rejector: "validatePostPr :: run.post_pr.terminal_fact.unexpected_authority_key :: is not allowed" },
  { name: "post-pr-terminal-fact-account-switch-failed-github-auth: wrong-schema (schema version)", record_id: "post-pr-terminal-fact-account-switch-failed-github-auth", family: "wrong-schema", target_label: "schema version", consumer: "validateRun", rejector: "validatePostPr :: run.post_pr.terminal_fact.schema_version :: must equal 1" },
  { name: "post-pr-terminal-fact-account-switch-failed-github-auth: wrong-kind (kind)", record_id: "post-pr-terminal-fact-account-switch-failed-github-auth", family: "wrong-kind", target_label: "kind", consumer: "validateRun", rejector: "validatePostPr :: run.post_pr.terminal_fact.kind :: must be one of account-switch-failed" },
  { name: "post-pr-terminal-fact-account-switch-failed-github-auth: wrong-time (timestamp observed_at)", record_id: "post-pr-terminal-fact-account-switch-failed-github-auth", family: "wrong-time", target_label: "timestamp observed_at", consumer: "validateRun", rejector: "validatePostPr :: run.post_pr.terminal_fact.observed_at :: must be an ISO timestamp" },
  { name: "post-pr-terminal-fact-account-switch-failed-github-auth: wrong-type (typed field)", record_id: "post-pr-terminal-fact-account-switch-failed-github-auth", family: "wrong-type", target_label: "typed field", consumer: "validateRun", rejector: "validatePostPr :: run.post_pr.terminal_fact.exit_code :: must be an integer from 0 to 255" },
  { name: "post-pr-terminal-fact-account-switch-failed-github-auth: stale-identity (stale exit_code)", record_id: "post-pr-terminal-fact-account-switch-failed-github-auth", family: "stale-identity", target_label: "stale exit_code", consumer: "validateRun", rejector: "validatePostPr :: run.post_pr.terminal_fact :: must bind the persisted account-switch error exactly" },
  { name: "post-pr-terminal-fact-account-switch-failed-github-auth: cross-bound-identity (cross-bound github_account)", record_id: "post-pr-terminal-fact-account-switch-failed-github-auth", family: "cross-bound-identity", target_label: "cross-bound github_account", consumer: "validateRun", rejector: "validatePostPr :: run.post_pr.terminal_fact.github_account :: must match run.github_account" },
  { name: "post-pr-terminal-fact-account-switch-failed-push: missing-key (required field)", record_id: "post-pr-terminal-fact-account-switch-failed-push", family: "missing-key", target_label: "required field", consumer: "validateRun", rejector: "validatePostPr :: run.post_pr.terminal_fact.kind :: must be one of account-switch-failed" },
  { name: "post-pr-terminal-fact-account-switch-failed-push: unknown-key (record root)", record_id: "post-pr-terminal-fact-account-switch-failed-push", family: "unknown-key", target_label: "record root", consumer: "validateRun", rejector: "validatePostPr :: run.post_pr.terminal_fact.unexpected_authority_key :: is not allowed" },
  { name: "post-pr-terminal-fact-account-switch-failed-push: wrong-schema (schema version)", record_id: "post-pr-terminal-fact-account-switch-failed-push", family: "wrong-schema", target_label: "schema version", consumer: "validateRun", rejector: "validatePostPr :: run.post_pr.terminal_fact.schema_version :: must equal 1" },
  { name: "post-pr-terminal-fact-account-switch-failed-push: wrong-kind (kind)", record_id: "post-pr-terminal-fact-account-switch-failed-push", family: "wrong-kind", target_label: "kind", consumer: "validateRun", rejector: "validatePostPr :: run.post_pr.terminal_fact.kind :: must be one of account-switch-failed" },
  { name: "post-pr-terminal-fact-account-switch-failed-push: wrong-time (timestamp observed_at)", record_id: "post-pr-terminal-fact-account-switch-failed-push", family: "wrong-time", target_label: "timestamp observed_at", consumer: "validateRun", rejector: "validatePostPr :: run.post_pr.terminal_fact.observed_at :: must be an ISO timestamp" },
  { name: "post-pr-terminal-fact-account-switch-failed-push: wrong-type (typed field)", record_id: "post-pr-terminal-fact-account-switch-failed-push", family: "wrong-type", target_label: "typed field", consumer: "validateRun", rejector: "validatePostPr :: run.post_pr.terminal_fact.attempt :: must be an integer from 1 to 9007199254740991" },
  { name: "post-pr-terminal-fact-account-switch-failed-push: stale-identity (stale attempt)", record_id: "post-pr-terminal-fact-account-switch-failed-push", family: "stale-identity", target_label: "stale attempt", consumer: "validateRun", rejector: "validatePostPr :: run.post_pr.terminal_fact.attempt :: must be an integer from 1 to 9007199254740991" },
  { name: "post-pr-terminal-fact-account-switch-failed-push: cross-bound-identity (cross-bound candidate_head_sha)", record_id: "post-pr-terminal-fact-account-switch-failed-push", family: "cross-bound-identity", target_label: "cross-bound candidate_head_sha", consumer: "transitionPostPrState", rejector: "transitionPostPrState :: Error :: post-PR transition rejected: terminal run 'needs-human'" },
  { name: "post-pr-terminal-fact-dispatch-start-unknown: missing-key (required field)", record_id: "post-pr-terminal-fact-dispatch-start-unknown", family: "missing-key", target_label: "required field", consumer: "validateRun", rejector: "validatePostPr :: run.post_pr.terminal_fact.kind :: must be one of dispatch-start-unknown" },
  { name: "post-pr-terminal-fact-dispatch-start-unknown: unknown-key (record root)", record_id: "post-pr-terminal-fact-dispatch-start-unknown", family: "unknown-key", target_label: "record root", consumer: "validateRun", rejector: "validatePostPr :: run.post_pr.terminal_fact.unexpected_authority_key :: is not allowed" },
  { name: "post-pr-terminal-fact-dispatch-start-unknown: wrong-schema (schema version)", record_id: "post-pr-terminal-fact-dispatch-start-unknown", family: "wrong-schema", target_label: "schema version", consumer: "validateRun", rejector: "validatePostPr :: run.post_pr.terminal_fact.schema_version :: must equal 1" },
  { name: "post-pr-terminal-fact-dispatch-start-unknown: wrong-kind (kind)", record_id: "post-pr-terminal-fact-dispatch-start-unknown", family: "wrong-kind", target_label: "kind", consumer: "validateRun", rejector: "validatePostPr :: run.post_pr.terminal_fact.kind :: must be one of dispatch-start-unknown" },
  { name: "post-pr-terminal-fact-dispatch-start-unknown: wrong-time (timestamp observed_at)", record_id: "post-pr-terminal-fact-dispatch-start-unknown", family: "wrong-time", target_label: "timestamp observed_at", consumer: "validateRun", rejector: "validatePostPr :: run.post_pr.terminal_fact.observed_at :: must be an ISO timestamp" },
  { name: "post-pr-terminal-fact-dispatch-start-unknown: wrong-type (typed field)", record_id: "post-pr-terminal-fact-dispatch-start-unknown", family: "wrong-type", target_label: "typed field", consumer: "validateRun", rejector: "validatePostPr :: run.post_pr.terminal_fact.attempt :: must be an integer from 1 to 9007199254740991" },
  { name: "post-pr-terminal-fact-dispatch-start-unknown: stale-identity (stale attempt)", record_id: "post-pr-terminal-fact-dispatch-start-unknown", family: "stale-identity", target_label: "stale attempt", consumer: "validateRun", rejector: "validatePostPr :: run.post_pr.terminal_fact.attempt :: must be an integer from 1 to 9007199254740991" },
  { name: "post-pr-terminal-fact-dispatch-start-unknown: cross-bound-identity (cross-bound dispatch_id)", record_id: "post-pr-terminal-fact-dispatch-start-unknown", family: "cross-bound-identity", target_label: "cross-bound dispatch_id", consumer: "validateRun", rejector: "validatePostPr :: run.post_pr.terminal_fact :: must bind the running dispatch identity exactly" },
  { name: "post-pr-terminal-fact-path-lane-violation: missing-key (required field)", record_id: "post-pr-terminal-fact-path-lane-violation", family: "missing-key", target_label: "required field", consumer: "validateRun", rejector: "validatePostPr :: run.post_pr.terminal_fact.kind :: must be one of path-lane-violation" },
  { name: "post-pr-terminal-fact-path-lane-violation: unknown-key (record root)", record_id: "post-pr-terminal-fact-path-lane-violation", family: "unknown-key", target_label: "record root", consumer: "validateRun", rejector: "validatePostPr :: run.post_pr.terminal_fact.unexpected_authority_key :: is not allowed" },
  { name: "post-pr-terminal-fact-path-lane-violation: wrong-schema (schema version)", record_id: "post-pr-terminal-fact-path-lane-violation", family: "wrong-schema", target_label: "schema version", consumer: "validateRun", rejector: "validatePostPr :: run.post_pr.terminal_fact.schema_version :: must equal 1" },
  { name: "post-pr-terminal-fact-path-lane-violation: wrong-kind (kind)", record_id: "post-pr-terminal-fact-path-lane-violation", family: "wrong-kind", target_label: "kind", consumer: "validateRun", rejector: "validatePostPr :: run.post_pr.terminal_fact.kind :: must be one of path-lane-violation" },
  { name: "post-pr-terminal-fact-path-lane-violation: wrong-time (timestamp observed_at)", record_id: "post-pr-terminal-fact-path-lane-violation", family: "wrong-time", target_label: "timestamp observed_at", consumer: "validateRun", rejector: "validatePostPr :: run.post_pr.terminal_fact.observed_at :: must be an ISO timestamp" },
  { name: "post-pr-terminal-fact-path-lane-violation: wrong-type (typed field)", record_id: "post-pr-terminal-fact-path-lane-violation", family: "wrong-type", target_label: "typed field", consumer: "validateRun", rejector: "validatePostPr :: run.post_pr.terminal_fact.attempt :: must be an integer from 1 to 9007199254740991" },
  { name: "post-pr-terminal-fact-path-lane-violation: stale-identity (stale attempt)", record_id: "post-pr-terminal-fact-path-lane-violation", family: "stale-identity", target_label: "stale attempt", consumer: "validateRun", rejector: "validatePostPr :: run.post_pr.terminal_fact.attempt :: must be an integer from 1 to 9007199254740991" },
  { name: "post-pr-terminal-fact-path-lane-violation: cross-bound-identity (cross-bound lane)", record_id: "post-pr-terminal-fact-path-lane-violation", family: "cross-bound-identity", target_label: "cross-bound lane", consumer: "validateRun", rejector: "validatePostPr :: run.post_pr.terminal_fact :: must bind the remediation lane and changed paths exactly" },
  { name: "post-pr-terminal-fact-remote-head-diverged: missing-key (required field)", record_id: "post-pr-terminal-fact-remote-head-diverged", family: "missing-key", target_label: "required field", consumer: "validateRun", rejector: "validatePostPr :: run.post_pr.terminal_fact.kind :: must be one of remote-head-diverged" },
  { name: "post-pr-terminal-fact-remote-head-diverged: unknown-key (record root)", record_id: "post-pr-terminal-fact-remote-head-diverged", family: "unknown-key", target_label: "record root", consumer: "validateRun", rejector: "validatePostPr :: run.post_pr.terminal_fact.unexpected_authority_key :: is not allowed" },
  { name: "post-pr-terminal-fact-remote-head-diverged: wrong-schema (schema version)", record_id: "post-pr-terminal-fact-remote-head-diverged", family: "wrong-schema", target_label: "schema version", consumer: "validateRun", rejector: "validatePostPr :: run.post_pr.terminal_fact.schema_version :: must equal 1" },
  { name: "post-pr-terminal-fact-remote-head-diverged: wrong-kind (kind)", record_id: "post-pr-terminal-fact-remote-head-diverged", family: "wrong-kind", target_label: "kind", consumer: "validateRun", rejector: "validatePostPr :: run.post_pr.terminal_fact.kind :: must be one of remote-head-diverged" },
  { name: "post-pr-terminal-fact-remote-head-diverged: wrong-time (timestamp observed_at)", record_id: "post-pr-terminal-fact-remote-head-diverged", family: "wrong-time", target_label: "timestamp observed_at", consumer: "validateRun", rejector: "validatePostPr :: run.post_pr.terminal_fact.observed_at :: must be an ISO timestamp" },
  { name: "post-pr-terminal-fact-remote-head-diverged: wrong-type (typed field)", record_id: "post-pr-terminal-fact-remote-head-diverged", family: "wrong-type", target_label: "typed field", consumer: "validateRun", rejector: "validatePostPr :: run.post_pr.terminal_fact.attempt :: must be an integer from 1 to 9007199254740991" },
  { name: "post-pr-terminal-fact-remote-head-diverged: stale-identity (stale attempt)", record_id: "post-pr-terminal-fact-remote-head-diverged", family: "stale-identity", target_label: "stale attempt", consumer: "validateRun", rejector: "validatePostPr :: run.post_pr.terminal_fact.attempt :: must be an integer from 1 to 9007199254740991" },
  { name: "post-pr-terminal-fact-remote-head-diverged: cross-bound-identity (cross-bound candidate_head_sha)", record_id: "post-pr-terminal-fact-remote-head-diverged", family: "cross-bound-identity", target_label: "cross-bound candidate_head_sha", consumer: "validateRun", rejector: "validatePostPr :: run.post_pr.terminal_fact :: must bind the push-pending remote and candidate heads exactly" },
  { name: "post-pr-terminal-fact-panel-runner-result-malformed: missing-key (required field)", record_id: "post-pr-terminal-fact-panel-runner-result-malformed", family: "missing-key", target_label: "required field", consumer: "validateRun", rejector: "validatePostPr :: run.post_pr.terminal_fact :: is allowed only for fact-bound post-PR terminal reasons" },
  { name: "post-pr-terminal-fact-panel-runner-result-malformed: unknown-key (record root)", record_id: "post-pr-terminal-fact-panel-runner-result-malformed", family: "unknown-key", target_label: "record root", consumer: "validateRun", rejector: "validatePostPr :: run.post_pr.terminal_fact.unexpected_authority_key :: is not allowed" },
  { name: "post-pr-terminal-fact-panel-runner-result-malformed: wrong-schema (schema version)", record_id: "post-pr-terminal-fact-panel-runner-result-malformed", family: "wrong-schema", target_label: "schema version", consumer: "validateRun", rejector: "validatePostPr :: run.post_pr.terminal_fact.schema_version :: must equal 1" },
  { name: "post-pr-terminal-fact-panel-runner-result-malformed: wrong-kind (kind)", record_id: "post-pr-terminal-fact-panel-runner-result-malformed", family: "wrong-kind", target_label: "kind", consumer: "validateRun", rejector: "validatePostPr :: run.post_pr.terminal_fact :: is allowed only for fact-bound post-PR terminal reasons" },
  { name: "post-pr-terminal-fact-panel-runner-result-malformed: wrong-time (timestamp observed_at)", record_id: "post-pr-terminal-fact-panel-runner-result-malformed", family: "wrong-time", target_label: "timestamp observed_at", consumer: "validateRun", rejector: "validatePostPr :: run.post_pr.terminal_fact.observed_at :: must be an ISO timestamp" },
  { name: "post-pr-terminal-fact-panel-runner-result-malformed: wrong-type (typed field)", record_id: "post-pr-terminal-fact-panel-runner-result-malformed", family: "wrong-type", target_label: "typed field", consumer: "validateRun", rejector: "validatePostPr :: run.post_pr.terminal_fact.attempt :: must be an integer from 1 to 9007199254740991" },
  { name: "post-pr-terminal-fact-panel-runner-result-malformed: stale-identity (stale attempt)", record_id: "post-pr-terminal-fact-panel-runner-result-malformed", family: "stale-identity", target_label: "stale attempt", consumer: "validateRun", rejector: "validatePostPr :: run.post_pr.terminal_fact.attempt :: must be an integer from 1 to 9007199254740991" },
  { name: "post-pr-terminal-fact-panel-runner-result-malformed: cross-bound-identity (cross-bound dispatch_id)", record_id: "post-pr-terminal-fact-panel-runner-result-malformed", family: "cross-bound-identity", target_label: "cross-bound dispatch_id", consumer: "validateRun", rejector: "validatePostPr :: run.post_pr.terminal_fact :: must bind the running panel job exactly" },
  { name: "post-pr-terminal-fact-push-failed: missing-key (required field)", record_id: "post-pr-terminal-fact-push-failed", family: "missing-key", target_label: "required field", consumer: "validateRun", rejector: "validatePostPr :: run.post_pr.terminal_fact.kind :: must be one of push-failed" },
  { name: "post-pr-terminal-fact-push-failed: unknown-key (record root)", record_id: "post-pr-terminal-fact-push-failed", family: "unknown-key", target_label: "record root", consumer: "validateRun", rejector: "validatePostPr :: run.post_pr.terminal_fact.unexpected_authority_key :: is not allowed" },
  { name: "post-pr-terminal-fact-push-failed: wrong-schema (schema version)", record_id: "post-pr-terminal-fact-push-failed", family: "wrong-schema", target_label: "schema version", consumer: "validateRun", rejector: "validatePostPr :: run.post_pr.terminal_fact.schema_version :: must equal 1" },
  { name: "post-pr-terminal-fact-push-failed: wrong-kind (kind)", record_id: "post-pr-terminal-fact-push-failed", family: "wrong-kind", target_label: "kind", consumer: "validateRun", rejector: "validatePostPr :: run.post_pr.terminal_fact.kind :: must be one of push-failed" },
  { name: "post-pr-terminal-fact-push-failed: wrong-time (timestamp observed_at)", record_id: "post-pr-terminal-fact-push-failed", family: "wrong-time", target_label: "timestamp observed_at", consumer: "validateRun", rejector: "validatePostPr :: run.post_pr.terminal_fact.observed_at :: must be an ISO timestamp" },
  { name: "post-pr-terminal-fact-push-failed: wrong-type (typed field)", record_id: "post-pr-terminal-fact-push-failed", family: "wrong-type", target_label: "typed field", consumer: "validateRun", rejector: "validatePostPr :: run.post_pr.terminal_fact.attempt :: must be an integer from 1 to 9007199254740991" },
  { name: "post-pr-terminal-fact-push-failed: stale-identity (stale attempt)", record_id: "post-pr-terminal-fact-push-failed", family: "stale-identity", target_label: "stale attempt", consumer: "validateRun", rejector: "validatePostPr :: run.post_pr.terminal_fact.attempt :: must be an integer from 1 to 9007199254740991" },
  { name: "post-pr-terminal-fact-push-failed: cross-bound-identity (cross-bound candidate_head_sha)", record_id: "post-pr-terminal-fact-push-failed", family: "cross-bound-identity", target_label: "cross-bound candidate_head_sha", consumer: "transitionPostPrState", rejector: "transitionPostPrState :: Error :: post-PR transition rejected: terminal run 'needs-human'" },
  { name: "post-pr-terminal-fact-panel-attribution-unsafe: missing-key (required field)", record_id: "post-pr-terminal-fact-panel-attribution-unsafe", family: "missing-key", target_label: "required field", consumer: "validateRun", rejector: "validatePostPr :: run.post_pr.terminal_fact.kind :: must be one of panel-attribution-unsafe" },
  { name: "post-pr-terminal-fact-panel-attribution-unsafe: unknown-key (record root)", record_id: "post-pr-terminal-fact-panel-attribution-unsafe", family: "unknown-key", target_label: "record root", consumer: "validateRun", rejector: "validatePostPr :: run.post_pr.terminal_fact.unexpected_authority_key :: is not allowed" },
  { name: "post-pr-terminal-fact-panel-attribution-unsafe: wrong-schema (schema version)", record_id: "post-pr-terminal-fact-panel-attribution-unsafe", family: "wrong-schema", target_label: "schema version", consumer: "validateRun", rejector: "validatePostPr :: run.post_pr.terminal_fact.schema_version :: must equal 1" },
  { name: "post-pr-terminal-fact-panel-attribution-unsafe: wrong-kind (kind)", record_id: "post-pr-terminal-fact-panel-attribution-unsafe", family: "wrong-kind", target_label: "kind", consumer: "validateRun", rejector: "validatePostPr :: run.post_pr.terminal_fact.kind :: must be one of panel-attribution-unsafe" },
  { name: "post-pr-terminal-fact-panel-attribution-unsafe: wrong-time (timestamp observed_at)", record_id: "post-pr-terminal-fact-panel-attribution-unsafe", family: "wrong-time", target_label: "timestamp observed_at", consumer: "validateRun", rejector: "validatePostPr :: run.post_pr.terminal_fact.observed_at :: must be an ISO timestamp" },
  { name: "post-pr-terminal-fact-panel-attribution-unsafe: wrong-type (typed field)", record_id: "post-pr-terminal-fact-panel-attribution-unsafe", family: "wrong-type", target_label: "typed field", consumer: "validateRun", rejector: "validatePostPr :: run.post_pr.terminal_fact.attempt :: must be an integer from 1 to 9007199254740991" },
  { name: "post-pr-terminal-fact-panel-attribution-unsafe: stale-identity (stale attempt)", record_id: "post-pr-terminal-fact-panel-attribution-unsafe", family: "stale-identity", target_label: "stale attempt", consumer: "validateRun", rejector: "validatePostPr :: run.post_pr.terminal_fact.attempt :: must be an integer from 1 to 9007199254740991" },
  { name: "post-pr-terminal-fact-panel-attribution-unsafe: cross-bound-identity (cross-bound panel)", record_id: "post-pr-terminal-fact-panel-attribution-unsafe", family: "cross-bound-identity", target_label: "cross-bound panel", consumer: "transitionPostPrState", rejector: "transitionPostPrState :: Error :: post-PR transition rejected: terminal run 'needs-human'" },
]);

const B0M4_LITERAL_ROW_COUNTS = Object.freeze({
  "post-pr-phase-disabled": 6,
  "post-pr-phase-awaiting-pr": 6,
  "post-pr-phase-observing": 6,
  "post-pr-phase-failure-recording": 6,
  "post-pr-phase-remediation-planned": 6,
  "post-pr-phase-remediation-running": 6,
  "post-pr-phase-changes-observed": 11,
  "post-pr-phase-committed": 11,
  "post-pr-phase-revalidating": 11,
  "post-pr-phase-validated": 11,
  "post-pr-phase-push-pending": 11,
  "post-pr-phase-remote-confirmed": 11,
  "post-pr-phase-succeeded": 6,
  "post-pr-phase-blocked": 6,
  "post-pr-phase-needs-human": 6,
  "post-pr-policy-disabled": 6,
  "post-pr-policy-enabled": 6,
  "post-pr-observation-null": 5,
  "post-pr-observation-active": 7,
  "post-pr-observation-last-error": 6,
  "post-pr-observation-review-request": 6,
  "post-pr-observation-snapshot": 6,
  "post-pr-remediation-null": 5,
  "post-pr-remediation-active": 13,
  "post-pr-remediation-owner": 6,
  "post-pr-remediation-changes": 7,
  "post-pr-remediation-change-entry": 7,
  "post-pr-dispatch-planned": 6,
  "post-pr-dispatch-running": 6,
  "post-pr-dispatch-returned": 6,
  "post-pr-revalidation-empty": 5,
  "post-pr-revalidation-bound": 14,
  "post-pr-canonical-job-planned": 6,
  "post-pr-canonical-job-running": 6,
  "post-pr-canonical-job-retry-wait": 6,
  "post-pr-canonical-job-bound": 8,
  "post-pr-validator-job-planned": 6,
  "post-pr-validator-job-running": 6,
  "post-pr-validator-job-retry-wait": 6,
  "post-pr-validator-job-bound": 8,
  "post-pr-security-job-planned": 6,
  "post-pr-security-job-running": 6,
  "post-pr-security-job-retry-wait": 6,
  "post-pr-security-job-bound": 8,
  "post-pr-push-not-ready": 6,
  "post-pr-push-pending": 6,
  "post-pr-push-confirmed": 6,
  "post-pr-push-last-error": 6,
  "post-pr-evidence-sidecar": 8,
  "post-pr-continuation-review-null": 5,
  "post-pr-continuation-review-bound": 8,
  "post-pr-terminal-fact-null": 5,
  "post-pr-terminal-fact-account-switch-failed-github-auth": 8,
  "post-pr-terminal-fact-account-switch-failed-push": 8,
  "post-pr-terminal-fact-dispatch-start-unknown": 8,
  "post-pr-terminal-fact-path-lane-violation": 8,
  "post-pr-terminal-fact-remote-head-diverged": 8,
  "post-pr-terminal-fact-panel-runner-result-malformed": 8,
  "post-pr-terminal-fact-push-failed": 8,
  "post-pr-terminal-fact-panel-attribution-unsafe": 8,
});
const B0M4_LITERAL_POST_PR_COUNT = 429;

const B0M4_PREREQUISITE_VALID_SCENARIOS = Object.freeze({
  "post-pr-revalidation-empty: missing-key (required field)": "post-pr",
  "post-pr-revalidation-empty: stale-identity (stale canonical_verdict)": "post-pr",
  "post-pr-revalidation-empty: cross-bound-identity (cross-bound validator_verdict)": "post-pr",
  "post-pr-canonical-job-planned: wrong-time (timestamp started_at)": "post-pr",
  "post-pr-canonical-job-planned: stale-identity (stale steering_generation)": "post-pr",
  "post-pr-canonical-job-running: wrong-time (timestamp started_at)": "post-pr",
  "post-pr-canonical-job-running: stale-identity (stale steering_generation)": "post-pr",
  "post-pr-canonical-job-retry-wait: wrong-time (timestamp next_retry_at)": "post-pr",
  "post-pr-canonical-job-retry-wait: stale-identity (stale steering_generation)": "post-pr",
  "post-pr-validator-job-planned: wrong-time (timestamp started_at)": "post-pr",
  "post-pr-validator-job-planned: stale-identity (stale steering_generation)": "post-pr",
  "post-pr-validator-job-running: wrong-time (timestamp started_at)": "post-pr",
  "post-pr-validator-job-running: stale-identity (stale steering_generation)": "post-pr",
  "post-pr-validator-job-retry-wait: wrong-time (timestamp next_retry_at)": "post-pr",
  "post-pr-validator-job-retry-wait: stale-identity (stale steering_generation)": "post-pr",
  "post-pr-security-job-planned: wrong-time (timestamp started_at)": "post-pr",
  "post-pr-security-job-planned: stale-identity (stale steering_generation)": "post-pr",
  "post-pr-security-job-running: wrong-time (timestamp started_at)": "post-pr",
  "post-pr-security-job-running: stale-identity (stale steering_generation)": "post-pr",
  "post-pr-security-job-retry-wait: wrong-time (timestamp next_retry_at)": "post-pr",
  "post-pr-security-job-retry-wait: stale-identity (stale steering_generation)": "post-pr",
  "post-pr-push-not-ready: wrong-time (timestamp pushed_at)": "post-pr",
  "post-pr-push-not-ready: stale-identity (stale remote_before_sha)": "post-pr",
  "post-pr-push-not-ready: cross-bound-identity (cross-bound local_head_sha)": "post-pr",
  "post-pr-push-pending: wrong-time (timestamp pushed_at)": "post-pr",
  "post-pr-push-last-error: wrong-time (timestamp observed_at)": "post-pr",
  "post-pr-push-last-error: wrong-type (typed field)": "post-pr",
  "post-pr-push-last-error: stale-identity (stale next_retry_at)": "post-pr",
  "post-pr-push-last-error: cross-bound-identity (cross-bound candidate_head_sha)": "post-pr",
});

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
        { family: "wrong-hash", path: ["descriptor", "hash"] },
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
    assert.match(records["wrong-hash"].descriptor.hash, /^sha256:[0-9a-f]{64}$/u);
    assert.notEqual(records["wrong-hash"].descriptor.hash, source.descriptor.hash);
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
  it("preflights the independently literal exact 429-case B0M.4 inventory and exact-name dispositions", () => {
    const dispositionByName = exactB0m4DispositionMap(B0M4_EXACT_CASES);
    const emitted = [];
    const emittedNames = new Set();
    for (const recordId of Object.keys(B0M4_LITERAL_ROW_COUNTS)) {
      const record = findRecord(DURABLE_AUTHORITY_CATALOG, recordId);
      const cases = emitDurableRecordMutations(record.source, record.descriptor, record.externalSources);
      assert.equal(cases.length, B0M4_LITERAL_ROW_COUNTS[recordId], `${recordId} exact literal row count`);
      for (const mutationCase of cases) {
        assert.equal(emittedNames.has(mutationCase.name), false, `duplicate emitted name ${mutationCase.name}`);
        emittedNames.add(mutationCase.name);
        const disposition = dispositionByName.get(mutationCase.name);
        assert.ok(disposition, `unknown emitted name ${mutationCase.name}`);
        emitted.push({ name: mutationCase.name, record_id: recordId, family: mutationCase.family, target_label: disposition.target_label, consumer: disposition.consumer, rejector: disposition.rejector });
      }
    }
    assert.equal(B0M4_EXACT_CASES.length, 429);
    assert.equal(B0M4_LITERAL_POST_PR_COUNT, 429);
    assert.equal(Object.keys(B0M4_PREREQUISITE_VALID_SCENARIOS).length, 29);
    for (const name of Object.keys(B0M4_PREREQUISITE_VALID_SCENARIOS)) assert.equal(dispositionByName.has(name), true, `unknown prerequisite-valid case ${name}`);
    assert.equal(dispositionByName.size, 429);
    assert.deepEqual(emitted, B0M4_EXACT_CASES, "missing, duplicate, unknown, reordered, or mismatched tuple/consumer/rejector must fail preflight");
    const duplicateDisposition = B0M4_EXACT_CASES.slice();
    duplicateDisposition.push(B0M4_EXACT_CASES[0]);
    assert.throws(() => exactB0m4DispositionMap(duplicateDisposition), /duplicate exact B0M\.4 case/u);
    assert.throws(() => exactB0m4DispositionMap([{ ...B0M4_EXACT_CASES[0], consumer: "" }]), /literal consumer|concrete consumer and rejector/u);
    assert.equal(DURABLE_AUTHORITY_PRODUCTION_COVERED_RECORD_IDS.length, 184);
    assert.equal(DURABLE_AUTHORITY_CATALOG.flatMap(({ records }) => records).length, 185);
    for (const id of [
      "verification-artifact-claim-active", "verification-artifact-claim-completed-pass", "verification-artifact-claim-completed-fail",
      "verification-artifact-claim-unknown-process", "verification-artifact-claim-unknown-receipt", "verification-artifact-execution-receipt-pass",
      "verification-artifact-execution-receipt-fail", "checkpoint-reviewed-plan-v1", "checkpoint-admission-probe-valid",
      "checkpoint-child-disposition-v1", "checkpoint-child-publication-v1", "checkpoint-source-v1",
      "checkpoint-progress-reserved", "checkpoint-progress-child-published", "checkpoint-progress-launched",
      "checkpoint-progress-merged", "checkpoint-progress-closed", "checkpoint-merged-completion-v1", "checkpoint-final-closure-v1",
    ]) assert.equal(DURABLE_AUTHORITY_PRODUCTION_COVERED_RECORD_IDS.includes(id), true, `${id} must be production-covered`);
    assert.equal(DURABLE_AUTHORITY_PRODUCTION_COVERED_RECORD_IDS.includes("plan-v2-integration-gate"), true);
    assert.equal(DURABLE_AUTHORITY_PRODUCTION_COVERED_RECORD_IDS.includes("plan-delivery-envelope-v1"), true);
    assert.equal(DURABLE_AUTHORITY_PRODUCTION_COVERED_RECORD_IDS.includes("review-invariant-family-ledger-v1"), true);
    assert.equal(DURABLE_AUTHORITY_PRODUCTION_COVERED_RECORD_IDS.includes("checkpoint-routing-artifact-v1"), true);
    assert.equal(DURABLE_AUTHORITY_PRODUCTION_COVERED_RECORD_IDS.includes("terminal-result-blocked-checkpoint-routing"), true);
    assert.equal(DURABLE_AUTHORITY_PRODUCTION_COVERED_RECORD_IDS.includes("final-plan-descriptor"), false);
    assert.deepEqual(
      DURABLE_AUTHORITY_CATALOG.flatMap(({ records }) => records.map(({ id }) => id)).filter((id) => !DURABLE_AUTHORITY_PRODUCTION_COVERED_RECORD_IDS.includes(id)),
      ["final-plan-descriptor"],
    );
  });

  it("executes every one of the exact 429 B0M.4 cases once through its literal concrete consumer", async () => {
    const root = mkdtempSync(join(tmpdir(), "b0m4-exact-consumers-"));
    const executed = new Set();
    try {
      for (const expected of B0M4_EXACT_CASES) {
        assert.equal(executed.has(expected.name), false, `duplicate execution ${expected.name}`);
        const record = findRecord(DURABLE_AUTHORITY_CATALOG, expected.record_id);
        const mutationCase = emitDurableRecordMutations(record.source, record.descriptor, record.externalSources).find(({ name }) => name === expected.name);
        assert.ok(mutationCase, `literal case has no emitted mutation ${expected.name}`);
        if (Object.hasOwn(B0M4_PREREQUISITE_VALID_SCENARIOS, expected.name)) {
          await consumePrerequisiteValidB0M4Case(expected, record, mutationCase, B0M4_PREREQUISITE_VALID_SCENARIOS[expected.name]);
        } else if (expected.consumer === "validateRun") {
          const fixture = createPostPrCatalogBaseline(record);
          const mutatedRun = replaceCanonicalRecord(fixture.run, record.canonicalPath, mutationCase.record);
          assert.throws(() => validateRun(mutatedRun), (error) => {
            assert.equal(error?.name, "ValidationError", `${expected.name} must reach ${expected.rejector}`);
            const [rejector, path, message] = expected.rejector.split(" :: ");
            assert.equal(rejector, "validatePostPr", expected.name);
            assert.equal(error.errors.some((item) => item.path === path && item.message === message), true, `${expected.name} exact nested path/message`);
            return true;
          });
        } else if (expected.consumer === "checkRunConsistency") {
          const fixture = createPostPrCatalogBaseline(record);
          const mutatedRun = replaceCanonicalRecord(fixture.run, record.canonicalPath, mutationCase.record);
          const runDir = join(root, String(executed.size));
          materializeCatalogSources(runDir, mutationCase.externalSources, fixture.supportSources);
          const consistency = checkRunConsistency(runDir, mutatedRun);
          assert.equal(consistency.ok, false, `${expected.name} must reach ${expected.rejector}`);
          const [, checkName, path, message] = expected.rejector.split(" :: ");
          const check = consistency.checks.find(({ name }) => name === checkName);
          assert.ok(check, `${expected.name} exact consistency check`);
          assert.equal(check.errors.some((item) => item.path === path && item.message === message), true, `${expected.name} exact consistency path/message`);
        } else if (expected.consumer === "transitionPostPrState") {
          const fixture = createPostPrCatalogBaseline(record);
          const runDir = join(root, String(executed.size));
          materializeCatalogSources(runDir, fixture.externalSources);
          writeJson(join(runDir, "run.json"), fixture.run);
          const before = readFileSync(join(runDir, "run.json"), "utf8");
          const mutatedRun = replaceCanonicalRecord(fixture.run, record.canonicalPath, mutationCase.record);
          const [, errorName, errorMessage] = expected.rejector.split(" :: ");
          await assert.rejects(transitionPostPrState(runDir, mutatedRun.post_pr, { now: "2026-07-16T12:06:00.000Z" }), (error) => error.name === errorName && error.message === errorMessage, `${expected.name} must reach ${expected.rejector}`);
          assert.equal(readFileSync(join(runDir, "run.json"), "utf8"), before, `${expected.name} protected bytes`);
        } else assert.fail(`unknown literal consumer for ${expected.name}: ${expected.consumer}`);
        executed.add(expected.name);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
    assert.equal(executed.size, 429);
    assert.deepEqual([...executed], B0M4_EXACT_CASES.map(({ name }) => name));
  });

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
    assert.equal(recordCount, 185);
  });

  it("executes every amendment reviewer claim and closure mutation through production validators", () => {
    const ids = ["amendment-review-dispatch-claim", "amendment-review-dispatch-closure"];
    const executed = new Set();
    for (const id of ids) {
      const record = findRecord(DURABLE_AUTHORITY_CATALOG, id);
      const baseline = createDurableCatalogBaseline(record);
      const validate = id.endsWith("claim")
        ? (value) => validateIntegrationAmendmentReviewDispatchClaim(value, baseline.expected)
        : (value) => validateIntegrationAmendmentReviewDispatchClosure(value, baseline.expected);
      const canonical = id.endsWith("claim") ? baseline.claim : baseline.closure;
      assert.equal(validate(canonical), canonical, `${id} canonical production row`);
      const cases = emitDurableRecordMutations(record.source, record.descriptor, record.externalSources);
      for (const mutationCase of cases) {
        assert.throws(() => validate(mutationCase.record), undefined, mutationCase.name);
        executed.add(mutationCase.name);
      }
      for (const family of DURABLE_MUTATION_FAMILIES) {
        const targeted = cases.some((mutationCase) => mutationCase.family === family);
        const excluded = typeof record.descriptor.exclusions[family] === "string" && record.descriptor.exclusions[family].trim().length > 0;
        assert.notEqual(targeted, excluded, `${id} must deliberately target or exclude ${family}`);
      }
    }
    const generated = ids.flatMap((id) => {
      const record = findRecord(DURABLE_AUTHORITY_CATALOG, id);
      return emitDurableRecordMutations(record.source, record.descriptor, record.externalSources).map(({ name }) => name);
    });
    assert.deepEqual([...executed].sort(), generated.sort());
  });

  it("registers all B1R claim and receipt variants separately", () => {
    const ids = DURABLE_AUTHORITY_REQUIRED_RECORD_IDS["steps-acceptance-inheritance"].filter((id) => id.startsWith("test-execution-"));
    assert.deepEqual(ids, [
      "test-execution-claim-active", "test-execution-claim-completed-pass", "test-execution-claim-completed-fail",
      "test-execution-claim-unknown-process-outcome-indeterminate", "test-execution-claim-unknown-authority-changed",
      "test-execution-claim-unknown-receipt-publication-indeterminate", "test-execution-receipt-pass",
      "test-execution-receipt-failed-nonzero-exit", "test-execution-receipt-failed-signal",
      "test-execution-receipt-failed-launch-error", "test-execution-receipt-failed-timeout", "test-execution-receipt-failed-output-limit",
    ]);
    for (const id of ids) {
      const record = findRecord(DURABLE_AUTHORITY_CATALOG, id);
      const baseline = createDurableCatalogBaseline(record);
      if (id.startsWith("test-execution-receipt-")) {
        assert.equal(baseline.consumer, "validateTestExecutionReceipt");
        assert.equal(validateTestExecutionReceipt(baseline.receipt), baseline.receipt);
      } else {
        assert.equal(baseline.consumer, "validateRun");
        assert.equal(validateRun(baseline.run), baseline.run);
      }
    }
  });

  it("executes every generated checked receipt mutation through production completion, replay, and applicable acceptance consumers", async () => {
    const activeClaim = findRecord(DURABLE_AUTHORITY_CATALOG, "test-execution-claim-active");
    const records = DURABLE_AUTHORITY_CATALOG
      .flatMap(({ records: catalogRecords }) => catalogRecords)
      .filter(({ id }) => id.startsWith("test-execution-receipt-"));
    const expectedCases = records.flatMap((record) => emitDurableRecordMutations(record.source, record.descriptor, record.externalSources));
    const executed = new Set();
    const root = mkdtempSync(join(tmpdir(), "checked-receipt-catalog-"));
    try {
      for (const record of records) {
        for (const [index, mutationCase] of emitDurableRecordMutations(record.source, record.descriptor, record.externalSources).entries()) {
          const consumers = record.source.status === "pass" ? ["completion", "replay", "acceptance"] : ["completion", "replay"];
          for (const consumer of consumers) {
            const fixture = await createCheckedClaimMutationFixture(root, activeClaim, `${record.id}-${index}-${consumer}`);
            const canonicalReceipt = bindCatalogReceiptToFixture(record.source, fixture);
            const mutatedReceipt = structuredClone(canonicalReceipt);
            applyMutationDifference(mutatedReceipt, record.source, mutationCase.record);
            const beforeRun = readFileSync(fixture.runFile);

            if (consumer === "completion") {
              await assert.rejects(
                completeCheckedTestExecution(fixture.runDir, fixture.claimed.claim, fixture.claimed.authority, mutatedReceipt, { now: CLAIM_NOW }),
                undefined,
                `${mutationCase.name} completion`,
              );
              assert.deepEqual(readFileSync(fixture.runFile), beforeRun, `${mutationCase.name} completion protected run bytes`);
              assert.equal(existsSync(fixture.receiptPath), false, `${mutationCase.name} completion must not publish receipt bytes`);
            } else {
              await completeCheckedTestExecution(fixture.runDir, fixture.claimed.claim, fixture.claimed.authority, canonicalReceipt, { now: CLAIM_NOW });
              writeJson(fixture.receiptPath, mutatedReceipt);
              const completedRun = readFileSync(fixture.runFile);
              const mutatedReceiptBytes = readFileSync(fixture.receiptPath);
              const consume = consumer === "replay"
                ? () => executeCheckedTestExecution(fixture.runDir, { spawnFn() { throw new Error("mutated replay must not spawn"); } })
                : () => transitionRunStep(fixture.runDir, "test-verifier", {
                    status: "accepted", attempts: 1, artifact_ref: "artifacts/test-report.md",
                    evidence_ref: "evidence/test-verifier.attempt-1.json", review_ref: "reviews/test-verifier.attempt-1.json",
                  }, { mustExist: true });
              await assert.rejects(consume(), undefined, `${mutationCase.name} ${consumer}`);
              assert.deepEqual(readFileSync(fixture.runFile), completedRun, `${mutationCase.name} ${consumer} protected run bytes`);
              assert.deepEqual(readFileSync(fixture.receiptPath), mutatedReceiptBytes, `${mutationCase.name} ${consumer} protected receipt bytes`);
            }
            executed.add(`${mutationCase.name}:${consumer}`);
          }
        }
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
    const expectedExecutionCount = expectedCases.reduce((total, mutationCase) => total + (mutationCase.record.status === "pass" ? 3 : 2), 0);
    assert.equal(executed.size, expectedExecutionCount);
    for (const mutationCase of expectedCases) {
      const consumers = mutationCase.record.status === "pass" ? ["completion", "replay", "acceptance"] : ["completion", "replay"];
      for (const consumer of consumers) assert.equal(executed.has(`${mutationCase.name}:${consumer}`), true);
    }
  });

  it("executes every generated checked execution claim mutation through production consumers", async () => {
    const records = DURABLE_AUTHORITY_CATALOG
      .flatMap(({ records: catalogRecords }) => catalogRecords)
      .filter(({ id }) => id.startsWith("test-execution-claim-"));
    const generated = records.flatMap((record) => emitDurableRecordMutations(record.source, record.descriptor, record.externalSources));
    const executed = new Set();
    const recoveryExecuted = new Set();
    const cleanupExecuted = new Set();
    const consumers = new Set();
    const root = mkdtempSync(join(tmpdir(), "checked-claim-catalog-"));
    try {
      for (const record of records) {
        if (["active", "unknown"].includes(record.source.execution_claim.state)) {
          const canonicalFixture = await createCheckedClaimMutationFixture(root, record, "canonical-cleanup");
          const canonicalSnapshot = checkedClaimCleanupSnapshot(canonicalFixture);
          await assert.rejects(
            cleanupRun("catalog-run", { cwd: canonicalFixture.repo, force: true }),
            (error) => error?.code === "TEST_EXECUTION_OPERATOR_RECONCILIATION_REQUIRED",
            `${record.id} canonical cleanup refusal`,
          );
          assertCheckedClaimCleanupUnchanged(canonicalFixture, canonicalSnapshot, `${record.id} canonical cleanup`);
          cleanupExecuted.add(`${record.id}:canonical`);
          consumers.add("cleanup refusal");
        }
        const cases = emitDurableRecordMutations(record.source, record.descriptor, record.externalSources);
        for (const [index, mutationCase] of cases.entries()) {
          const fixture = await createCheckedClaimMutationFixture(root, record, index);
          const canonicalRun = JSON.parse(readFileSync(fixture.runFile, "utf8"));
          const mutatedRun = structuredClone(canonicalRun);
          const mutatedStep = mutatedRun.steps.find(({ agent }) => agent === "test-verifier");
          applyMutationDifference(mutatedStep, record.source, mutationCase.record);
          const recoveryBoundClaimMutation = fixture.state !== "unknown" || checkedRecoveryBindingChanged(record.source.execution_claim, mutationCase.record.execution_claim);
          if (recoveryBoundClaimMutation && mutationCase.record.execution_claim_hash === record.source.execution_claim_hash && mutatedStep.execution_claim) {
            mutatedStep.execution_claim_hash = hashValue(mutatedStep.execution_claim);
          }
          applyCheckedClaimExternalMutation(fixture, record, mutationCase);
          writeJson(fixture.runFile, mutatedRun);
          const beforeRun = readFileSync(fixture.runFile);
          const beforeReceipt = fixture.receiptPath && existsSync(fixture.receiptPath) ? readFileSync(fixture.receiptPath) : null;

          let schemaValid = true;
          try {
            validateRun(mutatedRun);
          } catch (error) {
            assert.equal(error?.name, "ValidationError", mutationCase.name);
            consumers.add("validateRun");
            schemaValid = false;
          }

          if (fixture.state === "completed" && schemaValid) {
            const consistency = checkRunConsistency(fixture.runDir, mutatedRun);
            if (!consistency.ok) consumers.add("checkRunConsistency");
            await assert.rejects(
              executeCheckedTestExecution(fixture.runDir, { env: { PATH: "/catalog/bin" }, spawnFn() { throw new Error("completed replay must not spawn"); } }),
              undefined,
              `${mutationCase.name} checked execution replay`,
            );
            consumers.add("checked execution replay");
            if (record.id === "test-execution-claim-completed-pass") {
              await assert.rejects(
                transitionRunStep(fixture.runDir, "test-verifier", {
                  status: "accepted", attempts: 1, artifact_ref: "artifacts/test-report.md",
                  evidence_ref: "evidence/test-verifier.attempt-1.json", review_ref: "reviews/test-verifier.attempt-1.json",
                }, { mustExist: true }),
                undefined,
                `${mutationCase.name} generic acceptance`,
              );
              consumers.add("generic test-verifier acceptance");
            }
          } else if (fixture.state === "active") {
            await assert.rejects(
              completeCheckedTestExecution(fixture.runDir, fixture.claimed.claim, fixture.claimed.authority, fixture.receipt, { now: CLAIM_NOW }),
              undefined,
              `${mutationCase.name} checked completion`,
            );
            consumers.add("checked execution completion");
          }
          if (["active", "unknown"].includes(fixture.state)) {
            await assert.rejects(
              transitionRecoverOrphan(fixture.runDir, "test-execution-reconciliation"),
              undefined,
              `${mutationCase.name} public recovery refusal`,
            );
            recoveryExecuted.add(mutationCase.name);
            consumers.add("public recovery refusal");
            const cleanupSnapshot = checkedClaimCleanupSnapshot(fixture);
            await assert.rejects(
              cleanupRun("catalog-run", { cwd: fixture.repo, force: true }),
              undefined,
              `${mutationCase.name} cleanup refusal`,
            );
            assertCheckedClaimCleanupUnchanged(fixture, cleanupSnapshot, `${mutationCase.name} cleanup refusal`);
            cleanupExecuted.add(mutationCase.name);
            consumers.add("cleanup refusal");
          }
          executed.add(mutationCase.name);
          assert.deepEqual(readFileSync(fixture.runFile), beforeRun, `${mutationCase.name} protected run bytes`);
          assertCheckedClaimReceiptUnchanged(fixture.receiptPath, beforeReceipt, mutationCase.name);
        }
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
    assert.deepEqual([...executed].sort(), generated.map(({ name }) => name).sort());
    const expectedRecovery = records
      .filter(({ source }) => ["active", "unknown"].includes(source.execution_claim.state))
      .flatMap((record) => emitDurableRecordMutations(record.source, record.descriptor, record.externalSources).map(({ name }) => name));
    assert.deepEqual([...recoveryExecuted].sort(), expectedRecovery.sort());
    assert.deepEqual([...cleanupExecuted].filter((name) => !name.endsWith(":canonical")).sort(), expectedRecovery.sort());
    assert.deepEqual([...cleanupExecuted].filter((name) => name.endsWith(":canonical")).sort(), records
      .filter(({ source }) => ["active", "unknown"].includes(source.execution_claim.state))
      .map(({ id }) => `${id}:canonical`).sort());
    assert.deepEqual([...consumers].sort(), [
      "checkRunConsistency", "checked execution completion", "checked execution replay", "cleanup refusal",
      "generic test-verifier acceptance", "public recovery refusal", "validateRun",
    ]);
  });

  it("rejects checked claim cross-bindings at panel, gate, fence, and PR consumers", async () => {
    const record = findRecord(DURABLE_AUTHORITY_CATALOG, "test-execution-claim-completed-pass");
    const cases = emitDurableRecordMutations(record.source, record.descriptor, record.externalSources);
    const scenarios = [
      ["panel", "cross-bound execution_claim.nonce"],
      ["gate", "hash execution_claim.plan_hash"],
      ["fence", "stale execution_claim.head_sha"],
      ["pr", "receipt hash"],
    ];
    const root = mkdtempSync(join(tmpdir(), "checked-claim-downstream-catalog-"));
    try {
      for (const [sink, label] of scenarios) {
        const mutationCase = cases.find(({ name }) => name.includes(`(${label})`));
        assert.ok(mutationCase, `${sink} requires generated case ${label}`);
        const fixture = await createCheckedClaimMutationFixture(root, record, sink);
        await acceptCheckedClaimFixture(fixture);
        const panelInput = await stageCheckedClaimPanels(fixture, sink !== "panel");
        let fence = null;
        if (["fence", "pr"].includes(sink)) await stageCheckedClaimPrePrApproval(fixture);
        if (sink === "pr") fence = await transitionPrePrFenceEstablished(fixture.runDir);

        const mutatedRun = JSON.parse(readFileSync(fixture.runFile, "utf8"));
        const mutatedStep = mutatedRun.steps.find(({ agent }) => agent === "test-verifier");
        applyMutationDifference(mutatedStep, record.source, mutationCase.record);
        mutatedStep.execution_claim_hash = hashValue(mutatedStep.execution_claim);
        assert.equal(validateRun(mutatedRun), mutatedRun, `${mutationCase.name} remains schema-valid for ${sink}`);
        writeJson(fixture.runFile, mutatedRun);
        const beforeRun = readFileSync(fixture.runFile);
        const beforeReceipt = readFileSync(fixture.receiptPath);

        const consume = sink === "panel"
          ? () => transitionPanelVerdicts(fixture.runDir, panelInput, { repoRoot: fixture.repo })
          : sink === "gate"
            ? () => transitionGateDecision(fixture.runDir, "pre_pr", { status: "pending", artifact: "artifacts/test-report.md", question_ref: "gates/pre-pr.md" })
            : sink === "fence"
              ? () => transitionPrePrFenceEstablished(fixture.runDir)
              : () => transitionPrCreated(fixture.runDir, {}, {
                  fenceToken: fence.fence.token,
                  repoRoot: fixture.repo,
                  observePrOperation: async () => ({
                    disposition: "open", reason: "unique-exact-open",
                    pull_request: {
                      pr_url: "https://github.com/acme/repo/pull/77", pr_number: 77, pr_node_id: "PR_catalog_77",
                      repository: fence.fence.repository, head_ref: fence.fence.head_ref, head_sha: fence.fence.head_sha,
                      base_ref: fence.fence.base_ref, base_sha: fence.fence.base_sha, draft: fence.fence.draft,
                    },
                  }),
                });
        await assert.rejects(consume(), undefined, `${mutationCase.name} ${sink} consumer`);
        assert.deepEqual(readFileSync(fixture.runFile), beforeRun, `${mutationCase.name} ${sink} protected run bytes`);
        assert.deepEqual(readFileSync(fixture.receiptPath), beforeReceipt, `${mutationCase.name} ${sink} protected receipt bytes`);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects every plan-v2-integration-gate mutation through its production creation validator", () => {
    const record = findRecord(DURABLE_AUTHORITY_CATALOG, "plan-v2-integration-gate");
    const fixture = createDurableCatalogBaseline(record);
    assert.equal(fixture.consumer, "validateSlicesPlan");
    assert.equal(validateSlicesPlan(fixture.plan, { requireIntegrationGate: true }), fixture.plan);

    const cases = emitDurableRecordMutations(record.source, record.descriptor, record.externalSources);
    assert.equal(cases.length, 6);
    for (const mutationCase of cases) {
      assert.throws(
        () => validateSlicesPlan(mutationCase.record, { requireIntegrationGate: true }),
        (error) => error?.name === "ValidationError",
        mutationCase.name,
      );
    }
  });

  it("rejects every delivery-envelope and invariant-ledger mutation through production extension consumers", () => {
    const envelopeRecord = findRecord(DURABLE_AUTHORITY_CATALOG, "plan-delivery-envelope-v1");
    const envelopeBaseline = createDurableCatalogBaseline(envelopeRecord);
    const envelopeCases = emitDurableRecordMutations(envelopeRecord.source, envelopeRecord.descriptor, envelopeRecord.externalSources);
    for (const mutationCase of envelopeCases) {
      const plan = structuredClone(envelopeBaseline.plan);
      plan.delivery_envelope = mutationCase.record;
      assert.throws(() => validateSlicesPlan(plan, { requireIntegrationGate: true }), undefined, mutationCase.name);
    }

    const ledgerRecord = findRecord(DURABLE_AUTHORITY_CATALOG, "review-invariant-family-ledger-v1");
    const ledgerBaseline = createDurableCatalogBaseline(ledgerRecord);
    const ledgerCases = emitDurableRecordMutations(ledgerRecord.source, ledgerRecord.descriptor, ledgerRecord.externalSources);
    for (const mutationCase of ledgerCases) {
      assert.throws(() => evaluateInvariantFamilyReview({
        plan: JSON.parse(mutationCase.externalSources.plan.bytes),
        sliceId: "backend",
        review: { subject: "backend", attempt: 1, reviewed_commit: "b".repeat(40), verdict: "REJECT", invariant_family_ledger: mutationCase.record },
        observeEvidence(ref) {
          const external = mutationCase.externalSources.evidence;
          return { ref, hash: `sha256:${createHash("sha256").update(external.bytes).digest("hex")}`, receipt: JSON.parse(external.bytes) };
        },
      }), undefined, mutationCase.name);
    }
    assert.equal(envelopeCases.length, 7);
    assert.equal(ledgerCases.length, 10);
  });

  it("rejects every checkpoint-routing artifact mutation through reviewed source authority", () => {
    const record = findRecord(DURABLE_AUTHORITY_CATALOG, "checkpoint-routing-artifact-v1");
    for (const mutationCase of emitDurableRecordMutations(record.source, record.descriptor, record.externalSources)) {
      assert.throws(() => {
        const plan = JSON.parse(mutationCase.externalSources.plan.bytes);
        const review = JSON.parse(mutationCase.externalSources.review.bytes);
        const planHash = `sha256:${createHash("sha256").update(mutationCase.externalSources.plan.bytes).digest("hex")}`;
        const reviewHash = `sha256:${createHash("sha256").update(mutationCase.externalSources.review.bytes).digest("hex")}`;
        validateCheckpointRoutingManifest(mutationCase.record, {
          plan,
          planHash,
          admissionResult: record.source.source.admission_result,
          decompositionAuthority: {
            plan_ref: "plan/slices.json", plan_hash: planHash,
            review_ref: "reviews/work-decomposer.json", review_hash: reviewHash,
            attempt: review.attempt, review,
          },
        });
      }, undefined, mutationCase.name);
    }
  });

  it("rejects every accepted work-decomposer plan/review mutation through its deciding consumers", () => {
    const record = findRecord(DURABLE_AUTHORITY_CATALOG, "step-work-decomposer-accepted-plan");
    const cases = emitDurableRecordMutations(record.source, record.descriptor, record.externalSources);
    assert.equal(cases.length, 12);
    const canonicalPlan = JSON.parse(record.externalSources.plan.bytes);
    const root = mkdtempSync(join(tmpdir(), "decomposition-authority-catalog-"));
    try {
      for (const [index, mutationCase] of cases.entries()) {
        const runDir = join(root, String(index));
        materializeCatalogSources(runDir, mutationCase.externalSources);
        const run = createRunRecord({
          run_id: `decomposition-catalog-${index}`,
          slices: canonicalPlan.slices.map((slice) => ({ id: slice.id, stack: slice.stack, depends_on: slice.depends_on, status: "merged", attempts: 1 })),
          steps: [mutationCase.record, { agent: "test-verifier", status: "blocked", attempts: 0 }],
        });
        assert.throws(() => {
          validateRun(run);
          const consistency = checkRunConsistency(runDir, run);
          if (!consistency.ok) throw new Error(failedConsistencyMessages(consistency));
          observeAcceptedDecompositionAuthority(runDir, run, { requireIntegrationGate: true });
        }, undefined, mutationCase.name);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects accepted decomposition canonical-source substitution, ref/hash drift, and external-byte drift", () => {
    for (const [label, mutate] of [
      ["source substitution", (record) => { record.source.status = "running"; }],
      ["canonical placement", (record) => { record.canonicalPath = ["steps", 1]; }],
      ["plan ref", (record) => { record.source.acceptance.artifact_ref = "plan/other.json"; }],
      ["plan hash", (record) => { record.source.acceptance.artifact_hash = `sha256:${"0".repeat(64)}`; }],
      ["plan bytes", (record) => { record.externalSources.plan.bytes = record.externalSources.plan.bytes.replace("AC1", "AC2"); }],
      ["review ref", (record) => { record.source.acceptance.review_ref = "reviews/other.json"; }],
      ["review hash", (record) => { record.source.acceptance.review_hash = `sha256:${"1".repeat(64)}`; }],
      ["review bytes", (record) => { record.externalSources.review.bytes = record.externalSources.review.bytes.replace("APPROVE", "REJECT"); }],
    ]) {
      const catalog = structuredClone(DURABLE_AUTHORITY_CATALOG);
      mutate(findRecord(catalog, "step-work-decomposer-accepted-plan"));
      assert.throws(() => assertDurableAuthorityCatalogComplete(catalog), /canonical source|contradicts|metadata/u, label);
    }
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

  it("uses an independent closed descriptor oracle for all 185 exact target/exclusion definitions", () => {
    const requiredIds = Object.values(DURABLE_AUTHORITY_REQUIRED_RECORD_IDS).flat();
    assert.deepEqual(DURABLE_AUTHORITY_DESCRIPTOR_MANIFEST.map(([id]) => id), requiredIds);
    assert.equal(DURABLE_AUTHORITY_DESCRIPTOR_MANIFEST.length, 185);
    assert.equal(DURABLE_AUTHORITY_DESCRIPTOR_MANIFEST.every(([, digest]) => /^[0-9a-f]{64}$/u.test(digest)), true);
    const helperSource = readFileSync(new URL("./helpers/durable-record-mutations.js", import.meta.url), "utf8");
    assert.doesNotMatch(helperSource, /RECORDS\.map\(\(record\).*descriptor/u, "descriptor expectations must not be produced from catalog records");
    assert.doesNotMatch(helperSource, /DURABLE_AUTHORITY_CATALOG[\s\S]{0,200}DESCRIPTOR_MANIFEST/u, "descriptor expectations must not be produced from the catalog export");
  });

  it("renders deterministic readable canonical JSON for independent oracle-manifest value review", () => {
    const record = findRecord(DURABLE_AUTHORITY_CATALOG, "final-plan-descriptor");
    const oldSnapshot = renderDurableAuthorityOracleReviewSnapshot(record);
    assert.equal(oldSnapshot, renderDurableAuthorityOracleReviewSnapshot(record));
    assert.equal(oldSnapshot.endsWith("\n"), true);
    const oldReview = JSON.parse(oldSnapshot);
    assert.deepEqual(Object.keys(oldReview), ["canonicalSource", "descriptor", "metadata"]);
    assert.equal(oldReview.metadata.writer, record.writer);
    assert.deepEqual(oldReview.descriptor.targets, record.descriptor.targets);
    assert.deepEqual(oldReview.canonicalSource.source, record.source);

    const changedRecord = structuredClone(record);
    changedRecord.writer = "independently reviewed replacement writer";
    changedRecord.descriptor.targets.find(({ family }) => family === "wrong-kind").value = "reviewed-kind";
    changedRecord.source.descriptor.kind = "reviewed-source-kind";
    const newReview = JSON.parse(renderDurableAuthorityOracleReviewSnapshot(changedRecord));
    assert.equal(newReview.metadata.writer, "independently reviewed replacement writer");
    assert.equal(newReview.descriptor.targets.find(({ family }) => family === "wrong-kind").value, "reviewed-kind");
    assert.equal(newReview.canonicalSource.source.descriptor.kind, "reviewed-source-kind");
    assert.equal(oldReview.metadata.writer, record.writer, "old readable snapshot must remain independently reviewable");
    assert.equal(oldReview.descriptor.targets.find(({ family }) => family === "wrong-kind").value, "unknown-graph");
    assert.equal(oldReview.canonicalSource.source.descriptor.kind, "slices-graph");
  });

  it("reviews all 46 activated amendment catalog values before accepting their literal digests", () => {
    const ids = DURABLE_AUTHORITY_REQUIRED_RECORD_IDS["pr79-merged-slice-repair"].filter((id) => id.startsWith("amendment-") && !id.startsWith("amendment-review-dispatch-"));
    assert.equal(ids.length, 46);
    for (const id of ids) {
      const record = findRecord(DURABLE_AUTHORITY_CATALOG, id);
      const review = JSON.parse(renderDurableAuthorityOracleReviewSnapshot(record));
      assert.equal(review.canonicalSource.id, id);
      assert.equal(review.canonicalSource.authorityClassId, "pr79-merged-slice-repair");
      assert.deepEqual(review.canonicalSource.source, record.source);
      assert.equal(review.metadata.writer, record.writer);
      assert.deepEqual(review.metadata.readers, record.readers);
      assert.deepEqual(review.descriptor.targets, record.descriptor.targets);
      for (const family of DURABLE_MUTATION_FAMILIES) {
        const targeted = review.descriptor.targets.some((target) => target.family === family);
        const excluded = Object.hasOwn(review.descriptor.exclusions, family);
        assert.notEqual(targeted, excluded, `${id}:${family} readable target-or-exclusion decision`);
      }
      assert.match(DURABLE_AUTHORITY_METADATA_MANIFEST.find(([row]) => row === id)[1], /^[0-9a-f]{64}$/u);
      assert.match(DURABLE_AUTHORITY_DESCRIPTOR_MANIFEST.find(([row]) => row === id)[1], /^[0-9a-f]{64}$/u);
      assert.match(DURABLE_AUTHORITY_CANONICAL_SOURCE_MANIFEST.find(([row]) => row === id)[1], /^[0-9a-f]{64}$/u);
    }
  });

  it("proves the reviewed plan descriptor manifest update changed only the stale dependency identity target", () => {
    const current = findRecord(DURABLE_AUTHORITY_CATALOG, "plan-slices-json");
    const prior = structuredClone(current);
    const priorTarget = prior.descriptor.targets.find(({ family }) => family === "stale-identity");
    Object.assign(priorTarget, { path: ["slices", 1, "id"], label: "stale slices.1.id", value: "stale-slice" });
    const oldReview = JSON.parse(renderDurableAuthorityOracleReviewSnapshot(prior));
    const newReview = JSON.parse(renderDurableAuthorityOracleReviewSnapshot(current));

    assert.deepEqual(oldReview.canonicalSource, newReview.canonicalSource);
    assert.deepEqual(oldReview.metadata, newReview.metadata);
    assert.deepEqual(oldReview.descriptor.exclusions, newReview.descriptor.exclusions);
    assert.deepEqual(oldReview.descriptor.targets.filter(({ family }) => family !== "stale-identity"), newReview.descriptor.targets.filter(({ family }) => family !== "stale-identity"));
    assert.deepEqual(oldReview.descriptor.targets.find(({ family }) => family === "stale-identity"), { family: "stale-identity", label: "stale slices.1.id", path: ["slices", 1, "id"], value: "stale-slice" });
    assert.deepEqual(newReview.descriptor.targets.find(({ family }) => family === "stale-identity"), { family: "stale-identity", label: "stale slices.1.depends_on.0", path: ["slices", 1, "depends_on", 0], value: "stale-slice" });
    assert.equal(DURABLE_AUTHORITY_DESCRIPTOR_MANIFEST.find(([id]) => id === "plan-slices-json")[1], "3c923442fe75f188546037455e61dca6f3172bb766399c4df4289de2f1c6f726");
  });

  it("reviews readable pre-B2 and B2 authority values before the literal manifest digest changes", () => {
    const preB2 = {
      "terminal-result-blocked-nonconvergence": {
        source: { status: "blocked", run_id: "catalog-run", reason: "review-blocked", summary: "Review blocked." },
        externalSources: {},
        digests: ["681845bd946f1cb11d6f2d0a528946365756a79f2ce284179856360e3d9b631e", "9e2aac2293e6a2aa0ff69725ec484565d1ba598e4f921be01c44267eaab6d231", "2e50300aa3e14e8fd6c935f3dae3fa44dd388c6ff386091ecbc28109f82ad855"],
      },
      "slice-running": {
        source: { id: "backend", stack: "backend", depends_on: [], status: "running", attempts: 1, branch: "feature--backend", worktree: "/tmp/backend" },
        externalSources: {},
        digests: ["d5e779da2618570c2922ff58dc14927a60548dc770616322812912c6c4ada981", "e4d226476601e984b5b50f12ad36ce05f8a7e3ac3a49421218b72a94be54c962", "c481d007f40269d98676cf2746db9a5ab4b15ffb1cafe92fc9d0569181cef758"],
      },
      "slice-review": {
        source: { id: "backend", stack: "backend", depends_on: [], status: "review", attempts: 1, branch: "feature--backend", worktree: "/tmp/backend", evidence_ref: "evidence/backend.json", evidence_hash: `sha256:${"a".repeat(64)}`, review_ref: "reviews/backend.json", review_hash: `sha256:${"b".repeat(64)}`, reviewed_commit: "b".repeat(40) },
        externalSources: { evidence: { ref: "evidence/backend.json" }, review: { ref: "reviews/backend.json" } },
        digests: ["8fd0fae00323e9bed95c0673fc1f4f22d345a0f886438fee4991e7a390b7e7b0", "1d0d4c6beaa40f3f3397a3d015ae7d682cd8eb4ed10e268998b59bf14d7c76ef", "ac668a5340a0db81df8ad31e4d73302234dfd49da5933161e0f43d869e8a3262"],
      },
      "slice-merged": {
        source: { id: "backend", stack: "backend", depends_on: [], status: "merged", attempts: 1, branch: "feature--backend", worktree: "/tmp/backend", evidence_ref: "evidence/backend.json", evidence_hash: `sha256:${"a".repeat(64)}`, review_ref: "reviews/backend.json", review_hash: `sha256:${"b".repeat(64)}`, reviewed_commit: "b".repeat(40), merge_commit: "b".repeat(40), updated_at: "2026-07-16T12:00:00.000Z" },
        externalSources: { evidence: { ref: "evidence/backend.json" }, review: { ref: "reviews/backend.json" } },
        digests: ["785275ed7b23a9ecb8fd33d838e0e3a6acc2980d9e69e96ebd0f4cb6a9410707", "d02186b0bac9122bd39058f4205cc5234e6a8da5bc82fd221c6b88ca76e6633f", "ad2674135456283cf415406224c7a04cf661565770b6a7270a00d673fe2d6869"],
      },
      "slice-blocked": {
        source: { id: "backend", stack: "backend", depends_on: [], status: "blocked", attempts: 1, branch: "feature--backend", worktree: "/tmp/backend", blocked_reason: "review rejected" },
        externalSources: {},
        digests: ["bfb537c4489fa0d6512d0470e5a28ab6fabeea5dfb2f86fb53ae11a6057fe954", "284ac69650ab3643fab2f8aece086a1a16c66f106449b29e3003848f9e53cd11", "720be910a4201dab3958263b06f17510181df9c58c77f63eda5b9a91bb39da10"],
      },
    };
    const expectedDigests = {
      "terminal-result-blocked-nonconvergence": ["1b119c91d1ead2e56f7fe0a4dd87f843a8b625a81130fdeac64f590ef50f90f1", "ced0d4f02aac844c1b226f371cd76f04ba4e616179c7ada1105d5f6c63fde7ab", "d103c2ca471cda13f1f010cb5ef51ad15ebb12960e8776b62fc9b3568b123f31"],
      "slice-running": ["9144cf9afff4ee300711b783015cb338985c1bee73e42b5596ba53ad89bf1a64", "fc42986c22298a35eab703ba8490a9607de4e6a1a1b40259ed8f8ed67f38bb6c", "ccf77d9effc8e1ea2f3e668ea0c2f323c875fb14dfbafc120fb65d5c956c5d4c"],
      "slice-review": ["ae319993929a22cc824eadcb09bf7abbf7a95d4e814e54d44e2dd6eed10a3721", "9f3c77e866b5987bfa102140e14c09abda335b82886e293384bcddefabe2af88", "e2b04184fee064abab12827bd7ed2f9cacc80b671fef9524aaf1533fc6e69836"],
      "slice-merged": ["a92aff127c2a340e4a925fab9e0a083e0f54e664ca315c148d77ee7eb3da1a81", "87e840a2ecb570c87c604c7f5fa24e06568905ded5e03e964639dd61b5f1e579", "071d7624f6ac5d954ba74d403a795c16055c0b454dbf7f67728753e7e58075b4"],
      "slice-blocked": ["76bede870d7e85a8529c5191aa0405dacc2150bded0bab5411c654c004a8e336", "745738f57c24027e1a41fbf0a2e5c85a1a743ccee174797496ff5a08b5b15d4b", "ba543529dac064e1f63239efbc8a2d4f168246b0f56a1d337def9b1f5204f90d"],
    };
    for (const [id, digests] of Object.entries(expectedDigests)) {
      const current = findRecord(DURABLE_AUTHORITY_CATALOG, id);
      const newReview = JSON.parse(renderDurableAuthorityOracleReviewSnapshot(current));
      assert.notDeepEqual(preB2[id].source, newReview.canonicalSource.source, id);
      assert.deepEqual(Object.keys(preB2[id]), ["source", "externalSources", "digests"], `${id}: independently authored prior fixture shape`);
      assert.equal(preB2[id].digests.every((digest) => /^[0-9a-f]{64}$/u.test(digest)), true, `${id}: retained prior manifest digests`);
      if (id.startsWith("slice-")) {
        assert.equal(Object.hasOwn(preB2[id].source, "dispatch_required"), false, id);
        assert.equal(newReview.canonicalSource.source.dispatch_required, true, id);
      } else {
        assert.equal(newReview.canonicalSource.source.nonconvergence.kind, "slice-review-nonconvergence");
      }
      assert.ok(newReview.descriptor.targets.some(({ family }) => family === "wrong-hash"), id);
      assert.ok(newReview.descriptor.targets.some(({ family }) => family === "wrong-bytes"), id);
      assert.deepEqual([
        DURABLE_AUTHORITY_METADATA_MANIFEST.find(([row]) => row === id)[1],
        DURABLE_AUTHORITY_DESCRIPTOR_MANIFEST.find(([row]) => row === id)[1],
        DURABLE_AUTHORITY_CANONICAL_SOURCE_MANIFEST.find(([row]) => row === id)[1],
      ], digests, id);
    }
  });

  it("reviews B0MR.2 fence and universal PR tuple values before manifest digest updates", () => {
    const expectedDigests = {
      "terminal-result-completed": ["624dd6c0050e64037c95aca7904c9841656bd09684c3d8548b05e15601ba094c", "8156685012bdcf0072fc38331dd34c2ee2f0ac59c94d14418a0cadc3f92b84be", "67cc3ac4f4bc522a7e48be30ea4b1cdfcba2016a309ba99224197641cfcb059e"],
      "steering-pr-fence": ["e21025a5e584db627db74d3c4b186de64f259bbe3711c22586c6b9a6db87f628", "aae0a3986f100717159038cc2b06cfd835b1313305e22fc7beeea4929db3d662", "16fa47900dbcbd6618a6ebd0eed5cb705910a2ccfc8478bd1f554c7f8ebef406"],
      "pr-created-result": ["3b863980fbc4b34d584f7ef02b57e5a16ca37858f2c8dc347addcdb02c8446a3", "6b510aefac2fe46ad7ea3679ab0b023eda0ad0702139fdcfe62176b0404272bc", "619a77468645eec8923dec7f7e3c8b0d1aa11064aac4494e039b7aa282e6f9ea"],
    };
    for (const [id, digests] of Object.entries(expectedDigests)) {
      const record = findRecord(DURABLE_AUTHORITY_CATALOG, id);
      const prior = structuredClone(record);
      if (id === "steering-pr-fence") {
        prior.source = Object.fromEntries(["token", "generation", "state_hash", "created_at"].map((key) => [key, prior.source[key]]));
      } else {
        for (const key of ["pr_node_id", "operation_id", "head_ref", "base_ref", "base_sha"]) delete prior.source[key];
        if (id === "terminal-result-completed") delete prior.source.head_sha;
      }
      const oldReview = JSON.parse(renderDurableAuthorityOracleReviewSnapshot(prior));
      const review = JSON.parse(renderDurableAuthorityOracleReviewSnapshot(record));
      assert.equal(Object.hasOwn(oldReview.canonicalSource.source, "operation_id"), false, `${id} readable legacy/absent operation identity`);
      assert.equal(review.canonicalSource.source.operation_id, `ffpr-v1-${"d".repeat(64)}`, id);
      for (const [key, expected] of Object.entries({ repository: "acme/repo", head_ref: "feature--catalog", head_sha: "b".repeat(40), base_ref: "main", base_sha: "a".repeat(40), draft: false })) {
        assert.equal(review.canonicalSource.source[key], expected, `${id}.${key}`);
      }
      if (id === "steering-pr-fence") {
        assert.equal(review.canonicalSource.canonicalPath.join("."), "steering.pr_fence");
        assert.equal(review.canonicalSource.source.created_at, "2026-07-16T12:00:00.000Z");
        assert.deepEqual(review.metadata.readers, [
          "validateSteering successor fence validation",
          "transitionPrCreated and transitionPrePrFenceCleared checked GitHub reconciliation",
        ]);
      } else {
        assert.equal(review.canonicalSource.source.pr_node_id, "PR_catalog_operation");
        assert.equal(review.canonicalSource.source.pr_url, "https://github.com/acme/repo/pull/7");
        assert.equal(review.canonicalSource.source.pr_number, 7);
      }
      assert.deepEqual([
        DURABLE_AUTHORITY_METADATA_MANIFEST.find(([row]) => row === id)[1],
        DURABLE_AUTHORITY_DESCRIPTOR_MANIFEST.find(([row]) => row === id)[1],
        DURABLE_AUTHORITY_CANONICAL_SOURCE_MANIFEST.find(([row]) => row === id)[1],
      ], digests, id);
    }
  });

  it("reviews B1R claim/hash and receipt production consumers before manifest digest updates", () => {
    const expectedDigests = {
      "test-execution-claim-active": ["03f1ff020067bf61c7b7a9d5eafa733280c87ed543db7ad60b35a1f9fd959ff4", "e55cad41c016c8dee103465c0edbd8d0420c5be200b7469a0c487eb584cd1998", "d4a4d2bb577573da8940bf2a2d76157cf36d9519dd5cef85e5dbe4312a252969"],
      "test-execution-claim-completed-pass": ["35f8b7d639d27df70c71a8fa6ca5dd8b6566def00de6436c69bd8a72c7314d11", "6300c1839365a0e71a880ef8600632b6d3b451e9f2198d3fc6f6847f57860e98", "d5d7cc2956e521212b5d9f3bf452684ebea1c1ddbcce56cfbb9baa789af3cf96"],
      "test-execution-claim-completed-fail": ["cd062085e9a3ef6faa7574e51ee02e411b5c8a47f62572a03fb773e664ecc899", "b692a52e9978c8081ce71eb32c292aa8cf1c2b2084b48732cae8767265155d74", "1b1f3f27c3ee12cc66f312a394075fbe9488d39f7221518ea79e3583dc8e7308"],
      "test-execution-claim-unknown-process-outcome-indeterminate": ["4c046c97ba3a20072a6d8d3ad3683b07338586ed2eca6b71fbce59cf56bf7a9a", "b1f923be4789d44f8499ab7e8582ed1b1851c8003c66f7aa1e758b16c0d36766", "7c24ac0448dce935ccb7a6861738a16c0a14661a27a0601db4580661b9863c96"],
      "test-execution-claim-unknown-authority-changed": ["7bf43890ef2730f9a564d6e326bf94ad685e1cdd22f442fe3e65a19df75f66cf", "315a0338114bf60c9ca237fcb2813f393bd9d2a8f16d5ef50e3bac684f1549e6", "2da0ca8cbea018f74abb0a794a8bddfb28e77f7a1c0db5e25ce498608cd05704"],
      "test-execution-claim-unknown-receipt-publication-indeterminate": ["7891c097a81f751a63d4a0b22e355587e28ef38f99dda5a6bf6be6107f3ab625", "0590889d9899011ce0b033b9b6b6beb905cf6e6c25ed990a3a5bf748de7946d5", "b0072954c0f3939c2d696eee6e71a5ac37387fc5c7ed4a3a79733cca5d5b380b"],
      "test-execution-receipt-pass": ["af10a4bb1555afcb16e84a99dad77db4077b974fa96691c946a12a78d436118e", "62c1cf9a8dd6280fb852f0bf59e8998879b93f2867ff74664bd4060b6161b253", "dd7438d18b5391af5f938d6f0aae45c17b307badca132acc2bda5abae6df1ce1"],
      "test-execution-receipt-failed-nonzero-exit": ["77902b7325c16ba6bd8be03f332ace59a1e9eb146311ec197e722366fe256bb1", "4a155144f55284460d7a4a1ad152e2f1ec7d654e6818f5d09413f76fa33cb06e", "f1c96dedd17251a4d275d183eb598bc2665718bf4b72e447b927c62858342131"],
      "test-execution-receipt-failed-signal": ["a1062a17a8fa090df073a67da2420c47c3310f2541777e8a14a0d98d10c51aeb", "ef1b84677a9f39273f2cfed12f764ab655824dcefc02896e93b082bbd37261eb", "ded1cb25e9a2e20360a1e80904a9d0e1a07726eadcc3cd5a97b5dce80e3c53cf"],
      "test-execution-receipt-failed-launch-error": ["d2bd3056c8c63416fd2f267ccf501e761ab6c5c2d2f1e0b153fd339cab88ca56", "98fb5aed768d553eb1cf4aba84b389bab19adc6631c0ed699296b23449a53d5c", "7d91074f027be0361cdaa2fb7eb1850209b2837504225a30b968363ee36fe8b1"],
      "test-execution-receipt-failed-timeout": ["892f06549abd30822f2874d1bb273afc5ea38e489558ec4478f4d02fadd00d68", "3458081e9dd7f4e65d1ed6e2f5002ab07906a675f2fdff2bfac16b0fcdc50dc2", "5d5a2975e970c83e77b746e50ee1899859e4ebdbb07139a1b8798d015012ca36"],
      "test-execution-receipt-failed-output-limit": ["6eca685723654ba1d6c4e8b2a3ba2b1a4dc56f65fbd4731e848823f76a07e727", "833673e91272686dedee1555e3e9d2a66961789abeec53f6a0ed4e21edd8af0a", "9e7b99607828b8f8cbcf232b0187ded202f9fd921fbae90570269b8ed2dc0cb5"],
    };
    for (const [id, digests] of Object.entries(expectedDigests)) {
      const record = findRecord(DURABLE_AUTHORITY_CATALOG, id);
      const review = JSON.parse(renderDurableAuthorityOracleReviewSnapshot(record));
      const isClaim = id.startsWith("test-execution-claim-");
      const productionTest = isClaim
        ? "test/durable-record-mutations.test.js: executes every generated checked execution claim mutation through production consumers"
        : "test/durable-record-mutations.test.js: executes every generated checked receipt mutation through production completion, replay, and applicable acceptance consumers";
      assert.equal(review.metadata.tests.includes(productionTest), true, id);
      if (!isClaim) {
        assert.deepEqual(review.metadata.readers, ["completeCheckedTestExecution protected completion transition", "executeCheckedTestExecution completed replay", "transitionRunStep schema-v2 generic acceptance"], id);
        assert.deepEqual([review.canonicalSource.source.status, review.canonicalSource.source.commands[0].outcome], [record.source.status, record.source.commands[0].outcome], id);
        assert.equal(review.canonicalSource.source.timeout_ms, 600_000, `${id} timeout authority`);
        assert.equal(review.descriptor.targets.some(({ path: targetPath }) => targetPath.join(".") === "timeout_ms"), true, `${id} timeout tamper target`);
      } else {
        assert.equal(review.canonicalSource.source.execution_claim.state, record.source.execution_claim.state, id);
        assert.equal(review.canonicalSource.source.execution_claim_hash, record.source.execution_claim_hash, id);
        assert.equal(review.canonicalSource.source.execution_claim.timeout_ms, 600_000, `${id} timeout authority`);
        assert.equal(review.metadata.readers.includes("transitionRecoverOrphan public fail-closed recovery refusal"), !id.includes("completed"), `${id} public recovery consumer`);
        assert.equal(review.descriptor.targets.some(({ path: targetPath }) => targetPath.join(".") === "execution_claim_hash"), true, `${id} execution_claim_hash`);
        for (const path of ["execution_claim.state", "execution_claim.attempt", "execution_claim.nonce", "execution_claim.claimed_at", "execution_claim.plan_ref", "execution_claim.plan_hash", "execution_claim.head_sha", "execution_claim.timeout_ms", "execution_claim.receipt_ref"]) {
          assert.equal(review.descriptor.targets.some(({ path: targetPath }) => targetPath.join(".") === path), true, `${id} ${path}`);
        }
        if (record.source.execution_claim.status) {
          for (const path of ["execution_claim.completed_at", "execution_claim.status", "execution_claim.receipt_hash", "evidence_ref", "$external.receipt.bytes"]) {
            assert.equal(review.descriptor.targets.some(({ path: targetPath }) => targetPath.join(".") === path), true, `${id} ${path}`);
          }
        } else {
          assert.match(review.descriptor.exclusions["wrong-bytes"], new RegExp(`^${id}: wrong-bytes is explicitly inapplicable`, "u"), `${id} receipt-byte exclusion`);
        }
        if (record.source.execution_claim.reason) {
          for (const path of ["execution_claim.failed_at", "execution_claim.reason"]) {
            assert.equal(review.descriptor.targets.some(({ path: targetPath }) => targetPath.join(".") === path), true, `${id} ${path}`);
          }
        }
      }
      assert.deepEqual([
        DURABLE_AUTHORITY_METADATA_MANIFEST.find(([row]) => row === id)[1],
        DURABLE_AUTHORITY_DESCRIPTOR_MANIFEST.find(([row]) => row === id)[1],
        DURABLE_AUTHORITY_CANONICAL_SOURCE_MANIFEST.find(([row]) => row === id)[1],
      ], digests, id);
    }
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
    assert.match(answerHash.record.handoff_receipt.answer_hash, /^sha256:[0-9a-f]{64}$/u);
    assert.notEqual(answerHash.record.handoff_receipt.answer_hash, approval.source.handoff_receipt.answer_hash);
    assert.equal(answerHash.externalSources.answer.bytes, "approve\n");
    assert.equal(answerBytes.record.answer_ref, "gates/story.answer.consumed-1");
    assert.match(answerBytes.record.handoff_receipt.answer_hash, /^sha256:[0-9a-f]{64}$/u);
    assert.equal(answerBytes.externalSources.answer.bytes, "tampered-sidecar-bytes");
  });

  it("binds every catalog row's source identity, placement, facts, and external bytes with an independent manifest", () => {
    const canonicalIds = DURABLE_AUTHORITY_CANONICAL_SOURCE_MANIFEST.map(([id]) => id);
    const requiredIds = Object.values(DURABLE_AUTHORITY_REQUIRED_RECORD_IDS).flat();
    assert.equal(canonicalIds.length, 185);
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
      ["slice attempt history deletion", (catalog) => { delete findRecord(catalog, "slice-review").source.attempt_reviews[0].review_hash; }],
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
      "terminal-result-blocked",
      "terminal-result-partial",
      "terminal-result-needs-human",
      "pr-created-result",
    ];
    assert.equal(previouslyUncovered.length, 8);
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

  it("routes current baselines through production validation and rejects retired continuation baselines", () => {
    const observedConsumers = new Map();
    for (const id of [...DURABLE_AUTHORITY_PRODUCTION_COVERED_RECORD_IDS, "final-plan-descriptor"]) {
      const record = findRecord(DURABLE_AUTHORITY_CATALOG, id);
      const baseline = createDurableCatalogBaseline(record);
      observedConsumers.set(id, baseline.consumer);
      if (baseline.consumer === "validateSlicesPlan") {
        assert.equal(validateSlicesPlan(baseline.plan, { requireIntegrationGate: id === "plan-v2-integration-gate" }), baseline.plan, `${id} must pass the exported plan validator`);
      } else if (baseline.consumer === "evaluateInvariantFamilyReview") {
        assert.deepEqual(evaluateInvariantFamilyReview({
          plan: baseline.plan,
          sliceId: "backend",
          review: { subject: "backend", attempt: 1, reviewed_commit: "b".repeat(40), verdict: "REJECT", invariant_family_ledger: baseline.ledger },
          observeEvidence: (ref) => ({ ref, hash: baseline.ledger.dispositions[0].evidence_hash, receipt: JSON.parse(baseline.externalSources.evidence.bytes), claim: JSON.parse(baseline.externalSources.claim.bytes) }),
        }), {
          schema_version: 1,
          extension: "invariant-family-review",
          status: "active",
          grants_b4_authority: false,
          decision: "reject",
          reasons: ["review-verdict-reject", "invariant-family-result-not-pass:backend-behavior", "invariant-family-unresolved-findings:backend-behavior"],
        });
      } else if (baseline.consumer === "final-plan-descriptor-contract") {
        assert.deepEqual(Object.keys(baseline.descriptor), ["schema_version", "kind", "created_at", "run_id", "descriptor"]);
        assert.deepEqual(Object.keys(baseline.descriptor.descriptor), ["kind", "ref", "hash"]);
        assert.equal(baseline.descriptor.descriptor.kind, "slices-graph");
        assert.equal(baseline.descriptor.descriptor.ref, baseline.externalSources.plan.ref);
        assert.equal(baseline.descriptor.descriptor.hash, `sha256:${createHash("sha256").update(baseline.externalSources.plan.bytes).digest("hex")}`);
      } else if (baseline.consumer === "validateTestExecutionReceipt") {
        assert.equal(validateTestExecutionReceipt(baseline.receipt), baseline.receipt, `${id} must use the exported closed receipt validator`);
      } else if (baseline.consumer === "validateCheckpointRoutingManifest") {
        assert.equal(validateCheckpointRoutingManifest(baseline.manifest, baseline), baseline.manifest, `${id} must use the production checkpoint manifest validator`);
      } else if (baseline.consumer === "validateReviewedCheckpointPlan") {
        assert.equal(validateReviewedCheckpointPlan(baseline.plan).checkpointPlan, baseline.plan.delivery_envelope.checkpoint_plan);
      } else if (baseline.consumer === "buildCheckpointRoutingManifest") {
        assert.equal(buildCheckpointRoutingManifest({ ...baseline, admissionProbe: baseline.probe }).kind, "delivery-checkpoint-routing-manifest");
      } else if (baseline.consumer === "validateCheckpointChildPublication") {
        assert.equal(validateCheckpointChildPublication(baseline.publication), baseline.publication);
      } else if (baseline.consumer === "validateCheckpointSource") {
        assert.equal(validateCheckpointSource(baseline.checkpointSource), baseline.checkpointSource);
      } else if (baseline.consumer === "validateCheckpointProgress") {
        assert.equal(validateCheckpointProgress(baseline.progress), baseline.progress);
      } else if (baseline.consumer === "validateDeliveryCheckpointFinalClosure") {
        assert.equal(validateDeliveryCheckpointFinalClosure(baseline.closure), baseline.closure);
      } else if (baseline.consumer === "validateVerificationArtifactExecutionClaim") {
        assert.equal(validateVerificationArtifactExecutionClaim(baseline.claim), baseline.claim);
      } else if (baseline.consumer === "validateVerificationArtifactExecutionReceipt") {
        assert.equal(validateVerificationArtifactExecutionReceipt(baseline.receipt), baseline.receipt);
      } else if (baseline.consumer === "validateIntegrationAmendmentReviewDispatchClaim") {
        assert.equal(validateIntegrationAmendmentReviewDispatchClaim(baseline.claim, baseline.expected), baseline.claim);
      } else if (baseline.consumer === "validateIntegrationAmendmentReviewDispatchClosure") {
        assert.equal(validateIntegrationAmendmentReviewDispatchClosure(baseline.closure, baseline.expected), baseline.closure);
      } else if (baseline.consumer === "validateIntegrationAmendment") {
        assert.equal(validateIntegrationAmendment(baseline.amendment), baseline.amendment);
      } else if (baseline.consumer === "validateIntegrationAmendmentExecutionClaim") {
        assert.equal(validateIntegrationAmendmentExecutionClaim(baseline.claim), baseline.claim);
      } else if (baseline.consumer === "validateIntegrationAmendmentExecutionReceipt") {
        assert.equal(validateIntegrationAmendmentExecutionReceipt(baseline.receipt), baseline.receipt);
      } else if (baseline.consumer === "validateIntegrationAmendmentReview") {
        assert.equal(validateIntegrationAmendmentReview(baseline.review), baseline.review);
      } else if (baseline.consumer === "prepare/completeSpecialBuilderTaskDispatch") {
        const sidecar = baseline.claim || baseline.closure;
        assert.equal(sidecar.route, "integration-amendment");
        assert.match(sidecar.kind, /^checked-special-builder-dispatch-(?:claim|closure)$/u);
      } else {
        assert.match(baseline.consumer, /^validateRun(?:\/checkRunConsistency)?$/u);
        assert.equal(validateRun(baseline.run), baseline.run, `${id} must use an actual validateRun-compatible persisted shape`);
      }
    }
    assert.equal(observedConsumers.size, 185);
    assert.deepEqual([...observedConsumers.keys()].slice(0, 184), DURABLE_AUTHORITY_PRODUCTION_COVERED_RECORD_IDS);
    assert.equal(observedConsumers.get("final-plan-descriptor"), "final-plan-descriptor-contract", "future-only final.plan is a descriptor contract, not claimed as current validateRun input");
  });

  it("rejects every checkpoint and verification-artifact authority mutation through its production consumer", () => {
    const ids = [
      "checkpoint-reviewed-plan-v1", "checkpoint-admission-probe-valid", "checkpoint-child-disposition-v1",
      "checkpoint-child-publication-v1", "checkpoint-source-v1", "checkpoint-progress-reserved",
      "checkpoint-progress-child-published", "checkpoint-progress-launched", "checkpoint-progress-merged",
      "checkpoint-progress-closed", "checkpoint-merged-completion-v1", "checkpoint-final-closure-v1",
      "verification-artifact-claim-active", "verification-artifact-claim-completed-pass", "verification-artifact-claim-completed-fail",
      "verification-artifact-claim-unknown-process", "verification-artifact-claim-unknown-receipt",
      "verification-artifact-execution-receipt-pass", "verification-artifact-execution-receipt-fail",
    ];
    for (const id of ids) {
      const record = findRecord(DURABLE_AUTHORITY_CATALOG, id);
      const baseline = createDurableCatalogBaseline(record);
      for (const mutationCase of emitDurableRecordMutations(record.source, record.descriptor, record.externalSources)) {
        const invoke = baseline.consumer === "validateVerificationArtifactExecutionClaim"
          ? () => validateVerificationArtifactExecutionClaim(mutationCase.record)
          : baseline.consumer === "validateVerificationArtifactExecutionReceipt"
            ? () => validateVerificationArtifactExecutionReceipt(mutationCase.record)
            : baseline.consumer === "validateReviewedCheckpointPlan"
              ? () => {
                const plan = structuredClone(baseline.plan);
                plan.delivery_envelope.checkpoint_plan = mutationCase.record;
                return validateReviewedCheckpointPlan(plan);
              }
              : baseline.consumer === "buildCheckpointRoutingManifest"
                ? () => {
                  const authority = structuredClone(baseline.decompositionAuthority);
                  let probe = authority.review.admission_probe;
                  if (id === "checkpoint-admission-probe-valid") {
                    probe = mutationCase.record;
                    authority.review.admission_probe = mutationCase.record;
                  } else authority.review.checkpoint_dispositions[0] = mutationCase.record;
                  return buildCheckpointRoutingManifest({ ...baseline, admissionProbe: probe, decompositionAuthority: authority });
                }
                : baseline.consumer === "validateCheckpointChildPublication"
                  ? () => validateCheckpointChildPublication(mutationCase.record)
                  : baseline.consumer === "validateCheckpointSource"
                    ? () => validateCheckpointSource(mutationCase.record)
                    : baseline.consumer === "validateCheckpointProgress"
                      ? () => validateCheckpointProgress(mutationCase.record)
                      : () => validateDeliveryCheckpointFinalClosure(mutationCase.record);
        if (id.startsWith("checkpoint-")) assert.throws(invoke, Error, mutationCase.name);
        else assert.throws(invoke, validationErrorFor(mutationCase.name), mutationCase.name);
      }
    }
  });

  it("executes every nonconvergence terminal mutation through schema or exact sidecar consistency", () => {
    const record = findRecord(DURABLE_AUTHORITY_CATALOG, "terminal-result-blocked-nonconvergence");
    const blockedSlice = findRecord(DURABLE_AUTHORITY_CATALOG, "slice-blocked");
    const fixture = createDurableCatalogBaseline(record);
    const root = mkdtempSync(join(tmpdir(), "terminal-nonconvergence-consumers-"));
    try {
      for (const mutationCase of emitDurableRecordMutations(record.source, record.descriptor, record.externalSources)) {
        const mutatedRun = replaceCanonicalRecord(fixture.run, record.canonicalPath, mutationCase.record);
        try {
          validateRun(mutatedRun);
        } catch (error) {
          assert.equal(error?.name, "ValidationError", mutationCase.name);
          continue;
        }
        const runDir = join(root, mutationCase.name.replaceAll(/[^a-z0-9]+/giu, "-"));
        materializeCatalogSources(runDir, { ...blockedSlice.externalSources, ...mutationCase.externalSources });
        const consistency = checkRunConsistency(runDir, mutatedRun);
        assert.equal(consistency.ok, false, mutationCase.name);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("executes every ordinary blocked-slice mutation through production authority consumers", async () => {
    const record = findRecord(DURABLE_AUTHORITY_CATALOG, "slice-blocked-ordinary");
    const root = mkdtempSync(join(tmpdir(), "ordinary-blocked-slice-consumers-"));
    try {
      for (const mutationCase of emitDurableRecordMutations(record.source, record.descriptor, record.externalSources)) {
        const consumer = await consumeSliceMutation(root, record, mutationCase, mutationCase.name.replaceAll(/[^a-z0-9]+/giu, "-"));
        assert.equal(consumer, "assertNoUnresolvedSliceDispatches/checkRunConsistency", mutationCase.name);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("preserves the current B0M.1-B0M.3 production-consumer regression matrix", async () => {
    const expectedIds = [
      "plan-slices-json",
      "run-envelope-running",
      "run-envelope-terminal",
      "terminal-result-blocked",
      "terminal-result-partial",
      "terminal-result-needs-human",
      "gate-pending",
      "gate-approved-without-receipt",
      "gate-approved-interactive",
      "gate-changes-requested",
      "gate-stopped",
      "step-running",
      "step-rejected",
      "step-blocked",
      "step-accepted",
      "step-inherited-acceptance",
      "slice-pending",
      "slice-running",
      "slice-review",
      "slice-merged",
      "slice-blocked",
      "validator-verdict-binding",
      "security-verdict-binding",
      "steering-boundary",
      "steering-action-claim",
      "steering-last-action",
      "steering-pr-fence",
    ];
    assert.deepEqual(DURABLE_AUTHORITY_PRODUCTION_COVERED_RECORD_IDS.filter((id) => !["plan-v2-integration-gate", "plan-delivery-envelope-v1", "review-invariant-family-ledger-v1", "checkpoint-routing-artifact-v1", "checkpoint-reviewed-plan-v1", "checkpoint-admission-probe-valid", "checkpoint-child-disposition-v1", "checkpoint-child-publication-v1", "checkpoint-source-v1", "checkpoint-progress-reserved", "checkpoint-progress-child-published", "checkpoint-progress-launched", "checkpoint-progress-merged", "checkpoint-progress-closed", "checkpoint-merged-completion-v1", "checkpoint-final-closure-v1", "terminal-result-blocked-checkpoint-routing", "step-work-decomposer-accepted-plan", "terminal-result-blocked-nonconvergence", "slice-blocked-ordinary", "terminal-result-completed", "pr-created-result"].includes(id) && !id.startsWith("test-execution-") && !id.startsWith("verification-artifact-") && !id.startsWith("continuation-")).slice(0, 27), expectedIds);
    assert.equal(DURABLE_AUTHORITY_PRODUCTION_COVERED_RECORD_IDS.includes("final-plan-descriptor"), false);
    const results = {};
    const root = mkdtempSync(join(tmpdir(), "b0m-production-consumers-"));
    try {
      for (const id of expectedIds) {
        const record = findRecord(DURABLE_AUTHORITY_CATALOG, id);
        const cases = emitDurableRecordMutations(record.source, record.descriptor, record.externalSources);
        results[id] = { count: cases.length, consumers: new Set() };
        for (const mutationCase of cases) {
          if (id === "plan-slices-json") {
            assert.throws(() => validateSlicesPlan(mutationCase.record), validationErrorFor(mutationCase.name));
            results[id].consumers.add("validateSlicesPlan");
            continue;
          }
          if (id === "run-envelope-running" && ["stale-identity", "cross-bound-identity"].includes(mutationCase.family)) {
            const runDir = join(root, mutationCase.family);
            mkdirSync(runDir, { recursive: true });
            writeJson(join(runDir, "run.json"), record.source);
            await assert.rejects(transitionRunJson(runDir, () => mutationCase.record), /run identity field '(?:base_commit|run_id)' is immutable/u, mutationCase.name);
            results[id].consumers.add("transitionRunJson identity guard");
            continue;
          }
          if (id.startsWith("steering-")) {
            const consumer = await consumeSteeringMutation(root, record, mutationCase);
            results[id].consumers.add(consumer);
            continue;
          }
          const fixture = createDurableCatalogBaseline(record);
          const mutatedRun = replaceCanonicalRecord(fixture.run, record.canonicalPath, mutationCase.record);
          try {
            validateRun(mutatedRun);
          } catch (error) {
            assert.equal(validationErrorFor(mutationCase.name)(error), true);
            results[id].consumers.add("validateRun");
            continue;
          }

          const runDir = join(root, id, mutationCase.name.replaceAll(/[^a-z0-9]+/giu, "-"));
          materializeCatalogSources(runDir, mutationCase.externalSources);
          if (id.startsWith("gate-") || ["step-accepted", "step-inherited-acceptance"].includes(id)) {
            const consistency = checkRunConsistency(runDir, mutatedRun);
            if (!consistency.ok) {
              results[id].consumers.add("checkRunConsistency");
              continue;
            }
          }
          if (id.startsWith("step-") && ["stale-identity", "cross-bound-identity"].includes(mutationCase.family)) {
            writeJson(join(runDir, "run.json"), fixture.run);
            await assert.rejects(transitionRunStep(runDir, "spec-writer", mutationCase.record), /attempts cannot regress|agent identity is immutable|inherited_acceptance can only be created|published carry-forward plan bytes/u, mutationCase.name);
            results[id].consumers.add("transitionRunStep");
            continue;
          }
          if (id.startsWith("slice-") || id.endsWith("-verdict-binding") || ["terminal-result-completed", "pr-created-result"].includes(id)) {
            const consumer = await consumeB0M3Mutation(root, record, mutationCase);
            results[id].consumers.add(consumer);
            continue;
          }
          assert.fail(`${mutationCase.name} escaped every approved production consumer`);
        }
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
    const expectedCounts = Object.fromEntries(expectedIds.map((id) => {
      const record = findRecord(DURABLE_AUTHORITY_CATALOG, id);
      return [id, emitDurableRecordMutations(record.source, record.descriptor, record.externalSources).length];
    }));
    assert.deepEqual(Object.fromEntries(Object.entries(results).map(([id, value]) => [id, value.count])), expectedCounts);
    assert.equal(Object.values(results).every(({ consumers }) => consumers.size > 0), true);
    const expectedB0M3Consumers = {
      "slice-pending": "transitionSlicesSeed",
      "slice-running": "assertNoUnresolvedSliceDispatches",
      "slice-review": "transitionRunSlice",
      "slice-merged": "transitionSliceMerged",
      "slice-blocked": "assertNoUnresolvedSliceDispatches/checkRunConsistency",
      "validator-verdict-binding": "transitionPanelVerdicts",
      "security-verdict-binding": "transitionPanelVerdicts",
      "steering-boundary": "transitionSteeringBoundaryCrossed",
      "steering-action-claim": "transitionSteeringActionStarted",
      "steering-last-action": "transitionSteeringActionClosed",
    };
    for (const [id, consumer] of Object.entries(expectedB0M3Consumers)) {
      assert.equal(results[id].consumers.has(consumer), true, `${id} must reach ${consumer}`);
      assert.equal(results[id].consumers.has("transitionRunJson B0M.3 authority guard"), false, `${id} must not use the generic guard as its mutation consumer`);
    }
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

    const steps = ["step-running", "step-rejected", "step-blocked", "step-accepted", "step-work-decomposer-accepted-plan", "step-inherited-acceptance"]
      .map((id) => findRecord(DURABLE_AUTHORITY_CATALOG, id));
    assert.deepEqual(steps.map(({ source }) => source.status), ["running", "rejected", "blocked", "accepted", "accepted", "accepted"]);
    assert.deepEqual(Object.keys(steps[3].source.acceptance), ["artifact_ref", "artifact_hash", "review_ref", "review_hash"]);
    assert.deepEqual(steps[4].source.acceptance, {
      artifact_ref: "plan/slices.json", artifact_hash: `sha256:${createHash("sha256").update(steps[4].externalSources.plan.bytes).digest("hex")}`,
      review_ref: "reviews/work-decomposer.json", review_hash: `sha256:${createHash("sha256").update(steps[4].externalSources.review.bytes).digest("hex")}`,
    });
    assert.deepEqual(Object.keys(steps[5].source.inherited_acceptance), ["from_run_id", "parent_spec_review_ref", "artifact_hash", "review_hash"]);

    const slices = ["slice-pending", "slice-running", "slice-review", "slice-merged", "slice-blocked-ordinary", "slice-blocked"]
      .map((id) => findRecord(DURABLE_AUTHORITY_CATALOG, id));
    assert.deepEqual(slices.map(({ source }) => source.status), ["pending", "running", "review", "merged", "blocked", "blocked"]);
    for (const { source } of slices) for (const key of ["review_binding", "sidecar_bytes"]) assert.equal(Object.hasOwn(source, key), false);
    assert.equal(Object.hasOwn(slices[0].source, "dispatch_required"), false);
    assert.equal(Object.hasOwn(slices[0].source, "authorized_baseline_commit"), false);
    assert.equal(Object.hasOwn(slices[1].source, "attempt_reviews"), false);
    for (const source of slices.slice(1).map(({ source }) => source)) {
      assert.equal(source.dispatch_required, true);
      assert.match(source.authorized_baseline_commit, /^[0-9a-f]{40}$/u);
      assert.match(source.dispatch_claim_ref, /^dispatch\/[0-9a-f]{64}\.json$/u);
      assert.match(source.dispatch_claim_hash, /^sha256:[0-9a-f]{64}$/u);
    }
    for (const source of slices.slice(2).map(({ source }) => source)) {
      assert.equal(source.attempt_reviews.length, 1);
      for (const key of ["dispatch_claim_ref", "dispatch_claim_hash", "dispatch_closure_ref", "dispatch_closure_hash"]) assert.equal(source.attempt_reviews[0][key], source[key]);
      assert.match(source.dispatch_closure_ref, /^dispatch\/[0-9a-f]{64}\.closed\.json$/u);
      assert.match(source.dispatch_closure_hash, /^sha256:[0-9a-f]{64}$/u);
    }
    assert.deepEqual(Object.keys(slices[2].source), ["id", "stack", "depends_on", "declared_paths", "effective_paths", "status", "attempts", "branch", "worktree", "authorized_baseline_commit", "dispatch_required", "dispatch_claim_ref", "dispatch_claim_hash", "attempt_reviews", "dispatch_closure_ref", "dispatch_closure_hash", "evidence_ref", "review_ref", "evidence_hash", "review_hash", "reviewed_commit"]);
    assert.deepEqual(Object.keys(slices[3].source), ["id", "stack", "depends_on", "declared_paths", "effective_paths", "status", "attempts", "branch", "worktree", "authorized_baseline_commit", "dispatch_required", "dispatch_claim_ref", "dispatch_claim_hash", "attempt_reviews", "dispatch_closure_ref", "dispatch_closure_hash", "evidence_ref", "review_ref", "evidence_hash", "review_hash", "reviewed_commit", "merge_commit", "updated_at"]);
    assert.deepEqual(Object.keys(slices[4].source), ["id", "stack", "depends_on", "declared_paths", "effective_paths", "status", "attempts", "branch", "worktree", "authorized_baseline_commit", "dispatch_required", "dispatch_claim_ref", "dispatch_claim_hash", "attempt_reviews", "dispatch_closure_ref", "dispatch_closure_hash", "evidence_ref", "review_ref", "blocked_reason"]);
    assert.deepEqual(Object.keys(slices[5].source), Object.keys(slices[4].source));

    assert.deepEqual(Object.keys(findRecord(DURABLE_AUTHORITY_CATALOG, "validator-verdict-binding").source), ["verdict", "report", "review_ref", "report_hash", "review_hash", "reviewed_head_sha"]);
    assert.deepEqual(Object.keys(findRecord(DURABLE_AUTHORITY_CATALOG, "security-verdict-binding").source), ["verdict", "review_ref", "review_hash", "reviewed_head_sha"]);
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
    assert.match(hashCase.record.canonical_evidence_hash, /^sha256:[0-9a-f]{64}$/u);
    assert.notEqual(hashCase.record.canonical_evidence_hash, record.source.canonical_evidence_hash);
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

  it("allows only the known adversarial traversal ref during fixture materialization", () => {
    const root = mkdtempSync(join(tmpdir(), "catalog-traversal-policy-"));
    try {
      assert.doesNotThrow(() => materializeCatalogSources(join(root, "known"), {
        adversarial: { ref: "../outside.json", bytes: "known adversarial traversal" },
      }));
      assert.throws(
        () => materializeCatalogSources(join(root, "unexpected"), {
          adversarial: { ref: "nested/../../future-traversal.json", bytes: "unexpected traversal" },
        }),
        /unexpected traversal ref must fail materialization: nested\/\.\.\/\.\.\/future-traversal\.json/u,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("per-record durable authority mutation matrices", () => {
  for (const authorityClass of DURABLE_AUTHORITY_CATALOG) {
    for (const record of authorityClass.records) {
      it(`${record.id} mutation matrix`, () => {
        const productionAmendment = record.id.startsWith("amendment-") && !record.id.startsWith("amendment-review-dispatch-");
        assert.equal(record.tests[0], `test/durable-record-mutations.test.js: ${record.id}${productionAmendment ? " production" : ""} mutation matrix`);
        if (record.id.startsWith("test-execution-claim-")) {
          assert.equal(record.tests.includes("test/durable-record-mutations.test.js: executes every generated checked execution claim mutation through production consumers"), true);
          assert.equal(record.tests.includes("test/durable-record-mutations.test.js: rejects checked claim cross-bindings at panel, gate, fence, and PR consumers"), record.id === "test-execution-claim-completed-pass");
        } else if (record.id.startsWith("test-execution-receipt-")) {
          assert.equal(record.tests.length, 2);
          assert.equal(record.tests.includes("test/durable-record-mutations.test.js: executes every generated checked receipt mutation through production completion, replay, and applicable acceptance consumers"), true);
        } else if (record.id === "slice-blocked-ordinary") {
          assert.deepEqual(record.tests, [
            "test/durable-record-mutations.test.js: slice-blocked-ordinary mutation matrix",
            "test/durable-record-mutations.test.js: executes every ordinary blocked-slice mutation through production authority consumers",
          ]);
        } else if (record.id.startsWith("amendment-review-dispatch-")) {
          assert.equal(record.tests.length, 3);
          assert.equal(record.tests.includes("test/durable-record-mutations.test.js: amendment reviewer provenance production mutation matrix"), true);
          assert.equal(record.tests.includes("test/integration-amendment.test.js: reviewer effect lifecycle and replay"), true);
        } else if (productionAmendment) {
          assert.equal(record.tests.length, 2);
        } else assert.equal(record.tests.length, 1);
        const sourceBefore = structuredClone(record.source);
        const cases = emitDurableRecordMutations(record.source, record.descriptor, record.externalSources);
        assert.equal(cases.length, record.descriptor.targets.length);
        assert.deepEqual(cases.map(({ family }) => family).sort(), record.descriptor.targets.map(({ family }) => family).sort());
        assert.deepEqual(record.source, sourceBefore);
      });
    }
  }
});

describe("issue128FinishAndDiscloseAuthorityOracle", () => {
  it("independently binds the exact 20-row successor authority inventory", () => {
    assert.equal(issue128FinishAndDiscloseAuthorityOracle(), true);
    assert.deepEqual(ISSUE128_FINISH_AND_DISCLOSE_AUTHORITY_CATALOG.map(({ id }) => id), ISSUE128_FINISH_AND_DISCLOSE_RECORD_IDS);
    assert.equal(ISSUE128_FINISH_AND_DISCLOSE_AUTHORITY_CATALOG.length, ISSUE128_EXPECTED_SOURCE_COUNT);
    const routeIds = ["durable-run-consistency", "durable-amendment-consistency", "ordinary-continuation", "checkpoint-continuation"]
      .flatMap(issue128BaselineIdsForRoute);
    assert.equal(new Set(routeIds).size, routeIds.length, "baseline route assignments must be disjoint");
    assert.deepEqual([...routeIds].sort(), [...ISSUE128_FINISH_AND_DISCLOSE_RECORD_IDS].sort(), "independent baseline route union must equal the exact successor inventory");
    assert.deepEqual(Object.keys(ISSUE128_BASELINE_ROUTE_INVENTORY), ISSUE128_FINISH_AND_DISCLOSE_RECORD_IDS, "every exact row ID must key one closed baseline route");
    for (const [id, assignment] of Object.entries(ISSUE128_BASELINE_ROUTE_INVENTORY)) {
      assert.equal(typeof assignment.consumer, "string", `${id}: exact baseline consumer route`);
      assert.equal(assignment.consumer.length > 0, true, `${id}: nonempty baseline consumer route`);
      const match = /^(test\/[^:]+) :: (.+)$/u.exec(assignment.test);
      assert.ok(match, `${id}: exact baseline test route`);
      const [, relativePath, title] = match;
      const source = readFileSync(join(TEST_DIR, relativePath.slice("test/".length)), "utf8");
      assert.equal(source.includes(`it("${title}"`), true, `${id}: assigned baseline test must exist exactly`);
    }
    assert.equal(Object.isFrozen(ISSUE128_FINISH_AND_DISCLOSE_AUTHORITY_CATALOG), true);
    for (const row of ISSUE128_FINISH_AND_DISCLOSE_AUTHORITY_CATALOG) {
      assert.deepEqual(Object.keys(row.dispositions).filter((key) => key.length === 1).sort(), ["B", "D", "H", "I", "K", "R", "V", "X"], row.id);
      assert.equal(row.facts.length > 0, true, `${row.id} must bind path-plus-expected-value facts`);
      assert.equal(row.readers.length > 0, true, `${row.id} must bind complete production readers`);
      assert.equal(row.tests.length > 0, true, `${row.id} must bind named tests`);
      assert.equal(Object.keys(row.external_sources).length > 0, true, `${row.id} must bind external source boundaries`);
      for (const testRef of row.tests) {
        const match = /^(test\/[^:]+) :: (.+)$/u.exec(testRef);
        assert.ok(match, `${row.id} must use an exact test-file and title reference`);
        const [, relativePath, title] = match;
        const source = readFileSync(join(TEST_DIR, relativePath.slice("test/".length)), "utf8");
        assert.equal(source.includes(`it("${title}"`), true, `${row.id} must name an existing exact production test title`);
      }
    }
    const physicalMutations = ISSUE128_FINISH_AND_DISCLOSE_AUTHORITY_CATALOG.flatMap(emitIssue128FinishAndDiscloseMutations);
    assert.deepEqual(ISSUE128_FINISH_AND_DISCLOSE_AUTHORITY_CATALOG.map((row) => [row.id, emitIssue128FinishAndDiscloseMutations(row).length]), ISSUE128_EXPECTED_MUTATION_COUNTS);
    assert.equal(physicalMutations.length, ISSUE128_EXPECTED_MUTATION_COUNT);
    assert.equal(new Set(physicalMutations.map(({ name }) => name)).size, ISSUE128_EXPECTED_MUTATION_COUNT);
    for (const mutation of physicalMutations) {
      assert.equal(typeof mutation.expected_check, "string", `${mutation.name}: concrete production check`);
      assert.equal(mutation.expected_check.length > 0, true, `${mutation.name}: nonempty production check`);
      assert.equal(typeof mutation.expected_rejection, "string", `${mutation.name}: target-specific rejection discriminator`);
      assert.doesNotThrow(() => new RegExp(mutation.expected_rejection, "iu"), `${mutation.name}: valid rejection discriminator`);
      if (mutation.operation === "unknown-key") {
        assert.equal(typeof mutation.key, "string", `${mutation.name}: concrete unsupported key`);
        assert.equal(mutation.key.startsWith("unsupported_issue128_"), true, `${mutation.name}: issue-specific unsupported key`);
        assert.notEqual(mutation.value, undefined, `${mutation.name}: concrete unsupported value`);
      }
    }
  });

  it("executes every non-continuation baseline and physical mutation through production consistency", async () => {
    const root = mkdtempSync(join(tmpdir(), "issue128-executable-oracle-"));
    const observedRunBaselineIds = [];
    const observedAmendmentBaselineIds = [];
    let mutationCount = 0;
    try {
      for (const [index, row] of ISSUE128_FINISH_AND_DISCLOSE_AUTHORITY_CATALOG.entries()) {
        if (row.id.includes("carry-forward-accepted-slice") || row.id === "amendment-owner-snapshot-v2-history") continue;
        const fixture = createIssue128ExecutableFixture(root, row, index);
        const immutableRun = freezeIssue128Baseline(structuredClone(fixture.run));
        const immutableRunBytes = readFileSync(join(fixture.runDir, "run.json"));
        assert.deepEqual(issue128RunAuthorityFailures(fixture.runDir, fixture.run), [], row.id);
        observedRunBaselineIds.push(row.id);
        for (const mutation of emitIssue128FinishAndDiscloseMutations(row)) {
          restoreIssue128ExecutableBaseline(fixture, immutableRun, immutableRunBytes, mutation);
          const candidate = structuredClone(immutableRun);
          applyIssue128ExecutableMutation(candidate, fixture, row, mutation);
          assertIssue128TargetRejection(issue128ExpectedConsumerFailures(fixture.runDir, candidate, mutation), mutation);
          mutationCount += 1;
        }
      }
      const amendmentRow = ISSUE128_FINISH_AND_DISCLOSE_AUTHORITY_CATALOG.find(({ id }) => id === "amendment-owner-snapshot-v2-history");
      const amendment = await createIssue128AmendmentFixture(root, amendmentRow, ISSUE128_FINISH_AND_DISCLOSE_AUTHORITY_CATALOG.indexOf(amendmentRow));
      const immutableAmendmentRun = freezeIssue128Baseline(structuredClone(amendment.run));
      const immutableAmendmentRunBytes = readFileSync(join(amendment.runDir, "run.json"));
      assert.doesNotThrow(() => assertIntegrationAmendmentConsistency(amendment.runDir, amendment.run));
      observedAmendmentBaselineIds.push(amendmentRow.id);
      for (const mutation of emitIssue128FinishAndDiscloseMutations(amendmentRow)) {
        restoreIssue128ExecutableBaseline(amendment, immutableAmendmentRun, immutableAmendmentRunBytes, mutation);
        const candidate = structuredClone(immutableAmendmentRun);
        applyIssue128ExecutableMutation(candidate, amendment, amendmentRow, mutation);
        assertIssue128TargetRejection(issue128ExpectedConsumerFailures(amendment.runDir, candidate, mutation), mutation);
        mutationCount += 1;
      }
      assert.deepEqual(observedRunBaselineIds, issue128BaselineIdsForRoute("durable-run-consistency"));
      assert.deepEqual(observedAmendmentBaselineIds, issue128BaselineIdsForRoute("durable-amendment-consistency"));
      assert.deepEqual([...observedRunBaselineIds, ...observedAmendmentBaselineIds], [
        ...issue128BaselineIdsForRoute("durable-run-consistency"),
        ...issue128BaselineIdsForRoute("durable-amendment-consistency"),
      ]);
      assert.equal(mutationCount, 1605);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects planless empty-v2 authority through production consistency", () => {
    const root = mkdtempSync(join(tmpdir(), "issue128-empty-authority-"));
    try {
      for (const id of ISSUE128_EMPTY_AUTHORITY_RECORD_IDS) {
        const row = ISSUE128_FINISH_AND_DISCLOSE_AUTHORITY_CATALOG.find((candidate) => candidate.id === id);
        const runDir = join(root, id);
        mkdirSync(runDir, { recursive: true });
        const run = materializeIssue128EmptyAuthority(runDir, createIssue128DurableRunBaseline(row));
        const result = checkRunConsistency(runDir, run);
        const targetIndex = run.slices.findIndex(({ id: sliceId }) => sliceId === "consumer");
        const failed = result.checks.find((check) => check.name === `run.slices[${targetIndex}].attempt_reviews[0]`);
        assert.equal(result.ok, false, id);
        assert.equal(failed?.ok, false, `${id} must fail its v2 ownership authority check`);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects omission, substitution, relocation, contradiction, synthetic keys, source loss, disposition substitution, and target mutation without changing the oracle", () => {
    const mutations = [
      ["omission", (rows) => { rows.splice(3, 1); }],
      ["substitution", (rows) => { rows[0].id = "slice-attempt-review-v2-substitute"; }],
      ["relocation", (rows) => { [rows[0], rows[1]] = [rows[1], rows[0]]; }],
      ["contradiction", (rows) => { rows[2].facts[0].expected = "run.other"; }],
      ["synthetic key", (rows) => { rows[3].source.sidecar_bytes = "untrusted"; }],
      ["source boundary loss", (rows) => { delete rows[4].external_sources.review; }],
      ["source boundary substitution", (rows) => { rows[4].external_sources.review = structuredClone(rows[5].external_sources.owner_review); }],
      ["authority fact deletion", (rows) => { rows[6].facts.splice(0, 1); }],
      ["authority fact relocation", (rows) => { rows[6].facts[0].path = ["source", "unexpected"]; }],
      ["disposition substitution", (rows) => { rows[5].dispositions.R = { disposition: "target", path: ["source", "invented_ref"], expected: "reviews/invented.json" }; }],
      ["target mutation", (rows) => { rows[6].dispositions.I.path = ["source", "merge_commit"]; }],
      ["target deletion", (rows) => { delete rows[7].dispositions.K; }],
      ["target to exclusion", (rows) => { rows[8].dispositions.V = { disposition: "exclusion", reason: "substituted" }; }],
      ["exclusion to target", (rows) => { rows[9].dispositions.time = { disposition: "target", path: ["source", "invented_at"], expected: "2026-07-26T00:00:00.000Z" }; }],
    ];
    for (const [label, mutate] of mutations) {
      const candidate = structuredClone(ISSUE128_FINISH_AND_DISCLOSE_AUTHORITY_CATALOG);
      mutate(candidate);
      assert.throws(() => issue128FinishAndDiscloseAuthorityOracle(candidate), /issue #128/u, label);
    }
    assert.equal(issue128FinishAndDiscloseAuthorityOracle(), true);
    assert.equal(DURABLE_AUTHORITY_CATALOG.flatMap(({ records }) => records).some(({ id }) => id === ISSUE128_FINISH_AND_DISCLOSE_RECORD_IDS[0]), false, "the pre-existing global catalog remains byte-for-byte independent");
  });
});

function materializeIssue128EmptyAuthority(runDir, run) {
  for (const slice of run.slices) {
    for (const entry of slice.attempt_reviews || []) {
      entry.evidence_ref = `evidence/${slice.id}.attempt-${entry.attempt}.json`;
      entry.review_ref = `reviews/${slice.id}.attempt-${entry.attempt}.json`;
      const nonconvergent = entry.convergence === "nonconvergent";
      const rejected = entry.verdict === "REJECT";
      const requiredFixes = rejected ? [nonconvergent ? "Replace the nonconvergent approach" : "Repair the rejected implementation"] : [];
      const evidence = {
        subject: slice.id,
        attempt: entry.attempt,
        status: "pass",
        review_ready: true,
        head_sha: entry.reviewed_commit,
        ownership_disclosure: [],
      };
      const review = {
        subject: slice.id,
        attempt: entry.attempt,
        reviewed_commit: entry.reviewed_commit,
        verdict: entry.verdict,
        convergence: entry.convergence,
        late_discovery_strike: entry.late_discovery_strike,
        remaining_fix_count: requiredFixes.length,
        required_fixes: requiredFixes,
        ownership_ratification: { schema_version: 2, kind: "factory-derived-modified-extension" },
        remediation_context: {
          schema_version: 2,
          fixes: requiredFixes.map((_fix, required_fix_index) => ({
            required_fix_index,
            classification: nonconvergent ? "nonconvergent" : "narrow-correction",
            scope_effect: "in-lane",
            likely_paths: [`src/${slice.id}/fix.js`],
            fix_owner: slice.id,
          })),
        },
      };
      mkdirSync(dirname(join(runDir, entry.evidence_ref)), { recursive: true });
      mkdirSync(dirname(join(runDir, entry.review_ref)), { recursive: true });
      writeFileSync(join(runDir, entry.evidence_ref), `${JSON.stringify(evidence, null, 2)}\n`);
      writeFileSync(join(runDir, entry.review_ref), `${JSON.stringify(review, null, 2)}\n`);
      entry.evidence_hash = hashFileBytes(join(runDir, entry.evidence_ref));
      entry.review_hash = hashFileBytes(join(runDir, entry.review_ref));
    }
    if (["review", "merged"].includes(slice.status)) {
      const current = slice.attempt_reviews.at(-1);
      slice.evidence_ref = current.evidence_ref;
      slice.evidence_hash = current.evidence_hash;
      slice.review_ref = current.review_ref;
      slice.review_hash = current.review_hash;
      slice.reviewed_commit = current.reviewed_commit;
    }
  }
  const nonconvergent = run.terminal_result?.nonconvergence;
  if (nonconvergent) {
    const current = run.slices.find(({ id }) => id === nonconvergent.slice_id).attempt_reviews.at(-1);
    nonconvergent.source_review = structuredClone(current);
    const reviewIndex = nonconvergent.continuation.args.indexOf("--review") + 1;
    nonconvergent.continuation.args[reviewIndex] = current.review_ref;
  }
  validateRun(run);
  return run;
}

function issue128RunAuthorityFailures(runDir, run) {
  const failures = [];
  const consume = (check, fn) => {
    try { fn(); } catch (error) { failures.push({ check, rejection: error.message }); }
  };
  consume("validateRun", () => validateRun(run));
  for (const check of checkRunConsistency(runDir, run).checks.filter(({ ok }) => !ok)) {
    failures.push(...check.errors.map(({ path, message }) => ({ check: `checkRunConsistency: ${check.name}`, rejection: `${path}: ${message}` })));
  }
  consume("observeAcceptedDecompositionAuthority", () => observeAcceptedDecompositionAuthority(runDir, run, { requireIntegrationGate: true, requireApprovingReview: true }));
  for (const slice of run.slices || []) {
    consume(`assertSliceAttemptHistoryCurrent(${slice.id})`, () => assertSliceAttemptHistoryCurrent(runDir, slice.id, slice));
    if (slice.status === "merged") {
      consume(`observeReviewedMergeProof(${slice.id})`, () => observeReviewedMergeProof(runDir, slice.id, slice.merge_commit, slice.reviewed_commit));
    }
  }
  if (!run.slices?.some(({ status }) => status === "blocked")) {
    consume("assertNoUnresolvedSliceDispatches", () => assertNoUnresolvedSliceDispatches(runDir, run));
  }
  return failures;
}

function issue128ExpectedConsumerFailures(runDir, run, mutation) {
  const failures = [];
  const check = mutation.expected_check;
  let consume;
  if (check === "validateRun") consume = () => validateRun(run);
  else if (check === "observeAcceptedDecompositionAuthority") consume = () => observeAcceptedDecompositionAuthority(runDir, run, { requireIntegrationGate: true, requireApprovingReview: true });
  else if (check === "assertNoUnresolvedSliceDispatches") consume = () => assertNoUnresolvedSliceDispatches(runDir, run);
  else if (check === "assertIntegrationAmendmentConsistency") consume = () => assertIntegrationAmendmentConsistency(runDir, run);
  else if (check.startsWith("assertSliceAttemptHistoryCurrent(")) {
    const sliceId = check.slice("assertSliceAttemptHistoryCurrent(".length, -1);
    consume = () => assertSliceAttemptHistoryCurrent(runDir, sliceId, run.slices.find(({ id }) => id === sliceId));
  } else if (check.startsWith("observeReviewedMergeProof(")) {
    const sliceId = check.slice("observeReviewedMergeProof(".length, -1);
    const slice = run.slices.find(({ id }) => id === sliceId);
    consume = () => observeReviewedMergeProof(runDir, sliceId, slice.merge_commit, slice.reviewed_commit);
  } else if (check.startsWith("checkRunConsistency: ")) {
    const checkName = check.slice("checkRunConsistency: ".length);
    const result = checkRunConsistency(runDir, run).checks.find(({ name }) => name === checkName);
    assert.ok(result, `${mutation.name}: production consistency check ${checkName} must exist`);
    if (!result.ok) failures.push(...result.errors.map(({ path, message }) => ({ check, rejection: `${path}: ${message}` })));
    return failures;
  } else throw new Error(`${mutation.name}: unsupported expected production check ${check}`);
  try { consume(); } catch (error) { failures.push({ check, rejection: error.message }); }
  return failures;
}

function assertIssue128TargetRejection(failures, mutation) {
  assert.equal(typeof mutation.expected_check, "string", `${mutation.name}: expected production check`);
  assert.equal(typeof mutation.expected_rejection, "string", `${mutation.name}: expected rejection discriminator`);
  const intended = failures.filter(({ check }) => check === mutation.expected_check);
  assert.notEqual(intended.length, 0, `${mutation.name}: expected ${mutation.expected_check}, got ${JSON.stringify(failures)}`);
  const discriminator = new RegExp(mutation.expected_rejection, "iu");
  assert.equal(intended.some(({ rejection }) => discriminator.test(rejection)), true, `${mutation.name}: ${mutation.expected_check} did not reject with /${mutation.expected_rejection}/; got ${JSON.stringify(intended)}`);
}

function createIssue128ExecutableFixture(root, row, index) {
  const repo = join(root, String(index));
  createIssue128StaticGit(repo);
  const runId = "issue128-oracle";
  const runDir = join(repo, ".opencode", "factory", runId);
  for (const directory of ["dispatch", "evidence", "plan", "reviews"]) mkdirSync(join(runDir, directory), { recursive: true });
  const plan = issue128Plan();
  writeJson(join(runDir, "plan", "slices.json"), plan);
  writeJson(join(runDir, "reviews", "work-decomposer.json"), { subject: "work-decomposer", attempt: 1, verdict: "APPROVE", required_fixes: [] });
  const amendmentOwner = row.id === "amendment-owner-snapshot-v2-history";
  const ownerReviewed = amendmentOwner ? "d29a5e849c5c73bc0d8dfe723fb51578ee6dfc06" : "ff72597376c2c7c3771198a766a1ba1c049da558";
  const ownerFamily = writeVerificationArtifactReceipt({
    runDir, runId, plan, sliceId: "owner", attempt: 1, reviewedCommit: ownerReviewed,
    artifactId: "fixture-artifact-1", evidenceRef: "evidence/owner.family.json",
    result: { type: "verification-result", outcome: "pass", summary: "Verify owner behavior passed" },
  });
  const expectedFamilyHash = JSON.parse(row.external_sources[row.external_sources.owner_review ? "owner_review" : "review"].bytes).invariant_family_ledger?.dispositions[0]?.evidence_hash;
  if (expectedFamilyHash) assert.equal(ownerFamily.hash, expectedFamilyHash, `${row.id}: owner family source hash`);
  const siblingRow = ISSUE128_FINISH_AND_DISCLOSE_AUTHORITY_CATALOG.find(({ id }) => id === "slice-attempt-review-v2-approve-sibling");
  const sources = structuredClone(row.external_sources);
  if (!amendmentOwner && !sources.owner_evidence) {
    for (const key of ["owner_evidence", "owner_review", "owner_dispatch_claim", "owner_dispatch_closure"]) sources[key] = structuredClone(siblingRow.external_sources[key]);
  }
  const sidecars = materializeIssue128Sources(runDir, sources, row.id);
  const run = createIssue128DurableRunBaseline(row);
  run.slices.push({ id: "remaining", stack: "backend", depends_on: ["consumer"], declared_paths: ["src/remaining/**"], effective_paths: ["src/remaining/**"], status: "pending", attempts: 0 });
  run.steps = [{
    agent: "work-decomposer", status: "accepted", attempts: 1, artifact_ref: "plan/slices.json", review_ref: "reviews/work-decomposer.json",
    acceptance: {
      artifact_ref: "plan/slices.json", artifact_hash: hashFileBytes(join(runDir, "plan", "slices.json")),
      review_ref: "reviews/work-decomposer.json", review_hash: hashFileBytes(join(runDir, "reviews", "work-decomposer.json")),
    },
  }];
  if (row.owner_source) assert.deepEqual(run.slices.find(({ id }) => id === "owner"), row.owner_source, `${row.id}: exact related owner source before production consumer`);
  assert.deepEqual(issue128CanonicalSource(run, row), row.source, `${row.id}: exact source before production consumer`);
  if (row.enclosing_source) assert.deepEqual(run.slices.find(({ id }) => id === "consumer").attempt_reviews[0], row.enclosing_source, `${row.id}: exact enclosing A2 before production consumer`);
  writeJson(join(runDir, "run.json"), run);
  return { repo, runDir, run, sidecars };
}

async function createIssue128AmendmentFixture(root, row, index) {
  const repo = join(root, String(index));
  createIssue128StaticGit(repo);
  const runId = "issue128-oracle";
  const runDir = join(repo, ".opencode", "factory", runId);
  for (const directory of ["dispatch", "evidence", "plan", "reviews"]) mkdirSync(join(runDir, directory), { recursive: true });
  const plan = issue128Plan();
  writeJson(join(runDir, "plan", "slices.json"), plan);
  writeJson(join(runDir, "reviews", "work-decomposer.json"), { subject: "work-decomposer", attempt: 1, verdict: "APPROVE", required_fixes: [] });
  const family = writeVerificationArtifactReceipt({
    runDir, runId, plan, sliceId: "owner", attempt: 1, reviewedCommit: row.source.reviewed_commit,
    artifactId: "fixture-artifact-1", evidenceRef: "evidence/owner.family.json",
    result: { type: "verification-result", outcome: "pass", summary: "Verify owner behavior passed" },
  });
  assert.equal(family.hash, JSON.parse(row.external_sources.review.bytes).invariant_family_ledger.dispositions[0].evidence_hash);
  const sidecars = materializeIssue128Sources(runDir, row.external_sources, row.id);
  const ownerEntry = row.source.attempt_reviews[0];
  const owner = {
    ...structuredClone(row.source),
    branch: "issue128-owner",
    worktree: "/tmp/issue128-owner",
    dispatch_required: true,
    dispatch_claim_ref: ownerEntry.dispatch_claim_ref,
    dispatch_claim_hash: ownerEntry.dispatch_claim_hash,
    dispatch_closure_ref: ownerEntry.dispatch_closure_ref,
    dispatch_closure_hash: ownerEntry.dispatch_closure_hash,
  };
  const consumer = { id: "consumer", stack: "backend", depends_on: ["owner"], declared_paths: ["src/consumer/**"], effective_paths: ["src/consumer/**"], status: "pending", attempts: 0 };
  const planPath = join(runDir, "plan", "slices.json");
  const decompositionReviewPath = join(runDir, "reviews", "work-decomposer.json");
  const baseline = row.source.merge_commit;
  const baselineTree = fixtureGit(repo, ["rev-parse", `${baseline}^{tree}`]).trim();
  const run = {
    schema_version: 1, run_id: runId, status: "running", branch: "issue128-amendment-main", worktree: repo, gates: {}, slices: [owner, consumer, { id: "remaining", stack: "backend", depends_on: ["consumer"], declared_paths: ["src/remaining/**"], effective_paths: ["src/remaining/**"], status: "pending", attempts: 0 }],
    steps: [{
      agent: "work-decomposer", status: "accepted", attempts: 1, artifact_ref: "plan/slices.json", review_ref: "reviews/work-decomposer.json",
      acceptance: { artifact_ref: "plan/slices.json", artifact_hash: hashFileBytes(planPath), review_ref: "reviews/work-decomposer.json", review_hash: hashFileBytes(decompositionReviewPath) },
    }],
  };
  writeJson(join(runDir, "run.json"), run);
  const unit = plan.delivery_envelope.delivery_units.find(({ slice_id }) => slice_id === "consumer");
  const artifact = unit.verification_artifacts[0];
  const admission = {
    baseline_ref: "refs/heads/issue128-amendment-main", baseline_commit: baseline, baseline_tree: baselineTree, worktree: repo,
    probe: { schema_version: 1, kind: "integration-amendment-probe", delivery_unit_id: unit.id, consumer_slice_id: "consumer", verification_artifact_id: artifact.id, test_plan_index: artifact.test_plan_index, test_plan_entry: artifact.test_plan_entry, program: "node", args: ["--test", "consumer"], timeout_ms: artifact.timeout_ms, substrate: "feature-baseline" },
    owner: structuredClone(row.source), consumer: structuredClone(consumer),
  };
  const identity = { schema_version: 1, kind: "integration-amendment-identity", run_id: runId, defect_path: "src/owner/amendment.js", admission };
  const amendmentId = integrationAmendmentId(identity);
  const nonce = "issue128-amendment-report-nonce";
  const receiptRef = `evidence/integration-amendment-${amendmentId}.report.receipt.json`;
  const stream = { captured_bytes: 0, sha256: `sha256:${createHash("sha256").update("").digest("hex")}`, truncated: false };
  const receipt = {
    schema_version: 1, kind: "integration-amendment-execution-receipt", phase: "report", subject: `integration-amendment:${amendmentId}:report`, run_id: runId,
    amendment_id: amendmentId, claim_nonce: nonce, probe: admission.probe, head_sha: baseline, tree_sha: baselineTree, cwd: repo, timeout_ms: artifact.timeout_ms,
    started_at: CLAIM_NOW, completed_at: CLAIM_NOW, duration_ms: 1, status: "fail", review_ready: true,
    commands: [{ index: 0, program: "node", args: ["--test", "consumer"], outcome: "exited", status: "fail", exit_code: 1, signal: null, error_code: null, duration_ms: 1, stdout: stream, stderr: stream }],
  };
  writeJson(join(runDir, receiptRef), receipt);
  writeJson(join(runDir, "evidence", "integration-amendment.report.claim.json"), {
    schema_version: 1, kind: "integration-amendment-execution-claim", phase: "report", subject: receipt.subject, state: "completed", nonce, amendment_id: amendmentId,
    identity, run_id: runId, probe: admission.probe, head_sha: baseline, tree_sha: baselineTree, cwd: repo, timeout_ms: artifact.timeout_ms,
    receipt_ref: receiptRef, claimed_at: CLAIM_NOW, completed_at: CLAIM_NOW, status: "fail", receipt_hash: hashFileBytes(join(runDir, receiptRef)),
  });
  await transitionIntegrationAmendment(runDir, { action: "report", owner_slice_id: "owner", consumer_slice_id: "consumer", defect_path: "src/owner/amendment.js", verification_artifact_id: artifact.id }, { repoRoot: repo, now: CLAIM_NOW });
  const published = JSON.parse(readFileSync(join(runDir, "run.json"), "utf8"));
  assert.deepEqual(published.integration_amendment.admission.owner, row.source, `${row.id}: exact source before amendment consistency consumer`);
  return { repo, runDir, run: published, sidecars };
}

function issue128Plan() {
  return withDeliveryEnvelope({
    slices: [
      { id: "owner", stack: "backend", paths: ["src/owner/**"], depends_on: [], acceptance: ["owner"], test_plan: ["node --test owner"] },
      { id: "consumer", stack: "backend", paths: ["src/consumer/**"], depends_on: ["owner"], acceptance: ["consumer"], test_plan: ["node --test consumer"] },
      { id: "remaining", stack: "backend", paths: ["src/remaining/**"], depends_on: ["consumer"], acceptance: ["remaining"], test_plan: ["node --test remaining"] },
    ],
    integration_gate: { required_commands: [{ program: "npm", args: ["run", "check"] }] },
  });
}

function materializeIssue128Sources(runDir, sources, id) {
  const sidecars = new Map();
  for (const [name, source] of Object.entries(sources)) {
    const path = join(runDir, source.ref);
    if (sidecars.has(source.ref)) {
      assert.equal(sidecars.get(source.ref).bytes, source.bytes, `${id}: ${name} duplicate ref bytes`);
      continue;
    }
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, source.bytes, "utf8");
    assert.equal(hashFileBytes(path), source.hash, `${id}: ${name} exact sidecar hash`);
    sidecars.set(source.ref, { path, bytes: source.bytes, hash: source.hash });
  }
  return sidecars;
}

function restoreIssue128ExecutableBaseline(fixture, immutableRun, immutableRunBytes, mutation) {
  const runPath = join(fixture.runDir, "run.json");
  assert.deepEqual(fixture.run, immutableRun, `${mutation.name}: immutable structured run baseline`);
  writeFileSync(runPath, immutableRunBytes);
  assert.deepEqual(readFileSync(runPath), immutableRunBytes, `${mutation.name}: exact restored run.json bytes`);
  assert.equal(hashFileBytes(runPath), hashBuffer(immutableRunBytes), `${mutation.name}: exact restored run.json hash`);
  for (const sidecar of fixture.sidecars.values()) {
    writeFileSync(sidecar.path, sidecar.bytes);
    assert.deepEqual(readFileSync(sidecar.path), Buffer.from(sidecar.bytes), `${mutation.name}: exact restored sidecar bytes`);
    assert.equal(hashFileBytes(sidecar.path), sidecar.hash, `${mutation.name}: exact restored sidecar hash`);
  }
}

function freezeIssue128Baseline(value) {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value)) freezeIssue128Baseline(nested);
  return Object.freeze(value);
}

function issue128CanonicalSource(run, row) {
  const consumer = run.slices.find(({ id }) => id === "consumer");
  if (row.id.startsWith("slice-attempt-review-")) return consumer.attempt_reviews[0];
  if (row.id.startsWith("slice-modified-extension-")) return consumer.attempt_reviews[0].modified_extensions[0];
  if (row.id.startsWith("slice-")) return run.slices.find(({ id }) => id === row.source.id);
  if (row.id.startsWith("terminal-")) return run.terminal_result.nonconvergence;
  if (row.id === "amendment-owner-snapshot-v2-history") return run.integration_amendment?.admission.owner;
  return run.continuation?.carry_forward.accepted_slices.find(({ id }) => id === row.source.id);
}

function applyIssue128ExecutableMutation(run, fixture, row, mutation) {
  if (mutation.code === "B") {
    const sourceName = mutation.path[1];
    const source = row.external_sources[sourceName];
    const sidecar = fixture.sidecars.get(source.ref);
    writeFileSync(sidecar.path, `${sidecar.bytes} `);
    return;
  }
  const source = issue128CanonicalSource(run, row);
  const enclosing = row.id.startsWith("slice-modified-extension-") ? run.slices.find(({ id }) => id === "consumer").attempt_reviews[0] : null;
  const rootName = mutation.path[0];
  const path = mutation.path.slice(1);
  let owner = rootName === "enclosing_source" ? enclosing : rootName === "owner_source" ? run.slices.find(({ id }) => id === "owner") : source;
  if (mutation.operation === "unknown-key") {
    for (const segment of path) owner = owner[segment];
    assert.deepEqual(owner, mutation.expected, `${mutation.name}: exact object boundary before unsupported-key insertion`);
    assert.equal(Object.hasOwn(owner, mutation.key), false, `${mutation.name}: unsupported key must be new`);
    owner[mutation.key] = mutation.value;
    assert.equal(owner[mutation.key], mutation.value, `${mutation.name}: unsupported key must be physically inserted`);
    return;
  }
  for (const segment of path.slice(0, -1)) owner = owner[segment];
  const key = path.at(-1);
  assert.deepEqual(owner[key], mutation.expected, `${mutation.name}: exact field before physical mutation`);
  if (mutation.code === "K") delete owner[key];
  else if (mutation.code === "V") owner[key] = typeof owner[key] === "string" ? "invalid" : "invalid-type";
  else if (mutation.code === "R") owner[key] = owner[key].startsWith("evidence/") ? "evidence/missing.json" : owner[key].startsWith("dispatch/") ? "dispatch/missing.json" : "reviews/missing.json";
  else if (mutation.code === "H") owner[key] = `sha256:${"0".repeat(64)}`;
  else if (mutation.code === "D") owner[key] = Array.isArray(owner[key]) ? [...owner[key], "synthetic/path"] : `drift-${owner[key]}`;
  else if (mutation.code === "I") owner[key] = Number.isInteger(owner[key]) ? owner[key] + 1 : owner[key]?.length === 40 ? "0".repeat(40) : "cross-bound-owner";
  else if (mutation.code === "X") owner[key] = "1".repeat(40);
}

function createIssue128StaticGit(repo) {
  mkdirSync(join(repo, "docs"), { recursive: true });
  mkdirSync(join(repo, "src", "owner"), { recursive: true });
  fixtureGit(repo, ["init", "-q", "-b", "main"]);
  writeFileSync(join(repo, ".git", "info", "exclude"), ".opencode/\n");
  writeFileSync(join(repo, "README.md"), "fixture\n");
  writeFileSync(join(repo, "docs", "consumer.md"), "baseline consumer\n");
  writeFileSync(join(repo, "src", "owner", "shared.js"), "export const shared = 1;\n");
  fixtureGit(repo, ["add", "README.md", "docs/consumer.md", "src/owner/shared.js"]);
  issue128Commit(repo, "2026-01-01T00:00:00Z", ["commit", "-q", "-m", "issue 128 baseline"]);
  const base = fixtureGit(repo, ["rev-parse", "HEAD"]).trim();
  assert.equal(base, "8b20ea435c507974bec4acb19f81e17969a8cf23");
  for (const branch of ["issue128-owner", "issue128-consumer", "issue128-empty", "issue128-unowned", "issue128-sibling", "issue128-amendment-owner"]) fixtureGit(repo, ["branch", branch, base]);

  fixtureGit(repo, ["checkout", "-q", "issue128-owner"]);
  writeFileSync(join(repo, "src", "owner", "owned.js"), "export const owned = true;\n");
  fixtureGit(repo, ["add", "src/owner/owned.js"]);
  issue128Commit(repo, "2026-01-01T00:01:00Z", ["commit", "-q", "-m", "issue 128 owner"]);
  assert.equal(fixtureGit(repo, ["rev-parse", "HEAD"]).trim(), "ff72597376c2c7c3771198a766a1ba1c049da558");
  fixtureGit(repo, ["checkout", "-q", "main"]);
  issue128Commit(repo, "2026-01-01T00:02:00Z", ["merge", "-q", "--no-ff", "-m", "merge issue 128 owner", "issue128-owner"]);
  const ownerMerge = fixtureGit(repo, ["rev-parse", "HEAD"]).trim();
  assert.equal(ownerMerge, "84ae9626ea3f547d151a9bc024393e5737805355");

  fixtureGit(repo, ["checkout", "-q", "issue128-empty"]);
  issue128Commit(repo, "2026-01-01T00:03:00Z", ["commit", "-q", "--allow-empty", "-m", "issue 128 empty consumer"]);
  assert.equal(fixtureGit(repo, ["rev-parse", "HEAD"]).trim(), "08f147e9f78c7a13c5b1e8159c6d85c8beb6a5fe");
  issue128MergeVariant(repo, "empty", ownerMerge, "issue128-empty", "2026-01-01T00:04:00Z", "cc372a426a85607b070337de5ddc601dc1604354");

  fixtureGit(repo, ["checkout", "-q", "issue128-unowned"]);
  writeFileSync(join(repo, "docs", "consumer.md"), "changed consumer\n");
  fixtureGit(repo, ["add", "docs/consumer.md"]);
  issue128Commit(repo, "2026-01-01T00:05:00Z", ["commit", "-q", "-m", "issue 128 unowned consumer"]);
  assert.equal(fixtureGit(repo, ["rev-parse", "HEAD"]).trim(), "2ab370fb56a397c11c1dd1defe59203a1587797a");
  issue128MergeVariant(repo, "unowned", ownerMerge, "issue128-unowned", "2026-01-01T00:06:00Z", "3b45f19f7ee2421894135a8dbd4462a49ead2209");

  fixtureGit(repo, ["checkout", "-q", "issue128-sibling"]);
  writeFileSync(join(repo, "src", "owner", "shared.js"), "export const shared = 2;\n");
  fixtureGit(repo, ["add", "src/owner/shared.js"]);
  issue128Commit(repo, "2026-01-01T00:07:00Z", ["commit", "-q", "-m", "issue 128 sibling consumer"]);
  assert.equal(fixtureGit(repo, ["rev-parse", "HEAD"]).trim(), "ddc920e780e08f2a3561d407b880f22a726b7c9d");
  issue128MergeVariant(repo, "sibling", ownerMerge, "issue128-sibling", "2026-01-01T00:08:00Z", "d209b10df237a6893c2aae54e4a36676588feda9");

  fixtureGit(repo, ["checkout", "-q", "issue128-amendment-owner"]);
  writeFileSync(join(repo, "docs", "consumer.md"), "changed amendment owner\n");
  writeFileSync(join(repo, "src", "owner", "amendment.js"), "export const amendmentOwner = true;\n");
  fixtureGit(repo, ["add", "docs/consumer.md", "src/owner/amendment.js"]);
  issue128Commit(repo, "2026-01-01T00:09:00Z", ["commit", "-q", "-m", "issue 128 amendment owner"]);
  assert.equal(fixtureGit(repo, ["rev-parse", "HEAD"]).trim(), "d29a5e849c5c73bc0d8dfe723fb51578ee6dfc06");
  issue128MergeVariant(repo, "amendment", base, "issue128-amendment-owner", "2026-01-01T00:10:00Z", "32c7160a87fd07fb9125ca31af1e46123f1dbbef");
  fixtureGit(repo, ["branch", "-f", "issue128-oracle", ownerMerge]);
}

function issue128MergeVariant(repo, name, base, reviewedBranch, date, expected) {
  fixtureGit(repo, ["checkout", "-q", "-B", `issue128-${name}-main`, base]);
  issue128Commit(repo, date, ["merge", "-q", "--no-ff", "-m", `merge issue 128 ${name}${name === "amendment" ? " owner" : " consumer"}`, reviewedBranch]);
  assert.equal(fixtureGit(repo, ["rev-parse", "HEAD"]).trim(), expected);
}

function issue128Commit(repo, date, args) {
  return execFileSync("git", args, {
    cwd: repo,
    encoding: "utf8",
    env: { ...process.env, GIT_AUTHOR_NAME: "Issue 128 Oracle", GIT_AUTHOR_EMAIL: "oracle@example.com", GIT_AUTHOR_DATE: date, GIT_COMMITTER_NAME: "Issue 128 Oracle", GIT_COMMITTER_EMAIL: "oracle@example.com", GIT_COMMITTER_DATE: date },
  });
}

async function consumeB0M3Mutation(root, record, mutationCase) {
  const safeName = mutationCase.name.replaceAll(/[^a-z0-9]+/giu, "-");
  if (record.id.startsWith("slice-")) return consumeSliceMutation(root, record, mutationCase, safeName);
  if (record.id.endsWith("-verdict-binding")) return consumePanelMutation(root, record, mutationCase, safeName);
  if (record.id.startsWith("steering-")) return consumeSteeringMutation(root, record, mutationCase, safeName);
  if (["terminal-result-completed", "pr-created-result"].includes(record.id)) return consumePrCreatedMutation(root, record, mutationCase, safeName);
  throw new Error(`no B0M.3 consumer for ${record.id}`);
}

async function consumeSliceMutation(root, record, mutationCase, safeName) {
  const mutation = mutationCase.record;
  if (["slice-review", "slice-merged"].includes(record.id)) {
    const repo = join(root, `actual-${record.id}`, safeName);
    const runDir = join(repo, ".opencode", "factory", "catalog-run");
    initCatalogGit(repo);
    fixtureGit(repo, ["branch", "feature--backend"]);
    const sliceWorktree = join(repo, ".opencode", "worktrees", "backend");
    mkdirSync(join(repo, ".opencode", "worktrees"), { recursive: true });
    fixtureGit(repo, ["worktree", "add", sliceWorktree, "feature--backend"]);
    const sliceBaseline = fixtureGit(sliceWorktree, ["rev-parse", "HEAD"]).trim();
    writeFileSync(join(sliceWorktree, "backend.txt"), "reviewed backend\n");
    fixtureGit(sliceWorktree, ["add", "backend.txt"]);
    fixtureGit(sliceWorktree, ["commit", "-q", "-m", "reviewed backend"]);
    const reviewedHead = fixtureGit(sliceWorktree, ["rev-parse", "HEAD"]).trim();
    const adaptSliceSources = (sources) => {
      const adapted = Object.fromEntries(Object.entries(sources || {}).map(([name, external]) => [name, {
        ...external,
        bytes: typeof external.bytes === "string"
          ? external.bytes.replaceAll("b".repeat(40), reviewedHead).replaceAll("/tmp/backend", sliceWorktree)
          : external.bytes,
      }]));
      if (adapted.claim && adapted.closure) {
        try {
          const claim = JSON.parse(adapted.claim.bytes);
          claim.head = sliceBaseline;
          adapted.claim.bytes = `${JSON.stringify(claim, null, 2)}\n`;
          const closure = JSON.parse(adapted.closure.bytes);
          closure.head = sliceBaseline;
          closure.claim_hash = `sha256:${createHash("sha256").update(adapted.claim.bytes).digest("hex")}`;
          adapted.closure.bytes = `${JSON.stringify(closure, null, 2)}\n`;
        } catch {
          // Preserve an intentionally malformed wrong-bytes closure mutation.
        }
      }
      return adapted;
    };
    materializeCatalogSources(runDir, adaptSliceSources(record.externalSources));
    const expectedEvidenceHash = hashFileBytes(join(runDir, "evidence", "backend.json"));
    const expectedReviewHash = hashFileBytes(join(runDir, "reviews", "backend.json"));
    const expectedClaimHash = hashFileBytes(join(runDir, record.source.dispatch_claim_ref));
    const expectedClosureHash = hashFileBytes(join(runDir, record.source.dispatch_closure_ref));
    materializeCatalogSources(runDir, adaptSliceSources(mutationCase.externalSources));
    const current = structuredClone(record.source);
    current.worktree = sliceWorktree;
    current.reviewed_commit = reviewedHead;
    current.authorized_baseline_commit = sliceBaseline;
    current.evidence_hash = expectedEvidenceHash;
    current.review_hash = expectedReviewHash;
    current.dispatch_claim_hash = expectedClaimHash;
    current.dispatch_closure_hash = expectedClosureHash;
    current.attempt_reviews = current.attempt_reviews.map((entry) => ({
      ...entry,
      evidence_hash: expectedEvidenceHash,
      review_hash: expectedReviewHash,
      reviewed_commit: reviewedHead,
      diff_base_commit: sliceBaseline,
    }));
    let mergeCommit = null;
    if (record.id === "slice-merged") {
      fixtureGit(repo, ["merge", "--no-ff", "feature--backend", "-m", "merge backend"]);
      mergeCommit = fixtureGit(repo, ["rev-parse", "HEAD"]).trim();
      current.merge_commit = mergeCommit;
      current.updated_at = record.source.updated_at;
    }
    applyMutationDifference(current, record.source, mutation);
    writeJson(join(runDir, "run.json"), createRunRecord({ run_id: "catalog-run", branch: "main", worktree: repo, slices: [current] }));
    if (record.id === "slice-merged") {
      await assert.rejects(transitionSliceMerged(runDir, "backend", { merge_commit: mergeCommit }, { repoRoot: repo }), undefined, mutationCase.name);
      return "transitionSliceMerged";
    }
    await assert.rejects(transitionRunSlice(runDir, "backend", {
      status: "review", attempts: current.attempts, evidence_ref: current.evidence_ref, review_ref: current.review_ref,
    }, { repoRoot: repo }), undefined, mutationCase.name);
    return "transitionRunSlice";
  }

  const runDir = join(root, `actual-${record.id}`, safeName);
  mkdirSync(runDir, { recursive: true });
  if (record.id === "slice-pending") {
    const current = { ...structuredClone(record.source), branch: "progress-bound" };
    writeJson(join(runDir, "run.json"), createRunRecord({ run_id: "catalog-run", slices: [current] }));
    writeJson(join(runDir, "plan", "slices.json"), withDeliveryEnvelope({
      integration_gate: { required_commands: [{ program: "npm", args: ["run", "check"] }] },
      slices: [{ id: record.source.id, stack: record.source.stack, paths: ["src/**"], depends_on: record.source.depends_on, acceptance: ["accepted"], test_plan: ["node --test"] }],
    }));
    await assert.rejects(transitionSlicesSeed(runDir, [mutation], { from: "plan/slices.json" }), undefined, record.id);
    return "transitionSlicesSeed";
  }
  if (record.id === "slice-running") {
    materializeCatalogSources(runDir, mutationCase.externalSources);
    const run = createRunRecord({ run_id: "catalog-run", slices: [mutation] });
    writeJson(join(runDir, "run.json"), run);
    assert.throws(() => assertNoUnresolvedSliceDispatches(runDir, run), undefined, mutationCase.name);
    return "assertNoUnresolvedSliceDispatches";
  }
  if (["slice-blocked", "slice-blocked-ordinary"].includes(record.id)) {
    const baselineDir = join(runDir, "baseline");
    const baselineRun = createRunRecord({ run_id: "catalog-run", slices: [structuredClone(record.source)] });
    materializeCatalogSources(baselineDir, record.externalSources);
    writeJson(join(baselineDir, "run.json"), baselineRun);
    assert.doesNotThrow(() => assertNoUnresolvedSliceDispatches(baselineDir, baselineRun), `${mutationCase.name}: valid predecessor dispatch`);
    assert.doesNotThrow(() => assertSliceAttemptHistoryCurrent(baselineDir, "backend", baselineRun.slices[0]), `${mutationCase.name}: valid predecessor history`);
    assert.equal(checkRunConsistency(baselineDir, baselineRun).ok, true, `${mutationCase.name}: valid predecessor consistency`);

    const mutatedDir = join(runDir, "mutated");
    const mutatedRun = createRunRecord({ run_id: "catalog-run", slices: [mutation] });
    materializeCatalogSources(mutatedDir, mutationCase.externalSources);
    writeJson(join(mutatedDir, "run.json"), mutatedRun);
    let rejected = false;
    try {
      assertSliceAttemptHistoryCurrent(mutatedDir, "backend", mutatedRun.slices[0]);
      assertNoUnresolvedSliceDispatches(mutatedDir, mutatedRun);
    } catch {
      rejected = true;
    }
    if (!rejected) rejected = !checkRunConsistency(mutatedDir, mutatedRun).ok;
    assert.equal(rejected, true, mutationCase.name);
    return "assertNoUnresolvedSliceDispatches/checkRunConsistency";
  }

  const current = { ...structuredClone(record.source), status: "running", attempts: Math.max(1, record.source.attempts || 1) };
  delete current.evidence_ref;
  delete current.review_ref;
  delete current.merge_commit;
  delete current.blocked_reason;
  delete current.updated_at;
  if (record.id === "slice-review") materializeSliceSidecars(runDir, mutation.id);
  writeJson(join(runDir, "run.json"), createRunRecord({ run_id: "catalog-run", slices: [current] }));
  await assert.rejects(transitionRunSlice(runDir, "backend", mutation), undefined, mutationCase.name);
  return "transitionRunSlice";
}

async function consumePanelMutation(root, record, mutationCase, safeName) {
  const repo = join(root, `actual-${record.id}`, safeName);
  const runDir = join(repo, ".opencode", "factory", "catalog-run");
  initCatalogGit(repo);
  fixtureGit(repo, ["branch", "feature--catalog"]);
  fixtureGit(repo, ["checkout", "feature--catalog"]);
  const head = fixtureGit(repo, ["rev-parse", "HEAD"]).trim();
  for (const dir of ["artifacts", "reviews"]) mkdirSync(join(runDir, dir), { recursive: true });
  writeFileSync(join(runDir, "artifacts", "validation-report.md"), "GO\n");
  writeJson(join(runDir, "reviews", "implementation-validator.json"), { subject: "feature--catalog", attempt: 1, verdict: "GO", reviewed_head_sha: head });
  writeJson(join(runDir, "reviews", "security-reviewer.json"), { subject: "feature--catalog", attempt: 1, verdict: "PASS", reviewed_head_sha: head });
  const adaptPanelSources = (sources) => Object.fromEntries(Object.entries(sources || {}).map(([name, external]) => [name, {
    ...external,
    bytes: typeof external.bytes === "string" ? external.bytes.replaceAll("b".repeat(40), head) : external.bytes,
  }]));
  materializeCatalogSources(runDir, adaptPanelSources(record.externalSources));
  const expectedReportHash = hashFileBytes(join(runDir, "artifacts", "validation-report.md"));
  const expectedValidatorHash = hashFileBytes(join(runDir, "reviews", "implementation-validator.json"));
  const expectedSecurityHash = hashFileBytes(join(runDir, "reviews", "security-reviewer.json"));
  materializeCatalogSources(runDir, adaptPanelSources(mutationCase.externalSources));
  const validator = {
    verdict: "GO", report: "artifacts/validation-report.md", report_hash: expectedReportHash,
    review_ref: "reviews/implementation-validator.json", review_hash: expectedValidatorHash, reviewed_head_sha: head,
  };
  const security = {
    verdict: "PASS", review_ref: "reviews/security-reviewer.json", review_hash: expectedSecurityHash, reviewed_head_sha: head,
  };
  const target = record.id === "validator-verdict-binding" ? validator : security;
  applyMutationDifference(target, record.source, mutationCase.record);
  writeJson(join(runDir, "run.json"), createRunRecord({ run_id: "catalog-run", branch: "feature--catalog", worktree: repo, slices: [], validator, security_review: security }));
  await assert.rejects(transitionPanelVerdicts(runDir, {
    validator: { verdict: validator.verdict, report: validator.report, review_ref: validator.review_ref },
    security_review: { verdict: security.verdict, review_ref: security.review_ref },
  }), undefined, mutationCase.name);
  return "transitionPanelVerdicts";
}

async function consumeSteeringMutation(root, record, mutationCase) {
  if (record.id === "steering-pr-fence") return consumePrFenceMutation(root, record, mutationCase);
  const safeName = mutationCase.name.replaceAll(/[^a-z0-9]+/giu, "-");
  const runDir = join(root, `actual-${record.id}`, safeName);
  const runFile = join(runDir, "run.json");
  const steering = { schema_version: 1, generation: 2, pending: null, uncheckpointed: null, boundary: null, action_claim: null, last_action: null, pr_fence: null, history: [] };
  writeJson(runFile, createRunRecord({ run_id: "catalog-run", slices: [], steering }));
  const opened = await transitionSteeringBoundaryOpened(runDir, "dispatch", { token: "dispatch-token-1", now: "2026-07-16T12:00:00.000Z" });
  let authorityKey;
  let consumer;
  let consume;
  if (record.id === "steering-boundary") {
    authorityKey = "boundary";
    consumer = "transitionSteeringBoundaryCrossed";
    consume = () => transitionSteeringBoundaryCrossed(runDir, "dispatch", opened.boundary.token, { now: "2026-07-16T12:00:00.000Z" });
  } else {
    const crossed = await transitionSteeringBoundaryCrossed(runDir, "dispatch", opened.boundary.token, { now: "2026-07-16T12:00:00.000Z" });
    if (record.id === "steering-action-claim") {
      authorityKey = "action_claim";
      consumer = "transitionSteeringActionStarted";
      consume = () => transitionSteeringActionStarted(runDir, "dispatch", crossed.action_claim.token, { now: "2026-07-16T12:00:01.000Z" });
    } else {
      const started = await transitionSteeringActionStarted(runDir, "dispatch", crossed.action_claim.token, { now: "2026-07-16T12:00:01.000Z" });
      authorityKey = "last_action";
      consumer = "transitionSteeringActionClosed";
      consume = () => transitionSteeringActionClosed(runDir, "dispatch", started.action.token, { now: "2026-07-16T12:00:02.000Z" });
    }
  }
  const persisted = JSON.parse(readFileSync(runFile, "utf8"));
  applyMutationDifference(persisted.steering[authorityKey], record.source, mutationCase.record);
  writeJson(runFile, persisted);
  const before = readFileSync(runFile, "utf8");
  await assert.rejects(consume(), (error) => isExactSteeringRejection(record, mutationCase, error), `${mutationCase.name} exact steering rejection`);
  assert.equal(readFileSync(runFile, "utf8"), before, `${mutationCase.name} protected run bytes`);
  return consumer;
}

async function consumePrFenceMutation(root, record, mutationCase) {
  const safeName = mutationCase.name.replaceAll(/[^a-z0-9]+/giu, "-");
  const fixture = createPrOperationTransitionFixture(root, "actual-pr-fence", safeName);
  const established = await transitionPrePrFenceEstablished(fixture.runDir);
  const persisted = JSON.parse(readFileSync(fixture.runFile, "utf8"));
  applyMutationDifference(persisted.steering.pr_fence, record.source, mutationCase.record);
  writeJson(fixture.runFile, persisted);
  const before = readFileSync(fixture.runFile, "utf8");
  await assert.rejects(
    transitionPrePrFenceCleared(fixture.runDir, established.fence.token, { repoRoot: fixture.repo, observePrOperation: async () => ({ disposition: "absent", reason: "complete-absence", pull_request: null }) }),
    undefined,
    mutationCase.name,
  );
  assert.equal(readFileSync(fixture.runFile, "utf8"), before, `${mutationCase.name} protected run bytes`);
  return "transitionPrePrFenceCleared";
}

async function consumePrCreatedMutation(root, record, mutationCase, safeName) {
  const fixture = createPrOperationTransitionFixture(root, "actual-pr-created", safeName);
  const { repo, runDir, runFile } = fixture;
  const established = await transitionPrePrFenceEstablished(runDir);
  const persisted = JSON.parse(readFileSync(runFile, "utf8"));
  if (mutationCase.record.operation_id !== record.source.operation_id) persisted.steering.pr_fence.operation_id = mutationCase.record.operation_id;
  writeJson(runFile, persisted);
  const operation = persisted.steering.pr_fence;
  const observed = {
    pr_url: mutationCase.record.pr_url,
    pr_number: mutationCase.record.pr_number,
    pr_node_id: mutationCase.record.pr_node_id,
    repository: mutationCase.record.repository,
    head_ref: mutationCase.record.head_ref,
    head_sha: mutationCase.record.head_sha,
    base_ref: mutationCase.record.base_ref,
    base_sha: mutationCase.record.base_sha,
    draft: mutationCase.record.draft,
  };
  const before = readFileSync(runFile, "utf8");
  await assert.rejects(
    transitionPrCreated(runDir, {}, { fenceToken: operation.token, repoRoot: repo, observePrOperation: async () => ({ disposition: "open", reason: "unique-exact-open", pull_request: observed }) }),
    undefined,
    mutationCase.name,
  );
  assert.equal(readFileSync(runFile, "utf8"), before, `${mutationCase.name} protected run bytes`);
  return "transitionPrCreated";
}

function createPrOperationTransitionFixture(root, family, safeName) {
  const repo = join(root, family, safeName);
  const runDir = join(repo, ".opencode", "factory", "catalog-run");
  const runFile = join(runDir, "run.json");
  initCatalogGit(repo);
  fixtureGit(repo, ["remote", "add", "origin", "https://github.com/acme/repo.git"]);
  fixtureGit(repo, ["config", `url.file://${repo}/.insteadOf`, "https://github.com/acme/repo.git"]);
  const head = fixtureGit(repo, ["rev-parse", "HEAD"]).trim();
  for (const dir of ["artifacts", "evidence", "reviews", "plan", "gates"]) mkdirSync(join(runDir, dir), { recursive: true });
  writeFileSync(join(runDir, "artifacts", "validation-report.md"), "GO\n");
  writeJson(join(runDir, "evidence", "backend.json"), { subject: "backend", attempt: 1, status: "pass", review_ready: true, head_sha: head });
  writeJson(join(runDir, "reviews", "backend.json"), { subject: "backend", attempt: 1, verdict: "APPROVE", convergence: "converging", late_discovery_strike: false, remaining_fix_count: 0, required_fixes: [], ownership_ratification: { schema_version: 1, paths: [] }, remediation_context: { schema_version: 2, fixes: [] }, reviewed_commit: head });
  writeJson(join(runDir, "reviews", "implementation-validator.json"), { subject: "main", attempt: 1, verdict: "GO", reviewed_head_sha: head });
  writeJson(join(runDir, "reviews", "security-reviewer.json"), { subject: "main", attempt: 1, verdict: "PASS", reviewed_head_sha: head });
  writeJson(join(runDir, "reviews", "work-decomposer.json"), { subject: "work-decomposer", attempt: 1, verdict: "APPROVE", required_fixes: [] });
  const plan = withDeliveryEnvelope({
    slices: [{ id: "backend", stack: "backend", paths: ["src/backend/**"], depends_on: [], acceptance: ["backend works"], test_plan: ["test backend"] }],
    integration_gate: { required_commands: [{ program: "npm", args: ["run", "check"] }] },
  });
  const planPath = join(runDir, "plan", "slices.json");
  writeJson(planPath, plan);
  const receiptRef = "evidence/test-verifier.attempt-1.json";
  const testReviewRef = "reviews/test-verifier.attempt-1.json";
  const testArtifactRef = "artifacts/test-report.md";
  const nonce = "123e4567-e89b-42d3-a456-426614174128";
  const emptyStream = { captured_bytes: 0, sha256: claimHash(""), truncated: false };
  const receipt = {
    schema_version: 1, kind: "checked-test-execution-receipt", subject: "test-verifier", run_id: "catalog-run", attempt: 1,
    claim_nonce: nonce, plan_ref: "plan/slices.json", plan_hash: hashFileBytes(planPath), head_sha: head, timeout_ms: plan.integration_gate.timeout_ms,
    started_at: CLAIM_NOW, completed_at: CLAIM_NOW, duration_ms: 0, status: "pass", review_ready: true,
    commands: plan.integration_gate.required_commands.map((command, index) => ({ index, ...command, outcome: "exited", status: "pass", exit_code: 0, signal: null, error_code: null, duration_ms: 0, stdout: emptyStream, stderr: emptyStream })),
  };
  writeJson(join(runDir, receiptRef), receipt);
  const claim = {
    schema_version: 1, kind: "checked-test-execution-claim", state: "completed", nonce, run_id: "catalog-run", attempt: 1,
    plan_ref: "plan/slices.json", plan_hash: hashFileBytes(planPath), head_sha: head, timeout_ms: plan.integration_gate.timeout_ms, receipt_ref: receiptRef,
    claimed_at: CLAIM_NOW, completed_at: CLAIM_NOW, status: "pass", receipt_hash: hashFileBytes(join(runDir, receiptRef)),
  };
  writeFileSync(join(runDir, testArtifactRef), "checked integration passed\n");
  writeJson(join(runDir, testReviewRef), { subject: "test-verifier", attempt: 1, verdict: "APPROVE", reviewed_head_sha: head, required_fixes: [] });
  const validator = { verdict: "GO", report: "artifacts/validation-report.md", report_hash: hashFileBytes(join(runDir, "artifacts", "validation-report.md")), review_ref: "reviews/implementation-validator.json", review_hash: hashFileBytes(join(runDir, "reviews", "implementation-validator.json")), reviewed_head_sha: head };
  const securityReview = { verdict: "PASS", review_ref: "reviews/security-reviewer.json", review_hash: hashFileBytes(join(runDir, "reviews", "security-reviewer.json")), reviewed_head_sha: head };
  const testAcceptance = {
    artifact_ref: testArtifactRef, artifact_hash: hashFileBytes(join(runDir, testArtifactRef)), evidence_ref: receiptRef,
    evidence_hash: hashFileBytes(join(runDir, receiptRef)), review_ref: testReviewRef, review_hash: hashFileBytes(join(runDir, testReviewRef)), reviewed_head_sha: head,
  };
  const questionRef = "gates/pre-pr.md";
  writeFileSync(join(runDir, questionRef), "approve pre-PR?\n");
  const checkedAuthorityHash = hashValue({
    test_execution_claim_hash: hashValue(claim), test_acceptance: testAcceptance,
    validator: { report_hash: validator.report_hash, review_hash: validator.review_hash, reviewed_head_sha: head },
    security_review: { review_hash: securityReview.review_hash, reviewed_head_sha: head },
  });
  writeJson(runFile, createRunRecord({
    run_id: "catalog-run",
    branch: "main",
    worktree: repo,
    base_ref: "main",
    base_commit: head,
    github_account: "acme",
    pr_mode: "ready",
    gates: { pre_pr: {
      status: "approved", artifact: "artifacts/validation-report.md", question_ref: questionRef, answer: "approve", answered_at: CLAIM_NOW,
      pending_snapshot: {
        question_ref: questionRef, question_hash: hashFileBytes(join(runDir, questionRef)), artifact_ref: "artifacts/validation-report.md",
        artifact_hash: validator.report_hash, created_at: CLAIM_NOW, checked_authority_hash: checkedAuthorityHash,
      },
    } },
    slices: [modernMergedSlice(runDir, "backend", head)],
    steps: [{
      agent: "work-decomposer", status: "accepted", attempts: 1, artifact_ref: "plan/slices.json", review_ref: "reviews/work-decomposer.json",
      acceptance: { artifact_ref: "plan/slices.json", artifact_hash: hashFileBytes(planPath), review_ref: "reviews/work-decomposer.json", review_hash: hashFileBytes(join(runDir, "reviews", "work-decomposer.json")) },
    }, {
      agent: "test-verifier", status: "accepted", attempts: 1, artifact_ref: testArtifactRef, evidence_ref: receiptRef, review_ref: testReviewRef,
      execution_claim: claim, execution_claim_hash: hashValue(claim), acceptance: testAcceptance,
    }],
    validator,
    security_review: securityReview,
  }));
  return { repo, runDir, runFile, head };
}

function materializeSliceSidecars(runDir, subject, reviewedHead = "b".repeat(40)) {
  writeJson(join(runDir, "evidence", "backend.json"), { subject, attempt: 1, status: "pass", review_ready: true, head_sha: reviewedHead });
  writeJson(join(runDir, "reviews", "backend.json"), { subject, attempt: 1, verdict: "APPROVE", convergence: "converging", late_discovery_strike: false, remaining_fix_count: 0, required_fixes: [], ownership_ratification: { schema_version: 1, paths: [] }, remediation_context: { schema_version: 2, fixes: [] }, reviewed_commit: reviewedHead });
}

function initCatalogGit(repo) {
  mkdirSync(repo, { recursive: true });
  fixtureGit(repo, ["init", "-q", "-b", "main"]);
  fixtureGit(repo, ["config", "user.email", "test@example.com"]);
  fixtureGit(repo, ["config", "user.name", "Test"]);
  writeFileSync(join(repo, "README.md"), "fixture\n");
  fixtureGit(repo, ["add", "README.md"]);
  fixtureGit(repo, ["commit", "-q", "-m", "baseline"]);
}

async function createCheckedClaimMutationFixture(root, record, index) {
  const repo = join(root, record.id, String(index));
  const runId = "catalog-run";
  const runDir = join(repo, ".opencode", "factory", runId);
  const runFile = join(runDir, "run.json");
  initCatalogGit(repo);
  fixtureGit(repo, ["checkout", "-q", "-b", runId]);
  fixtureGit(repo, ["remote", "add", "origin", "https://github.com/acme/repo.git"]);
  fixtureGit(repo, ["config", `url.file://${repo}/.insteadOf`, "https://github.com/acme/repo.git"]);
  const head = fixtureGit(repo, ["rev-parse", "HEAD"]).trim();
  for (const directory of ["artifacts", "evidence", "reviews", "plan"]) mkdirSync(join(runDir, directory), { recursive: true });
  writeFileSync(join(runDir, "artifacts", "technical-brief.md"), "accepted brief\n");
  writeFileSync(join(runDir, "artifacts", "test-report.md"), "checked receipt report\n");
  writeJson(join(runDir, "reviews", "spec-writer.json"), { subject: "spec-writer", attempt: 1, verdict: "APPROVE" });
  writeJson(join(runDir, "reviews", "work-decomposer.json"), { subject: "work-decomposer", attempt: 1, verdict: "APPROVE" });
  writeJson(join(runDir, "reviews", "validator.json"), { subject: "parent", attempt: 1, verdict: "NO-GO" });
  writeJson(join(runDir, "reviews", "test-verifier.attempt-1.json"), { subject: "test-verifier", attempt: 1, verdict: "APPROVE", reviewed_head_sha: head, required_fixes: [] });
  writeJson(join(runDir, "evidence", "slice.json"), { subject: "slice", attempt: 1, status: "pass", review_ready: true, head_sha: head });
  const plan = withDeliveryEnvelope({
    slices: [{ id: "slice", stack: "backend", paths: ["README.md"], depends_on: [], acceptance: ["works"], test_plan: ["checked"] }],
    integration_gate: { required_commands: [{ program: "npm", args: ["run", "check"] }] },
  });
  writeJson(join(runDir, "plan", "slices.json"), plan);
  const sliceEvidenceHash = hashFileBytes(join(runDir, "evidence", "slice.json"));
  const familyEvidenceRef = "evidence/slice.family.json";
  const familyEvidence = writeVerificationArtifactReceipt({
    runDir, runId, plan, sliceId: "slice", attempt: 1, reviewedCommit: head,
    artifactId: "fixture-artifact-1", evidenceRef: familyEvidenceRef,
    result: { type: "verification-result", outcome: "pass", summary: "Verify slice behavior passed" },
  });
  writeJson(join(runDir, "reviews", "slice.json"), {
    subject: "slice", attempt: 1, verdict: "APPROVE", convergence: "converging", late_discovery_strike: false, remaining_fix_count: 0, required_fixes: [],
    ownership_ratification: { schema_version: 1, paths: [] }, remediation_context: { schema_version: 2, fixes: [] }, reviewed_commit: head,
    invariant_family_ledger: passingInvariantFamilyLedger({ plan, sliceId: "slice", reviewedCommit: head, evidenceRef: familyEvidenceRef, evidenceHash: familyEvidence.hash }),
  });
  const briefHash = hashFileBytes(join(runDir, "artifacts", "technical-brief.md"));
  const specReviewHash = hashFileBytes(join(runDir, "reviews", "spec-writer.json"));
  const planHash = hashFileBytes(join(runDir, "plan", "slices.json"));
  const decompositionReviewHash = hashFileBytes(join(runDir, "reviews", "work-decomposer.json"));
  const validatorReviewHash = hashFileBytes(join(runDir, "reviews", "validator.json"));
  const sliceReviewHash = hashFileBytes(join(runDir, "reviews", "slice.json"));
  const policy = { enabled: false, wait_ms: 3_600_000, initial_poll_ms: 30_000, max_poll_ms: 120_000, check_start_grace_ms: 300_000, max_transient_errors: 12, review: { required: false, reviewer_login: null, source: "none" } };
  const continuation = {
    schema_version: 2, kind: "blocked-run-continuation", created_at: CLAIM_NOW, operator_summary: "checked claim catalog fixture",
    parent: { run_id: "parent", status: "blocked", run_ref: ".opencode/factory/parent/run.json", run_hash: claimHash("parent"), branch: "parent", commit: head, worktree: "/tmp/parent" },
    review: { kind: "validator", ref: "reviews/validator.json", hash: validatorReviewHash, subject: "parent", summary: "continue", required_fixes: ["verify"], source: "run.validator.review_ref" },
    target: { run_id: runId, branch: runId, worktree: repo, base_ref: "main", base_commit: head },
    parent_artifacts: [{ kind: "technical_brief", ref: "artifacts/technical-brief.md", hash: briefHash }],
    parent_evidence: [], parent_reviews: [{ kind: "review", ref: "reviews/spec-writer.json", hash: specReviewHash }, { kind: "review", ref: "reviews/validator.json", hash: validatorReviewHash }],
    planning_reuse: { eligible: true, spec_review_ref: "reviews/spec-writer.json", spec_review_hash: specReviewHash, spec_artifact_ref: "artifacts/technical-brief.md", spec_artifact_hash: briefHash, child_spec_review_ref: "reviews/spec-writer.json" },
    configuration: { mode: "headless", github_account: null, pr_mode: "ready", max_parallel_slices: 3, max_retries: 3, post_pr_policy: policy },
    carry_forward: { scope: "full-remaining-plan", plan_ref: "plan/slices.json", plan_hash: planHash, start_commit: head, accepted_slices: [], remaining_slice_ids: ["slice"] },
  };
  const run = {
    schema_version: 1, run_id: runId, mode: "headless", status: "running", base_ref: "main", base_commit: head, branch: runId, worktree: repo,
    github_account: null, pr_mode: "ready", max_parallel_slices: 3, max_retries: 3, gates: {}, continuation,
    post_pr: { schema_version: 1, policy, phase: "disabled", attempt: 0, observation: null, remediation: null, evidence_refs: [], continuation_review: null, terminal_fact: null, pr_operation: null },
    slices: [{ ...modernMergedSlice(runDir, "slice", head), stack: "backend", depends_on: [] }],
    steps: [
      { agent: "spec-writer", status: "accepted", attempts: 0, artifact_ref: "artifacts/technical-brief.md", review_ref: "reviews/spec-writer.json", acceptance: { artifact_ref: "artifacts/technical-brief.md", artifact_hash: briefHash, review_ref: "reviews/spec-writer.json", review_hash: specReviewHash }, inherited_acceptance: { from_run_id: "parent", parent_spec_review_ref: "reviews/spec-writer.json", artifact_hash: briefHash, review_hash: specReviewHash } },
      { agent: "work-decomposer", status: "accepted", attempts: 1, artifact_ref: "plan/slices.json", review_ref: "reviews/work-decomposer.json", acceptance: { artifact_ref: "plan/slices.json", artifact_hash: planHash, review_ref: "reviews/work-decomposer.json", review_hash: decompositionReviewHash } },
      { agent: "test-verifier", status: "running", attempts: 1 },
    ],
  };
  publishSyntheticV2Parent(runDir, continuation);
  writeJson(runFile, validateRun(run));
  const claimed = await claimCheckedTestExecution(runDir, { now: CLAIM_NOW, nonce: CLAIM_NONCE });
  const fail = record.id === "test-execution-claim-completed-fail";
  const emptyStream = { captured_bytes: 0, sha256: claimHash(""), truncated: false };
  const receipt = {
    schema_version: 1, kind: "checked-test-execution-receipt", subject: "test-verifier", run_id: runId, attempt: 1,
    claim_nonce: claimed.claim.nonce, plan_ref: claimed.claim.plan_ref, plan_hash: claimed.claim.plan_hash, head_sha: head,
    timeout_ms: claimed.claim.timeout_ms,
    started_at: CLAIM_NOW, completed_at: CLAIM_NOW, duration_ms: 1, status: fail ? "fail" : "pass", review_ready: !fail,
    commands: [{ index: 0, program: "npm", args: ["run", "check"], outcome: "exited", status: fail ? "fail" : "pass", exit_code: fail ? 7 : 0, signal: null, error_code: null, duration_ms: 1, stdout: emptyStream, stderr: emptyStream }],
  };
  const state = record.source.execution_claim.state;
  if (state === "completed") await completeCheckedTestExecution(runDir, claimed.claim, claimed.authority, receipt, { now: CLAIM_NOW });
  if (state === "unknown") await markCheckedTestExecutionUnknown(runDir, claimed.claim, record.source.execution_claim.reason, { now: CLAIM_NOW });
  const receiptPath = join(runDir, claimed.claim.receipt_ref);
  return { repo, runDir, runFile, runId, head, state, claimed, receipt, receiptPath };
}

function bindCatalogReceiptToFixture(source, fixture) {
  return {
    ...structuredClone(source),
    run_id: fixture.claimed.claim.run_id,
    attempt: fixture.claimed.claim.attempt,
    claim_nonce: fixture.claimed.claim.nonce,
    plan_ref: fixture.claimed.claim.plan_ref,
    plan_hash: fixture.claimed.claim.plan_hash,
    head_sha: fixture.claimed.claim.head_sha,
    timeout_ms: fixture.claimed.claim.timeout_ms,
  };
}

function checkedRecoveryBindingChanged(source, mutated) {
  if (!source || !mutated) return false;
  return ["run_id", "attempt", "plan_ref", "plan_hash", "head_sha", "receipt_ref"]
    .some((key) => !Object.is(source[key], mutated[key]));
}

async function acceptCheckedClaimFixture(fixture) {
  return transitionRunStep(fixture.runDir, "test-verifier", {
    status: "accepted", attempts: 1, artifact_ref: "artifacts/test-report.md",
    evidence_ref: "evidence/test-verifier.attempt-1.json", review_ref: "reviews/test-verifier.attempt-1.json",
  }, { mustExist: true });
}

async function stageCheckedClaimPanels(fixture, publish) {
  writeFileSync(join(fixture.runDir, "artifacts", "validation-report.md"), "GO\n");
  writeJson(join(fixture.runDir, "reviews", "implementation-validator.json"), { subject: "catalog-run", attempt: 1, verdict: "GO", reviewed_head_sha: fixture.head });
  writeJson(join(fixture.runDir, "reviews", "security-reviewer.json"), { subject: "catalog-run", attempt: 1, verdict: "PASS", reviewed_head_sha: fixture.head });
  const input = {
    validator: { verdict: "GO", report: "artifacts/validation-report.md", review_ref: "reviews/implementation-validator.json" },
    security_review: { verdict: "PASS", review_ref: "reviews/security-reviewer.json" },
  };
  if (publish) await transitionPanelVerdicts(fixture.runDir, input, { repoRoot: fixture.repo });
  return input;
}

async function stageCheckedClaimPrePrApproval(fixture) {
  mkdirSync(join(fixture.runDir, "gates"), { recursive: true });
  writeFileSync(join(fixture.runDir, "gates", "pre-pr.md"), "approve?\n");
  await transitionGateDecision(fixture.runDir, "pre_pr", { status: "pending", artifact: "artifacts/test-report.md", question_ref: "gates/pre-pr.md" });
  const opened = await transitionSteeringBoundaryOpened(fixture.runDir, "gate");
  await transitionGateDecision(fixture.runDir, "pre_pr", {
    status: "approved", artifact: "artifacts/test-report.md", question_ref: "gates/pre-pr.md", answer: "approve",
  }, { boundaryToken: opened.boundary.token });
}

function applyCheckedClaimExternalMutation(fixture, record, mutationCase) {
  if (mutationCase.family !== "wrong-bytes" || !record.externalSources?.receipt) return;
  assert.equal(existsSync(fixture.receiptPath), true, `${mutationCase.name} canonical receipt`);
  writeFileSync(fixture.receiptPath, mutationCase.externalSources.receipt.bytes);
}

function assertCheckedClaimReceiptUnchanged(receiptPath, before, name) {
  if (before === null) assert.equal(existsSync(receiptPath), false, `${name} must not publish a receipt`);
  else assert.deepEqual(readFileSync(receiptPath), before, `${name} protected receipt bytes`);
}

function checkedClaimCleanupSnapshot(fixture) {
  return {
    runBytes: readFileSync(fixture.runFile),
    receiptBytes: existsSync(fixture.receiptPath) ? readFileSync(fixture.receiptPath) : null,
    branchHead: fixtureGit(fixture.repo, ["rev-parse", `refs/heads/${fixture.runId}`]).trim(),
    runEntries: readdirSync(fixture.runDir).sort(),
    opencodeEntries: readdirSync(join(fixture.repo, ".opencode")).sort(),
  };
}

function assertCheckedClaimCleanupUnchanged(fixture, before, name) {
  assert.deepEqual(readFileSync(fixture.runFile), before.runBytes, `${name} protected run.json bytes`);
  assertCheckedClaimReceiptUnchanged(fixture.receiptPath, before.receiptBytes, name);
  assert.equal(existsSync(fixture.repo), true, `${name} protected worktree`);
  assert.equal(fixtureGit(fixture.repo, ["rev-parse", `refs/heads/${fixture.runId}`]).trim(), before.branchHead, `${name} protected branch`);
  assert.deepEqual(readdirSync(fixture.runDir).sort(), before.runEntries, `${name} protected run directory`);
  assert.deepEqual(readdirSync(join(fixture.repo, ".opencode")).sort(), before.opencodeEntries, `${name} protected cleanup staging`);
}

function claimHash(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function materializeCatalogSources(runDir, ...sourceGroups) {
  mkdirSync(runDir, { recursive: true });
  for (const sources of sourceGroups) {
    for (const { ref, bytes } of Object.values(sources ?? {})) {
      if (bytes === null) continue;
      if (ref.startsWith("../") || ref.includes("/../")) {
        assert.equal(ref, "../outside.json", `unexpected traversal ref must fail materialization: ${ref}`);
        continue;
      }
      const file = join(runDir, ref);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, bytes);
    }
  }
}

function replaceCanonicalRecord(run, canonicalPath, record) {
  if (canonicalPath.length === 0) return structuredClone(record);
  const next = structuredClone(run);
  let owner = next;
  for (const segment of canonicalPath.slice(0, -1)) owner = owner[segment];
  owner[canonicalPath.at(-1)] = structuredClone(record);
  return next;
}

function failedConsistencyMessages(result) {
  return result.checks.filter(({ ok }) => !ok).flatMap(({ name, errors }) => errors.map(({ path, message }) => `${name} ${path}: ${message}`)).join("; ");
}

function fixtureGit(repo, args) {
  return execFileSync("git", args, { cwd: repo, encoding: "utf8" });
}

function writeJson(file, value) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function modernMergedSlice(runDir, id, reviewedCommit) {
  const evidenceRef = `evidence/${id}.json`;
  const reviewRef = `reviews/${id}.json`;
  const evidenceHash = hashFileBytes(join(runDir, evidenceRef));
  const reviewHash = hashFileBytes(join(runDir, reviewRef));
  return {
    id, stack: "backend", depends_on: [], declared_paths: [id === "slice" ? "README.md" : `src/${id}/**`], effective_paths: [id === "slice" ? "README.md" : `src/${id}/**`], status: "merged", attempts: 1, evidence_ref: evidenceRef, evidence_hash: evidenceHash, review_ref: reviewRef, review_hash: reviewHash,
    reviewed_commit: reviewedCommit, merge_commit: reviewedCommit,
    attempt_reviews: [{ attempt: 1, evidence_ref: evidenceRef, evidence_hash: evidenceHash, review_ref: reviewRef, review_hash: reviewHash, reviewed_commit: reviewedCommit, diff_base_commit: reviewedCommit, ratified_paths: [], verdict: "APPROVE", convergence: "converging", late_discovery_strike: false, remaining_fix_count: 0 }],
  };
}

function applyMutationDifference(actual, source, mutated) {
  for (const key of Object.keys(source)) {
    if (!Object.hasOwn(mutated, key)) {
      delete actual[key];
      continue;
    }
    const sourceValue = source[key];
    const mutatedValue = mutated[key];
    if (isPlainObject(sourceValue) && isPlainObject(mutatedValue) && isPlainObject(actual[key])) {
      applyMutationDifference(actual[key], sourceValue, mutatedValue);
    } else if (JSON.stringify(sourceValue) !== JSON.stringify(mutatedValue)) {
      actual[key] = structuredClone(mutatedValue);
    }
  }
  for (const key of Object.keys(mutated)) {
    if (!Object.hasOwn(source, key)) actual[key] = structuredClone(mutated[key]);
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hashFileBytes(file) {
  return `sha256:${createHash("sha256").update(readFileSync(file)).digest("hex")}`;
}

function hashBuffer(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function issue128BaselineIdsForRoute(route) {
  return Object.entries(ISSUE128_BASELINE_ROUTE_INVENTORY)
    .filter(([, assignment]) => assignment.route === route)
    .map(([id]) => id);
}

function isExactNamedRejection(error, rejector) {
  const [name, message] = rejector.split(" :: ");
  return error?.name === name && error?.message === message;
}

function isExactSteeringRejection(record, mutationCase, error) {
  const authorityKey = record.canonicalPath.at(-1);
  const path = `run.steering.${authorityKey}`;
  if (["missing-key", "unknown-key", "wrong-kind", "wrong-time", "wrong-type", "descriptor-key-shape-drift"].includes(mutationCase.family)) {
    assert.equal(error?.name, "ValidationError", `${mutationCase.name} validation error type`);
    let expected;
    if (mutationCase.family === "missing-key") {
      expected = { path: `${path}.token`, message: "must be a non-empty string" };
    } else if (mutationCase.family === "unknown-key") {
      expected = { path: `${path}.unexpected_authority_key`, message: "is not allowed" };
    } else if (mutationCase.family === "wrong-kind") {
      const values = authorityKey === "boundary"
        ? "gate, dispatch, remediation, terminal, post-pr-observe, post-pr-push"
        : "dispatch, remediation, terminal, post-pr-observe, post-pr-push";
      expected = { path: `${path}.kind`, message: `must be one of ${values}` };
    } else if (mutationCase.family === "wrong-time") {
      const key = authorityKey === "boundary" ? "created_at" : authorityKey === "action_claim" ? "claimed_at" : "resolved_at";
      expected = { path: `${path}.${key}`, message: "must be an ISO timestamp" };
    } else if (mutationCase.family === "wrong-type") {
      expected = { path: `${path}.generation`, message: "must be a non-negative integer" };
    } else {
      expected = { path: `${path}.operation_token`, message: "is not allowed" };
    }
    assert.equal(error.errors.some((item) => item.path === expected.path && item.message === expected.message), true, `${mutationCase.name} exact timestamp/schema invariant`);
    return true;
  }
  const exactMessage = authorityKey === "boundary"
    ? mutationCase.family === "cross-bound-identity" ? "dispatch boundary token mismatch" : "dispatch boundary observation is stale"
    : authorityKey === "action_claim"
      ? mutationCase.family === "cross-bound-identity" ? "action start claim token mismatch" : "action start claim is stale"
      : "origin action is missing, stale, or not started";
  return error?.name === "Error" && error?.message === exactMessage;
}

function exactB0m4DispositionMap(cases) {
  const dispositions = new Map();
  for (const exactCase of cases) {
    if (dispositions.has(exactCase.name)) throw new Error(`duplicate exact B0M.4 case ${exactCase.name}`);
    for (const key of ["name", "record_id", "family", "target_label", "consumer", "rejector"]) {
      if (typeof exactCase[key] !== "string" || exactCase[key].length === 0) throw new Error(`exact B0M.4 case requires literal ${key}`);
    }
    if (!exactCase.consumer || !exactCase.rejector) throw new Error("exact B0M.4 case requires a concrete consumer and rejector");
    dispositions.set(exactCase.name, exactCase);
  }
  return dispositions;
}

async function consumePrerequisiteValidB0M4Case(expected, record, mutationCase, scenario) {
  assert.equal(scenario, "post-pr");
  const control = await createPrerequisitePostPrFixture(record, mutationCase, false);
  try {
    const result = await transitionPostPrState(control.runDir, control.next.post_pr, { worktree: control.repo, now: "2026-07-16T12:06:00.000Z" });
    assert.deepEqual(result.run.post_pr, control.next.post_pr, `${expected.name} canonical control`);
  } finally { rmSync(control.repo, { recursive: true, force: true }); }
  const mutated = await createPrerequisitePostPrFixture(record, mutationCase, true);
  try {
    const before = readFileSync(join(mutated.runDir, "run.json"), "utf8");
    await assertExactB0M4Rejection(transitionPostPrState(mutated.runDir, mutated.next.post_pr, { worktree: mutated.repo, now: "2026-07-16T12:06:00.000Z" }), expected);
    assert.equal(readFileSync(join(mutated.runDir, "run.json"), "utf8"), before, `${expected.name} protected bytes`);
  } finally { rmSync(mutated.repo, { recursive: true, force: true }); }
}

async function createPrerequisitePostPrFixture(record, mutationCase, mutated) {
  const repo = mkdtempSync(join(tmpdir(), "b0m4-post-pr-prerequisite-"));
  initCatalogGit(repo);
  const baseline = fixtureGit(repo, ["rev-parse", "HEAD"]).trim();
  const path = join(repo, "src", "backend.js");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, "candidate\n");
  fixtureGit(repo, ["add", "src/backend.js"]);
  fixtureGit(repo, ["commit", "-q", "-m", "candidate"]);
  const candidate = fixtureGit(repo, ["rev-parse", "HEAD"]).trim();
  const stale = fixtureGit(repo, ["commit-tree", `${baseline}^{tree}`, "-p", baseline, "-m", "stale authority"]).trim();
  const fixture = createPostPrCatalogBaseline(record);
  const translate = (value) => translateCatalogCommitIdentities(value, { ["a".repeat(40)]: baseline, ["b".repeat(40)]: candidate, ["c".repeat(40)]: stale });
  const run = translate(fixture.run);
  run.worktree = repo;
  run.branch = "main";
  run.base_commit = baseline;
  const runDir = join(repo, ".opencode", "factory", "prerequisite-run");
  materializeCatalogSources(runDir, fixture.externalSources);
  writeJson(join(runDir, "run.json"), run);
  const next = mutated ? replaceCanonicalRecord(run, record.canonicalPath, translate(mutationCase.record)) : structuredClone(run);
  return { repo, runDir, next };
}

function translateCatalogCommitIdentities(value, replacements) {
  if (typeof value === "string") return replacements[value] || value;
  if (Array.isArray(value)) return value.map((item) => translateCatalogCommitIdentities(item, replacements));
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, translateCatalogCommitIdentities(item, replacements)]));
}

async function assertExactB0M4Rejection(promise, expected) {
  const [, errorName, errorMessage] = expected.rejector.split(" :: ");
  await assert.rejects(promise, (error) => error.name === errorName && error.message === errorMessage, `${expected.name} must reach ${expected.rejector}`);
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

function validationErrorFor(name) {
  return (error) => {
    assert.equal(error?.name, "ValidationError", `${name} must be rejected by schema validation`);
    return true;
  };
}
