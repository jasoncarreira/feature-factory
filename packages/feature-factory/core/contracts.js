// Family contracts against the schema-neutral write core.
//
// Each contract owns one region of run.json: its projection, the transitions that
// region permits, and any re-observation it needs immediately before the atomic
// rename. The core knows none of this — it calls the four methods and never
// branches on which family it is talking to.
//
// `mode` is a static, code-owned string declared by the transition descriptor. It
// is never persisted, never produced by an agent, and never hashed.
import { GATE_NAMES, GATE_STATUSES, SLICE_STATUSES, STEP_STATUSES, TERMINAL_STATUSES } from "../state/schema.js";

const TERMINAL_MODES = new Set(["terminalize"]);

// The core hands each contract the observer the caller registered; it does not call it.
// A contract that omits `reobserve` therefore ignores that observer silently, which is
// twice now how a check that read as enforcement turned out to be dead. Families whose
// only re-observation is the caller's use this.
async function callRegisteredObserver({ observe, ...rest }) {
  if (typeof observe === "function") await observe(rest);
}

function contract({ id, project, validateTransition, reobserve }) {
  return Object.freeze({
    id,
    project,
    validateProjection: (projection) => {
      if (projection === undefined) throw new Error(`${id} projection is undefined`);
    },
    validateTransition,
    reobserve: reobserve ?? (async () => {}),
  });
}

// ---------------------------------------------------------------------------
// envelope — identity, status, timestamps, limits, terminal_result
// ---------------------------------------------------------------------------
const envelope = contract({
  id: "envelope",
  reobserve: callRegisteredObserver,
  project: (state) => ({
    run_id: state.run_id,
    status: state.status,
    mode: state.mode,
    branch: state.branch,
    worktree: state.worktree,
    pr_base: state.pr_base,
    created_at: state.created_at,
    updated_at: state.updated_at,
    terminal_result: state.terminal_result ?? null,
  }),
  validateTransition: ({ mode, before, after }) => {
    // Identity is immutable for the life of a run. Nothing legitimate renames a
    // run, and allowing it would let a transition retarget another run's record.
    for (const key of ["run_id", "created_at", "pr_base"]) {
      if (before[key] !== after[key]) throw new Error(`envelope.${key} is immutable`);
    }
    if (Date.parse(after.updated_at) < Date.parse(before.updated_at)) {
      throw new Error("envelope.updated_at cannot move backwards");
    }
    const wasTerminal = TERMINAL_STATUSES.includes(before.status);
    const isTerminal = TERMINAL_STATUSES.includes(after.status);
    if (wasTerminal && before.status !== after.status) {
      throw new Error(`envelope cannot leave terminal status ${before.status}`);
    }
    if (isTerminal && !wasTerminal && !TERMINAL_MODES.has(mode)) {
      throw new Error(`only a terminalize transition may enter ${after.status}`);
    }
  },
});

// ---------------------------------------------------------------------------
// gates — the three human approval gates
// ---------------------------------------------------------------------------
// Approving Gate 3 is the moment publication becomes authorized, and in the skill's flow
// it is also the last moment before the branch is pushed and the PR is created. Checks
// that live only in `factory pr` run after both of those effects, so they can report a
// bad publication but not prevent one. The readiness check is therefore invoked here as
// well, and an approval that arrives without an observer is refused rather than trusted:
// the two dead reobservers this codebase already found were both "registered but never
// called", which fails open exactly here.
async function checkPrePrApproval({ observe, current, candidate, state, nextState }) {
  const wasApproved = current?.pre_pr?.status === "approved";
  const isApproved = candidate?.pre_pr?.status === "approved";
  if (!isApproved || wasApproved) return callRegisteredObserver({ observe, current, candidate, state, nextState });
  if (typeof observe !== "function") {
    throw new Error("approving the pre_pr gate requires a publication-readiness observer");
  }
  await observe({ current, candidate, state, nextState });
}

const gates = contract({
  id: "gates",
  reobserve: checkPrePrApproval,
  project: (state) => ({ ...(state.gates ?? {}) }),
  validateTransition: ({ before, after, candidate }) => {
    for (const name of GATE_NAMES) {
      const from = before[name];
      const to = after[name];
      if (to === undefined) continue;
      if (from === undefined) {
        // A gate may appear only as pending; a gate that springs into existence
        // already approved is a decision nobody made.
        if (to.status !== "pending") throw new Error(`gate '${name}' must open as pending`);
        continue;
      }
      const decided = from.status !== "pending";
      const reopening = decided && to.status === "pending";
      // The artifact is *what was decided against*, so a decided gate's artifact is frozen.
      // Checked before the unchanged-status early-out, because that is where it was
      // reachable: re-deciding a gate to the status it already held skipped every check
      // below, and the handler writes whatever --artifact it is given, so an approved Story
      // could be pointed at a new document in place, without re-opening anything.
      if (decided && !reopening && from.artifact !== to.artifact) {
        throw new Error(`gate '${name}' artifact is what was decided against and cannot change`);
      }
      // Every gate is compared on every gates transition, so a gate nobody touched must fall
      // through here rather than be judged again.
      if (from.status === to.status) continue;
      // Re-opening turns on what was decided and on whether anything downstream would be stranded.
      // `changes` asks for another round and every later stage requires this gate approved, so
      // nothing rests on it. An approved gate is the hazard — one re-opened once published Story v1's
      // implementation under Story v2 — but that needs built work, and before seeding there is none.
      const seeded = (candidate.slices ?? []).length > 0;
      const mayReopen = from.status === "changes" || name === "pre_pr"
        || (from.status === "approved" && !seeded);
      if (reopening && !mayReopen) {
        throw new Error(`gate '${name}' cannot be re-opened once ${from.status}${seeded ? " and its plan is seeded" : ""}`);
      }
      if (decided && !reopening) {
        throw new Error(`gate '${name}' is already decided as ${from.status}`);
      }
      if (!GATE_STATUSES.includes(to.status)) throw new Error(`gate '${name}' status is invalid`);
      if (to.status !== "pending" && !to.at) throw new Error(`gate '${name}' decision requires 'at'`);
    }
  },
});

// ---------------------------------------------------------------------------
// steps — agent step rows
// ---------------------------------------------------------------------------
const steps = contract({
  id: "steps",
  project: (state) => (state.steps ?? []).map((step) => ({ ...step })),
  validateTransition: ({ before, after, candidate }) => {
    const priorByAgent = new Map(before.map((step) => [step.agent, step]));
    for (const step of after) {
      const prior = priorByAgent.get(step.agent);
      if (!prior) {
        if (step.attempts !== 1) throw new Error(`step '${step.agent}' must start at attempt 1`);
        continue;
      }
      if (step.attempts < prior.attempts) throw new Error(`step '${step.agent}' attempts cannot decrease`);
      if (step.attempts > prior.attempts + 1) throw new Error(`step '${step.agent}' attempts cannot skip`);
      if (prior.status === "accepted" && step.status !== "accepted") {
        throw new Error(`step '${step.agent}' is already accepted`);
      }
      if (!STEP_STATUSES.includes(step.status)) throw new Error(`step '${step.agent}' status is invalid`);
    }
    // Bounded loops: viso's max_retries, enforced rather than instructed.
    for (const step of after) {
      if (step.attempts > candidate.max_retries && step.status !== "blocked") {
        throw new Error(`step '${step.agent}' exhausted max_retries and must be blocked`);
      }
    }
    // A step row may never disappear; that would erase an attempt record.
    for (const agent of priorByAgent.keys()) {
      if (!after.some((step) => step.agent === agent)) throw new Error(`step '${agent}' cannot be removed`);
    }
  },
});

// ---------------------------------------------------------------------------
// slices — slice rows, attempts, merge_commit
// ---------------------------------------------------------------------------
// Attack 5 lives here rather than in the CLI. `reobserve` runs inside the
// transition, immediately before the atomic rename, so a merge cannot be recorded
// without the ownership check having run against freshly observed paths.
// The write core calls reobserve with { mode, current, candidate, observe, state,
// nextState } — `current` is the family's freshly re-read projection and `candidate`
// is the projection about to be written. An earlier version destructured
// before/after here, which are the validateTransition names, so `candidate` was
// undefined and this guard threw before checking anything. It read as enforcement
// and was dead. The end-to-end test caught it; the unit tests could not, because
// they called the path helpers directly and never went through the hook.
async function refuseUnownedMerge({ mode, current, candidate, observe }) {
  if (mode !== "merge") return;
  const priorSlices = Array.isArray(current) ? current : [];
  const nextSlices = Array.isArray(candidate) ? candidate : [];
  const newlyMerged = nextSlices.filter((slice) => slice.status === "merged"
    && priorSlices.find((prior) => prior.id === slice.id)?.status !== "merged");
  if (newlyMerged.length === 0) return;
  if (typeof observe !== "function") {
    // Fail closed: a merge whose paths cannot be observed is not a merge we can
    // authorize. Recording it anyway is precisely the false green being prevented.
    throw new Error("a merge transition requires a path observer");
  }
  for (const slice of newlyMerged) {
    const observed = await observe(slice);
    if (!observed || observed.diff_observed !== true) {
      throw new Error(`slice '${slice.id}' merge requires observed changed paths`);
    }
    // Privilege is reported before ownership. A privileged path is almost always
    // also unowned, so checking ownership first made the privileged message
    // unreachable - and the two are different findings: exceeding your lane is a
    // planning problem, touching the control plane is not.
    if (observed.privileged.length > 0) {
      throw new Error(`slice '${slice.id}' changed privileged control-plane paths: ${observed.privileged.join(", ")}`);
    }
    if (observed.unowned.length > 0) {
      throw new Error(`slice '${slice.id}' changed paths it does not own: ${observed.unowned.join(", ")}`);
    }
  }
}

const slices = contract({
  id: "slices",
  reobserve: refuseUnownedMerge,
  project: (state) => (state.slices ?? []).map((slice) => ({ ...slice })),
  validateTransition: ({ before, after, candidate }) => {
    const priorById = new Map(before.map((slice) => [slice.id, slice]));
    for (const slice of after) {
      const prior = priorById.get(slice.id);
      if (!prior) continue; // seeding from plan/slices.json
      // Finding 3: base_ref was replaceable on every update, so supplying the slice
      // head as its own base made the diff empty and every ownership check vacuous.
      // It is the branch point, which is a fact about the past: writable once, then
      // fixed.
      if (prior.base_ref && slice.base_ref !== prior.base_ref) {
        throw new Error(`slice '${slice.id}' base_ref is immutable once recorded`);
      }
      // The gate ratified these two at seeding. Widening `paths` afterwards would make
      // every ownership check judge against a set nobody approved; emptying `test_plan`
      // afterwards would waive the tests after the fact. Both were only immutable by the
      // CLI declining to write them, which is not the same as being immutable.
      for (const field of ["paths", "test_plan"]) {
        if (JSON.stringify(prior[field]) !== JSON.stringify(slice[field])) {
          throw new Error(`slice '${slice.id}' ${field} is ratified at seeding and cannot change`);
        }
      }
      if (slice.attempts < prior.attempts) throw new Error(`slice '${slice.id}' attempts cannot decrease`);
      if (slice.attempts > prior.attempts + 1) throw new Error(`slice '${slice.id}' attempts cannot skip`);
      if (prior.status === "merged" && slice.status !== "merged") {
        throw new Error(`slice '${slice.id}' is already merged`);
      }
      if (prior.status === "merged" && prior.merge_commit !== slice.merge_commit) {
        throw new Error(`slice '${slice.id}' merge_commit is immutable once merged`);
      }
      if (!SLICE_STATUSES.includes(slice.status)) throw new Error(`slice '${slice.id}' status is invalid`);
      if (slice.attempts > candidate.max_retries && !["merged", "blocked"].includes(slice.status)) {
        throw new Error(`slice '${slice.id}' exhausted max_retries and must be blocked`);
      }
      // Dependency order: a slice cannot merge before everything it depends on.
      if (slice.status === "merged") {
        for (const dep of slice.depends_on ?? []) {
          const dependency = after.find((entry) => entry.id === dep);
          if (dependency?.status !== "merged") {
            throw new Error(`slice '${slice.id}' cannot merge before dependency '${dep}'`);
          }
        }
      }
    }
    for (const id of priorById.keys()) {
      if (!after.some((slice) => slice.id === id)) throw new Error(`slice '${id}' cannot be removed`);
    }
  },
});

// ---------------------------------------------------------------------------
// verdict — validator verdict and pr_url
// ---------------------------------------------------------------------------
async function checkPublication({ mode, observe, current, candidate, state, nextState }) {
  if (mode !== "publish") return;
  if (typeof observe !== "function") throw new Error("publishing a PR requires an observer");
  await observe({ current, candidate, state, nextState });
}

const verdict = contract({
  id: "verdict",
  reobserve: checkPublication,
  project: (state) => ({ validator: state.validator ?? null, pr_url: state.pr_url ?? null }),
  validateTransition: ({ before, after, candidate }) => {
    if (before.pr_url && before.pr_url !== after.pr_url) {
      // Exactly-once: a run has one PR. Overwriting the URL would hide a second.
      throw new Error("pr_url is immutable once recorded");
    }
    const priorLoops = before.validator?.loops ?? 0;
    const nextLoops = after.validator?.loops ?? 0;
    if (nextLoops < priorLoops) throw new Error("validator.loops cannot decrease");
    // What the human approved at Gate 3 was this verdict against this head. The gate record
    // stores only a status and a time, so re-recording the verdict afterwards silently
    // re-points that approval at whatever the branch has become: opencode approved at one
    // head, committed directly to reach a second, re-observed the tests and re-recorded the
    // verdict there, then published without re-presenting the gate. Every machine check was
    // current and the human decision was stale.
    //
    // Freezing the verdict while the gate stands is what makes the approval mean a commit,
    // without storing a second copy of the head for the two records to disagree about. It
    // is not a dead end: re-open Gate 3 as pending, re-validate, and present it again. So
    // the cost of a late change is one more approval, not a lost run.
    if (candidate.gates?.pre_pr?.status === "approved"
      && JSON.stringify(before.validator) !== JSON.stringify(after.validator)) {
      throw new Error("the pre_pr gate is approved; re-open it as pending before re-recording the validator");
    }
  },
});

export const FAMILY_CONTRACTS = Object.freeze([envelope, gates, steps, slices, verdict]);
export const FAMILY_IDS = Object.freeze(FAMILY_CONTRACTS.map((entry) => entry.id));
