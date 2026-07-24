import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { canonicalGithubRepositoryFromOrigin } from "../github.js";
import { git } from "../git.js";
import { requireNonEmptyString } from "../utils.js";

const FULL_COMMIT_PATTERN = /^[0-9a-f]{40}$/u;
const ORIGIN_MAIN_REF = "refs/heads/main";
const TEMPORARY_REF_ROOT = "refs/opencode/base-advance-origin/";
const FAILURE = Object.freeze({
  GIT_STATE_INVALID: "BASE_ADVANCE_GIT_STATE_INVALID",
  NON_FAST_FORWARD: "BASE_ADVANCE_NON_FAST_FORWARD",
  ORIGIN_AMBIGUOUS: "BASE_ADVANCE_ORIGIN_AMBIGUOUS",
  ORIGIN_UNAVAILABLE: "BASE_ADVANCE_ORIGIN_UNAVAILABLE",
  TARGET_MOVED: "BASE_ADVANCE_TARGET_MOVED",
  TEMP_REF_CLEANUP_FAILED: "BASE_ADVANCE_TEMP_REF_CLEANUP_FAILED",
});

/**
 * Hold a fresh, private observation of canonical origin/main while `consume`
 * performs its checked operation. The remote advertisement is checked both
 * before and after the consumer, and the temporary ref is removed by exact
 * object-id compare-and-swap before this function returns.
 */
export async function withCanonicalOriginMain(repo, recordedBase, consume, options = {}) {
  const repositoryRoot = resolve(requireNonEmptyString(repo, "repository"));
  const baseCommit = requireFullCommit(recordedBase, "recorded base commit");
  if (typeof consume !== "function") throw new Error("canonical origin consumer must be a function");

  const gitOptions = options.gitOptions || {};
  requireLocalCommit(repositoryRoot, baseCommit, gitOptions);
  const origin = readCanonicalOrigin(repositoryRoot, gitOptions);
  const temporaryRef = `${TEMPORARY_REF_ROOT}${randomUUID()}`;
  let temporaryRefWasAbsent = false;
  let ownedOid = null;
  let result;
  let caughtFailure = null;

  try {
    const validRef = git(repositoryRoot, ["check-ref-format", temporaryRef], gitOptions);
    if (!validRef.ok) throw failure(FAILURE.GIT_STATE_INVALID, "canonical origin temporary ref is invalid");
    const initialRef = inspectTemporaryRef(repositoryRoot, temporaryRef, gitOptions, FAILURE.ORIGIN_AMBIGUOUS);
    if (initialRef.exists) throw failure(FAILURE.ORIGIN_AMBIGUOUS, "canonical origin temporary ref is not initially absent");
    temporaryRefWasAbsent = true;

    const fetched = git(repositoryRoot, [
      "fetch", "--no-tags", "--no-recurse-submodules", "--no-write-fetch-head", "--refmap=", "--force",
      "origin", `+${ORIGIN_MAIN_REF}:${temporaryRef}`,
    ], gitOptions);
    if (!fetched.ok) {
      throw failure(FAILURE.ORIGIN_UNAVAILABLE, "canonical origin/main fetch is unavailable");
    }

    ownedOid = resolveCommit(repositoryRoot, temporaryRef, "fetched canonical origin/main", gitOptions, FAILURE.ORIGIN_AMBIGUOUS);
    await options.afterFetch?.({
      origin: origin.url,
      repository: origin.repository,
      ref: ORIGIN_MAIN_REF,
      commit: ownedOid,
      temporary_ref: temporaryRef,
    });

    const advertised = exactAdvertisedOriginMain(repositoryRoot, gitOptions);
    if (advertised !== ownedOid) throw failure(FAILURE.ORIGIN_AMBIGUOUS, "canonical origin/main fetch and advertisement disagree");
    const ancestor = git(repositoryRoot, ["merge-base", "--is-ancestor", baseCommit, ownedOid], gitOptions);
    if (!ancestor.ok && ancestor.status === 1) {
      throw failure(FAILURE.NON_FAST_FORWARD, "recorded base commit is not an ancestor of canonical origin/main");
    }
    if (!ancestor.ok) throw failure(FAILURE.GIT_STATE_INVALID, "canonical origin ancestry could not be verified");

    const observation = Object.freeze({
      origin: origin.url,
      repository: origin.repository,
      ref: ORIGIN_MAIN_REF,
      commit: ownedOid,
      recorded_base: baseCommit,
      temporary_ref: temporaryRef,
    });
    result = await consume(observation);

    await options.beforeFinalAdvertisement?.(observation);
    const finalAdvertised = exactAdvertisedOriginMain(repositoryRoot, gitOptions);
    if (finalAdvertised !== ownedOid) {
      throw failure(FAILURE.TARGET_MOVED, "canonical origin/main moved before the checked operation completed");
    }
  } catch (error) {
    caughtFailure = error;
  }

  const cleanupFailure = temporaryRefWasAbsent
    ? cleanupOwnedTemporaryRef(repositoryRoot, temporaryRef, ownedOid, gitOptions)
    : null;
  if (cleanupFailure) throw cleanupFailure;
  if (caughtFailure) throw caughtFailure;
  return result;
}

/** Return one fresh observation after all stability and cleanup checks pass. */
export function observeCanonicalOriginMain(repo, recordedBase, options = {}) {
  return withCanonicalOriginMain(repo, recordedBase, (observation) => observation, options);
}

function readCanonicalOrigin(repo, gitOptions) {
  const configured = git(repo, ["config", "--get-all", "remote.origin.url"], gitOptions);
  if (!configured.ok) throw failure(FAILURE.ORIGIN_UNAVAILABLE, "canonical Git origin is unavailable");
  const match = /^([^\r\n]+)\n$/u.exec(configured.stdout);
  if (!match || match[1] !== match[1].trim()) {
    throw failure(FAILURE.ORIGIN_AMBIGUOUS, "base advancement requires exactly one canonical GitHub origin");
  }
  let repository;
  try {
    repository = canonicalGithubRepositoryFromOrigin(match[1]);
  } catch {
    throw failure(FAILURE.ORIGIN_AMBIGUOUS, "base advancement requires exactly one canonical GitHub origin");
  }
  return {
    url: match[1],
    repository,
  };
}

function exactAdvertisedOriginMain(repo, gitOptions) {
  const advertised = git(repo, ["ls-remote", "--exit-code", "--refs", "origin", ORIGIN_MAIN_REF], gitOptions);
  if (!advertised.ok) throw failure(FAILURE.ORIGIN_UNAVAILABLE, "canonical origin/main advertisement is unavailable");
  const match = /^([0-9a-f]{40})\trefs\/heads\/main\n$/u.exec(advertised.stdout);
  if (!match) throw failure(FAILURE.ORIGIN_AMBIGUOUS, "canonical origin/main advertisement is ambiguous");
  return match[1];
}

function cleanupOwnedTemporaryRef(repo, temporaryRef, ownedOid, gitOptions) {
  let current;
  try {
    current = inspectTemporaryRef(repo, temporaryRef, gitOptions, FAILURE.TEMP_REF_CLEANUP_FAILED);
  } catch (error) {
    return error;
  }
  if (!current.exists) return ownedOid === null ? null : failure(FAILURE.TEMP_REF_CLEANUP_FAILED, "canonical origin temporary ref disappeared before cleanup");
  if (ownedOid === null || current.oid !== ownedOid) {
    return failure(FAILURE.TEMP_REF_CLEANUP_FAILED, "canonical origin temporary ref changed and cannot be cleaned safely");
  }
  const removed = git(repo, ["update-ref", "-d", temporaryRef, ownedOid], gitOptions);
  if (!removed.ok) return failure(FAILURE.TEMP_REF_CLEANUP_FAILED, "canonical origin temporary ref could not be cleaned safely");
  let remaining;
  try {
    remaining = inspectTemporaryRef(repo, temporaryRef, gitOptions, FAILURE.TEMP_REF_CLEANUP_FAILED);
  } catch (error) {
    return error;
  }
  if (remaining.exists) return failure(FAILURE.TEMP_REF_CLEANUP_FAILED, "canonical origin temporary ref remained after cleanup");
  return null;
}

function resolveCommit(repo, ref, label, gitOptions, code = FAILURE.GIT_STATE_INVALID) {
  const resolved = git(repo, ["rev-parse", "--verify", `${ref}^{commit}`], gitOptions);
  const match = resolved.ok ? /^([0-9a-f]{40})\n$/u.exec(resolved.stdout) : null;
  if (!match) throw failure(code, `${label} did not resolve to one full commit`);
  return match[1];
}

function requireLocalCommit(repo, commit, gitOptions) {
  const resolved = resolveCommit(repo, commit, "recorded base commit", gitOptions, FAILURE.GIT_STATE_INVALID);
  if (resolved !== commit) throw failure(FAILURE.GIT_STATE_INVALID, "recorded base commit identity is invalid");
}

function requireFullCommit(value, label) {
  let commit;
  try {
    commit = requireNonEmptyString(value, label);
  } catch {
    throw failure(FAILURE.GIT_STATE_INVALID, `${label} must be a full lowercase commit id`);
  }
  if (!FULL_COMMIT_PATTERN.test(commit)) throw failure(FAILURE.GIT_STATE_INVALID, `${label} must be a full lowercase commit id`);
  return commit;
}

function inspectTemporaryRef(repo, ref, gitOptions, failureCode) {
  const inspected = git(repo, ["show-ref", "--verify", "--quiet", ref], gitOptions);
  if (!inspected.ok && inspected.status === 1) return { exists: false, oid: null };
  if (!inspected.ok) throw failure(failureCode, "canonical origin temporary ref identity could not be verified");
  return { exists: true, oid: resolveCommit(repo, ref, "canonical origin temporary ref", gitOptions, failureCode) };
}

function failure(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}
