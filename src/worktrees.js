import { createHash, randomUUID } from "node:crypto";
import { existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { git } from "./git.js";
import { assertContainedPath, physicalPath, requireNonEmptyString } from "./utils.js";

const FULL_COMMIT_PATTERN = /^[0-9a-f]{40}$/u;
const IN_PROGRESS_GIT_PATHS = Object.freeze([
  "MERGE_HEAD",
  "CHERRY_PICK_HEAD",
  "REVERT_HEAD",
  "REBASE_HEAD",
  "rebase-merge",
  "rebase-apply",
  "sequencer",
  "BISECT_LOG",
]);

export function parseWorktreeListPorcelain(stdout) {
  const entries = [];
  let current = null;
  for (const line of String(stdout || "").split(/\r?\n/u)) {
    if (!line) continue;
    if (line.startsWith("worktree ")) {
      if (current) entries.push(current);
      current = { path: line.slice("worktree ".length), branch: null, head: null, bare: false, detached: false };
      continue;
    }
    if (!current) continue;
    if (line.startsWith("HEAD ")) current.head = line.slice("HEAD ".length);
    if (line.startsWith("branch refs/heads/")) current.branch = line.slice("branch refs/heads/".length);
    if (line === "bare") current.bare = true;
    if (line === "detached") current.detached = true;
  }
  if (current) entries.push(current);
  return entries;
}

export function checkWorktreeIdentity(repo, worktree, expected = {}, options = {}) {
  const physicalWorktree = physicalPath(worktree);
  if (!existsSync(physicalWorktree) || !statSync(physicalWorktree).isDirectory()) {
    return { ok: false, reason: "missing-worktree", worktree: physicalWorktree };
  }
  const result = git(repo, ["worktree", "list", "--porcelain"], options);
  if (!result.ok) return { ok: false, reason: result.stderr || "git worktree list failed", worktree: physicalWorktree };
  const entries = parseWorktreeListPorcelain(result.stdout);
  const entry = entries.find((item) => physicalPath(item.path) === physicalWorktree) || null;
  if (!entry) return { ok: false, reason: "not-a-registered-worktree", worktree: physicalWorktree };
  if (expected.branch && entry.branch !== expected.branch) {
    return { ok: false, reason: `branch-mismatch:${entry.branch || "detached"}`, worktree: physicalWorktree, entry };
  }
  if (expected.head && entry.head !== expected.head) {
    return { ok: false, reason: `head-mismatch:${entry.head || "missing"}`, worktree: physicalWorktree, entry };
  }
  return { ok: true, worktree: physicalWorktree, entry };
}

/**
 * Observe the exact registered integration worktree identity used by a checked
 * transition. Unlike the lightweight identity predicate above, this rejects
 * dirty state, in-progress Git operations, duplicate registrations, and any
 * path outside the repository's factory-owned worktree root.
 */
export function observeRegisteredWorktree(repo, worktree, expected = {}, options = {}) {
  const repository = physicalPath(repo, "repository", { mustExist: true });
  const worktreeRoot = physicalPath(options.worktreeRoot || join(repository, ".opencode", "worktrees"), "worktree root", { mustExist: true });
  const target = physicalPath(worktree, "worktree", { mustExist: true });
  assertContainedPath(repository, worktreeRoot, "worktree root", { allowEqual: false });
  assertContainedPath(worktreeRoot, target, "registered worktree", { allowEqual: false });

  const branch = requireNonEmptyString(expected.branch, "expected worktree branch");
  const head = requireNonEmptyString(expected.head, "expected worktree head");
  if (!FULL_COMMIT_PATTERN.test(head)) throw new Error("expected worktree head must be a full lowercase commit id");
  const validBranch = git(repository, ["check-ref-format", "--branch", branch], options);
  if (!validBranch.ok) throw new Error("expected worktree branch is invalid");

  const listed = git(repository, ["worktree", "list", "--porcelain"], options);
  if (!listed.ok) throw new Error(`registered worktree list failed: ${(listed.stderr || listed.stdout || "unknown Git error").trim()}`);
  const matches = parseWorktreeListPorcelain(listed.stdout).filter((entry) => physicalPath(entry.path) === target);
  if (matches.length !== 1) throw new Error("worktree must have exactly one physical registration");
  const entry = matches[0];
  if (entry.bare || entry.detached || entry.branch !== branch) throw new Error("registered worktree is not attached to the expected branch");
  if (entry.head !== head) throw new Error("registered worktree HEAD does not equal the expected commit");

  const symbolicHead = git(target, ["symbolic-ref", "--quiet", "HEAD"], options);
  if (!symbolicHead.ok || symbolicHead.stdout.trim() !== `refs/heads/${branch}`) {
    throw new Error("worktree HEAD is not attached to the expected branch");
  }
  const branchHead = resolveWorktreeCommit(target, `refs/heads/${branch}`, "worktree branch", options);
  const worktreeHead = resolveWorktreeCommit(target, "HEAD", "worktree HEAD", options);
  if (branchHead !== head || worktreeHead !== head || branchHead !== worktreeHead) {
    throw new Error("registered branch and worktree HEAD do not equal the expected commit");
  }

  const status = git(target, ["status", "--porcelain=v1", "-z", "--untracked-files=all"], options);
  if (!status.ok) throw new Error(`worktree cleanliness could not be observed: ${(status.stderr || status.stdout || "unknown Git error").trim()}`);
  if (status.stdout !== "") throw new Error("registered worktree is dirty");

  for (const operationPath of IN_PROGRESS_GIT_PATHS) {
    const resolvedPath = git(target, ["rev-parse", "--path-format=absolute", "--git-path", operationPath], options);
    const path = resolvedPath.stdout.trim();
    if (!resolvedPath.ok || !isAbsolute(path)) throw new Error("worktree Git operation state could not be observed");
    if (existsSync(path)) throw new Error(`registered worktree has an in-progress Git operation: ${operationPath}`);
  }

  return Object.freeze({
    repository,
    worktree: target,
    worktree_root: worktreeRoot,
    branch,
    head,
  });
}

export function createOrRecoverWorktree(repo, worktree, expected = {}, options = {}) {
  const repository = resolve(requireNonEmptyString(repo, "repo"));
  const target = resolve(requireNonEmptyString(worktree, "worktree"));
  const branch = requireNonEmptyString(expected.branch, "expected branch");
  const head = requireNonEmptyString(expected.head, "expected head");
  const claimOid = requireNonEmptyString(expected.claim, "expected claim oid");
  if (!/^[a-f0-9]{40}$/u.test(head)) throw new Error("expected worktree head must be a full lowercase commit id");
  if (!/^[a-f0-9]{40}$/u.test(claimOid)) throw new Error("expected worktree claim oid must be a full lowercase object id");
  const root = resolve(repository, ".opencode", "worktrees");
  const targetRelative = relative(root, target);
  if (!targetRelative || targetRelative === ".." || targetRelative.startsWith("../") || isAbsolute(targetRelative)) {
    throw new Error(`continuation worktree must stay under ${root}`);
  }

  mkdirSync(root, { recursive: true });
  const rootEntry = lstatSync(root);
  if (rootEntry.isSymbolicLink() || !rootEntry.isDirectory()) throw new Error(`continuation worktree root is unsafe: ${root}`);
  const reservationPath = `${target}.continuation-reservation`;
  const expectedReservation = { root, target, branch, head, claimOid, reservationPath };
  const existing = inspectTarget(target);
  if (existing.exists) {
    const exact = exactWorktreeOrThrow(repository, target, branch, head, options, true);
    const reservation = readReservationIfPresent(expectedReservation, { ownedPath: target });
    if (reservation) removeOwnedReservation(reservation);
    return exact;
  }

  const reservation = acquireReservation(expectedReservation);
  if (typeof options.afterReserve === "function") options.afterReserve({ reservationPath, reservation: reservation.record });
  if (typeof options.beforeAdd === "function") options.beforeAdd({ repo: repository, worktree: target, branch, head });
  if (inspectTarget(target).exists) {
    releaseUnusedReservation(repository, reservation, options);
    throw new Error(`continuation worktree target appeared after reservation and will not be adopted: ${target}`);
  }

  let stagingIdentity = checkWorktreeIdentity(repository, reservation.record.staging, { branch, head }, options);
  if (!stagingIdentity.ok) {
    if (stagingIdentity.reason !== "not-a-registered-worktree") {
      throw new Error(`continuation reserved staging worktree conflicts with expected branch/head: ${stagingIdentity.reason}`);
    }
    assertReservationOwnedPath(reservation, reservation.record.staging);
    const added = git(repository, ["worktree", "add", reservation.record.staging, branch], { timeout: 30000, ...options });
    if (!added.ok) throw new Error(`continuation worktree add failed: ${(added.stderr || added.stdout || "unknown git error").trim()}`);
    stagingIdentity = checkWorktreeIdentity(repository, reservation.record.staging, { branch, head }, options);
    if (!stagingIdentity.ok) throw new Error(`continuation worktree add produced an invalid registered staging worktree: ${stagingIdentity.reason}`);
    if (typeof options.afterAdd === "function") options.afterAdd({ reservationPath, reservation: reservation.record });
  }

  if (inspectTarget(target).exists) throw new Error(`continuation worktree target exists and will not be overwritten: ${target}`);
  if (typeof options.beforeMove === "function") options.beforeMove({ reservationPath, reservation: reservation.record });
  const moved = git(repository, ["worktree", "move", reservation.record.staging, target], { timeout: 30000, ...options });
  if (!moved.ok) {
    const racedTarget = inspectTarget(target);
    if (!racedTarget.exists) throw new Error(`continuation worktree move failed: ${(moved.stderr || moved.stdout || "unknown git error").trim()}`);
    exactWorktreeOrThrow(repository, target, branch, head, options, true);
  }
  if (typeof options.afterMove === "function") options.afterMove({ reservationPath, reservation: reservation.record });
  const final = exactWorktreeOrThrow(repository, target, branch, head, options, reservation.created === false);
  assertReservationOwnedPath(reservation, target);
  removeOwnedReservation(reservation);
  return final;
}

export function deriveExpectedWorktreePath(repo, branch) {
  const branchName = requireNonEmptyString(branch, "branch");
  const root = resolve(repo, ".opencode", "worktrees");
  const slug = branchName.replace(/[\\/]+/gu, "-");
  const candidate = resolve(root, slug);
  if (!existsSync(candidate)) return candidate;
  const identity = checkWorktreeIdentity(repo, candidate, { branch: branchName });
  if (identity.ok) return candidate;
  return resolve(root, `${slug}-${shortHash(branchName)}`);
}

function shortHash(value) {
  return createHash("sha256").update(value).digest("hex").slice(0, 8);
}

function resolveWorktreeCommit(worktree, ref, label, options) {
  const resolved = git(worktree, ["rev-parse", "--verify", `${ref}^{commit}`], options);
  const oid = resolved.stdout.trim();
  if (!resolved.ok || !FULL_COMMIT_PATTERN.test(oid)) throw new Error(`${label} did not resolve to one full commit`);
  return oid;
}

function inspectTarget(target) {
  try {
    const entry = lstatSync(target);
    if (entry.isSymbolicLink() || !entry.isDirectory()) throw new Error(`continuation worktree path exists but is unsafe: ${target}`);
    return { exists: true };
  } catch (error) {
    if (error?.code === "ENOENT") return { exists: false };
    throw error;
  }
}

function exactWorktreeOrThrow(repo, target, branch, head, options, recovered) {
  const identity = checkWorktreeIdentity(repo, target, { branch, head }, options);
  if (!identity.ok) throw new Error(`continuation worktree conflicts with expected branch/head: ${identity.reason}`);
  const observedHead = git(target, ["rev-parse", "--verify", "HEAD^{commit}"], options);
  if (!observedHead.ok || observedHead.stdout.trim() !== head) {
    throw new Error("continuation worktree HEAD does not equal the registered start commit");
  }
  return { worktree: identity.worktree, recovered, entry: identity.entry };
}

function acquireReservation(expected) {
  const existing = readReservationIfPresent(expected);
  if (existing) return { ...existing, created: false };

  const staging = mkdtempSync(join(expected.root, `.continuation-stage-${shortHash(`${expected.target}\0${expected.claimOid}`)}-`));
  const stagingEntry = lstatSync(staging);
  if (stagingEntry.isSymbolicLink() || !stagingEntry.isDirectory()) throw new Error("continuation reservation staging path is unsafe");
  const record = {
    schema_version: 1,
    kind: "continuation-worktree-reservation",
    claim_oid: expected.claimOid,
    target: expected.target,
    branch: expected.branch,
    head: expected.head,
    staging,
    staging_dev: String(stagingEntry.dev),
    staging_ino: String(stagingEntry.ino),
  };
  const bytes = canonicalJson(record);
  const temporary = `${expected.reservationPath}.tmp-${randomUUID()}`;
  writeFileSync(temporary, bytes, { encoding: "utf8", flag: "wx", mode: 0o600 });
  try {
    linkSync(temporary, expected.reservationPath);
  } catch (error) {
    unlinkSync(temporary);
    rmdirSync(staging);
    if (error?.code === "EEXIST") {
      const winner = readReservationIfPresent(expected);
      if (winner) return { ...winner, created: false };
    }
    throw new Error(`continuation reservation could not be published without overwrite: ${error.message}`);
  }
  unlinkSync(temporary);
  const markerEntry = lstatSync(expected.reservationPath);
  return { record, bytes, marker_dev: String(markerEntry.dev), marker_ino: String(markerEntry.ino), path: expected.reservationPath, created: true };
}

function readReservationIfPresent(expected, options = {}) {
  let markerEntry;
  try {
    markerEntry = lstatSync(expected.reservationPath);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  if (markerEntry.isSymbolicLink() || !markerEntry.isFile()) throw new Error(`continuation reservation path is foreign or unsafe: ${expected.reservationPath}`);
  const bytes = readFileSync(expected.reservationPath, "utf8");
  let record;
  try {
    record = JSON.parse(bytes);
  } catch (error) {
    throw new Error(`continuation reservation is invalid JSON: ${error.message}`);
  }
  const keys = ["branch", "claim_oid", "head", "kind", "schema_version", "staging", "staging_dev", "staging_ino", "target"];
  if (!record || typeof record !== "object" || Array.isArray(record) || Object.keys(record).sort().join("\0") !== keys.join("\0")
    || bytes !== canonicalJson(record) || record.schema_version !== 1 || record.kind !== "continuation-worktree-reservation"
    || record.claim_oid !== expected.claimOid || record.target !== expected.target || record.branch !== expected.branch || record.head !== expected.head) {
    throw new Error("continuation reservation does not exactly match the claim-bound target identity");
  }
  const staging = resolve(record.staging);
  const stagingRelative = relative(expected.root, staging);
  if (!stagingRelative || stagingRelative === ".." || stagingRelative.startsWith("../") || isAbsolute(stagingRelative)
    || !stagingRelative.startsWith(".continuation-stage-") || !/^\d+$/u.test(record.staging_dev) || !/^\d+$/u.test(record.staging_ino)) {
    throw new Error("continuation reservation staging identity is unsafe");
  }
  const reservation = { record: { ...record, staging }, bytes, marker_dev: String(markerEntry.dev), marker_ino: String(markerEntry.ino), path: expected.reservationPath };
  assertReservationOwnedPath(reservation, options.ownedPath || staging);
  return reservation;
}

function assertReservationOwnedPath(reservation, path) {
  let entry;
  try {
    entry = lstatSync(path);
  } catch (error) {
    if (error?.code === "ENOENT") throw new Error(`continuation reservation owned path is missing: ${path}`);
    throw error;
  }
  if (entry.isSymbolicLink() || !entry.isDirectory()
    || String(entry.dev) !== reservation.record.staging_dev || String(entry.ino) !== reservation.record.staging_ino) {
    throw new Error(`continuation reservation owned path has the wrong filesystem identity: ${path}`);
  }
}

function removeOwnedReservation(reservation) {
  const markerEntry = lstatSync(reservation.path);
  if (markerEntry.isSymbolicLink() || !markerEntry.isFile() || String(markerEntry.dev) !== reservation.marker_dev
    || String(markerEntry.ino) !== reservation.marker_ino || readFileSync(reservation.path, "utf8") !== reservation.bytes) {
    throw new Error("continuation reservation cleanup refused a changed or foreign marker");
  }
  unlinkSync(reservation.path);
}

function releaseUnusedReservation(repo, reservation, options) {
  const identity = checkWorktreeIdentity(repo, reservation.record.staging, {}, options);
  if (identity.reason !== "not-a-registered-worktree") {
    throw new Error("continuation reservation cleanup refused a registered or foreign staging worktree");
  }
  assertReservationOwnedPath(reservation, reservation.record.staging);
  rmdirSync(reservation.record.staging);
  removeOwnedReservation(reservation);
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
