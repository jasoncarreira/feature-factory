// `feature_background`: start a run in its own background session, or answer that session's pending gate.
//
// Ported from the V1 tool. V2's plugin session domain has no `list`, so the run -> session association
// the V1 tool found by session title is kept in plugin storage instead, keyed by the run id and the
// directory the plugin loaded in. A recorded session that no longer exists is treated as absent.
//
// Every outcome is reported, never retried: `dispatched` means the prompt was admitted to the session,
// not that the run did anything.
const RUN_ID = /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/u;
const CALLERS = Object.freeze(["build", "feature-factory"]);

function validDecision(decision) {
  return decision === "approve" || decision === "stop"
    || (typeof decision === "string" && decision.startsWith("changes: ") && decision.slice("changes: ".length).trim().length > 0);
}

export function rejection(operation, args, context) {
  if (typeof args?.runId !== "string" || !RUN_ID.test(args.runId)) return "invalid_run_id";
  if (operation !== "start" && operation !== "answer") return "invalid_operation";
  if (operation === "start" && (typeof args.request !== "string" || args.request.trim().length === 0)) return "missing_request";
  if (operation === "answer" && !validDecision(args.decision)) return "invalid_decision";
  if (!CALLERS.includes(context?.agent)) return "unauthorized_agent";
  return null;
}

const describe = (error) => String(error?.message ?? error);

export function createBackgroundTool(ctx) {
  const directory = ctx.location?.directory;
  const key = (runId) => `background/${Buffer.from(String(directory), "utf8").toString("base64url")}/${runId}`;
  const inFlight = new Map();

  async function recorded(runId) {
    const sessionID = await ctx.storage.get(key(runId));
    if (typeof sessionID !== "string" || !sessionID) return null;
    try {
      await ctx.session.get({ sessionID });
      return sessionID;
    } catch {
      return null;
    }
  }

  async function operate({ operation, runId, request, decision }) {
    const unknown = (stage, error, sessionID) => ({ status: "unknown", operation, runId, stage, ...(sessionID ? { sessionID } : {}), outcome: describe(error) });
    let sessionID;
    try {
      sessionID = await recorded(runId);
    } catch (error) {
      return unknown("lookup", error);
    }
    if (operation === "start" && sessionID) return { status: "existing", operation, runId, sessionID };
    if (operation === "answer" && !sessionID) return { status: "not_backgrounded", operation, runId };
    if (operation === "start") {
      try {
        const created = await ctx.session.create({ title: `feature-factory:${runId}` });
        sessionID = created?.id ?? created?.data?.id;
        if (typeof sessionID !== "string" || !sessionID) return unknown("create", "the host returned no session id");
        await ctx.storage.set(key(runId), sessionID);
        await ctx.session.switchAgent({ sessionID, agent: "run-orchestrator" });
      } catch (error) {
        return unknown("create", error, sessionID);
      }
    }
    const text = operation === "start"
      ? `Drive exactly one feature-factory run as the bounded run-orchestrator. Load and follow the feature skill. The expected canonical run ID is "${runId}". The plugin's directory is "${directory}". Independently derive the same run ID before any factory command, then enter Step 0. The request follows unchanged:\n\n${request}`
      : decision;
    try {
      await ctx.session.prompt({ sessionID, text });
    } catch (error) {
      return unknown("prompt", error, sessionID);
    }
    return { status: "dispatched", operation, runId, sessionID };
  }

  return {
    name: "feature_background",
    description: "Start a feature-factory run in its own background session, or answer that session's pending gate.",
    input: {
      type: "object",
      properties: {
        operation: { type: "string", enum: ["start", "answer"], description: "start a background run, or answer its pending gate" },
        runId: { type: "string", description: "the canonical run id" },
        request: { type: "string", description: "for start: the complete /feature request, forwarded unchanged" },
        decision: { type: "string", description: "for answer: approve, stop, or changes: <feedback>" },
      },
      required: ["operation", "runId"],
      additionalProperties: false,
    },
    async execute(input, context) {
      const operation = input?.operation;
      const reason = rejection(operation, input, context);
      if (reason) return { content: JSON.stringify({ status: "rejected", operation, reason }) };
      // One operation per run at a time: a second start while one is admitting joins it, anything else
      // is refused, so two sessions can never be created for one run.
      const active = inFlight.get(input.runId);
      if (active) {
        if (operation === "start" && active.operation === "start") return { content: JSON.stringify(await active.promise) };
        return { content: JSON.stringify({ status: "rejected", operation, runId: input.runId, reason: "operation_in_flight" }) };
      }
      const promise = operate({ operation, runId: input.runId, request: input.request, decision: input.decision });
      inFlight.set(input.runId, { operation, promise });
      try {
        return { content: JSON.stringify(await promise) };
      } finally {
        inFlight.delete(input.runId);
      }
    },
  };
}
