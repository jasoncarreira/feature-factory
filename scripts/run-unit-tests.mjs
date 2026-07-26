#!/usr/bin/env node
// Runs the unit suite with file concurrency capped below node --test's
// one-process-per-core default. The suite is dominated by child-process spawns
// (git fixtures, CLI subprocesses), so a full-width run oversubscribes the CPU:
// on a 12-core host, capping file concurrency at half the cores measured ~30%
// faster wall time and lowers the oversubscription flake class (spurious
// ENOENT/timeout failures under load). Small hosts keep near-full width
// (cores - 1, matching node's default).
//
// --with-smoke additionally runs the packed-package smoke test inside the same
// invocation so it overlaps with unit files instead of running as a serial
// tail. It requires npm_execpath (always set when invoked via npm scripts).
//
// --shard k/n splits the file list across n independent invocations (CI
// runners), assigning files to shards by greedy size balancing: files are
// sorted by byte size descending and each goes to the currently-lightest
// shard. Size is a stable proxy for runtime that also lands the giant suites
// on different shards. The assignment is deterministic for a given tree, and
// the union of all shards is exactly the full file list.
import { spawn } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { availableParallelism } from "node:os";

const parallelism = availableParallelism();
const concurrency = parallelism <= 4 ? Math.max(1, parallelism - 1) : Math.min(8, Math.floor(parallelism / 2));
let files = readdirSync("test").filter((name) => name.endsWith(".test.js")).map((name) => `test/${name}`).sort();
if (files.length === 0) {
  console.error("no test files found under test/");
  process.exit(1);
}

const shardArgIndex = process.argv.indexOf("--shard");
if (shardArgIndex !== -1) {
  const spec = /^([1-9]\d*)\/([1-9]\d*)$/u.exec(process.argv[shardArgIndex + 1] ?? "");
  const shard = spec && Number(spec[1]);
  const total = spec && Number(spec[2]);
  if (!spec || shard > total) {
    console.error("--shard requires k/n with 1 <= k <= n");
    process.exit(1);
  }
  const weighted = files
    .map((file) => ({ file, size: statSync(file).size }))
    .sort((a, b) => b.size - a.size || (a.file < b.file ? -1 : 1));
  const loads = Array.from({ length: total }, () => 0);
  const bins = Array.from({ length: total }, () => []);
  for (const { file, size } of weighted) {
    let lightest = 0;
    for (let i = 1; i < total; i += 1) if (loads[i] < loads[lightest]) lightest = i;
    bins[lightest].push(file);
    loads[lightest] += size;
  }
  files = bins[shard - 1].sort();
  console.log(`shard ${shard}/${total}: ${files.length} files, ${loads[shard - 1]} bytes`);
}

if (process.argv.includes("--with-smoke")) files.push("test/package-smoke.mjs");

const child = spawn(process.execPath, ["--test", `--test-concurrency=${concurrency}`, ...files], { stdio: "inherit" });
child.on("error", (error) => {
  console.error(`failed to start node --test: ${error.message}`);
  process.exitCode = 1;
});
child.on("exit", (code, signal) => {
  process.exitCode = signal ? 1 : code ?? 1;
});
