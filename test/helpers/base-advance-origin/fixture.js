import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runFixtureGit } from "../git-fixture.js";

export function createCanonicalOriginFixture(name) {
  const root = mkdtempSync(join(tmpdir(), `canonical-origin-${name}-`));
  const remote = join(root, "origin.git");
  const publisher = join(root, "publisher");
  const repo = join(root, "repo");
  git(root, ["init", "--bare", "--initial-branch=main", remote]);
  git(root, ["clone", remote, publisher]);
  writeFileSync(join(publisher, "state.txt"), "base\n");
  git(publisher, ["add", "state.txt"]);
  commit(publisher, "base");
  git(publisher, ["push", "origin", "main"]);
  git(root, ["clone", remote, repo]);

  const canonicalUrl = `https://github.com/example/${name}.git`;
  git(repo, ["remote", "set-url", "origin", canonicalUrl]);
  git(repo, ["config", `url.file://${remote}.insteadOf`, canonicalUrl]);
  git(repo, ["config", "protocol.file.allow", "always"]);
  const base = output(repo, ["rev-parse", "HEAD"]);

  return {
    root,
    remote,
    publisher,
    repo,
    canonicalUrl,
    base,
    advance(contents = `${Date.now()}\n`) {
      writeFileSync(join(publisher, "state.txt"), contents);
      git(publisher, ["add", "state.txt"]);
      commit(publisher, "advance");
      git(publisher, ["push", "origin", "main"]);
      return output(publisher, ["rev-parse", "HEAD"]);
    },
  };
}

export function git(cwd, args) {
  const result = runFixtureGit(cwd, args);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result;
}

export function output(cwd, args) {
  return git(cwd, args).stdout.trim();
}

function commit(cwd, message) {
  git(cwd, ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", message]);
}
