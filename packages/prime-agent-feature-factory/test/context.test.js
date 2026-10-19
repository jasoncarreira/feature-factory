import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { PROFILE_CONFIG_PATH, context, dispatchProfiles, factoryResources, profileFor, readProfileConfig } from "../bin/context.js";

// `resolveFromOwnPath` walks up from the script's OWN location, so exercising it means putting a copy
// of the script in a real install layout and importing it from there -- injecting a stub proves the
// call site and nothing about the traversal or where it starts. Each case gets its own temp root so the
// copies have distinct URLs and Node does not hand back one cached module for all three.
const scriptSource = fileURLToPath(new URL("../bin/context.js", import.meta.url));
async function scriptInstalledAt(layout) {
  // Through the realpath: `import.meta.url` of the imported copy resolves symlinks, and on macOS the
  // temp dir is /var -> /private/var, so a walk that is correct still reports the other spelling.
  const root = realpathSync(mkdtempSync(join(tmpdir(), "prime-ext-")));
  const pkg = join(root, "node_modules", "prime-agent-feature-factory");
  mkdirSync(join(pkg, "bin"), { recursive: true });
  copyFileSync(scriptSource, join(pkg, "bin", "context.js"));
  writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "prime-agent-feature-factory", type: "module" }));
  if (layout !== "absent") {
    const host = layout === "nested" ? pkg : root;
    mkdirSync(join(host, "node_modules", "feature-factory"), { recursive: true });
    writeFileSync(join(host, "node_modules", "feature-factory", "package.json"), JSON.stringify({ name: "feature-factory" }));
  }
  const script = join(pkg, "bin", "context.js");
  const module = await import(pathToFileURL(script).href);
  return { root, pkg, script, module, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

const resolveFeatureFactory = () => "/opt/prime/node_modules/feature-factory/state/index.js";

describe("Prime install context", () => {
  it("derives the installed agents and CLI, from its own path when bare resolution fails", async () => {
    // A failed resolution used to propagate the resolver's bare "Cannot find module 'feature-factory'",
    // which names no remedy. Seen for real under Prime 0.9 on a global install where the dependency WAS
    // present -- so the message has to point at both possibilities, not just a missing package, and the
    // walk up from this file finds a dependency that bare resolution cannot see.
    const beside = "/install/node_modules/prime-agent-feature-factory/node_modules/feature-factory";
    assert.deepEqual(
      factoryResources(() => { throw new Error("Cannot find module 'feature-factory'"); }, () => beside),
      { agents: `${beside}/agents`, cli: `${beside}/bin/factory.js` },
      "a resolver that cannot see the dependency must not stop the context printing",
    );
    // The traversal itself, against real directories, with `findBeside` left at its default. The injected
    // case above proves dispatch; these prove where the walk starts and how far it goes -- a walk rooted
    // at the process cwd, or one that stopped at the package boundary, passes the injected test and fails
    // every one of these.
    const throwingResolve = () => { throw new Error("Cannot find module 'feature-factory'"); };
    for (const [layout, expected] of [["nested", "pkg"], ["hoisted", "root"]]) {
      const installed = await scriptInstalledAt(layout);
      try {
        const base = expected === "pkg" ? installed.pkg : installed.root;
        assert.deepEqual(installed.module.factoryResources(throwingResolve),
          { agents: join(base, "node_modules", "feature-factory", "agents"),
            cli: join(base, "node_modules", "feature-factory", "bin", "factory.js") },
          `the walk must find a ${layout} dependency from the script's own location`);
      } finally { installed.cleanup(); }
    }
    // And absence is still an error rather than a wrong path invented from the walk.
    const missing = await scriptInstalledAt("absent");
    try {
      assert.throws(() => missing.module.factoryResources(throwingResolve),
        /could not resolve its 'feature-factory' dependency/u,
        "an install genuinely lacking the dependency must fail, not resolve to something made up");
    } finally { missing.cleanup(); }

    // Only when the install genuinely lacks it does this fail -- and then it says what to do.
    assert.throws(() => factoryResources(() => { throw new Error("Cannot find module 'feature-factory'"); }, () => null), (error) => {
      assert.match(error.message, /could not resolve its 'feature-factory' dependency from .+context\.js/u,
        "the error must name the file resolution was attempted from");
      assert.match(error.message, /npm install -g prime-agent-feature-factory/u, "and the remedy");
      assert.match(error.message, /run this script from `?its installed path/u, "and the other cause");
      assert.match(error.cause.message, /Cannot find module/u, "the original resolver error must survive as the cause");
      return true;
    });
    assert.deepEqual(factoryResources(resolveFeatureFactory), {
      agents: "/opt/prime/node_modules/feature-factory/agents",
      cli: "/opt/prime/node_modules/feature-factory/bin/factory.js",
    });
  });

  it("prints the install context as one JSON line when run by node, and fails closed without the dependency", async () => {
    // The skill runs this with `node` and binds every path from its stdout, so the property is the real
    // process: one JSON object naming readable paths. HOME and cwd are empty temp dirs so an operator's own
    // profile file cannot leak into the expectation.
    const scratch = realpathSync(mkdtempSync(join(tmpdir(), "prime-ctx-")));
    try {
      const run = (script) => spawnSync(process.execPath, [script], { cwd: scratch, env: { ...process.env, HOME: scratch }, encoding: "utf8" });
      const printed = run(scriptSource);
      assert.equal(printed.status, 0, printed.stderr);
      const payload = JSON.parse(printed.stdout);
      assert.deepEqual(Object.keys(payload), ["agents", "cli", "dispatch"]);
      assert.ok(existsSync(payload.cli) && existsSync(join(payload.agents, "work-reviewer.md")), "both paths must exist");
      assert.equal(payload.dispatch["work-reviewer"].thinking, dispatchProfiles(payload.agents)["work-reviewer"].thinking);
      assert.equal(printed.stdout.trim().split("\n").length, 1);
      const missing = await scriptInstalledAt("absent");
      try {
        const refused = run(missing.script);
        assert.deepEqual([refused.status, refused.stdout], [1, ""], "no partial context on stdout");
        assert.match(refused.stderr, /could not resolve its 'feature-factory' dependency/u);
      } finally { missing.cleanup(); }
    } finally { rmSync(scratch, { recursive: true, force: true }); }
    // Shape is reported even when the agent directory is unreadable, so a driver binds one key rather than
    // branching on its absence.
    assert.deepEqual(context({ resolveFeatureFactory, profiles: {} }), {
      agents: "/opt/prime/node_modules/feature-factory/agents",
      cli: "/opt/prime/node_modules/feature-factory/bin/factory.js",
      dispatch: {},
    });
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
    assert.deepEqual(dispatch["spec-writer"], { thinking: "xhigh" });
    assert.deepEqual(dispatch["backend-builder"], { thinking: "medium" });
    assert.deepEqual(dispatch["story-reader"], { thinking: "low" });
    assert.equal(Object.keys(dispatch).length, 11);
    for (const [name, entry] of Object.entries(dispatch)) {
      assert.ok(entry.thinking, `${name} declares no usable effort`);
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
    assert.deepEqual(bad["spec-writer"], {});
  });

  it("carries the dispatch map in the context so the driver never reparses frontmatter", () => {
    const realResolve = () => fileURLToPath(new URL("../../feature-factory/state/index.js", import.meta.url));
    const { dispatch } = context({ resolveFeatureFactory: realResolve, profiles: { reviewer: { model: "p/strong" } } });
    assert.equal(dispatch["work-reviewer"].model, "p/strong");
    assert.equal(dispatch["backend-builder"].model, undefined);
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

  // Prime fails a spawn on an unknown keyword instead of ignoring it, and the skill spreads the whole
  // dispatch entry into the call. So the end-to-end property is not "role is absent" but "every entry
  // spreads cleanly into a spawn that accepts exactly what Prime accepts" -- a diagnostic key added here
  // later breaks the first dispatch of every run, and this is what notices.
  it("produces entries that spread into a spawn accepting only name, model and thinking", () => {
    const ACCEPTED = new Set(["name", "model", "thinking"]);
    const spawn = (prompt, kwargs) => {
      if (typeof prompt !== "string") throw new TypeError("prompt must be str");
      if (!kwargs.name) throw new TypeError("name is required");
      for (const key of Object.keys(kwargs)) {
        if (!ACCEPTED.has(key)) throw new TypeError(`rlm.spawn got an unexpected keyword argument '${key}'`);
      }
      return { name: kwargs.name };
    };
    const dispatch = dispatchProfiles(AGENTS, { profiles: { reviewer: { model: "p/strong", thinking: "max" } } });
    for (const [name, profile] of Object.entries(dispatch)) {
      assert.doesNotThrow(() => spawn("do the thing", { name, ...profile }), `${name} cannot be spawned`);
    }
    // Control: the strict fake is what makes the loop meaningful, so prove it rejects the shape this
    // test exists to prevent rather than passing everything.
    assert.throws(() => spawn("x", { name: "a", role: "planning" }), /unexpected keyword argument 'role'/u);
  });

  // The skill runs the script with no options, so an options argument is unreachable from a normal
  // install. These exercise the file the script actually reads.
  it("reads profiles from the project file, then the home file, and prefers the project", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "prime-cfg-")));
    const write = (base, body) => {
      mkdirSync(join(base, dirname(PROFILE_CONFIG_PATH)), { recursive: true });
      writeFileSync(join(base, PROFILE_CONFIG_PATH), body);
    };
    const project = join(root, "project");
    const home = join(root, "home");
    write(home, JSON.stringify({ profiles: { default: { model: "home/model" } } }));
    assert.deepEqual(readProfileConfig(project, home), { profiles: { default: { model: "home/model" } } });
    write(project, JSON.stringify({ profiles: { default: { model: "project/model" } } }));
    assert.deepEqual(readProfileConfig(project, home), { profiles: { default: { model: "project/model" } } });
    assert.deepEqual(readProfileConfig(join(root, "none"), join(root, "none")), {});
    rmSync(root, { recursive: true, force: true });
  });

  it("reads no profiles rather than throwing when the config file is malformed", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "prime-cfg-bad-")));
    mkdirSync(join(root, dirname(PROFILE_CONFIG_PATH)), { recursive: true });
    writeFileSync(join(root, PROFILE_CONFIG_PATH), "{ not json");
    // A typo in an optional profile must not stop every run before it starts.
    assert.deepEqual(readProfileConfig(root, join(root, "none")), {});
    writeFileSync(join(root, PROFILE_CONFIG_PATH), JSON.stringify(["array", "is", "not", "config"]));
    assert.deepEqual(readProfileConfig(root, join(root, "none")), {});
    rmSync(root, { recursive: true, force: true });
  });
});
