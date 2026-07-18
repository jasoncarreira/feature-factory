import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { hashFile } from "../../src/refs.js";
import { runFixtureGit } from "./git-fixture.js";

export function publishSyntheticV2Parent(runDir, continuation) {
  const repository = resolve(runDir, "../../..");
  const head = runFixtureGit(repository, ["rev-parse", "HEAD^{commit}"]);
  if (head.status !== 0) throw new Error(head.stderr || "synthetic schema-v2 parent requires a Git repository");
  const parentCommit = head.stdout.trim();
  const oldParentCommit = continuation.parent.commit;
  continuation.parent.commit = parentCommit;
  if (continuation.carry_forward?.start_commit === oldParentCommit) continuation.carry_forward.start_commit = parentCommit;
  const branch = runFixtureGit(repository, ["branch", "-f", continuation.parent.branch, parentCommit]);
  if (branch.status !== 0) throw new Error(branch.stderr || "synthetic schema-v2 parent branch could not be published");
  const parentFile = resolve(repository, continuation.parent.run_ref);
  const parentDir = dirname(parentFile);
  mkdirSync(parentDir, { recursive: true });

  const bindings = [
    ...(continuation.parent_artifacts || []),
    ...(continuation.parent_evidence || []),
    ...(continuation.parent_reviews || []),
  ];
  for (const binding of bindings) {
    const { ref } = binding;
    const source = join(runDir, ref);
    const target = join(parentDir, ref);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(source, target);
    binding.hash = hashFile(source);
  }

  writeFileSync(parentFile, `${JSON.stringify({
    schema_version: 1,
    run_id: continuation.parent.run_id,
    status: "blocked",
    branch: continuation.parent.branch,
    gates: {},
    terminal_result: {
      status: "blocked",
      run_id: continuation.parent.run_id,
      reason: "review blocked",
    },
  }, null, 2)}\n`);
  continuation.parent.run_hash = hashFile(parentFile);
  return parentFile;
}
