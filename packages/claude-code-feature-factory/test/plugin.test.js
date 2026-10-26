import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ALLOWED_TOOLS, claudeArgs, launch, parseArgs } from "../launcher/launch.js";

const here = (path) => new URL(`../${path}`, import.meta.url);
const read = (path) => readFileSync(here(path), "utf8");
const manifest = JSON.parse(read("package.json"));
const plugin = JSON.parse(read(".claude-plugin/plugin.json"));
const marketplace = JSON.parse(readFileSync(new URL("../../../.claude-plugin/marketplace.json", import.meta.url), "utf8"));
const factoryRoot = new URL("../../feature-factory/", import.meta.url);
const factoryManifest = JSON.parse(readFileSync(new URL("package.json", factoryRoot), "utf8"));
const canonicalWorkflow = readFileSync(new URL("WORKFLOW.md", factoryRoot), "utf8");
const skill = read("skills/feature/SKILL.md");

// Every file a directory holds, relative to it, so two trees compare as one assertion.
function tree(url, prefix = "") {
  return readdirSync(url, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap((entry) =>
    entry.isDirectory() ? tree(new URL(`${entry.name}/`, url), `${prefix}${entry.name}/`) : [`${prefix}${entry.name}`]);
}

describe("Claude Code plugin contract", () => {
  it("ships one version everywhere a marketplace or the CLI reads it, and the CLI it was built with", () => {
    // ENFORCEMENT: a half-applied bump is a marketplace entry that installs a package other than the one
    // released, or a plugin whose manifest names a version it does not carry.
    assert.equal(manifest.name, "claude-code-feature-factory");
    for (const [where, version] of [
      ["plugin.json", plugin.version],
      ["the marketplace entry", marketplace.plugins.find((entry) => entry.name === plugin.name)?.source.version],
      ["feature-factory", factoryManifest.version],
    ]) assert.equal(version, manifest.version, `${where} must carry ${manifest.version}`);
    assert.deepEqual(marketplace.plugins.find((entry) => entry.name === plugin.name).source,
      { source: "npm", package: manifest.name, version: manifest.version });
    // The plugin name is the namespace of every subagent the skill dispatches to.
    assert.equal(plugin.name, "feature-factory");
    // No runtime dependency: a marketplace install does not install one without a published lockfile.
    assert.equal(manifest.dependencies, undefined);
    // A plugin's `bin/` goes on the Bash PATH and keeps it off claude.ai; the launcher lives elsewhere.
    assert.ok(!manifest.files.includes("bin"), "a plugin bin/ directory is put on PATH");

    // The vendored CLI and the registered agents are exactly what feature-factory publishes, byte for byte.
    const vendored = here("vendor/feature-factory/");
    const published = [...factoryManifest.files, "package.json"].flatMap((entry) =>
      statSync(new URL(entry, factoryRoot)).isDirectory() ? tree(new URL(`${entry}/`, factoryRoot), `${entry}/`) : [entry]).sort();
    assert.deepEqual(tree(vendored).sort(), published);
    for (const file of published) {
      assert.equal(readFileSync(new URL(file, vendored), "utf8"), readFileSync(new URL(file, factoryRoot), "utf8"), `vendor/feature-factory/${file}`);
    }
    assert.deepEqual(tree(here("agents/")), tree(new URL("agents/", factoryRoot)).filter((name) => name.endsWith(".md")));
    for (const name of tree(here("agents/"))) {
      const text = read(`agents/${name}`);
      assert.equal(text, readFileSync(new URL(`agents/${name}`, factoryRoot), "utf8"), `agents/${name}`);
      // ENFORCEMENT: delegation one level deep holds only because no specialist may call the Agent tool;
      // Claude Code otherwise lets a subagent spawn its own. Frontmatter `model` must be a family name it
      // resolves, so a tier never reaches a host that needs an exact id.
      const front = text.slice(4, text.indexOf("\n---", 4));
      const tools = /^tools:\s*(.+)$/mu.exec(front)?.[1].split(/,\s*/u) ?? [];
      assert.ok(tools.length > 0 && !tools.includes("Agent") && !tools.includes("Task"), `${name} tools: ${tools}`);
      assert.match(front, /^model: (?:sonnet|opus|haiku|fable)$/mu, `${name} model`);
    }
  });

  it("binds the canonical workflow, session and CLI through Claude Code's substitutions", () => {
    assert.equal(read("skills/feature/WORKFLOW.md"), canonicalWorkflow);
    assert.ok(skill.startsWith("---\nname: feature\ndescription: "));
    for (const [label, contract] of [
      ["workflow path", /Read `\$\{CLAUDE_SKILL_DIR\}\/WORKFLOW\.md` in full/u],
      ["cli", /^CLI=\$\{CLAUDE_PLUGIN_ROOT\}\/vendor\/feature-factory\/bin\/factory\.js$/mu],
      ["agents", /^AGENTS=\$\{CLAUDE_PLUGIN_ROOT\}\/agents$/mu],
      ["session", /^SESSION_ID=claude-code:\$\{CLAUDE_SESSION_ID\}$/mu],
      ["unsubstituted refusal", /contain no unsubstituted `\$\{`/u],
      ["namespaced dispatch", /`subagent_type: "feature-factory:story-reader"`/u],
      ["foreground dispatch", /Never set `run_in_background`/u],
      ["parallel wave", /every Agent call of the wave in one message/u],
      ["no generic agents", /never to `general-purpose`, `Explore`/u],
      ["background placement", /reject an exact case-sensitive first `--background`/u],
      ["retry refusal", /--max-retries must be a positive integer; no run created\./u],
      ["closed order", /closed pre-context order:\s+canonical workflow load; placement rejection/u],
      ["never PATH", /`node "\$CLI" init \.\.\.`, never from `PATH`/u],
      ["no hand-written state", /never hand-write `run\.json`/u],
    ]) assert.match(skill, contract, label);
    // ENFORCEMENT, as on every host: an init assembled from flag fragments once dropped `--json` and
    // stranded a live sandbox, so the skill carries the canonical invocation and pre-init step verbatim.
    const init = canonicalWorkflow.split("\n").find((line) => line.startsWith("INIT_RESPONSE="));
    assert.ok(init?.endsWith("--json)\"") && skill.includes(init), "the canonical init invocation, verbatim");
    const start = canonicalWorkflow.slice(canonicalWorkflow.indexOf("**Start from the remote's base.**"), canonicalWorkflow.indexOf("An explicit `PR_BASE` wins.")).trim();
    assert.ok(start.length > 1500 && skill.includes(start), "the canonical pre-init fast-forward step, verbatim");
    for (const otherHost of [/rlm\.spawn/u, /agent_message/u, /IPython/u, /not readable until init/u]) {
      assert.doesNotMatch(skill, otherHost, `another host's binding: ${otherHost}`);
    }
  });

  it("launches a detached, isolated -p session that cannot prompt", () => {
    const options = parseArgs(["--model", "sonnet", "--", "--autonomous", "#12"]);
    assert.equal(options.request, "--autonomous #12");
    for (const [bad, message] of [[["#12"], /usage/u], [["--"], /usage/u], [["--cwd", "--", "x"], /missing value for --cwd/u], [["--nope", "x", "--", "y"], /unknown option --nope/u]]) {
      assert.throws(() => parseArgs(bad), message);
    }
    const args = claudeArgs(options, "sid", "/plugin");
    const flag = (name) => args[args.indexOf(name) + 1];
    assert.equal(args[0], "-p");
    assert.equal(args[1], "/feature-factory:feature --autonomous #12");
    // ENFORCEMENT: each flag below closes a trap that was hit live. Without `--setting-sources project`
    // the user's permission settings let an unallowed tool run; without `--strict-mcp-config` the user's
    // connectors reached the subagents; without `--permission-prompts none` a prompt would wait forever.
    for (const [name, value] of [["--plugin-dir", "/plugin"], ["--session-id", "sid"], ["--setting-sources", "project"],
      ["--permission-mode", "acceptEdits"], ["--permission-prompts", "none"], ["--allowedTools", ALLOWED_TOOLS.join(",")],
      ["--output-format", "stream-json"], ["--model", "sonnet"]]) assert.equal(flag(name), value, name);
    assert.ok(args.includes("--strict-mcp-config"));
    assert.ok(!claudeArgs({ request: "x" }, "sid").includes("--model"), "no model flag unless one is asked for");

    // The real spawn, against a stub `claude` that records its argv and outlives the launcher.
    const dir = mkdtempSync(join(tmpdir(), "ff-claude-launch-"));
    try {
      const stub = join(dir, "claude");
      writeFileSync(stub, `#!/bin/sh\nprintf '%s\\n' "$PWD" "$@" > ${JSON.stringify(join(dir, "argv"))}\necho streamed\n`);
      chmodSync(stub, 0o755);
      const log = join(dir, "run.jsonl");
      const handle = launch({ ...parseArgs(["--cwd", dir, "--claude", stub, "--log", log, "--", "x"]) }, new URL("..", import.meta.url).pathname);
      assert.match(handle.sessionId, /^[0-9a-f-]{36}$/u);
      assert.equal(handle.stop, `kill -TERM -- -${handle.pid}`);
      for (const deadline = Date.now() + 5000; Date.now() < deadline && !readFileSync(log, "utf8").includes("streamed");) execFileSync("sleep", ["0.1"]);
      const argv = readFileSync(join(dir, "argv"), "utf8").split("\n");
      assert.equal(argv[argv.indexOf("--session-id") + 1], handle.sessionId);
      assert.ok(argv[0].endsWith(dir.split("/").pop()), "the session runs in --cwd");
      assert.match(readFileSync(log, "utf8"), /streamed/u, "output goes to the log");
      // Without the bundled CLI nothing is started.
      assert.throws(() => launch({ ...parseArgs(["--claude", stub, "--", "x"]) }, dir), /no bundled factory CLI/u);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
