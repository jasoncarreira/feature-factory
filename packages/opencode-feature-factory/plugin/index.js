// OpenCode integration. Read-only toward run state, by contract.
//
// This package observes and renders; it never writes run.json. The API it consumes from
// feature-factory is the schema plus the read-only reader and `nextAction`. If that stops being
// enough, the package boundary is wrong rather than the export list being too small.
//
// The predecessor's plugin was 1,350 lines, and almost all of it served subsystems this rebuild
// dropped: dispatch claim/closure, post-PR CI configuration, cost attribution, lifecycle-event
// emission. What is left once those go is genuinely small, and that is the honest result rather
// than a stub — the orchestrator drives every state change through the CLI, so there is no
// correctness work for a plugin hook to do. Its job is to answer "what is this repository's run
// doing", for the sidebar and for anything else that asks.
import { registerWorkflow } from "./config.js";

// The plugin's one job: register the workflow with the host.
//
// It previously returned no hooks, on the reasoning that no session or task event is load-bearing
// when the orchestrator drives every transition through the CLI. That was right about *events* and
// wrong about the plugin, because it left the operator to install a skill and eleven agents by hand —
// and when they had not, a run loaded a stale 94 KB skill from a previous era and spent its first
// minutes reverse-engineering how to hand-write run.json from deleted source. Which is the one thing
// this whole design exists to prevent.
//
// `config` is the hook that fixes it, and it writes nothing: the host takes the command, the skill
// path and the agent definitions in memory. Upgrading the package upgrades all three, with no install
// step and nothing stale left in a config directory.
export default async function plugin(_input, options = {}) {
  return {
    // The session id, exported so a run can record the session that owns it.
    //
    // `factory lock` has always had a `session` field and the sidebar has always offered to jump to
    // it, but the skill's `$SESSION_ID` was referenced five times and defined nowhere — and nothing
    // in a shell call's environment could have defined it. So every run invented a label like
    // `opencode-163-20260803`, the lock recorded it, and `navigate("session", { sessionID })` was
    // handed a string naming no session. Built end to end against a value that was never wired up.
    //
    // This is the hook that supplies it, and it writes nothing: the host hands over the env for one
    // shell call and takes it back. Absent `sessionID` exports nothing rather than a placeholder,
    // because a placeholder is precisely how the defect started.
    async "shell.env"({ sessionID }, output) {
      if (typeof sessionID === "string" && sessionID.length > 0) output.env.FACTORY_SESSION_ID = sessionID;
    },
    async config(cfg) {
      // Everything the operator can configure, forwarded whole: `models` maps the agents' declared
      // tiers to concrete ids, `profiles` overrides per agent, and a project's own opencode.json
      // outranks both because the host has already merged it into `cfg`.
      // Forwarded whole. Naming individual keys here is how the `profile` level went missing and the
      // tier map went inert: the resolver owns the vocabulary, this hook just hands it over.
      registerWorkflow(cfg, options);
    },
  };
}
