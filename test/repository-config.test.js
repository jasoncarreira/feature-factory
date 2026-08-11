// Contract test for this repository's own `.factory.json`.
//
// Every other suite exercises *synthetic* resolver declarations, so the committed one was unverified — and
// it broke: renaming the repo to `feature-factory` left `resolve` matching issue URLs against the old slug
// with an exact `sed` pattern, so a pasted `feature-factory/issues/N` produced no run id. It failed silently,
// because the command ends `[ -n "$n" ] || exit 0` — a caller sees success and an empty payload rather than an
// error. That is the class of defect a regression test exists for, and hand-running it in a shell (which is
// how it was verified the first time) leaves nothing behind to stop it recurring.
//
// The probe executes the real committed command with a stubbed `gh` first on PATH. The stub records its argv
// and synthesises the payload, so nothing touches the network, and the recorded argv proves which repository
// the command would actually query.

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, chmodSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { describe, it } from "node:test";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CONFIG = JSON.parse(readFileSync(join(ROOT, ".factory.json"), "utf8"));

function runResolve(input) {
  const dir = mkdtempSync(join(tmpdir(), "resolve-probe-"));
  try {
    const argvLog = join(dir, "argv.txt");
    const stub = join(dir, "gh");
    // Records every argument, then emits the payload the real `gh --jq` would produce. The issue number is
    // read back out of argv, which is what proves the resolver extracted and forwarded it.
    writeFileSync(stub, [
      "#!/bin/sh",
      `printf '%s\\n' "$@" > ${JSON.stringify(argvLog)}`,
      "n=''",
      "while [ $# -gt 0 ]; do",
      "  case \"$1\" in issue) shift; [ \"$1\" = view ] && { shift; n=$1; } ;; esac",
      "  shift",
      "done",
      'printf \'{"run_id":"%s","number":%s,"title":"stub"}\\n\' "$n" "$n"',
      "",
    ].join("\n"));
    chmodSync(stub, 0o755);
    const stdout = execFileSync("bash", ["-c", CONFIG.resolve], {
      cwd: ROOT,
      encoding: "utf8",
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, FACTORY_INPUT: input },
    });
    return {
      stdout: stdout.trim(),
      argv: existsSync(argvLog) ? readFileSync(argvLog, "utf8") : "",
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("this repository's .factory.json", () => {
  it("resolves every accepted issue reference form and queries the renamed repository", () => {
    // Rows, not separate call sites: the accepted grammar is data, and a new form is one line here.
    const resolves = [
      ["bare id", "279", "279"],
      ["hash form", "#279", "279"],
      ["leading and trailing whitespace", "  #279  ", "279"],
      // The rename target. This is the case that silently failed.
      ["current-slug URL", "https://github.com/jasoncarreira/feature-factory/issues/279", "279"],
      // Kept deliberately: GitHub redirects the old slug, but this is an exact-match parser and URLs
      // already pasted in issues, notes and salvage archives carry the old form.
      ["legacy-slug URL", "https://github.com/jasoncarreira/opencode-feature-factory/issues/279", "279"],
      ["multi-digit id", "1423", "1423"],
    ];
    for (const [label, input, expected] of resolves) {
      const { stdout, argv } = runResolve(input);
      assert.match(stdout, /^\{/u, `${label}: expected a JSON payload, got ${JSON.stringify(stdout)}`);
      assert.equal(JSON.parse(stdout).run_id, expected, `${label}: wrong run_id`);
      assert.ok(argv.includes("jasoncarreira/feature-factory"),
        `${label}: must query the renamed repository, argv was ${JSON.stringify(argv)}`);
      assert.ok(!argv.split("\n").includes("jasoncarreira/opencode-feature-factory"),
        `${label}: must not query the old slug as a --repo target`);
    }

    // Unrecognised input yields no run id and no forge call at all. Asserted because the silent-success
    // path is exactly how the rename regression hid: an empty payload reads as "no issue" rather than "the
    // parser no longer understands this".
    for (const [label, input] of [
      ["prose", "not-an-issue"],
      ["zero", "0"],
      ["url with a trailing path", "https://github.com/jasoncarreira/feature-factory/issues/279/files"],
      ["different repository", "https://github.com/jasoncarreira/mimir/issues/279"],
      ["empty", ""],
    ]) {
      const { stdout, argv } = runResolve(input);
      assert.equal(stdout, "", `${label}: expected no payload, got ${JSON.stringify(stdout)}`);
      assert.equal(argv, "", `${label}: expected no forge call, argv was ${JSON.stringify(argv)}`);
    }
  });
});
