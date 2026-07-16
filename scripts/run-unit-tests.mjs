#!/usr/bin/env node
// Runs the unit suite with file concurrency capped below node --test's
// one-process-per-core default. The suite is dominated by child-process spawns
// (git fixtures, CLI subprocesses), so a full-width run oversubscribes the CPU:
// on a 12-core host, capping file concurrency at half the cores measured ~30%
// faster wall time and lowers the oversubscription flake class (spurious
// ENOENT/timeout failures under load). Small hosts keep the default shape.
//
// --with-smoke additionally runs the packed-package smoke test inside the same
// invocation so it overlaps with unit files instead of running as a serial
// tail. It requires npm_execpath (always set when invoked via npm scripts).
import { spawn } from "node:child_process";
import { readdirSync } from "node:fs";
import { availableParallelism } from "node:os";

const parallelism = availableParallelism();
const concurrency = parallelism <= 4 ? Math.max(1, parallelism - 1) : Math.min(8, Math.floor(parallelism / 2));
const files = readdirSync("test").filter((name) => name.endsWith(".test.js")).map((name) => `test/${name}`);
if (files.length === 0) {
  console.error("no test files found under test/");
  process.exit(1);
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
