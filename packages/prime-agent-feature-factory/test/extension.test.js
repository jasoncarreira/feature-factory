import { describe, it } from "node:test";
import assert from "node:assert/strict";
import featureFactoryExtension, { factoryResources, primeSessionId } from "../extensions/index.js";

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
  it("derives installed resources and a stable session owner", () => {
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
});
