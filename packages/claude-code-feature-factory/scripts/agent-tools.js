// Turn a specialist's `tools:` allowlist into Claude Code's `disallowedTools:` denylist.
//
// The specialist files are shared by every host, and their `tools:` line says what each role may do. In
// Claude Code an allowlist is also the end of the list: it removes every MCP tool, so a specialist could
// not use the project's own servers (#407). With no `tools:` line a subagent inherits the session's tools,
// MCP included, and `disallowedTools` takes away what the role was never given. Verified on Claude Code
// 2.1.319 with plugin agents: an inheriting agent called a project `.mcp.json` server, a denied tool came
// back as "No such tool available", and an unknown name in the list was ignored. Wildcards are not
// honoured in either list, so every name below is exact.
//
// Inheritance also brings in Claude Code's own session tools. None of the listed roles uses them, so each
// is denied unless the role declares it. A tool a later release adds is inherited until it is added here;
// that is the cost of letting MCP servers through without naming them.

// ENFORCEMENT: Agent (and Task, its earlier name) is what keeps delegation one level deep. Claude Code
// lets a subagent spawn its own, and the workflow's single owner of every run transition is the driver.
const DELEGATION = ["Agent", "Task"];
// Claude Code's own session tools, verified as inherited by a plugin subagent on 2.1.319, plus the
// interactive ones a subagent might inherit in a future release. Instruction-level hygiene, not a boundary.
const SESSION_TOOLS = [
  "AskUserQuestion", "Artifact", "ArtifactComments", "ArtifactData", "CronCreate", "CronDelete", "CronList",
  "DesignSync", "EnterPlanMode", "EnterWorktree", "ExitPlanMode", "ExitWorktree", "ListAgents", "Monitor",
  "NotebookEdit", "PushNotification", "RemoteTrigger", "ReportFindings", "SendMessage", "Skill", "TaskStop",
  "WebFetch", "WebSearch", "Workflow",
];
// The role tools the shared files grant or withhold. A role without Edit and Write is read-only, and the
// reviewer and validator keep Bash, so that is instruction (the canonical read-only rule), as before.
const ROLE_TOOLS = ["Bash", "Edit", "Write"];

export function deniedTools(declared) {
  const granted = new Set(declared);
  return [...DELEGATION, ...ROLE_TOOLS.filter((tool) => !granted.has(tool)), ...SESSION_TOOLS.filter((tool) => !granted.has(tool))];
}

// Rewrite one agent file. A file with no `tools:` line in its frontmatter is refused: it would inherit
// everything, the Agent tool included.
export function withDeniedTools(text) {
  const end = text.indexOf("\n---", 4);
  const front = text.slice(0, end);
  const line = /^tools:\s*(.+)$/mu.exec(front);
  if (!text.startsWith("---\n") || end < 0 || !line) throw new Error("an agent file must declare `tools:` in its frontmatter");
  const declared = line[1].split(",").map((tool) => tool.trim()).filter(Boolean);
  return `${front.replace(line[0], `disallowedTools: ${deniedTools(declared).join(", ")}`)}${text.slice(end)}`;
}
