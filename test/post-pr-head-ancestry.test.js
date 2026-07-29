import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "./helpers/git-fixture.js";
import { observePrHeadAncestry } from "../src/factory.js";

const roots = [];
after(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }); });

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

// Mirrors the shape of a real factory repo: a working repo with an `origin`
// remote, a reviewed commit pushed to the PR branch, then one further commit
// standing in for the operator's update-branch or merge push.
function fixture(name) {
  const root = mkdtempSync(join(tmpdir(), `post-pr-head-ancestry-${name}-`));
  roots.push(root);
  const remote = join(root, "origin.git");
  const repo = join(root, "repo");
  mkdirSync(repo);
  git(root, "init", "--bare", "-b", "main", remote);
  git(repo, "init", "-b", "main");
  git(repo, "config", "user.name", "Ancestry Fixture");
  git(repo, "config", "user.email", "ancestry@example.com");
  writeFileSync(join(repo, "README.md"), "base\n");
  git(repo, "add", "README.md");
  git(repo, "commit", "-m", "base");
  git(repo, "remote", "add", "origin", remote);
  git(repo, "push", "-u", "origin", "main");

  git(repo, "checkout", "-b", "feature");
  writeFileSync(join(repo, "reviewed.txt"), "reviewed\n");
  git(repo, "add", "reviewed.txt");
  git(repo, "commit", "-m", "reviewed");
  const reviewed = git(repo, "rev-parse", "HEAD");
  git(repo, "push", "origin", "feature");

  const run = { run_id: `ancestry-${name}`, post_pr: { pr_operation: { head_ref: "feature" } } };
  const probeRef = `refs/opencode/post-pr-head-probe/${run.run_id}`;
  const probeRefs = () => git(repo, "for-each-ref", "--format=%(refname)", "refs/opencode/");
  return { root, repo, remote, run, reviewed, probeRef, probeRefs };
}

function advanceRemote(f, message) {
  writeFileSync(join(f.repo, `${message}.txt`), `${message}\n`);
  git(f.repo, "add", "-A");
  git(f.repo, "commit", "-m", message);
  const head = git(f.repo, "rev-parse", "HEAD");
  git(f.repo, "push", "origin", "feature");
  return head;
}

describe("post-PR head ancestry observation", () => {
  it("classifies an operator-advanced head as a descendant and leaves no probe ref", () => {
    const f = fixture("descendant");
    const advanced = advanceRemote(f, "operator-merge");

    assert.equal(observePrHeadAncestry(f.repo, f.run, f.reviewed, advanced), "descendant");
    assert.equal(f.probeRefs(), "", "the probe ref must not outlive the observation");
  });

  it("resolves an unchanged head without touching the remote at all", () => {
    const f = fixture("exact");
    // No fetch is needed or wanted when the head already matches, so this holds
    // even for a repository whose origin is unreachable.
    git(f.repo, "remote", "set-url", "origin", join(f.root, "missing.git"));
    assert.equal(observePrHeadAncestry(f.repo, f.run, f.reviewed, f.reviewed), "exact");
    assert.equal(f.probeRefs(), "");
  });

  it("classifies a head with unrelated history as unrelated, not tolerable", () => {
    const f = fixture("unrelated");
    // A branch rebuilt from the root commit: the reviewed commit is genuinely not
    // an ancestor, which is the case that must never merge.
    git(f.repo, "checkout", "--orphan", "rewritten");
    git(f.repo, "rm", "-rf", "--cached", ".");
    writeFileSync(join(f.repo, "rewritten.txt"), "rewritten\n");
    git(f.repo, "add", "rewritten.txt");
    git(f.repo, "commit", "-m", "rewritten");
    const rewritten = git(f.repo, "rev-parse", "HEAD");
    git(f.repo, "push", "--force", "origin", "rewritten:feature");

    assert.equal(observePrHeadAncestry(f.repo, f.run, f.reviewed, rewritten), "unrelated");
    assert.equal(f.probeRefs(), "");
  });

  it("refuses to guess when GitHub's head and the advertised branch tip disagree", () => {
    const f = fixture("disagree");
    const advanced = advanceRemote(f, "operator-merge");
    // The remote advertises `advanced`, but GitHub reported something else. Two
    // observations of one fact disagree, so ancestry is not even considered.
    assert.equal(observePrHeadAncestry(f.repo, f.run, f.reviewed, "c".repeat(40)), "indeterminate");
    assert.equal(observePrHeadAncestry(f.repo, f.run, f.reviewed, advanced), "descendant", "control: the same fixture resolves when they agree");
    assert.equal(f.probeRefs(), "");
  });

  it("treats an unobservable remote or missing branch as indeterminate rather than unrelated", () => {
    const f = fixture("unobservable");
    const advanced = advanceRemote(f, "operator-merge");

    const missingBranch = { ...f.run, post_pr: { pr_operation: { head_ref: "no-such-branch" } } };
    assert.equal(observePrHeadAncestry(f.repo, missingBranch, f.reviewed, advanced), "indeterminate");

    git(f.repo, "remote", "set-url", "origin", join(f.root, "missing.git"));
    assert.equal(observePrHeadAncestry(f.repo, f.run, f.reviewed, advanced), "indeterminate");

    const noHeadRef = { run_id: f.run.run_id, post_pr: { pr_operation: {} } };
    assert.equal(observePrHeadAncestry(f.repo, noHeadRef, f.reviewed, advanced), "indeterminate");
    assert.equal(f.probeRefs(), "");
  });

  it("degrades a proven descendant to indeterminate when the probe ref cannot be removed", () => {
    const f = fixture("cleanup");
    const advanced = advanceRemote(f, "operator-merge");
    // A ref left behind accumulates and pins its object graph, so failing to
    // remove it is not a detail to log and continue past: the observation loses
    // the right to report a tolerable answer.
    const gitRunner = (repo, args, options) => (args[0] === "update-ref"
      ? { ok: false, stdout: "", stderr: "refusing to delete" }
      : realRunner(repo, args, options));
    assert.equal(observePrHeadAncestry(f.repo, f.run, f.reviewed, advanced, { gitRunner }), "indeterminate");
    // The ref is still present, which is exactly why the answer was withheld.
    assert.equal(f.probeRefs(), f.probeRef);
    git(f.repo, "update-ref", "-d", f.probeRef);
  });

  it("withholds a proven descendant when the cleanup inspection itself fails", () => {
    const f = fixture("inspect");
    const advanced = advanceRemote(f, "operator-merge");
    // Distinct from a delete that is refused: here the presence probe cannot be
    // read at all. git exits 1 for a ref that is genuinely gone, so any other
    // status is an unreadable repository, not an empty one, and reporting
    // cleanup success from it would preserve a tolerable ancestry on a ref that
    // may still exist.
    let inspections = 0;
    const gitRunner = (repo, args, options) => {
      if (args[0] === "rev-parse" && args.includes("--quiet")) {
        inspections += 1;
        return { ok: false, status: 128, stdout: "", stderr: "fatal: not a git repository" };
      }
      return realRunner(repo, args, options);
    };
    assert.equal(observePrHeadAncestry(f.repo, f.run, f.reviewed, advanced, { gitRunner }), "indeterminate");
    assert.ok(inspections > 0, "the presence probe must actually run");
    // The ref is genuinely still there, which is what the withheld answer protects.
    assert.equal(f.probeRefs(), f.probeRef);
    git(f.repo, "update-ref", "-d", f.probeRef);
  });

  it("separates a failed ancestry probe from a proven non-ancestor", () => {
    const f = fixture("probe-error");
    const advanced = advanceRemote(f, "operator-merge");
    // Exit 1 from merge-base means "proven not an ancestor"; anything else means
    // the probe failed. Collapsing them records a relationship never established.
    const failing = (status) => (repo, args, options) => (args[0] === "merge-base"
      ? { ok: false, status, stdout: "", stderr: "probe failure" }
      : realRunner(repo, args, options));

    assert.equal(observePrHeadAncestry(f.repo, f.run, f.reviewed, advanced, { gitRunner: failing(1) }), "unrelated");
    assert.equal(observePrHeadAncestry(f.repo, f.run, f.reviewed, advanced, { gitRunner: failing(128) }), "indeterminate");
    assert.equal(f.probeRefs(), "", "either way the probe ref is cleaned up");
  });
});

// Must carry `status`, not just `ok`: the observer distinguishes git's exit 1
// ("proven no") from any other nonzero ("probe failed"), so a runner that drops
// the status turns every real negative into an indeterminate.
function realRunner(cwd, args, options = {}) {
  try {
    return { ok: true, status: 0, stdout: execFileSync("git", args, { ...options, cwd, encoding: "utf8" }), stderr: "" };
  } catch (error) {
    return {
      ok: false,
      status: Number.isInteger(error?.status) ? error.status : null,
      stdout: "",
      stderr: String(error?.message ?? error),
    };
  }
}
