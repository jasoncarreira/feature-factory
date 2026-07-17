import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  DURABLE_AUTHORITY_PRODUCTION_COVERED_RECORD_IDS,
  DURABLE_AUTHORITY_REQUIRED_RECORD_IDS,
  DURABLE_MUTATION_FAMILIES,
  assertDurableAuthorityCatalogComplete,
  createDurableCatalogBaseline,
  createPostPrCatalogBaseline,
  createRepairCatalogBaseline,
  emitDurableRecordMutations,
  renderDurableAuthorityOracleReviewSnapshot,
} from "./helpers/durable-record-mutations.js";
import { checkRunConsistency, validateRun, validateSlicesPlan } from "../src/validate.js";
import { continueFactory, seedContinuationPlanningArtifacts } from "../src/factory.js";
import {
  assertContinuationAuthorityCurrent,
  transitionMergedSliceRepair,
  mergedSliceRepairFence,
  transitionPanelVerdicts,
  transitionContinuationAdoption,
  transitionPostPrState,
  transitionPrCreated,
  transitionPrePrFenceCleared,
  transitionPrePrFenceEstablished,
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

const B0M3_CONTINUATION_EXACT_CASES = Object.freeze([
  { name: "continuation-envelope: cross-bound-identity (cross-bound operator_summary)", record_id: "continuation-envelope", family: "cross-bound-identity", consumer: "transitionContinuationAdoption", rejector: "Error :: continuation operator_summary is stale or cross-bound" },
  { name: "continuation-parent-binding: wrong-hash (parent-run hash)", record_id: "continuation-parent-binding", family: "wrong-hash", consumer: "transitionContinuationAdoption", rejector: "Error :: continuation parent run.json changed since observation" },
  { name: "continuation-parent-binding: wrong-bytes (parent-run sidecar bytes)", record_id: "continuation-parent-binding", family: "wrong-bytes", consumer: "transitionContinuationAdoption", rejector: "Error :: continuation parent run.json changed since observation" },
  { name: "continuation-parent-binding: stale-identity (stale commit)", record_id: "continuation-parent-binding", family: "stale-identity", consumer: "transitionContinuationAdoption", rejector: "Error :: continuation parent branch/commit binding is stale" },
  { name: "continuation-selected-review: wrong-bytes (selected-review sidecar bytes)", record_id: "continuation-selected-review", family: "wrong-bytes", consumer: "transitionContinuationAdoption", rejector: "Error :: continuation selected review hash mismatch" },
  { name: "continuation-selected-review: stale-identity (stale verdict)", record_id: "continuation-selected-review", family: "stale-identity", consumer: "transitionContinuationAdoption", rejector: "Error :: continuation selected review identity is stale or cross-bound" },
  { name: "continuation-selected-review: cross-bound-identity (cross-bound subject)", record_id: "continuation-selected-review", family: "cross-bound-identity", consumer: "transitionContinuationAdoption", rejector: "Error :: continuation selected review identity is stale or cross-bound" },
  { name: "continuation-target-binding: stale-identity (stale base_commit)", record_id: "continuation-target-binding", family: "stale-identity", consumer: "transitionContinuationAdoption", rejector: "Error :: continuation target base binding is stale" },
  { name: "continuation-parent-artifact-sidecar: wrong-hash (artifact hash)", record_id: "continuation-parent-artifact-sidecar", family: "wrong-hash", consumer: "transitionContinuationAdoption", rejector: "Error :: continuation parent_artifacts binding is stale" },
  { name: "continuation-parent-artifact-sidecar: wrong-bytes (artifact sidecar bytes)", record_id: "continuation-parent-artifact-sidecar", family: "wrong-bytes", consumer: "transitionContinuationAdoption", rejector: "Error :: continuation parent_artifacts binding is stale" },
  { name: "continuation-parent-artifact-sidecar: stale-identity (stale hash)", record_id: "continuation-parent-artifact-sidecar", family: "stale-identity", consumer: "transitionContinuationAdoption", rejector: "Error :: continuation parent_artifacts binding is stale" },
  { name: "continuation-parent-evidence-sidecar: wrong-hash (evidence hash)", record_id: "continuation-parent-evidence-sidecar", family: "wrong-hash", consumer: "transitionContinuationAdoption", rejector: "Error :: continuation parent_evidence binding is stale" },
  { name: "continuation-parent-evidence-sidecar: wrong-bytes (evidence sidecar bytes)", record_id: "continuation-parent-evidence-sidecar", family: "wrong-bytes", consumer: "transitionContinuationAdoption", rejector: "Error :: continuation parent_evidence binding is stale" },
  { name: "continuation-parent-evidence-sidecar: stale-identity (stale hash)", record_id: "continuation-parent-evidence-sidecar", family: "stale-identity", consumer: "transitionContinuationAdoption", rejector: "Error :: continuation parent_evidence binding is stale" },
  { name: "continuation-parent-review-sidecar: wrong-hash (review hash)", record_id: "continuation-parent-review-sidecar", family: "wrong-hash", consumer: "transitionContinuationAdoption", rejector: "Error :: continuation parent_reviews binding is stale" },
  { name: "continuation-parent-review-sidecar: wrong-bytes (review sidecar bytes)", record_id: "continuation-parent-review-sidecar", family: "wrong-bytes", consumer: "transitionContinuationAdoption", rejector: "Error :: continuation parent_reviews binding is stale" },
  { name: "continuation-parent-review-sidecar: stale-identity (stale hash)", record_id: "continuation-parent-review-sidecar", family: "stale-identity", consumer: "transitionContinuationAdoption", rejector: "Error :: continuation parent_reviews binding is stale" },
  { name: "continuation-parent-review-sidecar: cross-bound-identity (cross-bound ref)", record_id: "continuation-parent-review-sidecar", family: "cross-bound-identity", consumer: "transitionContinuationAdoption", rejector: "Error :: continuation parent_reviews binding is stale" },
  { name: "continuation-planning-reuse-eligible: wrong-hash (review hash)", record_id: "continuation-planning-reuse-eligible", family: "wrong-hash", consumer: "transitionContinuationAdoption", rejector: "Error :: continuation planning_reuse binding is stale" },
  { name: "continuation-planning-reuse-eligible: wrong-hash (artifact hash)", record_id: "continuation-planning-reuse-eligible", family: "wrong-hash", consumer: "transitionContinuationAdoption", rejector: "Error :: continuation planning_reuse binding is stale" },
  { name: "continuation-planning-reuse-eligible: wrong-bytes (review sidecar bytes)", record_id: "continuation-planning-reuse-eligible", family: "wrong-bytes", consumer: "transitionContinuationAdoption", rejector: "Error :: continuation parent_reviews binding is stale" },
  { name: "continuation-planning-reuse-eligible: wrong-bytes (artifact sidecar bytes)", record_id: "continuation-planning-reuse-eligible", family: "wrong-bytes", consumer: "transitionContinuationAdoption", rejector: "Error :: continuation parent_artifacts binding is stale" },
  { name: "continuation-planning-reuse-eligible: cross-bound-identity (cross-bound spec_review_ref)", record_id: "continuation-planning-reuse-eligible", family: "cross-bound-identity", consumer: "transitionContinuationAdoption", rejector: "Error :: continuation planning_reuse binding is stale" },
  { name: "continuation-draft-reuse: wrong-hash (draft hash)", record_id: "continuation-draft-reuse", family: "wrong-hash", consumer: "seedContinuationPlanningArtifacts", rejector: "Error :: continuation draft_spec_reuse binding is stale" },
  { name: "continuation-draft-reuse: wrong-bytes (draft sidecar bytes)", record_id: "continuation-draft-reuse", family: "wrong-bytes", consumer: "seedContinuationPlanningArtifacts", rejector: "Error :: continuation parent_artifacts bindings changed since payload build" },
  { name: "continuation-post-pr-binding: wrong-hash (evidence hash)", record_id: "continuation-post-pr-binding", family: "wrong-hash", consumer: "assertContinuationAuthorityCurrent", rejector: "Error :: continuation post-PR evidence hash mismatch" },
  { name: "continuation-post-pr-binding: wrong-hash (review hash)", record_id: "continuation-post-pr-binding", family: "wrong-hash", consumer: "assertContinuationAuthorityCurrent", rejector: "Error :: continuation post-PR review hash mismatch" },
  { name: "continuation-post-pr-binding: wrong-hash (hash post_pr_hash)", record_id: "continuation-post-pr-binding", family: "wrong-hash", consumer: "assertContinuationAuthorityCurrent", rejector: "Error :: continuation post_pr state hash is stale" },
  { name: "continuation-post-pr-binding: wrong-bytes (evidence sidecar bytes)", record_id: "continuation-post-pr-binding", family: "wrong-bytes", consumer: "assertContinuationAuthorityCurrent", rejector: "Error :: continuation parent_evidence binding is stale" },
  { name: "continuation-post-pr-binding: wrong-bytes (review sidecar bytes)", record_id: "continuation-post-pr-binding", family: "wrong-bytes", consumer: "assertContinuationAuthorityCurrent", rejector: "Error :: continuation selected review hash mismatch" },
  { name: "continuation-post-pr-binding: stale-identity (stale head_sha)", record_id: "continuation-post-pr-binding", family: "stale-identity", consumer: "assertContinuationAuthorityCurrent", rejector: "Error :: continuation post_pr failed head binding is stale" },
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
  { name: "repair-reported: missing-key (required field)", record_id: "repair-reported", family: "missing-key", target_label: "required field", consumer: "validateRun", rejector: "validateMergedSliceRepair :: run.merged_slice_repair.status :: must be one of reported, repairing, review, merged, blocked" },
  { name: "repair-reported: unknown-key (record root)", record_id: "repair-reported", family: "unknown-key", target_label: "record root", consumer: "validateRun", rejector: "validateMergedSliceRepair :: run.merged_slice_repair.unexpected_authority_key :: is not allowed" },
  { name: "repair-reported: wrong-schema (schema version)", record_id: "repair-reported", family: "wrong-schema", target_label: "schema version", consumer: "validateRun", rejector: "validateMergedSliceRepair :: run.merged_slice_repair.schema_version :: must equal 1" },
  { name: "repair-reported: wrong-time (timestamp updated_at)", record_id: "repair-reported", family: "wrong-time", target_label: "timestamp updated_at", consumer: "transitionMergedSliceRepair", rejector: "transitionMergedSliceRepair :: ValidationError :: run.merged_slice_repair.updated_at: must be an ISO timestamp" },
  { name: "repair-reported: wrong-type (typed field)", record_id: "repair-reported", family: "wrong-type", target_label: "typed field", consumer: "validateRun", rejector: "validateMergedSliceRepair :: run.merged_slice_repair.attempts :: must be an integer from 0 to 2" },
  { name: "repair-reported: wrong-ref (plan ref)", record_id: "repair-reported", family: "wrong-ref", target_label: "plan ref", consumer: "checkRunConsistency", rejector: "checkRunConsistency :: run.merged_slice_repair.plan :: run.merged_slice_repair.plan :: referenced authority file does not exist" },
  { name: "repair-reported: wrong-ref (original-evidence ref)", record_id: "repair-reported", family: "wrong-ref", target_label: "original-evidence ref", consumer: "checkRunConsistency", rejector: "checkRunConsistency :: run.merged_slice_repair.evidence_ref :: run.merged_slice_repair.evidence_ref :: evidence ref must not contain empty, '.' or '..' path segments" },
  { name: "repair-reported: wrong-hash (plan hash)", record_id: "repair-reported", family: "wrong-hash", target_label: "plan hash", consumer: "checkRunConsistency", rejector: "checkRunConsistency :: run.merged_slice_repair.plan :: run.merged_slice_repair.plan_hash :: must match plan/slices.json bytes bound at report" },
  { name: "repair-reported: wrong-hash (original-evidence hash)", record_id: "repair-reported", family: "wrong-hash", target_label: "original-evidence hash", consumer: "checkRunConsistency", rejector: "checkRunConsistency :: run.merged_slice_repair.evidence_ref :: run.merged_slice_repair.evidence_hash :: must match evidence_ref bytes" },
  { name: "repair-reported: wrong-bytes (plan sidecar bytes)", record_id: "repair-reported", family: "wrong-bytes", target_label: "plan sidecar bytes", consumer: "checkRunConsistency", rejector: "checkRunConsistency :: run.merged_slice_repair.plan :: run.merged_slice_repair.plan_hash :: must match plan/slices.json bytes bound at report" },
  { name: "repair-reported: wrong-bytes (original-evidence sidecar bytes)", record_id: "repair-reported", family: "wrong-bytes", target_label: "original-evidence sidecar bytes", consumer: "checkRunConsistency", rejector: "checkRunConsistency :: run.merged_slice_repair.evidence_ref :: run.merged_slice_repair.evidence_hash :: must match evidence_ref bytes" },
  { name: "repair-reported: descriptor-key-shape-drift (evidence_ref renamed)", record_id: "repair-reported", family: "descriptor-key-shape-drift", target_label: "evidence_ref renamed", consumer: "validateRun", rejector: "validateMergedSliceRepair :: run.merged_slice_repair.reproduction_ref :: is not allowed" },
  { name: "repair-reported: stale-identity (stale attempts)", record_id: "repair-reported", family: "stale-identity", target_label: "stale attempts", consumer: "transitionMergedSliceRepair", rejector: "transitionMergedSliceRepair :: Error :: repair attempt must advance from 1 to 2" },
  { name: "repair-reported: cross-bound-identity (cross-bound consumer_slice_id)", record_id: "repair-reported", family: "cross-bound-identity", target_label: "cross-bound consumer_slice_id", consumer: "validateRun", rejector: "validateMergedSliceRepair :: run.merged_slice_repair.consumer_slice_id :: must differ from owner_slice_id" },
  { name: "repair-repairing: missing-key (required field)", record_id: "repair-repairing", family: "missing-key", target_label: "required field", consumer: "validateRun", rejector: "validateMergedSliceRepair :: run.merged_slice_repair.status :: must be one of reported, repairing, review, merged, blocked" },
  { name: "repair-repairing: unknown-key (record root)", record_id: "repair-repairing", family: "unknown-key", target_label: "record root", consumer: "validateRun", rejector: "validateMergedSliceRepair :: run.merged_slice_repair.unexpected_authority_key :: is not allowed" },
  { name: "repair-repairing: wrong-schema (schema version)", record_id: "repair-repairing", family: "wrong-schema", target_label: "schema version", consumer: "validateRun", rejector: "validateMergedSliceRepair :: run.merged_slice_repair.schema_version :: must equal 1" },
  { name: "repair-repairing: wrong-time (timestamp updated_at)", record_id: "repair-repairing", family: "wrong-time", target_label: "timestamp updated_at", consumer: "transitionMergedSliceRepair", rejector: "transitionMergedSliceRepair :: ValidationError :: run.merged_slice_repair.updated_at: must be an ISO timestamp" },
  { name: "repair-repairing: wrong-type (typed field)", record_id: "repair-repairing", family: "wrong-type", target_label: "typed field", consumer: "validateRun", rejector: "validateMergedSliceRepair :: run.merged_slice_repair.attempts :: must be an integer from 0 to 2" },
  { name: "repair-repairing: wrong-ref (plan ref)", record_id: "repair-repairing", family: "wrong-ref", target_label: "plan ref", consumer: "checkRunConsistency", rejector: "checkRunConsistency :: run.merged_slice_repair.plan :: run.merged_slice_repair.plan :: referenced authority file does not exist" },
  { name: "repair-repairing: wrong-ref (original-evidence ref)", record_id: "repair-repairing", family: "wrong-ref", target_label: "original-evidence ref", consumer: "checkRunConsistency", rejector: "checkRunConsistency :: run.merged_slice_repair.evidence_ref :: run.merged_slice_repair.evidence_ref :: evidence ref must not contain empty, '.' or '..' path segments" },
  { name: "repair-repairing: wrong-hash (plan hash)", record_id: "repair-repairing", family: "wrong-hash", target_label: "plan hash", consumer: "checkRunConsistency", rejector: "checkRunConsistency :: run.merged_slice_repair.plan :: run.merged_slice_repair.plan_hash :: must match plan/slices.json bytes bound at report" },
  { name: "repair-repairing: wrong-hash (original-evidence hash)", record_id: "repair-repairing", family: "wrong-hash", target_label: "original-evidence hash", consumer: "checkRunConsistency", rejector: "checkRunConsistency :: run.merged_slice_repair.evidence_ref :: run.merged_slice_repair.evidence_hash :: must match evidence_ref bytes" },
  { name: "repair-repairing: wrong-bytes (plan sidecar bytes)", record_id: "repair-repairing", family: "wrong-bytes", target_label: "plan sidecar bytes", consumer: "checkRunConsistency", rejector: "checkRunConsistency :: run.merged_slice_repair.plan :: run.merged_slice_repair.plan_hash :: must match plan/slices.json bytes bound at report" },
  { name: "repair-repairing: wrong-bytes (original-evidence sidecar bytes)", record_id: "repair-repairing", family: "wrong-bytes", target_label: "original-evidence sidecar bytes", consumer: "checkRunConsistency", rejector: "checkRunConsistency :: run.merged_slice_repair.evidence_ref :: run.merged_slice_repair.evidence_hash :: must match evidence_ref bytes" },
  { name: "repair-repairing: descriptor-key-shape-drift (evidence_ref renamed)", record_id: "repair-repairing", family: "descriptor-key-shape-drift", target_label: "evidence_ref renamed", consumer: "validateRun", rejector: "validateMergedSliceRepair :: run.merged_slice_repair.reproduction_ref :: is not allowed" },
  { name: "repair-repairing: stale-identity (stale attempts)", record_id: "repair-repairing", family: "stale-identity", target_label: "stale attempts", consumer: "validateRun", rejector: "validateMergedSliceRepair :: run.merged_slice_repair.attempts :: must be at least 1 once an attempt starts" },
  { name: "repair-repairing: stale-identity (stale baseline_commit)", record_id: "repair-repairing", family: "stale-identity", target_label: "stale baseline_commit", consumer: "transitionMergedSliceRepair", rejector: "transitionMergedSliceRepair :: Error :: repair reviewed commit must contain new work on top of the observed attempt baseline" },
  { name: "repair-repairing: cross-bound-identity (cross-bound consumer_slice_id)", record_id: "repair-repairing", family: "cross-bound-identity", target_label: "cross-bound consumer_slice_id", consumer: "validateRun", rejector: "validateMergedSliceRepair :: run.merged_slice_repair.consumer_slice_id :: must differ from owner_slice_id" },
  { name: "repair-review-approve: missing-key (required field)", record_id: "repair-review-approve", family: "missing-key", target_label: "required field", consumer: "validateRun", rejector: "validateMergedSliceRepair :: run.merged_slice_repair.status :: must be one of reported, repairing, review, merged, blocked" },
  { name: "repair-review-approve: unknown-key (record root)", record_id: "repair-review-approve", family: "unknown-key", target_label: "record root", consumer: "validateRun", rejector: "validateMergedSliceRepair :: run.merged_slice_repair.unexpected_authority_key :: is not allowed" },
  { name: "repair-review-approve: wrong-schema (schema version)", record_id: "repair-review-approve", family: "wrong-schema", target_label: "schema version", consumer: "validateRun", rejector: "validateMergedSliceRepair :: run.merged_slice_repair.schema_version :: must equal 1" },
  { name: "repair-review-approve: wrong-time (timestamp updated_at)", record_id: "repair-review-approve", family: "wrong-time", target_label: "timestamp updated_at", consumer: "transitionMergedSliceRepair", rejector: "transitionMergedSliceRepair :: ValidationError :: run.merged_slice_repair.updated_at: must be an ISO timestamp" },
  { name: "repair-review-approve: wrong-type (typed field)", record_id: "repair-review-approve", family: "wrong-type", target_label: "typed field", consumer: "validateRun", rejector: "validateMergedSliceRepair :: run.merged_slice_repair.attempts :: must be an integer from 0 to 2" },
  { name: "repair-review-approve: wrong-ref (plan ref)", record_id: "repair-review-approve", family: "wrong-ref", target_label: "plan ref", consumer: "checkRunConsistency", rejector: "checkRunConsistency :: run.merged_slice_repair.plan :: run.merged_slice_repair.plan :: referenced authority file does not exist" },
  { name: "repair-review-approve: wrong-ref (original-evidence ref)", record_id: "repair-review-approve", family: "wrong-ref", target_label: "original-evidence ref", consumer: "checkRunConsistency", rejector: "checkRunConsistency :: run.merged_slice_repair.evidence_ref :: run.merged_slice_repair.evidence_ref :: evidence ref must not contain empty, '.' or '..' path segments" },
  { name: "repair-review-approve: wrong-ref (repair-evidence ref)", record_id: "repair-review-approve", family: "wrong-ref", target_label: "repair-evidence ref", consumer: "checkRunConsistency", rejector: "checkRunConsistency :: run.merged_slice_repair.repair_evidence_ref :: run.merged_slice_repair.repair_evidence_ref :: evidence ref must not contain empty, '.' or '..' path segments" },
  { name: "repair-review-approve: wrong-ref (review ref)", record_id: "repair-review-approve", family: "wrong-ref", target_label: "review ref", consumer: "checkRunConsistency", rejector: "checkRunConsistency :: run.merged_slice_repair.review_ref :: run.merged_slice_repair.review_ref :: reviews ref must not contain empty, '.' or '..' path segments" },
  { name: "repair-review-approve: wrong-hash (plan hash)", record_id: "repair-review-approve", family: "wrong-hash", target_label: "plan hash", consumer: "checkRunConsistency", rejector: "checkRunConsistency :: run.merged_slice_repair.plan :: run.merged_slice_repair.plan_hash :: must match plan/slices.json bytes bound at report" },
  { name: "repair-review-approve: wrong-hash (original-evidence hash)", record_id: "repair-review-approve", family: "wrong-hash", target_label: "original-evidence hash", consumer: "checkRunConsistency", rejector: "checkRunConsistency :: run.merged_slice_repair.evidence_ref :: run.merged_slice_repair.evidence_hash :: must match evidence_ref bytes" },
  { name: "repair-review-approve: wrong-hash (repair-evidence hash)", record_id: "repair-review-approve", family: "wrong-hash", target_label: "repair-evidence hash", consumer: "checkRunConsistency", rejector: "checkRunConsistency :: run.merged_slice_repair.repair_evidence_ref :: run.merged_slice_repair.repair_evidence_hash :: must match repair_evidence_ref bytes" },
  { name: "repair-review-approve: wrong-hash (review hash)", record_id: "repair-review-approve", family: "wrong-hash", target_label: "review hash", consumer: "checkRunConsistency", rejector: "checkRunConsistency :: run.merged_slice_repair.review_ref :: run.merged_slice_repair.review_hash :: must match review_ref bytes" },
  { name: "repair-review-approve: wrong-bytes (plan sidecar bytes)", record_id: "repair-review-approve", family: "wrong-bytes", target_label: "plan sidecar bytes", consumer: "checkRunConsistency", rejector: "checkRunConsistency :: run.merged_slice_repair.plan :: run.merged_slice_repair.plan_hash :: must match plan/slices.json bytes bound at report" },
  { name: "repair-review-approve: wrong-bytes (original-evidence sidecar bytes)", record_id: "repair-review-approve", family: "wrong-bytes", target_label: "original-evidence sidecar bytes", consumer: "checkRunConsistency", rejector: "checkRunConsistency :: run.merged_slice_repair.evidence_ref :: run.merged_slice_repair.evidence_hash :: must match evidence_ref bytes" },
  { name: "repair-review-approve: wrong-bytes (repair-evidence sidecar bytes)", record_id: "repair-review-approve", family: "wrong-bytes", target_label: "repair-evidence sidecar bytes", consumer: "checkRunConsistency", rejector: "checkRunConsistency :: run.merged_slice_repair.repair_evidence_ref :: run.merged_slice_repair.repair_evidence_hash :: must match repair_evidence_ref bytes" },
  { name: "repair-review-approve: wrong-bytes (review sidecar bytes)", record_id: "repair-review-approve", family: "wrong-bytes", target_label: "review sidecar bytes", consumer: "checkRunConsistency", rejector: "checkRunConsistency :: run.merged_slice_repair.review_ref :: run.merged_slice_repair.review_hash :: must match review_ref bytes" },
  { name: "repair-review-approve: descriptor-key-shape-drift (evidence_ref renamed)", record_id: "repair-review-approve", family: "descriptor-key-shape-drift", target_label: "evidence_ref renamed", consumer: "validateRun", rejector: "validateMergedSliceRepair :: run.merged_slice_repair.reproduction_ref :: is not allowed" },
  { name: "repair-review-approve: stale-identity (stale attempts)", record_id: "repair-review-approve", family: "stale-identity", target_label: "stale attempts", consumer: "validateRun", rejector: "validateMergedSliceRepair :: run.merged_slice_repair.attempts :: must be at least 1 once an attempt starts" },
  { name: "repair-review-approve: stale-identity (stale baseline_commit)", record_id: "repair-review-approve", family: "stale-identity", target_label: "stale baseline_commit", consumer: "transitionMergedSliceRepair", rejector: "transitionMergedSliceRepair :: Error :: repair merge commit must contain new work on top of the observed attempt baseline" },
  { name: "repair-review-approve: cross-bound-identity (cross-bound consumer_slice_id)", record_id: "repair-review-approve", family: "cross-bound-identity", target_label: "cross-bound consumer_slice_id", consumer: "validateRun", rejector: "validateMergedSliceRepair :: run.merged_slice_repair.consumer_slice_id :: must differ from owner_slice_id" },
  { name: "repair-review-approve: cross-bound-identity (cross-bound reviewed_commit)", record_id: "repair-review-approve", family: "cross-bound-identity", target_label: "cross-bound reviewed_commit", consumer: "transitionMergedSliceRepair", rejector: "transitionMergedSliceRepair :: Error :: repair review must bind the exact reviewed commit; the recorded commit does not match the observed repair" },
  { name: "repair-review-reject: missing-key (required field)", record_id: "repair-review-reject", family: "missing-key", target_label: "required field", consumer: "validateRun", rejector: "validateMergedSliceRepair :: run.merged_slice_repair.status :: must be one of reported, repairing, review, merged, blocked" },
  { name: "repair-review-reject: unknown-key (record root)", record_id: "repair-review-reject", family: "unknown-key", target_label: "record root", consumer: "validateRun", rejector: "validateMergedSliceRepair :: run.merged_slice_repair.unexpected_authority_key :: is not allowed" },
  { name: "repair-review-reject: wrong-schema (schema version)", record_id: "repair-review-reject", family: "wrong-schema", target_label: "schema version", consumer: "validateRun", rejector: "validateMergedSliceRepair :: run.merged_slice_repair.schema_version :: must equal 1" },
  { name: "repair-review-reject: wrong-time (timestamp updated_at)", record_id: "repair-review-reject", family: "wrong-time", target_label: "timestamp updated_at", consumer: "transitionMergedSliceRepair", rejector: "transitionMergedSliceRepair :: ValidationError :: run.merged_slice_repair.updated_at: must be an ISO timestamp" },
  { name: "repair-review-reject: wrong-type (typed field)", record_id: "repair-review-reject", family: "wrong-type", target_label: "typed field", consumer: "validateRun", rejector: "validateMergedSliceRepair :: run.merged_slice_repair.attempts :: must be an integer from 0 to 2" },
  { name: "repair-review-reject: wrong-ref (plan ref)", record_id: "repair-review-reject", family: "wrong-ref", target_label: "plan ref", consumer: "checkRunConsistency", rejector: "checkRunConsistency :: run.merged_slice_repair.plan :: run.merged_slice_repair.plan :: referenced authority file does not exist" },
  { name: "repair-review-reject: wrong-ref (original-evidence ref)", record_id: "repair-review-reject", family: "wrong-ref", target_label: "original-evidence ref", consumer: "checkRunConsistency", rejector: "checkRunConsistency :: run.merged_slice_repair.evidence_ref :: run.merged_slice_repair.evidence_ref :: evidence ref must not contain empty, '.' or '..' path segments" },
  { name: "repair-review-reject: wrong-ref (repair-evidence ref)", record_id: "repair-review-reject", family: "wrong-ref", target_label: "repair-evidence ref", consumer: "checkRunConsistency", rejector: "checkRunConsistency :: run.merged_slice_repair.repair_evidence_ref :: run.merged_slice_repair.repair_evidence_ref :: evidence ref must not contain empty, '.' or '..' path segments" },
  { name: "repair-review-reject: wrong-ref (review ref)", record_id: "repair-review-reject", family: "wrong-ref", target_label: "review ref", consumer: "checkRunConsistency", rejector: "checkRunConsistency :: run.merged_slice_repair.review_ref :: run.merged_slice_repair.review_ref :: reviews ref must not contain empty, '.' or '..' path segments" },
  { name: "repair-review-reject: wrong-hash (plan hash)", record_id: "repair-review-reject", family: "wrong-hash", target_label: "plan hash", consumer: "checkRunConsistency", rejector: "checkRunConsistency :: run.merged_slice_repair.plan :: run.merged_slice_repair.plan_hash :: must match plan/slices.json bytes bound at report" },
  { name: "repair-review-reject: wrong-hash (original-evidence hash)", record_id: "repair-review-reject", family: "wrong-hash", target_label: "original-evidence hash", consumer: "checkRunConsistency", rejector: "checkRunConsistency :: run.merged_slice_repair.evidence_ref :: run.merged_slice_repair.evidence_hash :: must match evidence_ref bytes" },
  { name: "repair-review-reject: wrong-hash (repair-evidence hash)", record_id: "repair-review-reject", family: "wrong-hash", target_label: "repair-evidence hash", consumer: "checkRunConsistency", rejector: "checkRunConsistency :: run.merged_slice_repair.repair_evidence_ref :: run.merged_slice_repair.repair_evidence_hash :: must match repair_evidence_ref bytes" },
  { name: "repair-review-reject: wrong-hash (review hash)", record_id: "repair-review-reject", family: "wrong-hash", target_label: "review hash", consumer: "checkRunConsistency", rejector: "checkRunConsistency :: run.merged_slice_repair.review_ref :: run.merged_slice_repair.review_hash :: must match review_ref bytes" },
  { name: "repair-review-reject: wrong-bytes (plan sidecar bytes)", record_id: "repair-review-reject", family: "wrong-bytes", target_label: "plan sidecar bytes", consumer: "checkRunConsistency", rejector: "checkRunConsistency :: run.merged_slice_repair.plan :: run.merged_slice_repair.plan_hash :: must match plan/slices.json bytes bound at report" },
  { name: "repair-review-reject: wrong-bytes (original-evidence sidecar bytes)", record_id: "repair-review-reject", family: "wrong-bytes", target_label: "original-evidence sidecar bytes", consumer: "checkRunConsistency", rejector: "checkRunConsistency :: run.merged_slice_repair.evidence_ref :: run.merged_slice_repair.evidence_hash :: must match evidence_ref bytes" },
  { name: "repair-review-reject: wrong-bytes (repair-evidence sidecar bytes)", record_id: "repair-review-reject", family: "wrong-bytes", target_label: "repair-evidence sidecar bytes", consumer: "checkRunConsistency", rejector: "checkRunConsistency :: run.merged_slice_repair.repair_evidence_ref :: run.merged_slice_repair.repair_evidence_hash :: must match repair_evidence_ref bytes" },
  { name: "repair-review-reject: wrong-bytes (review sidecar bytes)", record_id: "repair-review-reject", family: "wrong-bytes", target_label: "review sidecar bytes", consumer: "checkRunConsistency", rejector: "checkRunConsistency :: run.merged_slice_repair.review_ref :: run.merged_slice_repair.review_hash :: must match review_ref bytes" },
  { name: "repair-review-reject: descriptor-key-shape-drift (evidence_ref renamed)", record_id: "repair-review-reject", family: "descriptor-key-shape-drift", target_label: "evidence_ref renamed", consumer: "validateRun", rejector: "validateMergedSliceRepair :: run.merged_slice_repair.reproduction_ref :: is not allowed" },
  { name: "repair-review-reject: stale-identity (stale attempts)", record_id: "repair-review-reject", family: "stale-identity", target_label: "stale attempts", consumer: "validateRun", rejector: "validateMergedSliceRepair :: run.merged_slice_repair.attempts :: must be at least 1 once an attempt starts" },
  { name: "repair-review-reject: stale-identity (stale baseline_commit)", record_id: "repair-review-reject", family: "stale-identity", target_label: "stale baseline_commit", consumer: "transitionMergedSliceRepair", rejector: "transitionMergedSliceRepair :: Error :: rejected repair review must bind work after the observed attempt baseline" },
  { name: "repair-review-reject: cross-bound-identity (cross-bound consumer_slice_id)", record_id: "repair-review-reject", family: "cross-bound-identity", target_label: "cross-bound consumer_slice_id", consumer: "validateRun", rejector: "validateMergedSliceRepair :: run.merged_slice_repair.consumer_slice_id :: must differ from owner_slice_id" },
  { name: "repair-review-reject: cross-bound-identity (cross-bound reviewed_commit)", record_id: "repair-review-reject", family: "cross-bound-identity", target_label: "cross-bound reviewed_commit", consumer: "transitionMergedSliceRepair", rejector: "transitionMergedSliceRepair :: Error :: repair review must bind the exact reviewed commit; the recorded commit does not match the observed repair" },
  { name: "repair-merged: missing-key (required field)", record_id: "repair-merged", family: "missing-key", target_label: "required field", consumer: "validateRun", rejector: "validateMergedSliceRepair :: run.merged_slice_repair.status :: must be one of reported, repairing, review, merged, blocked" },
  { name: "repair-merged: unknown-key (record root)", record_id: "repair-merged", family: "unknown-key", target_label: "record root", consumer: "validateRun", rejector: "validateMergedSliceRepair :: run.merged_slice_repair.unexpected_authority_key :: is not allowed" },
  { name: "repair-merged: wrong-schema (schema version)", record_id: "repair-merged", family: "wrong-schema", target_label: "schema version", consumer: "validateRun", rejector: "validateMergedSliceRepair :: run.merged_slice_repair.schema_version :: must equal 1" },
  { name: "repair-merged: wrong-time (timestamp updated_at)", record_id: "repair-merged", family: "wrong-time", target_label: "timestamp updated_at", consumer: "transitionMergedSliceRepair", rejector: "transitionMergedSliceRepair :: ValidationError :: run.merged_slice_repair.updated_at: must be an ISO timestamp" },
  { name: "repair-merged: wrong-type (typed field)", record_id: "repair-merged", family: "wrong-type", target_label: "typed field", consumer: "validateRun", rejector: "validateMergedSliceRepair :: run.merged_slice_repair.attempts :: must be an integer from 0 to 2" },
  { name: "repair-merged: wrong-ref (plan ref)", record_id: "repair-merged", family: "wrong-ref", target_label: "plan ref", consumer: "checkRunConsistency", rejector: "checkRunConsistency :: run.merged_slice_repair.plan :: run.merged_slice_repair.plan :: referenced authority file does not exist" },
  { name: "repair-merged: wrong-ref (original-evidence ref)", record_id: "repair-merged", family: "wrong-ref", target_label: "original-evidence ref", consumer: "checkRunConsistency", rejector: "checkRunConsistency :: run.merged_slice_repair.evidence_ref :: run.merged_slice_repair.evidence_ref :: evidence ref must not contain empty, '.' or '..' path segments" },
  { name: "repair-merged: wrong-ref (repair-evidence ref)", record_id: "repair-merged", family: "wrong-ref", target_label: "repair-evidence ref", consumer: "checkRunConsistency", rejector: "checkRunConsistency :: run.merged_slice_repair.repair_evidence_ref :: run.merged_slice_repair.repair_evidence_ref :: evidence ref must not contain empty, '.' or '..' path segments" },
  { name: "repair-merged: wrong-ref (review ref)", record_id: "repair-merged", family: "wrong-ref", target_label: "review ref", consumer: "checkRunConsistency", rejector: "checkRunConsistency :: run.merged_slice_repair.review_ref :: run.merged_slice_repair.review_ref :: reviews ref must not contain empty, '.' or '..' path segments" },
  { name: "repair-merged: wrong-ref (verification ref)", record_id: "repair-merged", family: "wrong-ref", target_label: "verification ref", consumer: "checkRunConsistency", rejector: "checkRunConsistency :: run.merged_slice_repair.verification_ref :: run.merged_slice_repair.verification_ref :: evidence ref must not contain empty, '.' or '..' path segments" },
  { name: "repair-merged: wrong-hash (plan hash)", record_id: "repair-merged", family: "wrong-hash", target_label: "plan hash", consumer: "checkRunConsistency", rejector: "checkRunConsistency :: run.merged_slice_repair.plan :: run.merged_slice_repair.plan_hash :: must match plan/slices.json bytes bound at report" },
  { name: "repair-merged: wrong-hash (original-evidence hash)", record_id: "repair-merged", family: "wrong-hash", target_label: "original-evidence hash", consumer: "checkRunConsistency", rejector: "checkRunConsistency :: run.merged_slice_repair.evidence_ref :: run.merged_slice_repair.evidence_hash :: must match evidence_ref bytes" },
  { name: "repair-merged: wrong-hash (repair-evidence hash)", record_id: "repair-merged", family: "wrong-hash", target_label: "repair-evidence hash", consumer: "checkRunConsistency", rejector: "checkRunConsistency :: run.merged_slice_repair.repair_evidence_ref :: run.merged_slice_repair.repair_evidence_hash :: must match repair_evidence_ref bytes" },
  { name: "repair-merged: wrong-hash (review hash)", record_id: "repair-merged", family: "wrong-hash", target_label: "review hash", consumer: "checkRunConsistency", rejector: "checkRunConsistency :: run.merged_slice_repair.review_ref :: run.merged_slice_repair.review_hash :: must match review_ref bytes" },
  { name: "repair-merged: wrong-hash (verification hash)", record_id: "repair-merged", family: "wrong-hash", target_label: "verification hash", consumer: "checkRunConsistency", rejector: "checkRunConsistency :: run.merged_slice_repair.verification_ref :: run.merged_slice_repair.verification_hash :: must match verification_ref bytes" },
  { name: "repair-merged: wrong-bytes (plan sidecar bytes)", record_id: "repair-merged", family: "wrong-bytes", target_label: "plan sidecar bytes", consumer: "checkRunConsistency", rejector: "checkRunConsistency :: run.merged_slice_repair.plan :: run.merged_slice_repair.plan_hash :: must match plan/slices.json bytes bound at report" },
  { name: "repair-merged: wrong-bytes (original-evidence sidecar bytes)", record_id: "repair-merged", family: "wrong-bytes", target_label: "original-evidence sidecar bytes", consumer: "checkRunConsistency", rejector: "checkRunConsistency :: run.merged_slice_repair.evidence_ref :: run.merged_slice_repair.evidence_hash :: must match evidence_ref bytes" },
  { name: "repair-merged: wrong-bytes (repair-evidence sidecar bytes)", record_id: "repair-merged", family: "wrong-bytes", target_label: "repair-evidence sidecar bytes", consumer: "checkRunConsistency", rejector: "checkRunConsistency :: run.merged_slice_repair.repair_evidence_ref :: run.merged_slice_repair.repair_evidence_hash :: must match repair_evidence_ref bytes" },
  { name: "repair-merged: wrong-bytes (review sidecar bytes)", record_id: "repair-merged", family: "wrong-bytes", target_label: "review sidecar bytes", consumer: "checkRunConsistency", rejector: "checkRunConsistency :: run.merged_slice_repair.review_ref :: run.merged_slice_repair.review_hash :: must match review_ref bytes" },
  { name: "repair-merged: wrong-bytes (verification sidecar bytes)", record_id: "repair-merged", family: "wrong-bytes", target_label: "verification sidecar bytes", consumer: "checkRunConsistency", rejector: "checkRunConsistency :: run.merged_slice_repair.verification_ref :: run.merged_slice_repair.verification_hash :: must match verification_ref bytes" },
  { name: "repair-merged: descriptor-key-shape-drift (evidence_ref renamed)", record_id: "repair-merged", family: "descriptor-key-shape-drift", target_label: "evidence_ref renamed", consumer: "validateRun", rejector: "validateMergedSliceRepair :: run.merged_slice_repair.reproduction_ref :: is not allowed" },
  { name: "repair-merged: stale-identity (stale attempts)", record_id: "repair-merged", family: "stale-identity", target_label: "stale attempts", consumer: "validateRun", rejector: "validateMergedSliceRepair :: run.merged_slice_repair.attempts :: must be at least 1 once an attempt starts" },
  { name: "repair-merged: stale-identity (stale baseline_commit)", record_id: "repair-merged", family: "stale-identity", target_label: "stale baseline_commit", consumer: "transitionMergedSliceRepair", rejector: "transitionMergedSliceRepair :: Error :: merged-slice repair is terminal ('merged'); a further defect requires a recovery run" },
  { name: "repair-merged: stale-identity (stale merge_commit)", record_id: "repair-merged", family: "stale-identity", target_label: "stale merge_commit", consumer: "transitionMergedSliceRepair", rejector: "transitionMergedSliceRepair :: Error :: merged-slice repair is terminal ('merged'); a further defect requires a recovery run" },
  { name: "repair-merged: cross-bound-identity (cross-bound consumer_slice_id)", record_id: "repair-merged", family: "cross-bound-identity", target_label: "cross-bound consumer_slice_id", consumer: "validateRun", rejector: "validateMergedSliceRepair :: run.merged_slice_repair.consumer_slice_id :: must differ from owner_slice_id" },
  { name: "repair-merged: cross-bound-identity (cross-bound reviewed_commit)", record_id: "repair-merged", family: "cross-bound-identity", target_label: "cross-bound reviewed_commit", consumer: "transitionMergedSliceRepair", rejector: "transitionMergedSliceRepair :: Error :: merged-slice repair is terminal ('merged'); a further defect requires a recovery run" },
  { name: "repair-blocked-from-reported: missing-key (required field)", record_id: "repair-blocked-from-reported", family: "missing-key", target_label: "required field", consumer: "validateRun", rejector: "validateMergedSliceRepair :: run.merged_slice_repair.status :: must be one of reported, repairing, review, merged, blocked" },
  { name: "repair-blocked-from-reported: unknown-key (record root)", record_id: "repair-blocked-from-reported", family: "unknown-key", target_label: "record root", consumer: "validateRun", rejector: "validateMergedSliceRepair :: run.merged_slice_repair.unexpected_authority_key :: is not allowed" },
  { name: "repair-blocked-from-reported: wrong-schema (schema version)", record_id: "repair-blocked-from-reported", family: "wrong-schema", target_label: "schema version", consumer: "validateRun", rejector: "validateMergedSliceRepair :: run.merged_slice_repair.schema_version :: must equal 1" },
  { name: "repair-blocked-from-reported: wrong-time (timestamp updated_at)", record_id: "repair-blocked-from-reported", family: "wrong-time", target_label: "timestamp updated_at", consumer: "transitionMergedSliceRepair", rejector: "transitionMergedSliceRepair :: ValidationError :: run.merged_slice_repair.updated_at: must be an ISO timestamp" },
  { name: "repair-blocked-from-reported: wrong-type (typed field)", record_id: "repair-blocked-from-reported", family: "wrong-type", target_label: "typed field", consumer: "validateRun", rejector: "validateMergedSliceRepair :: run.merged_slice_repair.attempts :: must be an integer from 0 to 2" },
  { name: "repair-blocked-from-reported: wrong-ref (plan ref)", record_id: "repair-blocked-from-reported", family: "wrong-ref", target_label: "plan ref", consumer: "checkRunConsistency", rejector: "checkRunConsistency :: run.merged_slice_repair.plan :: run.merged_slice_repair.plan :: referenced authority file does not exist" },
  { name: "repair-blocked-from-reported: wrong-ref (original-evidence ref)", record_id: "repair-blocked-from-reported", family: "wrong-ref", target_label: "original-evidence ref", consumer: "checkRunConsistency", rejector: "checkRunConsistency :: run.merged_slice_repair.evidence_ref :: run.merged_slice_repair.evidence_ref :: evidence ref must not contain empty, '.' or '..' path segments" },
  { name: "repair-blocked-from-reported: wrong-hash (plan hash)", record_id: "repair-blocked-from-reported", family: "wrong-hash", target_label: "plan hash", consumer: "checkRunConsistency", rejector: "checkRunConsistency :: run.merged_slice_repair.plan :: run.merged_slice_repair.plan_hash :: must match plan/slices.json bytes bound at report" },
  { name: "repair-blocked-from-reported: wrong-hash (original-evidence hash)", record_id: "repair-blocked-from-reported", family: "wrong-hash", target_label: "original-evidence hash", consumer: "checkRunConsistency", rejector: "checkRunConsistency :: run.merged_slice_repair.evidence_ref :: run.merged_slice_repair.evidence_hash :: must match evidence_ref bytes" },
  { name: "repair-blocked-from-reported: wrong-bytes (plan sidecar bytes)", record_id: "repair-blocked-from-reported", family: "wrong-bytes", target_label: "plan sidecar bytes", consumer: "checkRunConsistency", rejector: "checkRunConsistency :: run.merged_slice_repair.plan :: run.merged_slice_repair.plan_hash :: must match plan/slices.json bytes bound at report" },
  { name: "repair-blocked-from-reported: wrong-bytes (original-evidence sidecar bytes)", record_id: "repair-blocked-from-reported", family: "wrong-bytes", target_label: "original-evidence sidecar bytes", consumer: "checkRunConsistency", rejector: "checkRunConsistency :: run.merged_slice_repair.evidence_ref :: run.merged_slice_repair.evidence_hash :: must match evidence_ref bytes" },
  { name: "repair-blocked-from-reported: descriptor-key-shape-drift (evidence_ref renamed)", record_id: "repair-blocked-from-reported", family: "descriptor-key-shape-drift", target_label: "evidence_ref renamed", consumer: "validateRun", rejector: "validateMergedSliceRepair :: run.merged_slice_repair.reproduction_ref :: is not allowed" },
  { name: "repair-blocked-from-reported: stale-identity (stale attempts)", record_id: "repair-blocked-from-reported", family: "stale-identity", target_label: "stale attempts", consumer: "transitionMergedSliceRepair", rejector: "transitionMergedSliceRepair :: Error :: merged-slice repair is terminal ('blocked'); a further defect requires a recovery run" },
  { name: "repair-blocked-from-reported: cross-bound-identity (cross-bound consumer_slice_id)", record_id: "repair-blocked-from-reported", family: "cross-bound-identity", target_label: "cross-bound consumer_slice_id", consumer: "validateRun", rejector: "validateMergedSliceRepair :: run.merged_slice_repair.consumer_slice_id :: must differ from owner_slice_id" },
  { name: "repair-blocked-from-repairing: missing-key (required field)", record_id: "repair-blocked-from-repairing", family: "missing-key", target_label: "required field", consumer: "validateRun", rejector: "validateMergedSliceRepair :: run.merged_slice_repair.status :: must be one of reported, repairing, review, merged, blocked" },
  { name: "repair-blocked-from-repairing: unknown-key (record root)", record_id: "repair-blocked-from-repairing", family: "unknown-key", target_label: "record root", consumer: "validateRun", rejector: "validateMergedSliceRepair :: run.merged_slice_repair.unexpected_authority_key :: is not allowed" },
  { name: "repair-blocked-from-repairing: wrong-schema (schema version)", record_id: "repair-blocked-from-repairing", family: "wrong-schema", target_label: "schema version", consumer: "validateRun", rejector: "validateMergedSliceRepair :: run.merged_slice_repair.schema_version :: must equal 1" },
  { name: "repair-blocked-from-repairing: wrong-time (timestamp updated_at)", record_id: "repair-blocked-from-repairing", family: "wrong-time", target_label: "timestamp updated_at", consumer: "transitionMergedSliceRepair", rejector: "transitionMergedSliceRepair :: ValidationError :: run.merged_slice_repair.updated_at: must be an ISO timestamp" },
  { name: "repair-blocked-from-repairing: wrong-type (typed field)", record_id: "repair-blocked-from-repairing", family: "wrong-type", target_label: "typed field", consumer: "validateRun", rejector: "validateMergedSliceRepair :: run.merged_slice_repair.attempts :: must be an integer from 0 to 2" },
  { name: "repair-blocked-from-repairing: wrong-ref (plan ref)", record_id: "repair-blocked-from-repairing", family: "wrong-ref", target_label: "plan ref", consumer: "checkRunConsistency", rejector: "checkRunConsistency :: run.merged_slice_repair.plan :: run.merged_slice_repair.plan :: referenced authority file does not exist" },
  { name: "repair-blocked-from-repairing: wrong-ref (original-evidence ref)", record_id: "repair-blocked-from-repairing", family: "wrong-ref", target_label: "original-evidence ref", consumer: "checkRunConsistency", rejector: "checkRunConsistency :: run.merged_slice_repair.evidence_ref :: run.merged_slice_repair.evidence_ref :: evidence ref must not contain empty, '.' or '..' path segments" },
  { name: "repair-blocked-from-repairing: wrong-hash (plan hash)", record_id: "repair-blocked-from-repairing", family: "wrong-hash", target_label: "plan hash", consumer: "checkRunConsistency", rejector: "checkRunConsistency :: run.merged_slice_repair.plan :: run.merged_slice_repair.plan_hash :: must match plan/slices.json bytes bound at report" },
  { name: "repair-blocked-from-repairing: wrong-hash (original-evidence hash)", record_id: "repair-blocked-from-repairing", family: "wrong-hash", target_label: "original-evidence hash", consumer: "checkRunConsistency", rejector: "checkRunConsistency :: run.merged_slice_repair.evidence_ref :: run.merged_slice_repair.evidence_hash :: must match evidence_ref bytes" },
  { name: "repair-blocked-from-repairing: wrong-bytes (plan sidecar bytes)", record_id: "repair-blocked-from-repairing", family: "wrong-bytes", target_label: "plan sidecar bytes", consumer: "checkRunConsistency", rejector: "checkRunConsistency :: run.merged_slice_repair.plan :: run.merged_slice_repair.plan_hash :: must match plan/slices.json bytes bound at report" },
  { name: "repair-blocked-from-repairing: wrong-bytes (original-evidence sidecar bytes)", record_id: "repair-blocked-from-repairing", family: "wrong-bytes", target_label: "original-evidence sidecar bytes", consumer: "checkRunConsistency", rejector: "checkRunConsistency :: run.merged_slice_repair.evidence_ref :: run.merged_slice_repair.evidence_hash :: must match evidence_ref bytes" },
  { name: "repair-blocked-from-repairing: descriptor-key-shape-drift (evidence_ref renamed)", record_id: "repair-blocked-from-repairing", family: "descriptor-key-shape-drift", target_label: "evidence_ref renamed", consumer: "validateRun", rejector: "validateMergedSliceRepair :: run.merged_slice_repair.reproduction_ref :: is not allowed" },
  { name: "repair-blocked-from-repairing: stale-identity (stale attempts)", record_id: "repair-blocked-from-repairing", family: "stale-identity", target_label: "stale attempts", consumer: "transitionMergedSliceRepair", rejector: "transitionMergedSliceRepair :: Error :: merged-slice repair is terminal ('blocked'); a further defect requires a recovery run" },
  { name: "repair-blocked-from-repairing: stale-identity (stale baseline_commit)", record_id: "repair-blocked-from-repairing", family: "stale-identity", target_label: "stale baseline_commit", consumer: "transitionMergedSliceRepair", rejector: "transitionMergedSliceRepair :: Error :: merged-slice repair is terminal ('blocked'); a further defect requires a recovery run" },
  { name: "repair-blocked-from-repairing: cross-bound-identity (cross-bound consumer_slice_id)", record_id: "repair-blocked-from-repairing", family: "cross-bound-identity", target_label: "cross-bound consumer_slice_id", consumer: "validateRun", rejector: "validateMergedSliceRepair :: run.merged_slice_repair.consumer_slice_id :: must differ from owner_slice_id" },
  { name: "repair-blocked-from-review: missing-key (required field)", record_id: "repair-blocked-from-review", family: "missing-key", target_label: "required field", consumer: "validateRun", rejector: "validateMergedSliceRepair :: run.merged_slice_repair.status :: must be one of reported, repairing, review, merged, blocked" },
  { name: "repair-blocked-from-review: unknown-key (record root)", record_id: "repair-blocked-from-review", family: "unknown-key", target_label: "record root", consumer: "validateRun", rejector: "validateMergedSliceRepair :: run.merged_slice_repair.unexpected_authority_key :: is not allowed" },
  { name: "repair-blocked-from-review: wrong-schema (schema version)", record_id: "repair-blocked-from-review", family: "wrong-schema", target_label: "schema version", consumer: "validateRun", rejector: "validateMergedSliceRepair :: run.merged_slice_repair.schema_version :: must equal 1" },
  { name: "repair-blocked-from-review: wrong-time (timestamp updated_at)", record_id: "repair-blocked-from-review", family: "wrong-time", target_label: "timestamp updated_at", consumer: "transitionMergedSliceRepair", rejector: "transitionMergedSliceRepair :: ValidationError :: run.merged_slice_repair.updated_at: must be an ISO timestamp" },
  { name: "repair-blocked-from-review: wrong-type (typed field)", record_id: "repair-blocked-from-review", family: "wrong-type", target_label: "typed field", consumer: "validateRun", rejector: "validateMergedSliceRepair :: run.merged_slice_repair.attempts :: must be an integer from 0 to 2" },
  { name: "repair-blocked-from-review: wrong-ref (plan ref)", record_id: "repair-blocked-from-review", family: "wrong-ref", target_label: "plan ref", consumer: "checkRunConsistency", rejector: "checkRunConsistency :: run.merged_slice_repair.plan :: run.merged_slice_repair.plan :: referenced authority file does not exist" },
  { name: "repair-blocked-from-review: wrong-ref (original-evidence ref)", record_id: "repair-blocked-from-review", family: "wrong-ref", target_label: "original-evidence ref", consumer: "checkRunConsistency", rejector: "checkRunConsistency :: run.merged_slice_repair.evidence_ref :: run.merged_slice_repair.evidence_ref :: evidence ref must not contain empty, '.' or '..' path segments" },
  { name: "repair-blocked-from-review: wrong-ref (repair-evidence ref)", record_id: "repair-blocked-from-review", family: "wrong-ref", target_label: "repair-evidence ref", consumer: "checkRunConsistency", rejector: "checkRunConsistency :: run.merged_slice_repair.repair_evidence_ref :: run.merged_slice_repair.repair_evidence_ref :: evidence ref must not contain empty, '.' or '..' path segments" },
  { name: "repair-blocked-from-review: wrong-ref (review ref)", record_id: "repair-blocked-from-review", family: "wrong-ref", target_label: "review ref", consumer: "checkRunConsistency", rejector: "checkRunConsistency :: run.merged_slice_repair.review_ref :: run.merged_slice_repair.review_ref :: reviews ref must not contain empty, '.' or '..' path segments" },
  { name: "repair-blocked-from-review: wrong-hash (plan hash)", record_id: "repair-blocked-from-review", family: "wrong-hash", target_label: "plan hash", consumer: "checkRunConsistency", rejector: "checkRunConsistency :: run.merged_slice_repair.plan :: run.merged_slice_repair.plan_hash :: must match plan/slices.json bytes bound at report" },
  { name: "repair-blocked-from-review: wrong-hash (original-evidence hash)", record_id: "repair-blocked-from-review", family: "wrong-hash", target_label: "original-evidence hash", consumer: "checkRunConsistency", rejector: "checkRunConsistency :: run.merged_slice_repair.evidence_ref :: run.merged_slice_repair.evidence_hash :: must match evidence_ref bytes" },
  { name: "repair-blocked-from-review: wrong-hash (repair-evidence hash)", record_id: "repair-blocked-from-review", family: "wrong-hash", target_label: "repair-evidence hash", consumer: "checkRunConsistency", rejector: "checkRunConsistency :: run.merged_slice_repair.repair_evidence_ref :: run.merged_slice_repair.repair_evidence_hash :: must match repair_evidence_ref bytes" },
  { name: "repair-blocked-from-review: wrong-hash (review hash)", record_id: "repair-blocked-from-review", family: "wrong-hash", target_label: "review hash", consumer: "checkRunConsistency", rejector: "checkRunConsistency :: run.merged_slice_repair.review_ref :: run.merged_slice_repair.review_hash :: must match review_ref bytes" },
  { name: "repair-blocked-from-review: wrong-bytes (plan sidecar bytes)", record_id: "repair-blocked-from-review", family: "wrong-bytes", target_label: "plan sidecar bytes", consumer: "checkRunConsistency", rejector: "checkRunConsistency :: run.merged_slice_repair.plan :: run.merged_slice_repair.plan_hash :: must match plan/slices.json bytes bound at report" },
  { name: "repair-blocked-from-review: wrong-bytes (original-evidence sidecar bytes)", record_id: "repair-blocked-from-review", family: "wrong-bytes", target_label: "original-evidence sidecar bytes", consumer: "checkRunConsistency", rejector: "checkRunConsistency :: run.merged_slice_repair.evidence_ref :: run.merged_slice_repair.evidence_hash :: must match evidence_ref bytes" },
  { name: "repair-blocked-from-review: wrong-bytes (repair-evidence sidecar bytes)", record_id: "repair-blocked-from-review", family: "wrong-bytes", target_label: "repair-evidence sidecar bytes", consumer: "checkRunConsistency", rejector: "checkRunConsistency :: run.merged_slice_repair.repair_evidence_ref :: run.merged_slice_repair.repair_evidence_hash :: must match repair_evidence_ref bytes" },
  { name: "repair-blocked-from-review: wrong-bytes (review sidecar bytes)", record_id: "repair-blocked-from-review", family: "wrong-bytes", target_label: "review sidecar bytes", consumer: "checkRunConsistency", rejector: "checkRunConsistency :: run.merged_slice_repair.review_ref :: run.merged_slice_repair.review_hash :: must match review_ref bytes" },
  { name: "repair-blocked-from-review: descriptor-key-shape-drift (evidence_ref renamed)", record_id: "repair-blocked-from-review", family: "descriptor-key-shape-drift", target_label: "evidence_ref renamed", consumer: "validateRun", rejector: "validateMergedSliceRepair :: run.merged_slice_repair.reproduction_ref :: is not allowed" },
  { name: "repair-blocked-from-review: stale-identity (stale attempts)", record_id: "repair-blocked-from-review", family: "stale-identity", target_label: "stale attempts", consumer: "transitionMergedSliceRepair", rejector: "transitionMergedSliceRepair :: Error :: merged-slice repair is terminal ('blocked'); a further defect requires a recovery run" },
  { name: "repair-blocked-from-review: stale-identity (stale baseline_commit)", record_id: "repair-blocked-from-review", family: "stale-identity", target_label: "stale baseline_commit", consumer: "transitionMergedSliceRepair", rejector: "transitionMergedSliceRepair :: Error :: merged-slice repair is terminal ('blocked'); a further defect requires a recovery run" },
  { name: "repair-blocked-from-review: cross-bound-identity (cross-bound consumer_slice_id)", record_id: "repair-blocked-from-review", family: "cross-bound-identity", target_label: "cross-bound consumer_slice_id", consumer: "validateRun", rejector: "validateMergedSliceRepair :: run.merged_slice_repair.consumer_slice_id :: must differ from owner_slice_id" },
  { name: "repair-blocked-from-review: cross-bound-identity (cross-bound reviewed_commit)", record_id: "repair-blocked-from-review", family: "cross-bound-identity", target_label: "cross-bound reviewed_commit", consumer: "transitionMergedSliceRepair", rejector: "transitionMergedSliceRepair :: Error :: merged-slice repair is terminal ('blocked'); a further defect requires a recovery run" },
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
  "repair-reported": 14,
  "repair-repairing": 15,
  "repair-review-approve": 22,
  "repair-review-reject": 22,
  "repair-merged": 26,
  "repair-blocked-from-reported": 14,
  "repair-blocked-from-repairing": 15,
  "repair-blocked-from-review": 22,
});
const B0M4_LITERAL_POST_PR_COUNT = 429;
const B0M4_LITERAL_REPAIR_COUNT = 150;

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
  "repair-reported: stale-identity (stale attempts)": "repair-reported",
  "repair-repairing: stale-identity (stale baseline_commit)": "repair-repairing",
  "repair-review-approve: stale-identity (stale baseline_commit)": "repair-review-approve-baseline",
  "repair-review-approve: cross-bound-identity (cross-bound reviewed_commit)": "repair-review-approve-reviewed",
  "repair-review-reject: stale-identity (stale baseline_commit)": "repair-review-reject-baseline",
  "repair-review-reject: cross-bound-identity (cross-bound reviewed_commit)": "repair-review-reject-reviewed",
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
  it("preflights the independently literal exact 579-case B0M.4 inventory and exact-name dispositions", () => {
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
    assert.equal(B0M4_EXACT_CASES.length, 579);
    assert.equal(B0M4_LITERAL_POST_PR_COUNT, 429);
    assert.equal(B0M4_LITERAL_REPAIR_COUNT, 150);
    assert.equal(Object.keys(B0M4_PREREQUISITE_VALID_SCENARIOS).length, 35);
    for (const name of Object.keys(B0M4_PREREQUISITE_VALID_SCENARIOS)) assert.equal(dispositionByName.has(name), true, `unknown prerequisite-valid case ${name}`);
    assert.equal(dispositionByName.size, 579);
    assert.deepEqual(emitted, B0M4_EXACT_CASES, "missing, duplicate, unknown, reordered, or mismatched tuple/consumer/rejector must fail preflight");
    const duplicateDisposition = B0M4_EXACT_CASES.slice();
    duplicateDisposition.push(B0M4_EXACT_CASES[0]);
    assert.throws(() => exactB0m4DispositionMap(duplicateDisposition), /duplicate exact B0M\.4 case/u);
    assert.throws(() => exactB0m4DispositionMap([{ ...B0M4_EXACT_CASES[0], consumer: "" }]), /literal consumer|concrete consumer and rejector/u);
    assert.equal(DURABLE_AUTHORITY_PRODUCTION_COVERED_RECORD_IDS.length, 108);
    assert.equal(DURABLE_AUTHORITY_CATALOG.flatMap(({ records }) => records).length, 109);
    assert.equal(DURABLE_AUTHORITY_PRODUCTION_COVERED_RECORD_IDS.includes("final-plan-descriptor"), false);
  });

  it("executes every one of the exact 579 B0M.4 cases once through its literal concrete consumer", async () => {
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
          const fixture = expected.record_id.startsWith("repair-") ? createRepairCatalogBaseline(record) : createPostPrCatalogBaseline(record);
          const mutatedRun = replaceCanonicalRecord(fixture.run, record.canonicalPath, mutationCase.record);
          assert.throws(() => validateRun(mutatedRun), (error) => {
            assert.equal(error?.name, "ValidationError", `${expected.name} must reach ${expected.rejector}`);
            const [rejector, path, message] = expected.rejector.split(" :: ");
            assert.equal(["validatePostPr", "validateMergedSliceRepair"].includes(rejector), true, expected.name);
            assert.equal(error.errors.some((item) => item.path === path && item.message === message), true, `${expected.name} exact nested path/message`);
            return true;
          });
        } else if (expected.consumer === "checkRunConsistency") {
          const fixture = expected.record_id.startsWith("repair-") ? createRepairCatalogBaseline(record) : createPostPrCatalogBaseline(record);
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
        } else if (expected.consumer === "transitionMergedSliceRepair") {
          const fixture = createRepairCatalogBaseline(record);
          const runDir = join(root, String(executed.size));
          materializeCatalogSources(runDir, mutationCase.externalSources, fixture.supportSources);
          const mutatedRun = replaceCanonicalRecord(fixture.run, record.canonicalPath, mutationCase.record);
          writeJson(join(runDir, "run.json"), mutatedRun);
          const before = readFileSync(join(runDir, "run.json"), "utf8");
          const fence = structuredClone(mergedSliceRepairFence(mutatedRun));
          const [, errorName, errorMessage] = expected.rejector.split(" :: ");
          await assert.rejects(transitionMergedSliceRepair(runDir, repairProbeRequest(mutationCase.record), { repoRoot: runDir, now: "2026-07-16T12:06:00.000Z" }), (error) => error.name === errorName && error.message === errorMessage, `${expected.name} must reach ${expected.rejector}`);
          assert.equal(readFileSync(join(runDir, "run.json"), "utf8"), before, `${expected.name} protected bytes`);
          assert.deepEqual(mergedSliceRepairFence(JSON.parse(before)), fence, `${expected.name} repair fence`);
        } else assert.fail(`unknown literal consumer for ${expected.name}: ${expected.consumer}`);
        executed.add(expected.name);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
    assert.equal(executed.size, 579);
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
    assert.equal(recordCount, 109);
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

  it("uses an independent closed descriptor oracle for all 109 exact target/exclusion definitions", () => {
    const requiredIds = Object.values(DURABLE_AUTHORITY_REQUIRED_RECORD_IDS).flat();
    assert.deepEqual(DURABLE_AUTHORITY_DESCRIPTOR_MANIFEST.map(([id]) => id), requiredIds);
    assert.equal(DURABLE_AUTHORITY_DESCRIPTOR_MANIFEST.length, 109);
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

  it("reviews readable old/new successor catalog values before the four manifest digest changes", () => {
    const expectedDigests = {
      "slice-review": ["8fd0fae00323e9bed95c0673fc1f4f22d345a0f886438fee4991e7a390b7e7b0", "1d0d4c6beaa40f3f3397a3d015ae7d682cd8eb4ed10e268998b59bf14d7c76ef", "ac668a5340a0db81df8ad31e4d73302234dfd49da5933161e0f43d869e8a3262"],
      "slice-merged": ["785275ed7b23a9ecb8fd33d838e0e3a6acc2980d9e69e96ebd0f4cb6a9410707", "d02186b0bac9122bd39058f4205cc5234e6a8da5bc82fd221c6b88ca76e6633f", "ad2674135456283cf415406224c7a04cf661565770b6a7270a00d673fe2d6869"],
      "validator-verdict-binding": ["ce1205fb84feece303f45e9841916d68fe26431d3117636aecc4b0cdccc79e14", "d5663f22b888f878625141430a2602863730f8ab122a815359dd545d876b49cb", "22c22e8e118609a58e29101a6f6a89dacc8ddfddcc92974c810fe4b51cc5fdc9"],
      "security-verdict-binding": ["81cbb46158b44646aabf50e0152b80d5ed6dc423826337bf45fe6be7c24e5995", "88c89ebb14e5f14121dc022da8f0c73dc1e5e9639d570337edcfb09cef5c17d7", "56e34d4427dc76cb46caee5a002856e4e97ef2dc870543fc489a750e384e6d99"],
    };
    for (const [id, digests] of Object.entries(expectedDigests)) {
      const current = findRecord(DURABLE_AUTHORITY_CATALOG, id);
      const prior = structuredClone(current);
      for (const key of ["evidence_hash", "review_hash", "reviewed_commit", "report_hash", "reviewed_head_sha"]) delete prior.source[key];
      prior.externalSources = {};
      prior.sidecars = [];
      delete prior.observations;
      const oldReview = JSON.parse(renderDurableAuthorityOracleReviewSnapshot(prior));
      const newReview = JSON.parse(renderDurableAuthorityOracleReviewSnapshot(current));
      assert.equal(Object.hasOwn(oldReview.canonicalSource.source, id.startsWith("slice-") ? "reviewed_commit" : "reviewed_head_sha"), false, id);
      assert.equal(Object.hasOwn(newReview.canonicalSource.source, id.startsWith("slice-") ? "reviewed_commit" : "reviewed_head_sha"), true, id);
      assert.deepEqual(Object.keys(oldReview.canonicalSource.externalSources), []);
      assert.ok(Object.keys(newReview.canonicalSource.externalSources).length > 0, id);
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
      "steering-pr-fence": ["372be755ffb890bc4fdc9ae5913adad802c809e3d35c0e8c4746917c82e59b8a", "aae0a3986f100717159038cc2b06cfd835b1313305e22fc7beeea4929db3d662", "16fa47900dbcbd6618a6ebd0eed5cb705910a2ccfc8478bd1f554c7f8ebef406"],
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
    assert.equal(canonicalIds.length, 109);
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

  it("routes exactly the adopted canonical baselines through production validation and keeps final.plan descriptor-only", () => {
    const observedConsumers = new Map();
    for (const id of [...DURABLE_AUTHORITY_PRODUCTION_COVERED_RECORD_IDS, "final-plan-descriptor"]) {
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
    assert.equal(observedConsumers.size, 109);
    assert.deepEqual([...observedConsumers.keys()].slice(0, 108), DURABLE_AUTHORITY_PRODUCTION_COVERED_RECORD_IDS);
    assert.equal(observedConsumers.get("final-plan-descriptor"), "final-plan-descriptor-contract", "future-only final.plan is a descriptor contract, not claimed as current validateRun input");
  });

  it("preserves the prior B0M.1-B0M.3 production-consumer regression matrix", async () => {
    const expectedIds = [
      "plan-slices-json",
      "run-envelope-running",
      "run-envelope-terminal",
      "terminal-result-completed",
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
      "pr-created-result",
    ];
    assert.deepEqual(DURABLE_AUTHORITY_PRODUCTION_COVERED_RECORD_IDS.slice(0, 40), expectedIds);
    assert.equal(DURABLE_AUTHORITY_PRODUCTION_COVERED_RECORD_IDS.includes("final-plan-descriptor"), false);
    const continuationDispositions = exactB0m3ContinuationDispositionMap(B0M3_CONTINUATION_EXACT_CASES);
    const executedContinuationCases = [];
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
            await assert.rejects(transitionRunStep(runDir, "spec-writer", mutationCase.record), /attempts cannot regress|agent identity is immutable|inherited_acceptance can only be created/u, mutationCase.name);
            results[id].consumers.add("transitionRunStep");
            continue;
          }
          if (id.startsWith("continuation-")) {
            const disposition = continuationDispositions.get(mutationCase.name);
            assert.ok(disposition, `schema-valid continuation case requires an exact disposition: ${mutationCase.name}`);
            assert.equal(disposition.record_id, id, mutationCase.name);
            assert.equal(disposition.family, mutationCase.family, mutationCase.name);
            await consumeContinuationMutation(root, record, mutationCase, disposition, executedContinuationCases.length);
            executedContinuationCases.push(mutationCase.name);
            results[id].consumers.add(disposition.consumer);
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
    assert.equal(executedContinuationCases.length, 31, "all 31 schema-valid continuation mutations must execute a checked production consumer");
    assert.deepEqual(executedContinuationCases, B0M3_CONTINUATION_EXACT_CASES.map(({ name }) => name));
    const expectedB0M3Consumers = {
      "slice-pending": "transitionSlicesSeed",
      "slice-running": "transitionRunSlice",
      "slice-review": "transitionRunSlice",
      "slice-merged": "transitionSliceMerged",
      "slice-blocked": "transitionRunSlice",
      "validator-verdict-binding": "transitionPanelVerdicts",
      "security-verdict-binding": "transitionPanelVerdicts",
      "steering-boundary": "transitionSteeringBoundaryCrossed",
      "steering-action-claim": "transitionSteeringActionStarted",
      "steering-last-action": "transitionSteeringActionClosed",
      "pr-created-result": "transitionPrCreated",
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

    const steps = ["step-running", "step-rejected", "step-blocked", "step-accepted", "step-inherited-acceptance"]
      .map((id) => findRecord(DURABLE_AUTHORITY_CATALOG, id));
    assert.deepEqual(steps.map(({ source }) => source.status), ["running", "rejected", "blocked", "accepted", "accepted"]);
    assert.deepEqual(Object.keys(steps[3].source.acceptance), ["artifact_ref", "artifact_hash", "review_ref", "review_hash"]);
    assert.deepEqual(Object.keys(steps[4].source.inherited_acceptance), ["from_run_id", "parent_spec_review_ref", "artifact_hash", "review_hash"]);

    const slices = ["slice-pending", "slice-running", "slice-review", "slice-merged", "slice-blocked"]
      .map((id) => findRecord(DURABLE_AUTHORITY_CATALOG, id));
    assert.deepEqual(slices.map(({ source }) => source.status), ["pending", "running", "review", "merged", "blocked"]);
    for (const { source } of slices) for (const key of ["review_binding", "attempt_reviews", "sidecar_bytes"]) assert.equal(Object.hasOwn(source, key), false);
    for (const source of [slices[0].source, slices[1].source, slices[4].source]) {
      for (const key of ["reviewed_commit", "review_hash", "evidence_hash"]) assert.equal(Object.hasOwn(source, key), false);
    }
    assert.deepEqual(Object.keys(slices[2].source), ["id", "stack", "depends_on", "status", "attempts", "branch", "worktree", "evidence_ref", "evidence_hash", "review_ref", "review_hash", "reviewed_commit"]);
    assert.deepEqual(Object.keys(slices[3].source), ["id", "stack", "depends_on", "status", "attempts", "branch", "worktree", "evidence_ref", "evidence_hash", "review_ref", "review_hash", "reviewed_commit", "merge_commit", "updated_at"]);

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
    writeFileSync(join(sliceWorktree, "backend.txt"), "reviewed backend\n");
    fixtureGit(sliceWorktree, ["add", "backend.txt"]);
    fixtureGit(sliceWorktree, ["commit", "-q", "-m", "reviewed backend"]);
    const reviewedHead = fixtureGit(sliceWorktree, ["rev-parse", "HEAD"]).trim();
    const adaptSliceSources = (sources) => Object.fromEntries(Object.entries(sources || {}).map(([name, external]) => [name, {
      ...external,
      bytes: typeof external.bytes === "string" ? external.bytes.replaceAll("b".repeat(40), reviewedHead) : external.bytes,
    }]));
    materializeCatalogSources(runDir, adaptSliceSources(record.externalSources));
    const expectedEvidenceHash = hashFileBytes(join(runDir, "evidence", "backend.json"));
    const expectedReviewHash = hashFileBytes(join(runDir, "reviews", "backend.json"));
    materializeCatalogSources(runDir, adaptSliceSources(mutationCase.externalSources));
    const current = {
      id: "backend", stack: "backend", depends_on: [], status: record.id === "slice-merged" ? "merged" : "review", attempts: 1,
      branch: "feature--backend", worktree: sliceWorktree,
      evidence_ref: "evidence/backend.json", evidence_hash: expectedEvidenceHash,
      review_ref: "reviews/backend.json", review_hash: expectedReviewHash, reviewed_commit: reviewedHead,
    };
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
    await assert.rejects(transitionSlicesSeed(runDir, [mutation]), undefined, record.id);
    return "transitionSlicesSeed";
  }

  const current = { ...structuredClone(record.source), status: "running", attempts: Math.max(1, record.source.attempts || 1) };
  delete current.evidence_ref;
  delete current.review_ref;
  delete current.merge_commit;
  delete current.blocked_reason;
  delete current.updated_at;
  if (record.id === "slice-review") materializeSliceSidecars(runDir, mutation.id);
  writeJson(join(runDir, "run.json"), createRunRecord({ run_id: "catalog-run", slices: [current] }));
  await assert.rejects(transitionRunSlice(runDir, "backend", mutation), undefined, record.id);
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
  for (const dir of ["artifacts", "evidence", "reviews"]) mkdirSync(join(runDir, dir), { recursive: true });
  writeFileSync(join(runDir, "artifacts", "validation-report.md"), "GO\n");
  writeJson(join(runDir, "evidence", "backend.json"), { subject: "backend", attempt: 1, status: "pass", review_ready: true, head_sha: head });
  writeJson(join(runDir, "reviews", "backend.json"), { subject: "backend", attempt: 1, verdict: "APPROVE", reviewed_commit: head });
  writeJson(join(runDir, "reviews", "implementation-validator.json"), { subject: "main", attempt: 1, verdict: "GO", reviewed_head_sha: head });
  writeJson(join(runDir, "reviews", "security-reviewer.json"), { subject: "main", attempt: 1, verdict: "PASS", reviewed_head_sha: head });
  writeJson(runFile, createRunRecord({
    run_id: "catalog-run",
    branch: "main",
    worktree: repo,
    base_ref: "main",
    base_commit: head,
    github_account: "acme",
    pr_mode: "ready",
    gates: { pre_pr: { status: "approved", artifact: "artifacts/validation-report.md", question_ref: "gates/pre-pr.md", answer: "approve", answered_at: "2026-07-16T12:00:00.000Z" } },
    slices: [{ id: "backend", status: "merged", attempts: 1, evidence_ref: "evidence/backend.json", evidence_hash: hashFileBytes(join(runDir, "evidence", "backend.json")), review_ref: "reviews/backend.json", review_hash: hashFileBytes(join(runDir, "reviews", "backend.json")), reviewed_commit: head, merge_commit: head }],
    validator: { verdict: "GO", report: "artifacts/validation-report.md", report_hash: hashFileBytes(join(runDir, "artifacts", "validation-report.md")), review_ref: "reviews/implementation-validator.json", review_hash: hashFileBytes(join(runDir, "reviews", "implementation-validator.json")), reviewed_head_sha: head },
    security_review: { verdict: "PASS", review_ref: "reviews/security-reviewer.json", review_hash: hashFileBytes(join(runDir, "reviews", "security-reviewer.json")), reviewed_head_sha: head },
  }));
  return { repo, runDir, runFile, head };
}

function materializeSliceSidecars(runDir, subject, reviewedHead = "b".repeat(40)) {
  writeJson(join(runDir, "evidence", "backend.json"), { subject, attempt: 1, status: "pass", review_ready: true, head_sha: reviewedHead });
  writeJson(join(runDir, "reviews", "backend.json"), { subject, attempt: 1, verdict: "APPROVE", reviewed_commit: reviewedHead });
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

function exactB0m3ContinuationDispositionMap(cases) {
  const dispositions = new Map();
  for (const exactCase of cases) {
    if (dispositions.has(exactCase.name)) throw new Error(`duplicate exact B0M.3 continuation case ${exactCase.name}`);
    for (const key of ["name", "record_id", "family", "consumer", "rejector"]) {
      if (typeof exactCase[key] !== "string" || exactCase[key].length === 0) throw new Error(`exact B0M.3 continuation case requires literal ${key}`);
    }
    dispositions.set(exactCase.name, exactCase);
  }
  assert.equal(dispositions.size, 31, "exactly 31 schema-valid continuation dispositions are required");
  return dispositions;
}

async function consumeContinuationMutation(root, record, mutationCase, disposition, index) {
  const fixture = createContinuationMutationFixture(root, record.id, index);
  const childRunDir = join(fixture.repo, ".opencode", "factory", fixture.childRunId);
  try {
    if (disposition.consumer === "seedContinuationPlanningArtifacts") {
      const continuation = structuredClone(fixture.continuation);
      const actualRecord = continuationRecordAtPath(continuation, record);
      applyMutationDifference(actualRecord, record.source, mutationCase.record);
      injectContinuationExternalMutation(fixture, record, mutationCase, actualRecord);
      const parentRunBefore = readFileSync(join(fixture.parentRunDir, "run.json"));
      const parentSourcesBefore = continuationSourceSnapshot(fixture.parentRunDir, continuation, record.id);
      assert.throws(
        () => seedContinuationPlanningArtifacts(fixture.repo, fixture.parentRunDir, continuation),
        (error) => isExactNamedRejection(error, disposition.rejector),
        `${mutationCase.name} must reach ${disposition.rejector}`,
      );
      assert.equal(existsSync(childRunDir), false, `${mutationCase.name} must not publish child seed bytes`);
      assert.deepEqual(readFileSync(join(fixture.parentRunDir, "run.json")), parentRunBefore, `${mutationCase.name} protected parent run bytes`);
      assert.deepEqual(continuationSourceSnapshot(fixture.parentRunDir, continuation, record.id), parentSourcesBefore, `${mutationCase.name} protected parent source bytes`);
      return;
    }

    const seeded = seedContinuationPlanningArtifacts(fixture.repo, fixture.parentRunDir, fixture.continuation);
    if (disposition.consumer === "transitionContinuationAdoption") assert.equal(seeded.eligible, true, `${mutationCase.name} adoption fixture must seed accepted planning authority`);
    else assert.equal(seeded.eligible, false, `${mutationCase.name} authority-reader fixture must remain reuse-ineligible`);
    writeJson(join(childRunDir, "run.json"), continuationChildRun(fixture.continuation));
    const childRun = JSON.parse(readFileSync(join(childRunDir, "run.json"), "utf8"));
    const actualRecord = continuationRecordAtPath(childRun.continuation, record);
    applyMutationDifference(actualRecord, record.source, mutationCase.record);
    writeJson(join(childRunDir, "run.json"), childRun);
    injectContinuationExternalMutation(fixture, record, mutationCase, actualRecord);
    const runBefore = readFileSync(join(childRunDir, "run.json"));
    const seedBefore = childSeedSnapshot(childRunDir, seeded);

    if (disposition.consumer === "assertContinuationAuthorityCurrent") {
      assert.throws(
        () => assertContinuationAuthorityCurrent(childRunDir, childRun, { repoRoot: fixture.repo }),
        (error) => isExactNamedRejection(error, disposition.rejector),
        `${mutationCase.name} must reach ${disposition.rejector}`,
      );
    } else if (disposition.consumer === "transitionContinuationAdoption") {
      await assert.rejects(
        transitionContinuationAdoption(childRunDir, { repoRoot: fixture.repo }),
        (error) => isExactNamedRejection(error, disposition.rejector),
        `${mutationCase.name} must reach ${disposition.rejector}`,
      );
    } else {
      assert.fail(`unknown exact continuation consumer ${disposition.consumer}`);
    }
    assert.deepEqual(readFileSync(join(childRunDir, "run.json")), runBefore, `${mutationCase.name} protected child run bytes`);
    assert.deepEqual(childSeedSnapshot(childRunDir, seeded), seedBefore, `${mutationCase.name} protected child seed bytes`);
  } finally {
    rmSync(fixture.repo, { recursive: true, force: true });
  }
}

function createContinuationMutationFixture(root, recordId, index) {
  const requestedRepo = join(root, "continuation-consumers", String(index));
  initCatalogGit(requestedRepo);
  const repo = fixtureGit(requestedRepo, ["rev-parse", "--show-toplevel"]).trim();
  const parentRunId = `continuation-parent-${index}`;
  const childRunId = `continuation-child-${index}`;
  fixtureGit(repo, ["branch", parentRunId]);
  const parentRunDir = join(repo, ".opencode", "factory", parentRunId);
  for (const dir of ["artifacts", "evidence", "reviews"]) mkdirSync(join(parentRunDir, dir), { recursive: true });
  writeFileSync(join(parentRunDir, "artifacts", "story.md"), "story\n");
  writeJson(join(parentRunDir, "reviews", "reviewer.json"), createReviewRecord({ subject: parentRunId, verdict: undefined, required_fixes: undefined, summary: "needs continuation" }));
  writeJson(join(parentRunDir, "reviews", "security.json"), createReviewRecord({ subject: parentRunId, verdict: "BLOCK", summary: "security context", required_fixes: [] }));
  writeJson(join(parentRunDir, "evidence", "context.json"), { subject: "spec-writer", status: "fail" });

  const spec = recordId === "continuation-draft-reuse"
    ? { status: "rejected", verdict: "REJECT" }
    : recordId === "continuation-post-pr-binding"
      ? null
      : { status: "accepted", verdict: "APPROVE" };
  let selectedReview = "reviewer.json";
  let parentRun = createRunRecord({
    run_id: parentRunId,
    status: "blocked",
    branch: parentRunId,
    worktree: join(repo, ".opencode", "worktrees", parentRunId),
    validator: { verdict: "NO-GO", review_ref: "reviews/reviewer.json" },
    security_review: { verdict: "BLOCK", review_ref: "reviews/security.json" },
    terminal_result: { status: "blocked", run_id: parentRunId, reason: "review blocked", summary: "blocked", artifacts: {} },
  });
  if (recordId === "continuation-post-pr-binding") {
    const postPrRecord = findRecord(DURABLE_AUTHORITY_CATALOG, "post-pr-continuation-review-bound");
    parentRun = structuredClone(createPostPrCatalogBaseline(postPrRecord).run);
    parentRun.run_id = parentRunId;
    parentRun.branch = parentRunId;
    parentRun.worktree = join(repo, ".opencode", "worktrees", parentRunId);
    parentRun.terminal_result.run_id = parentRunId;
    const failureRef = parentRun.post_pr.evidence_refs.at(-1).ref;
    writeJson(join(parentRunDir, failureRef), { kind: "post-pr-failure", failed_head_sha: parentRun.post_pr.remediation.failed_head_sha, verdict: "red" });
    const failureHash = hashFileBytes(join(parentRunDir, failureRef));
    parentRun.post_pr.evidence_refs.at(-1).hash = failureHash;
    parentRun.post_pr.remediation.failure_evidence_hash = failureHash;
    selectedReview = parentRun.post_pr.continuation_review.ref;
    writeJson(join(parentRunDir, selectedReview), createReviewRecord({
      subject: parentRunId,
      verdict: "BLOCKED",
      summary: "Post-PR remediation retry budget exhausted.",
      required_fixes: ["Continue remediation on a fresh PR."],
      head_sha: parentRun.post_pr.remediation.failed_head_sha,
    }));
    parentRun.post_pr.continuation_review.hash = hashFileBytes(join(parentRunDir, selectedReview));
  } else if (spec) {
    writeFileSync(join(parentRunDir, "artifacts", "technical-brief.md"), "brief\n");
    writeJson(join(parentRunDir, "reviews", "spec-writer.json"), createReviewRecord({ subject: "spec-writer", verdict: spec.verdict, summary: "spec review", required_fixes: [] }));
    const step = { agent: "spec-writer", status: spec.status, attempts: 1, artifact_ref: "artifacts/technical-brief.md", review_ref: "reviews/spec-writer.json", evidence_ref: "evidence/context.json" };
    if (spec.status === "accepted") {
      step.acceptance = {
        artifact_ref: "artifacts/technical-brief.md",
        artifact_hash: hashFileBytes(join(parentRunDir, "artifacts", "technical-brief.md")),
        review_ref: "reviews/spec-writer.json",
        review_hash: hashFileBytes(join(parentRunDir, "reviews", "spec-writer.json")),
      };
    }
    parentRun.steps = [step];
  } else {
    parentRun.steps = [{ agent: "context-reader", status: "blocked", attempts: 1, evidence_ref: "evidence/context.json" }];
  }
  writeJson(join(parentRunDir, "run.json"), parentRun);
  const { payload } = continueFactory(parentRunId, {
    cwd: repo,
    review: selectedReview,
    runId: childRunId,
    dryRun: true,
    newPr: recordId === "continuation-post-pr-binding",
    now: "2026-07-16T12:00:00.000Z",
  });
  return { repo, parentRunDir, parentRunId, childRunId, continuation: payload.continuation };
}

function continuationChildRun(continuation) {
  return createRunRecord({
    run_id: continuation.target.run_id,
    branch: continuation.target.branch,
    worktree: continuation.target.worktree,
    ...(continuation.draft_spec_reuse ? { max_retries: continuation.draft_spec_reuse.max_retries } : {}),
    continuation,
  });
}

function continuationRecordAtPath(continuation, record) {
  if (record.id === "continuation-parent-review-sidecar") {
    const contextualReview = continuation.parent_reviews.find(({ ref }) => ref !== continuation.review.ref && ref !== continuation.planning_reuse?.spec_review_ref);
    assert.ok(contextualReview, "continuation parent-review mutation requires a non-selected contextual review");
    return contextualReview;
  }
  const { canonicalPath, source } = record;
  if (canonicalPath.length === 1) return continuation;
  let current = continuation;
  for (const segment of canonicalPath.slice(1, -1)) current = current[segment];
  const key = canonicalPath.at(-1);
  if (current[key] === undefined) current[key] = structuredClone(source);
  return current[key];
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

function injectContinuationExternalMutation(fixture, record, mutationCase, actualRecord) {
  const externalSources = record.externalSources ?? {};
  const changed = Object.keys(externalSources).filter((key) => JSON.stringify(externalSources[key]) !== JSON.stringify(mutationCase.externalSources[key]));
  if (changed.length === 0) return;
  assert.equal(changed.length, 1, `${mutationCase.name} must mutate exactly one external source`);
  const externalKey = changed[0];
  let ref;
  if (record.id === "continuation-parent-binding" && externalKey === "parent-run") {
    const parentFile = join(fixture.parentRunDir, "run.json");
    writeFileSync(parentFile, `${readFileSync(parentFile, "utf8")} `);
    return;
  }
  if (record.id === "continuation-selected-review" && externalKey === "selected-review") ref = fixture.continuation.review.ref;
  else if (record.id === "continuation-planning-reuse-eligible" && externalKey === "review") ref = fixture.continuation.planning_reuse.spec_review_ref;
  else if (record.id === "continuation-planning-reuse-eligible" && externalKey === "artifact") ref = fixture.continuation.planning_reuse.spec_artifact_ref;
  else if (record.id === "continuation-draft-reuse" && externalKey === "draft") ref = fixture.continuation.draft_spec_reuse.artifact_ref;
  else if (["continuation-parent-artifact-sidecar", "continuation-parent-evidence-sidecar", "continuation-parent-review-sidecar"].includes(record.id)) ref = actualRecord.ref;
  else if (record.id === "continuation-post-pr-binding" && externalKey === "evidence") ref = actualRecord.evidence_ref;
  else if (record.id === "continuation-post-pr-binding" && externalKey === "review") ref = actualRecord.continuation_review_ref;
  else throw new Error(`no external mutation injector for ${record.id}/${externalKey}`);
  writeFileSync(join(fixture.parentRunDir, ref), `tampered bytes for ${mutationCase.name}\n`);
}

function childSeedSnapshot(childRunDir, seeded) {
  const refs = [...seeded.artifacts, ...(seeded.spec_review_ref ? [seeded.spec_review_ref] : [])].sort();
  return Object.fromEntries(refs.map((ref) => [ref, readFileSync(join(childRunDir, ref))]));
}

function continuationSourceSnapshot(parentRunDir, continuation, recordId) {
  const refs = recordId === "continuation-draft-reuse" ? [continuation.draft_spec_reuse.artifact_ref] : [];
  return Object.fromEntries(refs.map((ref) => [ref, readFileSync(join(parentRunDir, ref))]));
}

function hashFileBytes(file) {
  return `sha256:${createHash("sha256").update(readFileSync(file)).digest("hex")}`;
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
  if (scenario === "post-pr") {
    const control = createPrerequisitePostPrFixture(record, mutationCase, false);
    try {
      const result = await transitionPostPrState(control.runDir, control.next.post_pr, { worktree: control.repo, now: "2026-07-16T12:06:00.000Z" });
      assert.deepEqual(result.run.post_pr, control.next.post_pr, `${expected.name} canonical control`);
    } finally { rmSync(control.repo, { recursive: true, force: true }); }
    const mutated = createPrerequisitePostPrFixture(record, mutationCase, true);
    try {
      const before = readFileSync(join(mutated.runDir, "run.json"), "utf8");
      await assertExactB0M4Rejection(transitionPostPrState(mutated.runDir, mutated.next.post_pr, { worktree: mutated.repo, now: "2026-07-16T12:06:00.000Z" }), expected);
      assert.equal(readFileSync(join(mutated.runDir, "run.json"), "utf8"), before, `${expected.name} protected bytes`);
    } finally { rmSync(mutated.repo, { recursive: true, force: true }); }
    return;
  }
  const control = await createPrerequisiteRepairFixture(scenario);
  try {
    const result = await advancePrerequisiteRepairFixture(control, scenario);
    assert.equal(result.updated, true, `${expected.name} canonical control`);
  } finally { rmSync(control.repo, { recursive: true, force: true }); }
  const mutated = await createPrerequisiteRepairFixture(scenario);
  try {
    mutatePrerequisiteRepairAuthority(mutated, scenario);
    const before = readFileSync(join(mutated.runDir, "run.json"), "utf8");
    await assertExactB0M4Rejection(advancePrerequisiteRepairFixture(mutated, scenario), expected);
    assert.equal(readFileSync(join(mutated.runDir, "run.json"), "utf8"), before, `${expected.name} protected bytes`);
    assert.deepEqual(mergedSliceRepairFence(JSON.parse(before)), mutated.mutatedFence, `${expected.name} repair fence`);
  } finally { rmSync(mutated.repo, { recursive: true, force: true }); }
}

function createPrerequisitePostPrFixture(record, mutationCase, mutated) {
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

async function createPrerequisiteRepairFixture(scenario) {
  const fixture = createRepairTransitionFixture();
  await transitionRepairReport(fixture);
  if (scenario === "repair-reported") return fixture;
  await transitionMergedSliceRepair(fixture.runDir, { status: "repairing", attempts: 1 }, { repoRoot: fixture.repo });
  fixture.repairHead = commitTransitionRepair(fixture, scenario);
  fixture.reviewVerdict = scenario.startsWith("repair-review-reject") ? "REJECT" : "APPROVE";
  writeTransitionReview(fixture, fixture.reviewVerdict, fixture.repairHead);
  if (scenario !== "repair-repairing") await transitionRepairReview(fixture, fixture.repairHead);
  return fixture;
}

function advancePrerequisiteRepairFixture(fixture, scenario) {
  if (scenario === "repair-reported") return transitionMergedSliceRepair(fixture.runDir, { status: "repairing", attempts: 1 }, { repoRoot: fixture.repo });
  if (scenario === "repair-repairing") return transitionRepairReview(fixture, fixture.repairHead);
  if (scenario.startsWith("repair-review-approve")) {
    writeJson(join(fixture.runDir, "evidence", "verification-pass.json"), { subject: "consumer", status: "pass" });
    return transitionMergedSliceRepair(fixture.runDir, { status: "merged", merge_commit: fixture.repairHead, verification_ref: "evidence/verification-pass.json" }, { repoRoot: fixture.repo });
  }
  return transitionMergedSliceRepair(fixture.runDir, { status: "repairing", attempts: 2 }, { repoRoot: fixture.repo });
}

function mutatePrerequisiteRepairAuthority(fixture, scenario) {
  const runPath = join(fixture.runDir, "run.json");
  const run = JSON.parse(readFileSync(runPath, "utf8"));
  const repair = run.merged_slice_repair;
  if (scenario === "repair-reported") repair.attempts = 1;
  else if (scenario === "repair-repairing" || scenario.endsWith("baseline")) repair.baseline_commit = fixture.repairHead;
  else if (scenario.endsWith("reviewed")) repair.reviewed_commit = repair.baseline_commit;
  writeJson(runPath, run);
  fixture.mutatedFence = structuredClone(mergedSliceRepairFence(run));
}

async function assertExactB0M4Rejection(promise, expected) {
  const [, errorName, errorMessage] = expected.rejector.split(" :: ");
  await assert.rejects(promise, (error) => error.name === errorName && error.message === errorMessage, `${expected.name} must reach ${expected.rejector}`);
}

function repairProbeRequest(repair) {
  if (repair.status === "reported") return { status: "repairing", attempts: repair.attempts + 1 };
  if (repair.status === "repairing") return { status: "review", review_ref: "reviews/repair.json", repair_evidence_ref: "evidence/repair.json", reviewed_commit: "b".repeat(40) };
  if (repair.status === "review") return { status: "review", review_ref: repair.review_ref, repair_evidence_ref: repair.repair_evidence_ref, reviewed_commit: repair.reviewed_commit };
  return { status: "blocked", reason: "terminal repair mutation probe" };
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
