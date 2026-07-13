# Extraction Spec: feature-factory-core + Harness Adapters

## Motivation

Measured on the current tree (`src/` = 8,497 lines): the harness-agnostic engine is
~85–90% of the code. Opencode coupling is concentrated in five adapter files
(`plugin.js`, `tui.jsx`, most of `doctor.js`, `config.js`, the CLI `install` command),
four launcher call sites, and `.opencode/` path literals. The durable-state core —
`run-state.js`, `validate.js`, `factory-diagnostics.js`, `cost-attribution.js`,
`refs.js`, `git.js`, `steering-conflicts.js`, `utils.js` (2,959 lines) — has **zero**
opencode references today.

The external contract is already harness-independent by construction: drivers touch only
files (`run.json`, gate answers, steering) and the `feature-factory` CLI. The viso repo's
dual `.claude/` + `.opencode/` variants of the same skill prove the prompt/workflow
contract ports across harnesses with only dialect shims.

Goal: split into **`feature-factory-core`** (engine + CLI + templated assets) and
**`opencode-feature-factory`** (the adapter, keeping today's package name, exports, bin
behavior, and install base), such that a Claude Code adapter becomes a small third
package rather than a fork.

## Non-goals

- No behavior change for existing opencode users: same package name, same
  `feature-factory` CLI UX, same `.opencode/factory` layout, same plugin/TUI surfaces.
- No workflow redesign: SKILL/SCHEMA semantics, gates, transitions unchanged.
- No support burden for arbitrary harnesses beyond defining the seam; Claude Code is the
  validation target, implemented as a spike, not a supported release.

---

## The two seams

### Seam 1 — `HarnessAdapter` interface (core defines, adapters implement)

```js
export const adapter = {
  name: "opencode",                    // telemetry tracer/resource attrs, env snapshot labels
  controlPlaneDir: ".opencode",        // prefix for <dir>/factory and <dir>/worktrees

  // The ONLY place the engine invokes the harness. Wraps the four current call sites:
  // factory.js:113 (start), :504 (resume), :526 (continue) — execFileSync, stdio inherit —
  // and factory.js:1406 (detached spawn).
  launch(mode /* "interactive" | "detached" */, promptArgs, { cwd, env }) {},

  // Diagnostics-only environment capture (replaces env-snapshot.js:35,69-71,149 probes):
  version() {},                        // e.g. `opencode --version`
  capabilities() {},                   // e.g. { run_command, run_dir } via `run --help` probe

  // Harness-specific doctor checks (install/config/provider smoke). Core doctor keeps the
  // generic ones (git, gh, node, state validation, telemetry readiness).
  doctorChecks(options) {},

  // Asset seeding: where skills/agents/commands live and any frontmatter dialect shim.
  seedTargets(repo) {},                // e.g. [.opencode/skills/feature, .opencode/agent, ...]
  renderAgentFrontmatter(meta) {},     // opencode: mode/permission keys; claude: tools keys
};
```

Key property to preserve: **most CLI verbs need no harness at all.** Everything except
`start`/`resume`/`continue` (launch), `env` (version/capabilities), `doctor`
(harness checks), and `install` is pure file/git state manipulation. The core CLI must
run these verbs with no adapter configured.

### Seam 2 — control-plane path prefix

`factory-paths.js` already centralizes some of this. Finish the job: every
`.opencode/factory` and `.opencode/worktrees` literal routes through it, and it reads
the prefix from the adapter (default `.opencode` for back-compat via the adapter; core
standalone default `.factory`). Current literal inventory to sweep:
`factory.js` (19), `doctor.js` (9), `tui-data.js` (3), `cli.js` (3),
`env-snapshot.js` (2), `worktrees.js` (1), plus `factory-paths.js` itself (3, becomes
the single home).

Note: the prefix is per-repo state, not per-process — `run.json` files live under it and
diagnostics/TUI scan for it. Record the prefix in `run.json` (`control_plane: ".opencode"`)
at run creation so core tools opened against a foreign-prefix repo resolve correctly
without the adapter loaded.

---

## Module disposition

| Module | Lines | Disposition |
|---|---|---|
| `run-state.js` | 1,027 | **core** (zero refs today) |
| `validate.js` | 898 | **core** (zero refs) |
| `factory-diagnostics.js` | 395 | **core** (zero refs) |
| `cost-attribution.js` | 275 | **core** (zero refs) |
| `refs.js` / `git.js` / `utils.js` / `steering-conflicts.js` | 364 | **core** (zero refs) |
| `factory.js` | 2,116 | **core**, minus the four launch sites (→ `adapter.launch`) and path literals (→ seam 2) |
| `cli.js` | 881 | **core**, minus `install` (→ adapter); `start`/`resume`/`continue`/`env`/`doctor` accept the adapter via a `createCli(adapter)` factory |
| `telemetry.js` | 412 | **core**; tracer name + capture-risk message strings take `adapter.name` (3 refs are cosmetic) |
| `process-evidence.js` | 343 | **core** (2 cosmetic refs) |
| `env-snapshot.js` | 206 | **core** shell; the probe functions (`opencode --version`, `run --help` support checks, gitignore checks on prefixed paths) move behind `adapter.version()`/`capabilities()` |
| `factory-paths.js` | 40 | **core**; becomes the single path-prefix home (seam 2) |
| `worktrees.js` | 56 | **core**; prefix via seam 2 |
| `tui-data.js` | 364 | **split**: run-dir scanning + display projection (~330 lines) → core `status-projection.js`; the start-path/api glue + `.opencode` fallback scan (~30 lines) → adapter |
| `tui.jsx` | 233 | **adapter** (solid-js sidebar rendering) |
| `plugin.js` | 181 | **adapter** (registration, opencode frontmatter parsing) |
| `doctor.js` | 579 | **split**: generic checks (git/gh/node/state/telemetry readiness) → core; opencode install/config/provider smoke (~450 lines incl. `doctor.js:555` exec helper) → `adapter.doctorChecks` |
| `config.js` | 127 | **adapter** (opencode.jsonc read/write for install) |

Dependencies split accordingly: core keeps `@opentelemetry/api` + `jsonc-parser`
(jsonc only if core still reads any jsonc; otherwise it moves too); adapter keeps
`@opentui/solid`, `solid-js`, `esbuild` (TUI build).

## Asset templating

- `assets/agent/*.md` (12 prompts): **core owns the bodies** — they are the IP and are
  dialect-free. Frontmatter is rendered per-adapter (`renderAgentFrontmatter`):
  opencode emits `mode: subagent` / `permission: {edit: deny}`; Claude Code emits
  `tools:` / `disallowedTools:` equivalents.
- `assets/skills/feature/SKILL.md` + `SCHEMA.md`: **core owns**, templated with two
  variables: `{{CONTROL_PLANE}}` (path prefix) and `{{CLI}}` (bin name, in case an
  adapter renames it). Rendered at seed time by the adapter's `seedTargets`. The
  doc-contract test moves to core and runs against the rendered output.
- `assets/command/feature.md` (52 lines): **adapter** (opencode command registration
  wrapper). A Claude Code adapter ships the equivalent slash-command frontmatter file.

## Package layout

npm workspaces in this repo (avoid a repo split until the seam has settled):

```
packages/core/        feature-factory-core     (bin: feature-factory-core, exports ./cli, ./state, ./assets)
packages/opencode/    opencode-feature-factory (deps: core; keeps name, exports ., ./server, ./tui, ./cli; bin: feature-factory)
```

The adapter's bin is a two-liner: `createCli(opencodeAdapter)`. Existing consumers see
zero change: same install, same plugin spec, same commands. `dist/tui.js` build stays in
the adapter's prepack.

---

## Work order

### Phase 1 — finish literal centralization (no behavior change, current package)

Sweep all 37 `.opencode` literals through `factory-paths.js` (add
`worktreesRoot(repo)` beside `directFactoryRoot`). Add the `control_plane` field to
run.json at creation (schema: optional string, default `.opencode`).
**Accept:** `grep -rn "\.opencode" src/ | grep -v factory-paths.js` → zero; full suite
green.

### Phase 2 — define the adapter seam (current package)

Introduce `src/harness.js` with the `HarnessAdapter` shape and an `opencodeAdapter`
implementation. Wrap the four launch sites; move env-snapshot probes, doctor's opencode
checks, and telemetry naming behind it. `createCli(adapter)` factory; `src/cli.js`
becomes `createCli(opencodeAdapter)`.
**Accept:** `grep -rn "opencode" src/ --include="*.js"` hits only
`harness-opencode.js` (+ cosmetic strings routed through `adapter.name`); every CLI verb
except start/resume/continue/env/doctor/install works with the adapter stubbed out;
full suite green.

### Phase 3 — package split

Move files per the disposition table into `packages/core` and `packages/opencode`;
split tests along the same line (core tests must not require opencode on PATH — audit
for tests that exec `opencode`); split assets into core bodies + adapter frontmatter
shims; move the doc-contract test to core against rendered assets; workspace-ify
`package.json`; adapter re-exports keep the public surface byte-compatible.
**Accept:** core suite passes in an environment with opencode absent from PATH;
existing `test/package-smoke.mjs` passes unchanged against the adapter package
(same name/exports/bin/plugin id); `npm run check` green at the workspace root.

### Phase 4 — Claude Code adapter spike (validation, not release)

`packages/claude-code/` implementing: `controlPlaneDir: ".claude"` (factory under
`.claude/factory`, worktrees under `.claude/worktrees` — matching the viso skill's
existing convention), `launch` via `claude -p <prompt>` for headless and plain
instructions for interactive, `seedTargets` writing `.claude/skills/feature/` +
`.claude/agents/` with translated frontmatter, no TUI (`factory status`/`watch` and the
heartbeat diagnostics already cover monitoring; a statusline hook is optional).
**Accept:** in a scratch repo, a factory run seeded and launched through the Claude Code
adapter reaches Gate 1 with a valid `run.json`, and every state CLI verb round-trips.
Findings feed back into the seam before it's declared stable.

## Risks / open questions

- **Frontmatter dialect drift**: keep `renderAgentFrontmatter` tiny and lossy-safe —
  when a permission concept has no equivalent in a harness, fail seeding loudly rather
  than silently weakening a read-only reviewer.
- **`tui-data` split line**: the projection code imports diagnostics; keep the core
  module UI-framework-free (plain objects out) so both the opencode sidebar and any
  future statusline consume the same projection.
- **Version skew**: adapter pins an exact core version (`workspace:*` locally, exact on
  publish) — run.json `schema_version` plus the doc-contract test are the compatibility
  net.
- **Naming**: `feature-factory-core` npm availability unverified; decide at Phase 3.

## Run-wide acceptance gates

1. Phase greps above, per phase.
2. Workspace `npm run check` green; adapter pack smoke byte-compatible surface.
3. Core suite green with opencode absent from PATH.
4. A dogfood factory run on this repo through the opencode adapter completes to draft PR
   (the ultimate no-regression check).
5. Claude Code spike reaches Gate 1 in a scratch repo (Phase 4).
