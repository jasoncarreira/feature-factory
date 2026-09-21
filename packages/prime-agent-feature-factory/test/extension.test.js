import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import featureFactoryExtension, { dispatchProfiles, factoryResources, primeSessionId, profileFor } from "../extensions/index.js";

// `resolveFromOwnPath` walks up from the extension's OWN location, so exercising it means putting a copy
// of the extension in a real install layout and importing it from there -- injecting a stub proves the
// call site and nothing about the traversal or where it starts. Each case gets its own temp root so the
// copies have distinct URLs and Node does not hand back one cached module for all three.
const extensionSource = fileURLToPath(new URL("../extensions/index.js", import.meta.url));
async function extensionInstalledAt(layout) {
  // Through the realpath: `import.meta.url` of the imported copy resolves symlinks, and on macOS the
  // temp dir is /var -> /private/var, so a walk that is correct still reports the other spelling.
  const root = realpathSync(mkdtempSync(join(tmpdir(), "prime-ext-")));
  const pkg = join(root, "node_modules", "prime-agent-feature-factory");
  mkdirSync(join(pkg, "extensions"), { recursive: true });
  copyFileSync(extensionSource, join(pkg, "extensions", "index.js"));
  writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "prime-agent-feature-factory", type: "module" }));
  if (layout !== "absent") {
    const host = layout === "nested" ? pkg : root;
    mkdirSync(join(host, "node_modules", "feature-factory"), { recursive: true });
    writeFileSync(join(host, "node_modules", "feature-factory", "package.json"), JSON.stringify({ name: "feature-factory" }));
  }
  const module = await import(pathToFileURL(join(pkg, "extensions", "index.js")).href);
  return { root, pkg, module, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function host() {
  const commands = new Map();
  const tools = new Map();
  const messages = [];
  return {
    pi: {
      registerCommand(name, command) { commands.set(name, command); },
      registerTool(tool) { tools.set(tool.name, tool); },
      sendUserMessage(parts) { messages.push(parts); },
    }, commands, tools, messages,
  };
}

const resolveFeatureFactory = () => "/opt/prime/node_modules/feature-factory/state/index.js";

describe("Prime extension", () => {
  it("derives installed resources and a stable session owner", async () => {
    // A failed resolution used to propagate the resolver's bare "Cannot find module 'feature-factory'",
    // which the host prints under "Failed to load extension" and which names no remedy. Seen for real on a
    // global install where the dependency WAS present and the same specifier resolved fine from this
    // file's own path -- so the message has to point at both possibilities, not just a missing package.
    // The fix for the Prime Agent regression: bare resolution is the host's to control, the install layout
    // is not. When the host's resolver cannot see this package's dependency, the walk up from this file
    // finds it, so the extension loads rather than dying at startup.
    const beside = "/install/node_modules/prime-agent-feature-factory/node_modules/feature-factory";
    assert.deepEqual(
      factoryResources(() => { throw new Error("Cannot find module 'feature-factory'"); }, () => beside),
      { agents: `${beside}/agents`, cli: `${beside}/bin/factory.js` },
      "a host resolver that cannot see the dependency must not stop the extension loading",
    );
    // The traversal itself, against real directories, with `findBeside` left at its default. The injected
    // case above proves dispatch; these prove where the walk starts and how far it goes -- a walk rooted
    // at the process cwd, or one that stopped at the package boundary, passes the injected test and fails
    // every one of these.
    const throwingResolve = () => { throw new Error("Cannot find module 'feature-factory'"); };
    for (const [layout, expected] of [["nested", "pkg"], ["hoisted", "root"]]) {
      const installed = await extensionInstalledAt(layout);
      try {
        const base = expected === "pkg" ? installed.pkg : installed.root;
        assert.deepEqual(installed.module.factoryResources(throwingResolve),
          { agents: join(base, "node_modules", "feature-factory", "agents"),
            cli: join(base, "node_modules", "feature-factory", "bin", "factory.js") },
          `the walk must find a ${layout} dependency from the extension's own location`);
      } finally { installed.cleanup(); }
    }
    // And absence is still an error rather than a wrong path invented from the walk.
    const missing = await extensionInstalledAt("absent");
    try {
      assert.throws(() => missing.module.factoryResources(throwingResolve),
        /could not resolve its 'feature-factory' dependency/u,
        "an install genuinely lacking the dependency must fail, not resolve to something made up");
    } finally { missing.cleanup(); }

    // Only when the install genuinely lacks it does this fail -- and then it says what to do.
    assert.throws(() => factoryResources(() => { throw new Error("Cannot find module 'feature-factory'"); }, () => null), (error) => {
      assert.match(error.message, /could not resolve its 'feature-factory' dependency from .+extensions/u,
        "the error must name the file resolution was attempted from");
      assert.match(error.message, /npm install -g prime-agent-feature-factory/u, "and the remedy");
      assert.match(error.message, /loads this extension from `?its installed path/u, "and the other cause");
      assert.match(error.cause.message, /Cannot find module/u, "the original resolver error must survive as the cause");
      return true;
    });
    assert.deepEqual(factoryResources(resolveFeatureFactory), {
      agents: "/opt/prime/node_modules/feature-factory/agents",
      cli: "/opt/prime/node_modules/feature-factory/bin/factory.js",
    });
    assert.equal(primeSessionId("/tmp/abc/session-42.json", "unused"), "prime-agent:session-42.json");
    assert.equal(primeSessionId(undefined, "fixed"), "prime-agent:fixed");
  });

  it("returns current-session context through a tool instead of process-global environment", async () => {
    const runtime = host();
    featureFactoryExtension(runtime.pi, { resolveFeatureFactory });
    const tool = runtime.tools.get("feature_factory_context");
    const result = await tool.execute("call", {}, undefined, undefined, {
      sessionManager: { getSessionFile: () => "/tmp/sessions/run.jsonl" },
    });
    assert.deepEqual(result.details, {
      sessionId: "prime-agent:run.jsonl",
      agents: "/opt/prime/node_modules/feature-factory/agents",
      cli: "/opt/prime/node_modules/feature-factory/bin/factory.js",
      // Empty because this stub resolver names a directory that does not exist. The shape is still
      // reported, so a driver binds one key rather than branching on its absence.
      dispatch: {},
    });
    assert.equal(result.content[0].text, JSON.stringify(result.details));
  });

  it("memoizes an ephemeral lock identity for each live Prime session", async () => {
    const runtime = host();
    featureFactoryExtension(runtime.pi, { resolveFeatureFactory });
    const tool = runtime.tools.get("feature_factory_context");
    const firstSession = { getSessionFile: () => undefined };
    const secondSession = { getSessionFile: () => undefined };

    const first = await tool.execute("one", {}, undefined, undefined, { sessionManager: firstSession });
    const repeated = await tool.execute("two", {}, undefined, undefined, { sessionManager: firstSession });
    const other = await tool.execute("three", {}, undefined, undefined, { sessionManager: secondSession });

    assert.equal(repeated.details.sessionId, first.details.sessionId);
    assert.notEqual(other.details.sessionId, first.details.sessionId);
  });

  it("registers /feature and forwards its arguments unchanged in a separate text part", async () => {
    const runtime = host();
    featureFactoryExtension(runtime.pi, { resolveFeatureFactory });
    const command = runtime.commands.get("feature");
    const notifications = [];
    const ctx = { isIdle: () => true, ui: { notify: (...args) => notifications.push(args) } };
    const request = "--autonomous  preserve   spacing";
    await command.handler(request, ctx);
    assert.deepEqual(notifications, []);
    assert.equal(runtime.messages.length, 1);
    assert.match(runtime.messages[0][0].text, /Load and follow the feature skill/u);
    assert.deepEqual(runtime.messages[0][1], { type: "text", text: request });
  });

  it("rejects empty invocations and refuses to interrupt an active turn", async () => {
    const runtime = host();
    featureFactoryExtension(runtime.pi, { resolveFeatureFactory });
    const command = runtime.commands.get("feature");
    const notifications = [];
    const ui = { notify: (...args) => notifications.push(args) };
    await command.handler("   ", { isIdle: () => true, ui });
    await command.handler("ticket-1", { isIdle: () => false, ui });
    assert.equal(runtime.messages.length, 0);
    assert.deepEqual(notifications.map(([message, level]) => [message, level]), [
      ["Usage: /feature [--autonomous | --headless] <request>", "warning"],
      ["The agent is busy; wait before starting a feature run.", "warning"],
    ]);
  });

  // Prime takes `model` and `thinking` on rlm.spawn and nothing else, so what the operator configures
  // has to arrive resolved. These run against the real shipped agent directory rather than a fixture:
  // the resolution reads `role` and `effort` out of that frontmatter, and a fixture would prove the
  // merge while saying nothing about the files actually shipped.
  const AGENTS = fileURLToPath(new URL("../../feature-factory/agents", import.meta.url));

  it("spawns every specialist with its declared effort as the thinking level, and no model", () => {
    const dispatch = dispatchProfiles(AGENTS);
    // The whole set, so a new agent that forgets `effort` or `role` fails here rather than silently
    // spawning at the parent's level.
    assert.deepEqual(dispatch["spec-writer"], { role: "planning", thinking: "xhigh" });
    assert.deepEqual(dispatch["backend-builder"], { role: "builder", thinking: "medium" });
    assert.deepEqual(dispatch["story-reader"], { role: "story", thinking: "low" });
    assert.equal(Object.keys(dispatch).length, 11);
    for (const [name, entry] of Object.entries(dispatch)) {
      assert.ok(entry.thinking, `${name} declares no usable effort`);
      assert.ok(entry.role, `${name} declares no role`);
      assert.equal(entry.model, undefined, `${name} pinned a model with no operator profile`);
    }
  });

  it("resolves a profile through agent, role, default and bare levels in that order", () => {
    const options = {
      profile: { model: "p/bare" },
      profiles: {
        default: { model: "p/default" },
        reviewer: { model: "p/reviewer", thinking: "max" },
        "work-reviewer": { model: "p/named" },
      },
    };
    const dispatch = dispatchProfiles(AGENTS, options);
    assert.equal(dispatch["work-reviewer"].model, "p/named");          // agent beats role
    assert.equal(dispatch["implementation-validator"].model, "p/reviewer"); // role beats default
    assert.equal(dispatch["backend-builder"].model, "p/default");      // default beats bare
    assert.equal(dispatchProfiles(AGENTS, { profile: { model: "p/bare" } })["backend-builder"].model, "p/bare");
    // A profile that supplies only a model leaves the declared effort in place.
    assert.equal(dispatch["work-reviewer"].thinking, "high");
    assert.equal(dispatch["implementation-validator"].thinking, "max");
  });

  it("drops a thinking level Prime would reject instead of failing the spawn with it", () => {
    // Negative control for the level list: `max` is real and survives, `ludicrous` is not and is
    // omitted, which makes the child inherit and clamp rather than fail admission.
    const good = dispatchProfiles(AGENTS, { profiles: { planning: { thinking: "max" } } });
    const bad = dispatchProfiles(AGENTS, { profiles: { planning: { thinking: "ludicrous" } } });
    assert.equal(good["spec-writer"].thinking, "max");
    assert.equal(bad["spec-writer"].thinking, undefined);
    assert.equal(bad["spec-writer"].role, "planning");
  });

  it("carries the dispatch map on feature_factory_context so the driver never reparses frontmatter", async () => {
    const runtime = host();
    const realResolve = () => fileURLToPath(new URL("../../feature-factory/state/index.js", import.meta.url));
    featureFactoryExtension(runtime.pi, { resolveFeatureFactory: realResolve, profiles: { reviewer: { model: "p/strong" } } });
    const tool = runtime.tools.get("feature_factory_context");
    const ctx = { sessionManager: { getSessionFile: () => "/tmp/sessions/run.jsonl" } };
    const result = await tool.execute("call-1", {}, undefined, undefined, ctx);
    assert.equal(result.details.dispatch["work-reviewer"].model, "p/strong");
    assert.equal(result.details.dispatch["backend-builder"].model, undefined);
    assert.deepEqual(JSON.parse(result.content[0].text).dispatch, result.details.dispatch);
  });

  it("returns an empty dispatch rather than throwing when the agent directory is unreadable", () => {
    assert.deepEqual(dispatchProfiles("/nonexistent/agents"), {});
  });

  it("ignores a profile that carries neither a model nor a thinking level", () => {
    // `usable` exists so an empty or malformed entry falls through to the next level instead of
    // shadowing it with nothing.
    assert.deepEqual(profileFor("work-reviewer", "reviewer", { profiles: { "work-reviewer": {} }, profile: { model: "p/bare" } }), { model: "p/bare" });
    assert.deepEqual(profileFor("work-reviewer", "reviewer", { profiles: { "work-reviewer": "nope" }, profile: { model: "p/bare" } }), { model: "p/bare" });
  });
});
