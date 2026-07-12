import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { watchRun } from "../src/factory.js";

describe("factory watch output hardening", () => {
  it("projects before JSONL serialization and deduplicates the sanitized line", async () => {
    const originalLog = console.log;
    const lines = [];
    let reads = 0;
    console.log = (line) => lines.push(line);
    const timer = watchRun("watch-run", {
      intervalMs: 1000,
      watchValueFn() {
        reads += 1;
        const credential = reads === 1 ? "dXNlcjpmaXJzdC1zZWNyZXQ=" : "dXNlcjpzZWNvbmQtc2VjcmV0";
        return { run_id: "watch-run", status: "blocked", terminal_result: { reason: `Authorization: Basic ${credential}\r\u001b]8;;https://evil.test\u0007x` } };
      },
    });
    try {
      await new Promise((resolve) => setTimeout(resolve, 40));
    } finally {
      clearInterval(timer);
      console.log = originalLog;
    }
    assert.equal(lines.length, 1);
    assert.doesNotMatch(lines[0], /first-secret|second-secret|dXNlcj/u);
    assert.equal(lines[0].includes("\r"), false);
    assert.equal(lines[0].includes("\u001b"), false);
    assert.equal(lines[0].includes("\u0007"), false);
    assert.deepEqual(JSON.parse(lines[0]), {
      run_id: "watch-run",
      status: "blocked",
      terminal_result: { reason: "Authorization: Basic [redacted]\r\u001b]8;;https://evil.test\u0007x" },
    });
  });

  it("keeps repository-owned static seed warning filenames outside freeform migration", async () => {
    const source = await import("node:fs/promises").then(({ readFile }) => readFile(new URL("../src/factory.js", import.meta.url), "utf8"));
    assert.match(source, /const REPO_SEEDED_SKILL_FILES = \["SKILL\.md", "SCHEMA\.md"\]/u);
    assert.match(source, /preserved locally edited seeded skill file\(s\): \$\{skipped\.join\(", "\)\}/u);
  });
});
