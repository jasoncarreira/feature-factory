import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { canonicalGithubRepositoryFromOrigin } from "../github.js";
import { git } from "../git.js";
import { requireNonEmptyString } from "../utils.js";

const FULL_COMMIT_PATTERN = /^[0-9a-f]{40}$/u;
const ORIGIN_MAIN_REF = "refs/heads/main";
const TEMPORARY_REF_ROOT = "refs/opencode/base-advance-origin/";

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
  const origin = readCanonicalOrigin(repositoryRoot, gitOptions);
  const temporaryRef = `${TEMPORARY_REF_ROOT}${randomUUID()}`;
  let ownedOid = null;
  let result;
  let failure = null;

  try {
    const validRef = git(repositoryRoot, ["check-ref-format", temporaryRef], gitOptions);
    if (!validRef.ok) throw new Error("canonical origin temporary ref is invalid");
    const absent = git(repositoryRoot, ["rev-parse", "--verify", temporaryRef], gitOptions);
    if (absent.ok) throw new Error("canonical origin temporary ref already exists");

    const fetched = git(repositoryRoot, [
      "fetch", "--no-tags", "--no-recurse-submodules", "--no-write-fetch-head", "--refmap=", "--force",
      "origin", `+${ORIGIN_MAIN_REF}:${temporaryRef}`,
    ], gitOptions);
    if (!fetched.ok) {
      ownedOid = tryResolveCommit(repositoryRoot, temporaryRef, gitOptions);
      throw new Error(`canonical origin/main fetch failed: ${gitFailure(fetched)}`);
    }

    ownedOid = resolveCommit(repositoryRoot, temporaryRef, "fetched canonical origin/main", gitOptions);
    await options.afterFetch?.({
      origin: origin.url,
      repository: origin.repository,
      ref: ORIGIN_MAIN_REF,
      commit: ownedOid,
      temporary_ref: temporaryRef,
    });

    const advertised = exactAdvertisedOriginMain(repositoryRoot, gitOptions);
    if (advertised !== ownedOid) throw new Error("canonical origin/main changed during fresh observation");
    const ancestor = git(repositoryRoot, ["merge-base", "--is-ancestor", baseCommit, ownedOid], gitOptions);
    if (!ancestor.ok) throw new Error("recorded base commit is not an ancestor of canonical origin/main");

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
    if (finalAdvertised !== ownedOid) throw new Error("canonical origin/main moved before the checked operation completed");
  } catch (error) {
    failure = error;
  }

  const cleanupFailure = cleanupOwnedTemporaryRef(repositoryRoot, temporaryRef, ownedOid, gitOptions);
  if (cleanupFailure) throw cleanupFailure;
  if (failure) throw failure;
  return result;
}

/** Return one fresh observation after all stability and cleanup checks pass. */
export function observeCanonicalOriginMain(repo, recordedBase, options = {}) {
  return withCanonicalOriginMain(repo, recordedBase, (observation) => observation, options);
}

function readCanonicalOrigin(repo, gitOptions) {
  const configured = git(repo, ["config", "--get-all", "remote.origin.url"], gitOptions);
  const urls = configured.ok ? configured.stdout.split(/\r?\n/u).filter((line) => line !== "") : [];
  if (urls.length !== 1 || urls[0] !== urls[0].trim()) {
    throw new Error("base advancement requires exactly one canonical GitHub origin");
  }
  return {
    url: urls[0],
    repository: canonicalGithubRepositoryFromOrigin(urls[0]),
  };
}

function exactAdvertisedOriginMain(repo, gitOptions) {
  const advertised = git(repo, ["ls-remote", "--exit-code", "--refs", "origin", ORIGIN_MAIN_REF], gitOptions);
  const lines = advertised.ok ? advertised.stdout.trimEnd().split("\n").filter(Boolean) : [];
  const match = lines.length === 1 ? /^([0-9a-f]{40})\t([^\t\r\n]+)$/u.exec(lines[0]) : null;
  if (!match || match[2] !== ORIGIN_MAIN_REF) {
    throw new Error("canonical origin/main advertisement is unavailable or ambiguous");
  }
  return match[1];
}

function cleanupOwnedTemporaryRef(repo, temporaryRef, ownedOid, gitOptions) {
  const current = git(repo, ["rev-parse", "--verify", temporaryRef], gitOptions);
  if (!current.ok) {
    return ownedOid === null ? null : new Error("canonical origin temporary ref disappeared before cleanup");
  }
  const currentOid = current.stdout.trim();
  if (!FULL_COMMIT_PATTERN.test(currentOid) || ownedOid === null || currentOid !== ownedOid) {
    return new Error("canonical origin temporary ref changed and cannot be cleaned safely");
  }
  const removed = git(repo, ["update-ref", "-d", temporaryRef, ownedOid], gitOptions);
  if (!removed.ok) return new Error("canonical origin temporary ref could not be cleaned safely");
  const remaining = git(repo, ["rev-parse", "--verify", temporaryRef], gitOptions);
  if (remaining.ok) return new Error("canonical origin temporary ref remained after cleanup");
  return null;
}

function resolveCommit(repo, ref, label, gitOptions) {
  const resolved = git(repo, ["rev-parse", "--verify", `${ref}^{commit}`], gitOptions);
  const oid = resolved.stdout.trim();
  if (!resolved.ok || !FULL_COMMIT_PATTERN.test(oid)) throw new Error(`${label} did not resolve to one full commit`);
  return oid;
}

function tryResolveCommit(repo, ref, gitOptions) {
  const resolved = git(repo, ["rev-parse", "--verify", `${ref}^{commit}`], gitOptions);
  const oid = resolved.stdout.trim();
  return resolved.ok && FULL_COMMIT_PATTERN.test(oid) ? oid : null;
}

function requireFullCommit(value, label) {
  const commit = requireNonEmptyString(value, label);
  if (!FULL_COMMIT_PATTERN.test(commit)) throw new Error(`${label} must be a full lowercase commit id`);
  return commit;
}

function gitFailure(result) {
  return String(result?.stderr || result?.stdout || "unknown Git error").trim();
}
