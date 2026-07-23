import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "./helpers/git-fixture.js";
import {
  BASE_ADVANCE_LAUNCH_FENCE_OWNER_KIND,
  PROCESS_EVIDENCE_FILE,
  PROCESS_EVIDENCE_KIND,
  PROCESS_EVIDENCE_SCHEMA_VERSION,
  PROCESS_EVIDENCE_SIGNAL,
  acquireLaunchClaim,
  acquireLaunchFence,
  cancelProcessFromEvidence,
  inspectLaunchClaim,
  inspectProcessEvidence,
  inspectProcessEvidenceForCleanup,
  inspectProcessIdentity,
  readProcessEvidence,
  recordDetachedProcessEvidence,
  releaseLaunchClaim,
  releaseLaunchFence,
  transitionLaunchClaimPhase,
  writeProcessEvidence,
} from "../src/process-evidence.js";

const NOW = "2026-07-10T10:00:00.000Z";
const PID = 4242;
const BASE_ADVANCE_HELPER = fileURLToPath(new URL("./helpers/base-advance-launch/acquire-and-exit.js", import.meta.url));

describe("process evidence hardening migration", { concurrency: false }, () => {
  it("moves a run-owned launch claim through checked phases and cleans only its exact token", () => {
    const fixture = createFixture("launch-claim");
    try {
      const opts = processOptions(fixture.runDir);
      const acquired = acquireLaunchClaim(fixture.runDir, {
        runId: fixture.runId,
        executionId: "exec-claim",
        launchKind: "resume-foreground",
        phase: "foreground-live",
        pid: PID,
        cwd: fixture.runDir,
        hostname: "test-host",
        now: NOW,
      }, opts);
      assert.equal(acquired.acquired, true);
      assert.equal(releaseLaunchClaim(fixture.runDir, "wrong-token", opts), false);
      const released = transitionLaunchClaimPhase(fixture.runDir, acquired.token, "predecessor-active", {}, { ...opts, expectedPhase: "foreground-live" });
      assert.equal(released.claim.phase, "predecessor-active");
      const observed = inspectLaunchClaim(fixture.runDir, { ...opts, runId: fixture.runId });
      const ownerBytes = readFileSync(join(fixture.runDir, "process-launch.lock", "owner.json"));
      assert.equal(observed.claim.execution_id, "exec-claim");
      assert.equal(observed.hash, `sha256:${createHash("sha256").update(ownerBytes).digest("hex")}`);
      assert.equal(Number.isInteger(observed.identity.dir.ino), true);
      assert.equal(Number.isInteger(observed.identity.file.ino), true);
      assert.equal(releaseLaunchClaim(fixture.runDir, acquired.token, { ...opts, expectedPhase: "predecessor-active" }), true);
      assert.equal(inspectLaunchClaim(fixture.runDir, opts).missing, true);
    } finally {
      cleanup(fixture.root);
    }
  });

  it("rejects a claim directory replaced between directory inspection and owner open", () => {
    const fixture = createFixture("launch-claim-snapshot-race");
    const displaced = join(fixture.root, "displaced-claim");
    try {
      const opts = processOptions(fixture.runDir);
      const acquired = acquireLaunchClaim(fixture.runDir, {
        runId: fixture.runId,
        executionId: "exec-race",
        launchKind: "resume-foreground",
        phase: "foreground-live",
        pid: PID,
        cwd: fixture.runDir,
        hostname: "test-host",
        now: NOW,
      }, opts);
      const owner = readFileSync(join(fixture.runDir, "process-launch.lock", "owner.json"));
      let replaced = false;
      const inspected = inspectLaunchClaim(fixture.runDir, {
        ...opts,
        runId: fixture.runId,
        onLaunchClaimDirectoryInspected({ dir }) {
          if (replaced) return;
          replaced = true;
          renameSync(dir, displaced);
          mkdirSync(dir);
          writeFileSync(join(dir, "owner.json"), owner);
        },
      });
      assert.equal(acquired.acquired, true);
      assert.equal(inspected.ok, false);
      assert.equal(inspected.owner_status, "invalid");
      assert.equal(inspected.identity, null);
      assert.equal(inspected.hash, null);
      assert.match(inspected.reason, /identity changed/u);
    } finally {
      cleanup(fixture.root);
    }
  });

  it("rejects an owner pathname replaced after reading its opened descriptor", () => {
    const fixture = createFixture("launch-claim-owner-race");
    const displaced = join(fixture.root, "displaced-owner.json");
    try {
      const opts = processOptions(fixture.runDir);
      const acquired = acquireLaunchClaim(fixture.runDir, {
        runId: fixture.runId,
        executionId: "exec-owner-race",
        launchKind: "resume-foreground",
        phase: "foreground-live",
        pid: PID,
        cwd: fixture.runDir,
        hostname: "test-host",
        now: NOW,
      }, opts);
      const ownerPath = join(fixture.runDir, "process-launch.lock", "owner.json");
      const owner = readFileSync(ownerPath);
      let replaced = false;
      const inspected = inspectLaunchClaim(fixture.runDir, {
        ...processOptions(fixture.runDir, {
          livenessProbe() {
            if (!replaced) {
              replaced = true;
              renameSync(ownerPath, displaced);
              writeFileSync(ownerPath, owner);
            }
            return { status: "live" };
          },
        }),
        runId: fixture.runId,
      });
      assert.equal(acquired.acquired, true);
      assert.equal(inspected.ok, false);
      assert.equal(inspected.owner_status, "invalid");
      assert.equal(inspected.identity, null);
      assert.equal(inspected.hash, null);
      assert.match(inspected.reason, /identity changed/u);
    } finally {
      cleanup(fixture.root);
    }
  });

  it("serializes launch publication against an exact-token external fence", () => {
    const fixture = createFixture("launch-fence");
    try {
      const opts = processOptions(fixture.runDir);
      const fence = acquireLaunchFence(fixture.runDir, "cleanup", opts);
      assert.equal(fence.acquired, true);
      assert.equal(acquireLaunchFence(fixture.runDir, "launch", opts).acquired, false);
      const blocked = acquireLaunchClaim(fixture.runDir, {
        runId: fixture.runId, executionId: "blocked", launchKind: "resume-foreground", pid: PID, cwd: fixture.runDir, hostname: "test-host", now: NOW,
      }, opts);
      assert.equal(blocked.acquired, false);
      assert.equal(blocked.owner_status, "indeterminate");
      assert.equal(existsSync(join(fixture.runDir, "process-launch.lock")), false);
      assert.equal(releaseLaunchFence({ ...fence, nonce: "wrong-token-123456" }), false);
      assert.equal(releaseLaunchFence(fence), true);
      const acquired = acquireLaunchClaim(fixture.runDir, {
        runId: fixture.runId, executionId: "allowed", launchKind: "resume-foreground", pid: PID, cwd: fixture.runDir, hostname: "test-host", now: NOW,
      }, opts);
      assert.equal(acquired.acquired, true);
      assert.equal(releaseLaunchClaim(fixture.runDir, acquired.token, opts), true);
    } finally {
      cleanup(fixture.root);
    }
  });

  it("acquires and exactly releases a base-advance fence without altering the run-local launch claim", () => {
    const fixture = createFixture("base-advance-fence");
    const claimDir = join(fixture.runDir, "process-launch.lock");
    const claimPath = join(claimDir, "owner.json");
    try {
      mkdirSync(claimDir);
      writeFileSync(claimPath, "existing launch claim bytes\n", "utf8");
      const before = readFileSync(claimPath);
      const fence = acquireLaunchFence(fixture.runDir, BASE_ADVANCE_LAUNCH_FENCE_OWNER_KIND, baseAdvanceOptions(fixture.runDir));
      const owner = JSON.parse(readFileSync(fence.owner_path, "utf8"));

      assert.equal(fence.acquired, true);
      assert.equal(fence.owner_kind, "base-advance");
      assert.deepEqual(Object.keys(owner), ["schema_version", "kind", "run_path_hash", "owner_kind", "nonce", "pid", "hostname", "acquired_at", "identity"]);
      assert.equal(owner.owner_kind, "base-advance");
      assert.deepEqual(owner.identity, {
        inspector: "node-process",
        start_marker: "linux-procfs:333",
        command_name: "node",
        cwd: fixture.runDir,
      });
      assert.equal(releaseLaunchFence({ ...fence, nonce: "wrong-base-advance-token" }), false);
      assert.deepEqual(readFileSync(claimPath), before);
      assert.equal(releaseLaunchFence(fence), true);
      assert.deepEqual(readFileSync(claimPath), before);
    } finally {
      cleanup(fixture.root);
    }
  });

  it("reclaims an exact local base-advance owner only after its process is definitively dead", () => {
    const fixture = createFixture("base-advance-dead-owner");
    const host = "base-advance-helper-host";
    try {
      const child = spawnSync(process.execPath, [BASE_ADVANCE_HELPER, fixture.runDir, host], {
        cwd: process.cwd(),
        encoding: "utf8",
      });
      assert.equal(child.status, 0, child.stderr);
      const abandoned = JSON.parse(child.stdout);
      assert.equal(abandoned.owner_kind, "base-advance");
      assert.equal(existsSync(join(fixture.runDir, "process-launch.lock")), false);

      const replacement = acquireLaunchFence(fixture.runDir, "launch", { hostname: host });
      assert.equal(replacement.acquired, true);
      assert.equal(replacement.path, abandoned.path);
      assert.equal(replacement.owner_kind, "launch");
      assert.equal(existsSync(join(fixture.runDir, "process-launch.lock")), false);
      assert.equal(releaseLaunchFence(replacement), true);
    } finally {
      cleanup(fixture.root);
    }
  });

  it("keeps every non-exact or non-dead base-advance owner contended", () => {
    const cases = [
      { name: "live", contender: (fixture) => baseAdvanceOptions(fixture.runDir) },
      { name: "foreign", mutate: (owner) => ({ ...owner, hostname: "foreign-host" }), contender: () => ({ hostname: "test-host" }) },
      { name: "ownerless", removeOwner: true, contender: () => ({ hostname: "test-host" }) },
      { name: "malformed", malformed: true, contender: () => ({ hostname: "test-host" }) },
      {
        name: "changed",
        mutate: deadBaseAdvanceOwner,
        contender: (_fixture, ownerPath) => {
          let probes = 0;
          return {
            hostname: "test-host",
            livenessProbe: () => {
              probes += 1;
              if (probes === 2) writeFileSync(ownerPath, `${JSON.stringify({ changed: true })}\n`, "utf8");
              return { status: "absent" };
            },
          };
        },
      },
      {
        name: "mismatched",
        contender: (fixture) => baseAdvanceOptions(fixture.runDir, { marker: "334" }),
      },
      {
        name: "indeterminate",
        contender: (fixture) => baseAdvanceOptions(fixture.runDir, { liveness: "indeterminate" }),
      },
    ];

    for (const item of cases) {
      const fixture = createFixture(`base-advance-${item.name}`);
      try {
        const fence = acquireLaunchFence(fixture.runDir, "base-advance", baseAdvanceOptions(fixture.runDir));
        const ownerPath = fence.owner_path;
        const owner = JSON.parse(readFileSync(ownerPath, "utf8"));
        assert.equal(fence.acquired, true, item.name);
        if (item.removeOwner) rmSync(ownerPath);
        else if (item.malformed) writeFileSync(ownerPath, "malformed owner\n", "utf8");
        else if (item.mutate) writeFileSync(ownerPath, `${JSON.stringify(item.mutate(owner), null, 2)}\n`, "utf8");

        const contender = acquireLaunchFence(fixture.runDir, "cleanup", item.contender(fixture, ownerPath));
        assert.equal(contender.acquired, false, item.name);
        assert.equal(contender.path, fence.path, item.name);
        assert.equal(existsSync(fence.path), true, item.name);
        assert.equal(existsSync(join(fixture.runDir, "process-launch.lock")), false, item.name);
      } finally {
        cleanup(fixture.root);
      }
    }
  });

  it("uses one fence for lexical aliases of the same physical run directory", () => {
    const fixture = createFixture("launch-fence-alias");
    const aliasRoot = `${fixture.root}-alias`;
    try {
      symlinkSync(fixture.root, aliasRoot, "dir");
      const aliasRunDir = join(aliasRoot, fixture.runId);
      const fence = acquireLaunchFence(fixture.runDir, "cleanup");
      assert.equal(fence.acquired, true);
      const contended = acquireLaunchFence(aliasRunDir, "launch");
      assert.equal(contended.acquired, false);
      assert.equal(contended.path, fence.path);
      assert.equal(releaseLaunchFence(fence), true);
    } finally {
      rmSync(aliasRoot, { recursive: true, force: true });
      cleanup(fixture.root);
    }
  });

  it("rejects stale fence acquisition after the run directory is recreated", () => {
    const fixture = createFixture("launch-fence-generation");
    const displaced = join(fixture.root, "old-run");
    try {
      assert.throws(() => acquireLaunchFence(fixture.runDir, "launch", {
        onLaunchFenceReadyToAcquire() {
          renameSync(fixture.runDir, displaced);
          mkdirSync(fixture.runDir);
        },
      }), /run directory identity changed/u);

      const replacementFence = acquireLaunchFence(fixture.runDir, "cleanup");
      assert.equal(replacementFence.acquired, true);
      assert.equal(releaseLaunchFence(replacementFence), true);
    } finally {
      cleanup(fixture.root);
    }
  });

  it("removes its exact fence after owner publication or verification fails", () => {
    for (const failure of ["write", "verify"]) {
      const fixture = createFixture(`launch-fence-owner-${failure}`);
      try {
        const injected = failure === "write"
          ? { writeLaunchFenceOwner() { throw new Error("injected owner write failure"); } }
          : { inspectLaunchFenceOwner() { throw new Error("injected owner verification failure"); } };
        assert.throws(() => acquireLaunchFence(fixture.runDir, "launch", injected), new RegExp(`owner ${failure === "write" ? "write" : "verification"} failure`, "u"));

        const recovered = acquireLaunchFence(fixture.runDir, "cleanup");
        assert.equal(recovered.acquired, true, failure);
        assert.equal(releaseLaunchFence(recovered), true, failure);
      } finally {
        cleanup(fixture.root);
      }
    }
  });

  it("rejects acquisition when the bound fence root is replaced", () => {
    const fixture = createFixture("launch-fence-root-replacement");
    const displaced = join(fixture.root, "displaced-fence-root");
    try {
      assert.throws(() => acquireLaunchFence(fixture.runDir, "launch", {
        onLaunchFenceReadyToAcquire({ fenceRoot }) {
          renameSync(fenceRoot, displaced);
          mkdirSync(fenceRoot);
        },
      }), /namespace identity changed/u);

      const recovered = acquireLaunchFence(fixture.runDir, "cleanup");
      assert.equal(recovered.acquired, true);
      assert.equal(releaseLaunchFence(recovered), true);
    } finally {
      cleanup(fixture.root);
    }
  });

  it("rejects acquisition when the bound fence parent is replaced", () => {
    const fixture = createFixture("launch-fence-parent-replacement");
    const parent = join(fixture.root, "fence-parent");
    const displaced = join(fixture.root, "displaced-fence-parent");
    const launchFenceRoot = join(parent, "fences");
    mkdirSync(parent);
    try {
      assert.throws(() => acquireLaunchFence(fixture.runDir, "launch", {
        launchFenceRoot,
        onLaunchFenceReadyToAcquire() {
          renameSync(parent, displaced);
          mkdirSync(parent);
          mkdirSync(launchFenceRoot);
        },
      }), /namespace identity changed/u);

      const recovered = acquireLaunchFence(fixture.runDir, "cleanup", { launchFenceRoot });
      assert.equal(recovered.acquired, true);
      assert.equal(releaseLaunchFence(recovered), true);
    } finally {
      cleanup(fixture.root);
    }
  });

  it("rejects symlinked run roots and symlinked process-log ancestors without following them", () => {
    const fixture = createFixture("ancestor-symlinks");
    const alias = join(fixture.root, "run-alias");
    try {
      symlinkSync(fixture.runDir, alias);
      assert.throws(() => acquireLaunchClaim(alias, {
        runId: fixture.runId, executionId: "exec", launchKind: "resume-foreground", pid: PID, cwd: fixture.runDir, hostname: "test-host", now: NOW,
      }, processOptions(fixture.runDir)), /non-symlink directory/u);

      const outside = join(fixture.root, "outside-logs");
      mkdirSync(outside);
      writeFileSync(join(outside, "opencode.log"), "outside\n", "utf8");
      rmSync(join(fixture.runDir, "processes"), { recursive: true });
      symlinkSync(outside, join(fixture.runDir, "processes"));
      writeFileSync(join(fixture.runDir, PROCESS_EVIDENCE_FILE), `${JSON.stringify(evidence(fixture), null, 2)}\n`, "utf8");
      const inspected = inspectProcessEvidence(fixture.runDir, { runId: fixture.runId, ...processOptions(fixture.runDir) });
      assert.equal(inspected.ok, false);
      assert.match(inspected.reason, /non-symlink|symlink/u);
      assert.equal(readFileSync(join(outside, "opencode.log"), "utf8"), "outside\n");
    } finally {
      cleanup(fixture.root);
    }
  });

  it("preserves schema-v1 constants and exact persisted identity fields", () => {
    const fixture = createFixture("schema");
    try {
      const recorded = recordDetachedProcessEvidence(fixture.runDir, {
        runId: fixture.runId,
        executionId: "exec-1",
        pid: PID,
        cwd: fixture.runDir,
        logRef: "processes/opencode.log",
        now: NOW,
        ...processOptions(fixture.runDir),
      });

      assert.equal(PROCESS_EVIDENCE_FILE, "process.json");
      assert.equal(PROCESS_EVIDENCE_KIND, "opencode-process");
      assert.equal(PROCESS_EVIDENCE_SCHEMA_VERSION, 1);
      assert.equal(PROCESS_EVIDENCE_SIGNAL, "SIGTERM");
      assert.deepEqual(Object.keys(recorded.identity), ["inspector", "start_marker", "command_name"]);
      assert.deepEqual(recorded.identity, {
        inspector: "node-process",
        start_marker: "linux-procfs:111",
        command_name: "opencode",
      });
      assert.deepEqual(readProcessEvidence(fixture.runDir, { runId: fixture.runId }).evidence, recorded);
      assert.equal(readFileSync(join(fixture.runDir, PROCESS_EVIDENCE_FILE), "utf8"), `${JSON.stringify(recorded, null, 2)}\n`);
    } finally {
      cleanup(fixture.root);
    }
  });

  it("uses protected replacement without modifying a hard-linked outside inode", () => {
    const fixture = createFixture("hardlink");
    const outside = join(fixture.root, "outside-sentinel");
    const target = join(fixture.runDir, PROCESS_EVIDENCE_FILE);
    try {
      writeFileSync(outside, "outside stays unchanged\n", "utf8");
      linkSync(outside, target);

      writeProcessEvidence(fixture.runDir, evidence(fixture));

      assert.equal(readFileSync(outside, "utf8"), "outside stays unchanged\n");
      assert.equal(JSON.parse(readFileSync(target, "utf8")).run_id, fixture.runId);
    } finally {
      cleanup(fixture.root);
    }
  });

  it("fails closed instead of following a process.json symlink", () => {
    const fixture = createFixture("symlink");
    const outside = join(fixture.root, "outside-sentinel");
    try {
      writeFileSync(outside, "outside stays unchanged\n", "utf8");
      symlinkSync(outside, join(fixture.runDir, PROCESS_EVIDENCE_FILE));

      assert.throws(
        () => writeProcessEvidence(fixture.runDir, evidence(fixture)),
        (error) => error?.code === "TARGET_TYPE",
      );
      assert.equal(readFileSync(outside, "utf8"), "outside stays unchanged\n");
    } finally {
      cleanup(fixture.root);
    }
  });

  it("keeps the public inspection response while using structured verification dependencies", () => {
    const fixture = createFixture("inspect");
    try {
      assert.deepEqual(inspectProcessIdentity(PID, linuxOptions()), {
        ok: true,
        inspector: "node-process",
        pid: PID,
        start_marker: "linux-procfs:111",
        command_name: "opencode",
        cwd: fixture.runDir,
      });
    } finally {
      cleanup(fixture.root);
    }

    function linuxOptions() {
      return processOptions(fixture.runDir);
    }
  });

  it("inspects cleanup process evidence with finite states and no writes or signals", () => {
    const cases = [
      { name: "live", expected: "live-matching", liveness: "live" },
      { name: "absent", expected: "absent", liveness: "absent" },
      { name: "mismatched-identity", expected: "mismatched", liveness: "live", marker: "222" },
      { name: "indeterminate", expected: "indeterminate", liveness: "indeterminate" },
    ];
    for (const item of cases) {
      const fixture = createFixture(`cleanup-${item.name}`);
      const signals = [];
      try {
        writeProcessEvidence(fixture.runDir, evidence(fixture));
        const path = join(fixture.runDir, PROCESS_EVIDENCE_FILE);
        const before = readFileSync(path);
        const result = inspectProcessEvidenceForCleanup(fixture.runDir, {
          runId: fixture.runId,
          ...processOptions(fixture.runDir, {
            livenessProbe: () => ({ status: item.liveness }),
            marker: () => item.marker || "111",
          }),
          signalFn: (pid, signal) => signals.push({ pid, signal }),
        });

        assert.equal(result.state, item.expected, item.name);
        assert.equal(result.evidence.run_id, fixture.runId, item.name);
        assert.equal(result.hash, `sha256:${createHash("sha256").update(before).digest("hex")}`, item.name);
        assert.deepEqual(readFileSync(path), before, item.name);
        assert.deepEqual(signals, [], item.name);
      } finally {
        cleanup(fixture.root);
      }
    }
  });

  it("classifies missing, invalid, run-mismatched, and non-running cleanup evidence without mutation", () => {
    const fixture = createFixture("cleanup-static-states");
    try {
      assert.equal(inspectProcessEvidenceForCleanup(fixture.runDir, { runId: fixture.runId }).state, "missing");

      const path = join(fixture.runDir, PROCESS_EVIDENCE_FILE);
      writeFileSync(path, "not json\n", "utf8");
      const invalidBefore = readFileSync(path);
      assert.equal(inspectProcessEvidenceForCleanup(fixture.runDir, { runId: fixture.runId }).state, "invalid");
      assert.deepEqual(readFileSync(path), invalidBefore);

      writeProcessEvidence(fixture.runDir, evidence(fixture));
      assert.equal(inspectProcessEvidenceForCleanup(fixture.runDir, { runId: "another-run" }).state, "mismatched");

      writeProcessEvidence(fixture.runDir, evidence(fixture, { state: "exited" }));
      const exitedBefore = readFileSync(path);
      assert.equal(inspectProcessEvidenceForCleanup(fixture.runDir, { runId: fixture.runId }).state, "absent");
      assert.deepEqual(readFileSync(path), exitedBefore);
    } finally {
      cleanup(fixture.root);
    }
  });

  it("rejects symlinked cleanup process evidence without following or modifying it", () => {
    const fixture = createFixture("cleanup-symlink");
    const outside = join(fixture.root, "outside-process.json");
    try {
      writeFileSync(outside, `${JSON.stringify(evidence(fixture))}\n`, "utf8");
      symlinkSync(outside, join(fixture.runDir, PROCESS_EVIDENCE_FILE));
      const before = readFileSync(outside);

      assert.equal(inspectProcessEvidenceForCleanup(fixture.runDir, { runId: fixture.runId }).state, "invalid");
      assert.deepEqual(readFileSync(outside), before);
    } finally {
      cleanup(fixture.root);
    }
  });

  it("never signals absent, mismatched, or indeterminate final identities", async () => {
    for (const item of [
      { name: "absent", liveness: "absent", marker: "111", expectedStatus: "cancelled" },
      { name: "mismatched", liveness: "live", marker: "222", expectedStatus: "failed-closed" },
      { name: "indeterminate", liveness: "indeterminate", marker: "111", expectedStatus: "failed-closed" },
    ]) {
      const fixture = createFixture(`final-${item.name}`);
      const signals = [];
      try {
        writeProcessEvidence(fixture.runDir, evidence(fixture));
        const result = await cancelProcessFromEvidence(fixture.runDir, {
          runId: fixture.runId,
          cancelWaitMs: 0,
          ...processOptions(fixture.runDir, {
            livenessProbe: () => ({ status: item.liveness }),
            marker: () => item.marker,
          }),
          signalFn: (pid, signal) => signals.push({ pid, signal }),
        });

        assert.equal(result.status, item.expectedStatus, item.name);
        assert.equal(result.signaled, false, item.name);
        assert.deepEqual(signals, [], item.name);
      } finally {
        cleanup(fixture.root);
      }
    }
  });

  it("never signals for malformed or throwing legacy processAliveFn results", async () => {
    const callbacks = [
      () => "false",
      () => new Boolean(false),
      () => ({ status: "absent" }),
      () => [],
      () => 0,
      () => null,
      () => undefined,
      () => { throw new Error("probe failed"); },
    ];
    for (const [index, processAliveFn] of callbacks.entries()) {
      const fixture = createFixture(`legacy-liveness-${index}`);
      const signals = [];
      try {
        writeProcessEvidence(fixture.runDir, evidence(fixture));
        const result = await cancelProcessFromEvidence(fixture.runDir, {
          runId: fixture.runId,
          cancelWaitMs: 0,
          platform: "linux",
          processAliveFn,
          procReadFile: (path) => path.endsWith("/stat") ? linuxStat(PID, "111") : "/usr/local/bin/opencode\n",
          procReadlink: () => fixture.runDir,
          signalFn: (pid, signal) => signals.push({ pid, signal }),
        });
        assert.equal(result.status, "failed-closed");
        assert.equal(result.signaled, false);
        assert.deepEqual(signals, []);
        assert.equal(readProcessEvidence(fixture.runDir, { runId: fixture.runId }).evidence.state, "running");
      } finally {
        cleanup(fixture.root);
      }
    }
  });

  it("fails closed when legacy Darwin commandRunnerFn observes a changed final start marker", async () => {
    const fixture = createFixture("darwin-final-marker-change");
    const signals = [];
    const starts = ["Fri Jul 10 10:00:00 2026", "Fri Jul 10 10:00:01 2026"];
    let startProbe = 0;
    try {
      writeProcessEvidence(fixture.runDir, evidence(fixture, {
        identity: {
          inspector: "node-process",
          start_marker: `darwin-ps:${starts[0]}`,
          command_name: "opencode",
        },
      }));

      const result = await cancelProcessFromEvidence(fixture.runDir, {
        runId: fixture.runId,
        cancelWaitMs: 0,
        platform: "darwin",
        processAliveFn: () => true,
        commandRunnerFn: (command, args) => {
          if (command === "ps" && args.at(-1) === "lstart=") return `${starts[startProbe++]}\n`;
          if (command === "ps" && args.at(-1) === "comm=") return "/usr/local/bin/opencode\n";
          if (command === "lsof") return `p${PID}\nfcwd\nn${fixture.runDir}\n`;
          throw new Error("unexpected command");
        },
        signalFn: (pid, signal) => signals.push({ pid, signal }),
      });

      assert.equal(startProbe, 2);
      assert.equal(result.ok, false);
      assert.equal(result.status, "failed-closed");
      assert.equal(result.signaled, false);
      assert.equal(result.updated, false);
      assert.deepEqual(signals, []);
      assert.equal(readProcessEvidence(fixture.runDir, { runId: fixture.runId }).evidence.state, "running");
    } finally {
      cleanup(fixture.root);
    }
  });

  it("confirms post-signal cancellation only for absence; mismatch and unknown stay pending", async () => {
    for (const item of [
      { name: "absent", postStatus: "absent", expectedStatus: "cancelled", expectedState: "cancelled" },
      { name: "mismatched", postStatus: "live", expectedStatus: "cancel-pending", expectedState: "running" },
      { name: "indeterminate", postStatus: "indeterminate", expectedStatus: "cancel-pending", expectedState: "running" },
    ]) {
      const fixture = createFixture(`post-${item.name}`);
      const signals = [];
      let signaled = false;
      try {
        writeProcessEvidence(fixture.runDir, evidence(fixture));
        const result = await cancelProcessFromEvidence(fixture.runDir, {
          runId: fixture.runId,
          cancelWaitMs: 0,
          now: NOW,
          ...processOptions(fixture.runDir, {
            livenessProbe: () => ({ status: signaled ? item.postStatus : "live" }),
            marker: () => signaled && item.name === "mismatched" ? "222" : "111",
          }),
          signalFn: (pid, signal) => {
            signals.push({ pid, signal });
            signaled = true;
          },
        });

        assert.equal(result.status, item.expectedStatus, item.name);
        assert.deepEqual(signals, [{ pid: PID, signal: "SIGTERM" }], item.name);
        const persisted = readProcessEvidence(fixture.runDir, { runId: fixture.runId }).evidence;
        assert.equal(persisted.state, item.expectedState, item.name);
        assert.equal(persisted.cancel.result, item.expectedState === "cancelled" ? "cancelled" : "pending", item.name);
      } finally {
        cleanup(fixture.root);
      }
    }
  });

  it("preserves processInspectorFn and processSignalFn compatibility without broad signaling", async () => {
    const fixture = createFixture("legacy-aliases");
    const signals = [];
    let signaled = false;
    try {
      writeProcessEvidence(fixture.runDir, evidence(fixture, {
        identity: { inspector: "legacy-inspector", start_marker: "legacy-start", command_name: "opencode" },
      }));
      const result = await cancelProcessFromEvidence(fixture.runDir, {
        runId: fixture.runId,
        cancelWaitMs: 0,
        processInspectorFn: (pid) => signaled
          ? { ok: false, inspector: "legacy-inspector", code: "ESRCH", reason: "ESRCH" }
          : {
              ok: true,
              inspector: "legacy-inspector",
              pid,
              start_marker: "legacy-start",
              command_name: "opencode",
              cwd: fixture.runDir,
            },
        processSignalFn: (pid, signal) => {
          signals.push({ pid, signal });
          signaled = true;
        },
      });

      assert.equal(result.status, "cancelled");
      assert.deepEqual(signals, [{ pid: PID, signal: "SIGTERM" }]);
    } finally {
      cleanup(fixture.root);
    }
  });
});

function createFixture(name) {
  const root = mkdtempSync(join(tmpdir(), `process-evidence-${name}-`));
  const runId = `run-${name}`;
  const runDir = join(root, runId);
  mkdirSync(join(runDir, "processes"), { recursive: true });
  writeFileSync(join(runDir, "processes", "opencode.log"), "started\n", "utf8");
  return { root, runDir, runId };
}

function evidence(fixture, overrides = {}) {
  return {
    schema_version: 1,
    kind: "opencode-process",
    run_id: fixture.runId,
    execution_id: "exec-1",
    pid: PID,
    started_at: NOW,
    updated_at: NOW,
    state: "running",
    cwd: fixture.runDir,
    identity: {
      inspector: "node-process",
      start_marker: "linux-procfs:111",
      command_name: "opencode",
      ...(overrides.identity || {}),
    },
    log_ref: "processes/opencode.log",
    cancel: null,
    ...overrides,
    identity: {
      inspector: "node-process",
      start_marker: "linux-procfs:111",
      command_name: "opencode",
      ...(overrides.identity || {}),
    },
  };
}

function processOptions(cwd, { livenessProbe = () => ({ status: "live" }), marker = () => "111" } = {}) {
  return {
    platform: "linux",
    hostname: "test-host",
    livenessProbe,
    procReadFile: (path) => path.endsWith("/stat") ? linuxStat(PID, marker()) : "/usr/local/bin/opencode\n",
    procReadlink: () => cwd,
  };
}

function baseAdvanceOptions(cwd, { liveness = "live", marker = "333" } = {}) {
  return {
    hostname: "test-host",
    platform: "linux",
    livenessProbe: () => ({ status: liveness }),
    procReadFile: (path) => path.endsWith("/stat") ? linuxStat(process.pid, marker) : "node\n",
    procReadlink: () => cwd,
  };
}

function deadBaseAdvanceOwner(owner) {
  return {
    ...owner,
    pid: 999_999_999,
  };
}

function linuxStat(pid, marker) {
  return `${pid} (opencode) S ${Array(18).fill("0").join(" ")} ${marker}\n`;
}

function cleanup(path) {
  rmSync(path, { recursive: true, force: true });
}
