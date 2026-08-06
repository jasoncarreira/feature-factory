// What actually ships.
//
// A workspace-level release check rather than either package's unit test, because it is about
// tarballs and the two are only meaningful together. It lives here so `npm test` runs it and neither
// package's suite has to know how the other is published.
//
// It exists because three release blockers in one review round were invisible to 99 passing tests:
// the opencode package's `files` omitted `observe/`, which both entrypoints import, so installing it
// failed outright; and the factory package's `files` omitted `agents/`, so a consumer could not run
// the chain its README documents. The predecessor had a pack smoke test that would have caught
// exactly that, and deleting it in the same change that broke the manifests is what let them through.
//
// **Runtime checks use a real `npm install` of the local tarballs.** An earlier version extracted
// them instead, justified in a comment by the claim that installing unpublished packages would go to
// the registry and fail. That claim was never tested and is false — npm resolves
// `feature-factory@0.1.0` from the sibling tarball on the same command line, writes the dependency,
// and creates the `.bin/factory` shim. Extraction is kept only for the file inventory, where no
// resolution is involved and an install would just be slower.
//
// Installing rather than extracting is what makes two contracts testable at all: **bare specifiers**
// exercise `exports` names and conditions, which importing a manifest's target path silently
// bypasses; and **`node_modules/.bin/factory`** is a symlink, which is the exact shape that broke the
// CLI's entry guard.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PACKAGES = ["feature-factory", "opencode-feature-factory"];
const CONFIG_SCHEMA = `{
  "resolve": "<non-empty shell command>",
  "verify": "<non-empty shell command>",
  "publish": "<non-empty shell command>",
  "publishing_identity": "<non-empty account name>"
}`;
const SKILL_CONTRACTS = [
  ["the exact four-entry schema", (text) => text.includes(CONFIG_SCHEMA)],
  ["only three entries are commands and identity is static", (text) => /`resolve`, `verify`, and\s+`publish` are the only commands[\s\S]*`publishing_identity` is\s+a static non-empty publishing account name/u.test(text)],
  ["resolve uses an ordinary shell in the repository root", (text) => /configured string unchanged as one ordinary shell step, with exact cwd `O`, the inherited\s+environment plus `FACTORY_INPUT`/u.test(text)],
  ["empty stdout means not recognized", (text) => /Exit zero with exactly zero stdout bytes means the resolver did not recognize an issue reference/u.test(text)],
  ["stdout is the unchanged payload with a canonical run id, a title and a body", (text) => /stdout itself is `ISSUE_PAYLOAD`[\s\S]*canonical top-level string `run_id`, a non-empty string `title`, and a string `body`[\s\S]*exact same stdout bytes unchanged to `story-reader`/u.test(text)],
  ["the payload shape is validated before anything is dispatched", (text) => /Validate `run_id`, `title`, and `body` — presence and type — before binding `R`/u.test(text)],
  ["an absent config declares no resolver at all", (text) => /An absent `\$O\/\.factory\.json` means this repository declares no resolver/u.test(text)],
  ["no tracker grammar or fetch command ships in the skill", (text) => !/\bgh\s+(?:repo|issue)\b/u.test(text)],
  ["malformed config refuses closed", (text) => text.includes("invalid factory config: .factory.json; no session or run created.")],
  ["malformed payload refuses closed, naming the reference", (text) => text.includes("factory config entry 'resolve' returned malformed payload for reference <reference>; no session or run created.")],
  ["an observed status is reported without fallback, naming the reference", (text) => text.includes("factory config entry 'resolve' failed for reference <reference> with exit status <status>; no session or run created.")],
  ["an unavailable status is reported without fallback, naming the reference", (text) => text.includes("factory config entry 'resolve' failed for reference <reference>; exit status unavailable; no session or run created.")],
  ["commands and credentials are never disclosed", (text) => /Never print,\s+quote, reproduce, log, or persist the configured command string, an expanded or resolved command line,\s+credentials, or shell\/tool diagnostics/u.test(text)],
  ["no bridge, parser, capture, session, or output mechanism is added", (text) => /Add no helper module,\s+command runner, parser service[\s\S]*plugin bridge,[\s\S]*Use the ordinary shell result directly\. Add no stderr redirection or suppression rule, separate capture\s+policy, output channel, buffering, truncation, redaction, output-size limit[\s\S]*session/u.test(text)],
  ["resolve and verify are the only consumed entries", (text) => /`resolve` and `verify` are consumed now\. `publish` and `publishing_identity` remain deferred/u.test(text)],
  ["verify uses the exact integration worktree and inherited process context", (text) => /`verify` \| Ordinary shell step in the exact integration-worktree cwd with inherited environment[\s\S]*stdout and stderr are inherited, informational, and unparsed[\s\S]*Exit status is authoritative/u.test(text)],
  ["verify runs after the atomic merge record and writes canonical evidence", (text) => /After\s+the atomic merged transition[\s\S]*runs that unchanged ordinary shell command once in `INTEGRATION_WORKTREE` with inherited\s+environment and stdio and writes canonical `evidence\/test-verifier\.json`/u.test(text)],
  ["absent config preserves merge behavior silently", (text) => /An absent config preserves\s+the old response and emits nothing new/u.test(text)],
  ["a post-record failure preserves the merged slice and forbids its reopening, reseeding, re-observation, or redispatch", (text) => /If the row is `merged` at exactly\s+`MERGE_COMMIT`, preserve its evidence, review, refs, attempts, paths, test plan, and merge commit;[\s\S]*stop before `status\.next`, wave calculation,\s+activation, reopen, reseed, slice re-observation, or redispatch\. Never reopen or redispatch a\s+merged slice\./u.test(text)],
  ["Gate 3 is a fresh independent observation", (text) => /Gate 3 observation is always fresh and independent[\s\S]*never shares, substitutes,\s+or optimizes from a post-merge repository verification result/u.test(text)],
  ["operator ownership and privileged protection remain in force", (text) => /It remains operator-owned:[\s\S]*refused by the privileged-path policy/u.test(text)],
  ["publication and identity remain deferred", (text) => /push-target migration is deferred to #224[\s\S]*consumption is deferred to #216/u.test(text)],
];
const README_CONTRACTS = [
  ["the exact four-entry schema", (text) => text.includes(CONFIG_SCHEMA)],
  ["three commands and one static identity", (text) => /`resolve`, `verify`, and `publish` are non-empty command\s+strings[\s\S]*`publishing_identity` is a static non-empty account name/u.test(text)],
  ["resolve and verify are consumed", (text) => /`resolve` and `verify` are consumed now/u.test(text)],
  ["ordinary shell, repository-root cwd, and FACTORY_INPUT", (text) => /ordinary shell step[\s\S]*repository-root cwd[\s\S]*`FACTORY_INPUT`/u.test(text)],
  ["empty and non-empty stdout have the direct contract", (text) => /Empty stdout means the input was not\s+recognized[\s\S]*Non-empty stdout is the direct,\s+unchanged `ISSUE_PAYLOAD`[\s\S]*top-level string `run_id`/u.test(text)],
  ["present invalid config refuses and absence declares no resolver", (text) => /present invalid,[\s\S]*config refuses closed[\s\S]*If `\.factory\.json` is absent, intake declares no resolver/u.test(text)],
  ["commands and credentials are not disclosed", (text) => /neither the configured or expanded\s+command line, shell diagnostics, nor credentials are printed, logged, or persisted/u.test(text)],
  ["verify follows the atomic merge record in the integration worktree", (text) => /After a slice merge is successfully and atomically recorded, `verify` runs once in the exact recorded\s+integration worktree/u.test(text)],
  ["verify inherits environment and stdio without parsing output", (text) => /configured string is submitted unchanged as one ordinary shell command[\s\S]*inherited environment and stdio[\s\S]*Stdout and stderr are visible, informational,\s+and unparsed; they are not captured or persisted/u.test(text)],
  ["verify exit and canonical evidence are authoritative", (text) => /Numeric child exit status is authoritative[\s\S]*canonical\s+`evidence\/test-verifier\.json` schema[\s\S]*current merged head/u.test(text)],
  ["absence is silent after merge", (text) => /after a recorded merge the factory silently\s+returns its previous response with no repository command, evidence write, or new output/u.test(text)],
  ["failure preserves the merge and routes before the next wave", (text) => /post-record\s+failure leaves the merged row and its slice evidence and review unchanged and stops before the next wave[\s\S]*test-file-only repair path/u.test(text)],
  ["Gate 3 is fresh and does not share evidence", (text) => /Gate 3 always runs a separate fresh integrated `test-verifier` observation[\s\S]*never shares, substitutes, or\s+optimizes from post-merge evidence/u.test(text)],
  ["the config remains operator-owned and privileged", (text) => /file is operator-owned,\s+committed, and protected as a privileged path/u.test(text)],
  ["deferred consumers are named", (text) => /push-target publication is deferred to #224[\s\S]*identity enforcement is deferred to #216/u.test(text)],
  ["the live config is not packaged", (text) => /live config\s+is not part of this package[\s\S]*no generated config or resolver asset is shipped/u.test(text)],
];
const ROOT_README_CONTRACTS = [
  ["the exact four-entry schema", (text) => text.includes(CONFIG_SCHEMA)],
  ["resolve and verify are consumed", (text) => /`resolve` and `verify` are consumed now/u.test(text)],
  ["verify runs after an atomic record in the integration worktree", (text) => /After a slice merge is successfully and atomically recorded, `verify` runs once in the exact recorded\s+integration worktree/u.test(text)],
  ["verify inherits environment and stdio and leaves output unparsed", (text) => /ordinary shell command[\s\S]*process environment and stdio inherited[\s\S]*Stdout and stderr remain visible,\s+informational, and unparsed/u.test(text)],
  ["verify status and canonical evidence are authoritative", (text) => /numeric child exit status is\s+authoritative[\s\S]*canonical `evidence\/test-verifier\.json` schema/u.test(text)],
  ["absent config silently preserves merge behavior", (text) => /absence silently preserves the previous merge response and progression, with no\s+repository command, evidence write, or new output/u.test(text)],
  ["post-record failure preserves merged-slice records and routes before the next wave", (text) => /post-record verification failure does not roll back\s+or rewrite the merged row or its slice evidence and review[\s\S]*stops before the next wave/u.test(text)],
  ["Gate 3 is separately fresh without evidence sharing", (text) => /Gate 3 always performs its own fresh integrated `test-verifier` observation[\s\S]*never shares,\s+substitutes, or optimizes from post-merge evidence/u.test(text)],
  ["operator ownership and privileged protection remain in force", (text) => /file is operator-owned,\s+committed, and protected as a privileged path/u.test(text)],
  ["publish and identity remain deferred", (text) => /push-target publication is deferred to #224[\s\S]*identity enforcement is deferred to #216/u.test(text)],
];
const OPERATING_CONTRACTS = [
  ["the exact four-entry schema", (text) => text.includes(CONFIG_SCHEMA)],
  ["verify runs unchanged in the integration worktree with inherited process context", (text) => /unchanged string runs once as an ordinary shell command in the exact recorded integration-worktree cwd with inherited environment and stdio/u.test(text)],
  ["verify output is inherited and unparsed", (text) => /Stdout and stderr are visible, informational, and unparsed rather than captured or persisted/u.test(text)],
  ["verify status is authoritative", (text) => /Numeric child exit status is authoritative/u.test(text)],
  ["post-record evidence is canonical", (text) => /merge record commits before `verify` begins[\s\S]*canonical `evidence\/test-verifier\.json` schema/u.test(text)],
  ["failure preserves merged-slice records and blocks the next wave", (text) => /leaves the merged slice, its merge commit, its evidence, and its review unchanged and stops\s+the driver before it consults or activates the next wave/u.test(text)],
  ["failure routing keeps production source out of repair", (text) => /Production defects are not repaired on the integration branch and terminalize `needs-human`[\s\S]*confirmed test-only finding may change test files only/u.test(text)],
  ["absent config silently preserves prior behavior", (text) => /An absent `\.factory\.json` remains silent compatibility behavior[\s\S]*returns the same merge result as before this consumer existed/u.test(text)],
  ["Gate 3 remains fresh and independent", (text) => /Gate 3 always runs a fresh, independent integrated\s+`test-verifier` observation[\s\S]*without sharing or optimizing from the post-merge result/u.test(text)],
  ["operator ownership and privileged protection remain in force", (text) => /live file is operator-owned[\s\S]*protected by the\s+privileged-path policy/u.test(text)],
  ["publish and identity remain deferred", (text) => /Push-target publication is deferred to #224[\s\S]*deferred to #216/u.test(text)],
];

function assertContracts(text, contracts, artifact) {
  for (const [contract, matches] of contracts) {
    assert.equal(matches(text), true, `${artifact} must preserve the contract that ${contract}`);
  }
}

function pack(name, destination) {
  const output = execFileSync("npm", ["pack", "--json", "--pack-destination", destination],
    { cwd: join(root, "packages", name), encoding: "utf8" });
  const [metadata] = JSON.parse(output);
  return { tarball: join(destination, metadata.filename), files: metadata.files.map((file) => file.path) };
}

// A consumer with both tarballs really installed. Both go on one command line so npm can satisfy the
// inter-package dependency locally instead of reaching for the registry.
function installConsumer(dir) {
  const packed = Object.fromEntries(PACKAGES.map((name) => [name, pack(name, dir)]));
  const consumer = join(dir, "consumer");
  mkdirSync(consumer, { recursive: true });
  writeFileSync(join(consumer, "package.json"),
    JSON.stringify({ name: "pack-consumer", type: "module", private: true }));
  execFileSync("npm", ["install", "--silent", "--no-audit", "--no-fund",
    ...PACKAGES.map((name) => packed[name].tarball)], { cwd: consumer, encoding: "utf8" });
  return { consumer, packed };
}

// Imports run inside the consumer so bare specifiers resolve through its node_modules, the way a
// dependent's code would. A subprocess is the only honest way to do that from here.
function importInConsumer(consumer, script) {
  return execFileSync("node", ["--input-type=module", "-e", script], { cwd: consumer, encoding: "utf8" });
}

function commitOperatorRepository(consumer) {
  writeFileSync(join(consumer, ".gitignore"), "node_modules/\n.factory/\n.factory-sandboxes/\n");
  writeFileSync(join(consumer, "operator.txt"), "committed operator fixture\n");
  execFileSync("git", ["init", "--initial-branch=main"], { cwd: consumer, encoding: "utf8" });
  execFileSync("git", ["config", "user.name", "Factory Pack Test"], { cwd: consumer });
  execFileSync("git", ["config", "user.email", "factory-pack@example.test"], { cwd: consumer });
  execFileSync("git", ["add", ".gitignore", "operator.txt", "package.json", "package-lock.json"], { cwd: consumer });
  execFileSync("git", ["commit", "-m", "Create operator fixture"], { cwd: consumer, encoding: "utf8" });
  return realpathSync(consumer);
}

describe("what actually ships", () => {
  it("packs every file the entrypoints and the docs require", () => {
    const dir = mkdtempSync(join(tmpdir(), "ff-pack-files-"));
    try {
      const factory = pack("feature-factory", dir);
      const opencode = pack("opencode-feature-factory", dir);

      // The skill is useless without the agents it dispatches, and both READMEs promise them.
      for (const required of ["skills/feature/SKILL.md", "bin/factory.js", "state/index.js", "README.md", "LICENSE"]) {
        assert.ok(factory.files.includes(required), `feature-factory must ship ${required}`);
      }
      const agents = factory.files.filter((file) => file.startsWith("agents/"));
      assert.equal(agents.length, 11, `feature-factory must ship all eleven agents, packed ${agents.length}`);
      for (const [name, { files }] of [["feature-factory", factory], ["opencode-feature-factory", opencode]]) {
        assert.deepEqual(files.filter((file) => file.startsWith(".factory/")), [],
          `${name} must not package operator-owned .factory content`);
        const repositoryCommandAssets = files.filter((file) => /(^|\/)(?:(?:factory[-_.]|generated[-_.])?(?:config|resolver)|config-resolver)(?:[./_-]|$)/u.test(file));
        assert.deepEqual(repositoryCommandAssets,
          name === "opencode-feature-factory" ? ["plugin/config.js"] : [],
          `${name} must not add a generated config or resolver asset`);
      }

      const sourceSkill = readFileSync(join(root, "packages", "feature-factory", "skills", "feature", "SKILL.md"), "utf8");
      const sourcePackageReadme = readFileSync(join(root, "packages", "feature-factory", "README.md"), "utf8");
      assertContracts(sourceSkill, SKILL_CONTRACTS, "source skill");
      assertContracts(sourcePackageReadme, README_CONTRACTS, "source package README");

      // observe/ is not an entrypoint, which is exactly why it was left out: both entrypoints import
      // it, and nothing that only reads `exports` would notice.
      for (const required of ["plugin/index.js", "tui/dist/index.js", "observe/runs.js", "README.md", "LICENSE"]) {
        assert.ok(opencode.files.includes(required), `opencode-feature-factory must ship ${required}`);
      }
      // The host loads the built bundle and does not transform JSX, so shipping source instead of
      // output would fail at load with a syntax error.
      assert.deepEqual(opencode.files.filter((file) => file.endsWith(".jsx")), [],
        "raw JSX must not ship; the host cannot transform it");

      // Tests are not a release artifact. Shipping them doubles the tarball and invites a consumer to
      // run a suite against their own repository.
      for (const { files } of [factory, opencode]) {
        assert.deepEqual(files.filter((file) => file.includes("test/")), []);
      }

      const readme = readFileSync(join(root, "README.md"), "utf8");
      const operating = readFileSync(join(root, "OPERATING.md"), "utf8");
      assertContracts(readme, ROOT_README_CONTRACTS, "root README");
      assertContracts(operating, OPERATING_CONTRACTS, "operator guide");
      assert.deepEqual(readme.split(/\r?\n/u).filter((line) => line.startsWith("factory init <run-id>")), [
        "factory init <run-id> [--branch B] [--worktree W] [--pr-base TARGET] [--issue KEY] [--mode interactive|headless|autonomous]",
      ]);
      const readmeContracts = [
        ["fresh init receives O", /canonical operator checkout `O` as `--repo O`/u],
        ["S is deterministic", /`S = O\/\.factory-sandboxes\/<run-id>`/u],
        ["init returns selected roots", /returns its canonical `sandbox_path` and absolute `run_dir`/u],
        ["later commands use S", /returned\s+`sandbox_path` as `--repo S`/u],
        ["the clone destination is pre-reserved", /pre-reserves an empty `S`/u],
        ["one local clone is attempted", /exactly one\s+`git clone --local -- O S` attempt/u],
        ["proof precedes publication", /physical containment proof before publishing\s+`run\.json`/u],
        ["collisions are retained", /collision is retained for inspection/u],
        ["collisions are not reused, retried, or deleted", /never\s+reused, retried, or deleted during bootstrap or refusal/u],
        ["branch recovery precedes lock and dispatch", /Branch creation or recovery and provenance checks finish\s+before a lock is claimed or an agent is dispatched/u],
        ["push-target mismatch is redacted", /neither effective target is printed, persisted, or included in an error cause/u],
        ["direct O state is legacy only", /`O\/\.factory\/<run-id>` is supported only as\s+a legacy direct-run location/u],
        ["deletion is Step 7 only", /Sandbox deletion is allowed only during the verified Step 7 completed\s+handoff/u],
      ];
      for (const [contract, pattern] of readmeContracts) {
        assert.match(readme, pattern, `README must document that ${contract}`);
      }
      assert.doesNotMatch(readme, /git clean -xdf/u,
        "README must not advertise an unverified deletion path outside Step 7");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("installs from local tarballs and imports by bare specifier", () => {
    const dir = mkdtempSync(join(tmpdir(), "ff-pack-install-"));
    try {
      const { consumer } = installConsumer(dir);

      // The dependency has to have resolved locally, or the install silently pulled something else.
      const manifest = JSON.parse(readFileSync(
        join(consumer, "node_modules", "opencode-feature-factory", "package.json"), "utf8"));
      const factory = JSON.parse(readFileSync(
        join(consumer, "node_modules", "feature-factory", "package.json"), "utf8"));
      assert.equal(manifest.dependencies["feature-factory"], factory.version,
        "the installed integration must be pinned to the installed factory");
      assert.deepEqual(factory.exports, { ".": "./state/index.js" },
        "the existing package export must remain sufficient");
      assert.deepEqual(factory.files,
        ["bin", "core", "observe", "state", "skills", "agents", "README.md", "LICENSE"],
        "the existing files allowlist must ship the contract without generated assets");
      // The integration depends on the factory and nothing else. It registers a tool as a plain
      // object literal rather than through `@opencode-ai/plugin`'s `tool()` helper — that helper is a
      // pass-through, and depending on it would pin a host-coupled package into the packed graph for
      // no behaviour. Both host packages stay absent, so a consumer installs neither.
      for (const absent of ["@opencode-ai/plugin", "@opencode-ai/sdk"]) {
        assert.equal(manifest.dependencies[absent], undefined,
          `the integration must not depend on ${absent}; the host supplies it`);
      }

      // Bare specifiers, so `exports` names and conditions are exercised. Importing a manifest's
      // target path directly — which this test used to do — passes even when the export map is wrong.
      const output = importInConsumer(consumer, `
        const factory = await import("feature-factory");
        const plugin = await import("opencode-feature-factory");
        const tui = await import("opencode-feature-factory/tui");
        const missing = ["readRun", "readRunUnchecked", "nextAction", "validateRun"]
          .filter((name) => typeof factory[name] !== "function");
        if (missing.length) throw new Error("feature-factory is missing: " + missing.join(", "));
        if (typeof plugin.default !== "function") throw new Error("plugin root must default-export a function");
        if (typeof tui.default !== "object" || typeof tui.default.tui !== "function") {
          throw new Error("the tui entry must default-export an object carrying a tui() hook");
        }
        if (factory.transition !== undefined) throw new Error("the write path must not be exported");
        console.log("ok");
      `);
      assert.match(output, /^ok$/mu);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("runs the CLI through the installed .bin symlink", () => {
    const dir = mkdtempSync(join(tmpdir(), "ff-pack-bin-"));
    try {
      const { consumer } = installConsumer(dir);
      const operator = commitOperatorRepository(consumer);
      // `.bin/factory` is a symlink into the package. Invoking the real path instead — which this
      // test used to do — skips the one shape that broke the entry guard: `process.argv[1]` is the
      // symlink as typed while `import.meta.url` is resolved, so a naive comparison of the two makes
      // the CLI exit 0 having done nothing.
      const shim = join(consumer, "node_modules", ".bin", "factory");
      const help = execFileSync("node", [shim, "--help"], { cwd: consumer, encoding: "utf8" });
      assert.match(help, /factory init <run-id>/u, "the CLI must run through the shim and print usage");
      assert.match(help, /--issue KEY/u, "the packed CLI must advertise the active issue flag");
      assert.doesNotMatch(help, /--jira/u, "the packed CLI must not advertise the obsolete flag");

      const initOutput = execFileSync("node", [
        shim, "init", "packed-readme", "--branch", "feature/packed-readme", "--worktree", ".",
        "--pr-base", "main", "--issue", "ISSUE-214", "--mode", "headless", "--repo", operator, "--json",
      ], { cwd: consumer, encoding: "utf8" });
      const initialized = JSON.parse(initOutput);
      const sandbox = join(operator, ".factory-sandboxes", "packed-readme");
      const runDir = join(sandbox, ".factory", "packed-readme");
      assert.equal(initialized.sandbox_path, sandbox, "installed init must return deterministic S");
      assert.equal(initialized.run_dir, runDir, "installed init must return the absolute run directory in S");
      assert.equal(existsSync(join(operator, ".factory", "packed-readme", "run.json")), false,
        "fresh installed init must not publish a legacy direct record in O");
      const run = JSON.parse(readFileSync(join(initialized.run_dir, "run.json"), "utf8"));
      assert.equal(run.issue_key, "ISSUE-214");
      assert.equal(Object.hasOwn(run, "jira_key"), false);

      // And it must actually do work through the shim, not merely print. Later reads select the
      // returned sandbox explicitly rather than relying on the operator checkout to redirect them.
      const status = execFileSync("node", [
        shim, "status", "packed-readme", "--repo", initialized.sandbox_path, "--json",
      ],
        { cwd: consumer, encoding: "utf8" });
      const selected = JSON.parse(status);
      assert.equal(selected.valid, true, "status must read the initialized record from returned S");
      assert.equal(selected.sandbox_path, initialized.sandbox_path, "status must report the selected S");
      const absent = execFileSync("node", [
        shim, "status", "nope", "--repo", initialized.sandbox_path, "--json",
      ], { cwd: consumer, encoding: "utf8" });
      assert.match(absent, /"valid": false/u, "the CLI must report an absent run rather than crash");

      const skill = readFileSync(
        join(consumer, "node_modules", "feature-factory", "skills", "feature", "SKILL.md"), "utf8");
      const packageReadme = readFileSync(
        join(consumer, "node_modules", "feature-factory", "README.md"), "utf8");
      assertContracts(skill, SKILL_CONTRACTS, "installed skill");
      assertContracts(packageReadme, README_CONTRACTS, "installed package README");
      for (const [contract, pattern] of [
        ["init is requested with O", /factory init "\$R" --branch "\$FEATURE_BRANCH"[^\n]*--repo "\$O" --json/u],
        ["S comes from the response", /RUN_REPO="<exact response sandbox_path>"/u],
        ["one local clone follows reservation", /pre-reserves the deterministic sandbox, performs exactly one\s+`git clone --local -- O S`/u],
        ["physical proof precedes run.json", /completes the physical containment proof, and only then publishes\s+`run\.json`/u],
        ["failed init is not retried", /do not substitute another destination or repeat init/u],
        ["push mismatch omits targets", /never contains either target/u],
        ["completed removal is guarded", /Only after all ref and archive verification succeeds, guard the destructive removal/u],
      ]) {
        assert.match(skill, pattern, `installed skill must preserve the contract that ${contract}`);
      }
      const recovery = skill.indexOf("### Feature branch provenance and crash recovery");
      const beforeLock = skill.indexOf("Immediately before claiming or stealing a lock", recovery);
      const lock = skill.indexOf('factory lock "$R" claim', beforeLock);
      const dispatch = skill.indexOf("dispatch the planned ticket", lock);
      assert.ok(recovery >= 0 && recovery < beforeLock && beforeLock < lock && lock < dispatch,
        "installed skill must recover/prove the branch before lock and dispatch");

      // Executed *directly*, not through `node`. That is the only way the shebang and the executable
      // bit get exercised: npm sets the mode when packing a `bin` entry, and a tarball missing either
      // gives "permission denied" or "syntax error" on a machine where nobody thought to prefix node.
      const direct = execFileSync(shim, ["--help"], { cwd: consumer, encoding: "utf8" });
      assert.match(direct, /factory init <run-id>/u, "the shim must be directly executable");
      const source = readFileSync(join(consumer, "node_modules", "feature-factory", "bin", "factory.js"), "utf8");
      assert.match(source, /^#!\/usr\/bin\/env node\n/u, "and carry a shebang, or direct execution is a syntax error");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
