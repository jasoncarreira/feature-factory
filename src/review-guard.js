import { existsSync, realpathSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { SAFE_GIT_POLICY, listHiddenIndexPaths, safeGit } from "./safe-git.js";

const REVIEW_GUARD_ARGS = Object.freeze([
  "status",
  "--porcelain=v1",
  "--untracked-files=all",
  "--ignore-submodules=none",
]);
const REVIEW_GUARD_IDENTITY_ARGS = Object.freeze(["rev-parse", "--show-toplevel"]);
const REVIEW_GUARD_HEAD_ARGS = Object.freeze(["rev-parse", "HEAD", "HEAD^{tree}"]);
const REVIEW_GUARD_HIDDEN_INDEX_ARGS = Object.freeze(["ls-files", "-v"]);
const REVIEW_GUARD_IGNORED_ARGS = Object.freeze(["ls-files", "-z", "--others", "--ignored", "--exclude-standard"]);
const REVIEW_GUARD_SUBMODULE_ARGS = Object.freeze(["ls-files", "--stage"]);
const CONFLICT_CODES = new Set(["DD", "AU", "UD", "UA", "DU", "AA", "UU"]);
const C_STYLE_ESCAPES = Object.freeze({
  a: "\u0007",
  b: "\b",
  f: "\f",
  n: "\n",
  r: "\r",
  t: "\t",
  v: "\v",
  '"': '"',
  "\\": "\\",
});

export function checkReviewedWorktreeClean(worktree, options = {}) {
  const reviewedWorktree = requireText(worktree, "worktree");
  const gitOptions = normalizeSafeGitOptions(options);
  return observeReviewedWorktreeTree(reviewedWorktree, gitOptions);
}

export const checkReviewWorktree = checkReviewedWorktreeClean;

export function buildReviewGuardBlockReport({ reviewer, subject, reviewed_worktree, guard, attempt = 1, reason } = {}) {
  const resolvedGuard = normalizeGuard(guard || checkReviewedWorktreeClean(reviewed_worktree), reviewed_worktree);
  if (resolvedGuard.ok) throw new Error("guard must be blocking to build a review guard block report");

  return {
    status: "blocked",
    reason: reason == null ? defaultBlockReason(resolvedGuard) : String(reason),
    reviewer: reviewer ?? null,
    subject: subject ?? null,
    attempt: normalizeAttempt(attempt),
    reviewed_worktree: resolvedGuard.worktree,
    review_output_valid: false,
    dirty_paths: resolvedGuard.dirty_paths,
    guard: resolvedGuard,
  };
}

function observeReviewedWorktreeTree(worktree, gitOptions) {
  const localResult = observeSingleReviewedWorktree(worktree, gitOptions);
  if (localResult.status === "unverifiable") return localResult;

  const submodulesResult = listInitializedSubmodules(worktree, gitOptions);
  if (!submodulesResult.ok) {
    return buildGuardResult({
      ok: false,
      status: "unverifiable",
      worktree,
      command: localResult.command,
      exit_code: normalizeExitCode(submodulesResult.status),
      stdout: localResult.stdout,
      stderr: joinOutput(
        localResult.stderr,
        formatObservationFailure(
          "submodule observation",
          formatReviewGuardSubmoduleCommand(worktree),
          submodulesResult.stderr,
        ),
      ),
      dirty_paths: localResult.dirty_paths,
      head_commit: localResult.head_commit,
      head_tree: localResult.head_tree,
      hidden_index_paths: localResult.hidden_index_paths,
    });
  }

  const visibleDirtySubmodules = new Set(localResult.dirty_paths.map((entry) => entry?.path).filter(Boolean));
  let dirtyPaths = localResult.dirty_paths;
  let hiddenIndexPaths = localResult.hidden_index_paths;

  for (const submodule of submodulesResult.initialized_submodules) {
    const nestedResult = observeReviewedWorktreeTree(submodule.worktree, gitOptions);
    hiddenIndexPaths = mergeHiddenIndexPaths(hiddenIndexPaths, prefixHiddenIndexPaths(submodule.path, nestedResult.hidden_index_paths));
    dirtyPaths = mergeDirtyPaths(
      dirtyPaths,
      prefixDirtyPaths(
        submodule.path,
        nestedResult.dirty_paths.filter((entry) => shouldIncludeNestedDirtyPath(entry, visibleDirtySubmodules.has(submodule.path))),
      ),
    );

    if (nestedResult.status === "unverifiable") {
      return buildGuardResult({
        ok: false,
        status: "unverifiable",
        worktree,
        command: localResult.command,
        exit_code: normalizeExitCode(nestedResult.exit_code),
        stdout: localResult.stdout,
        stderr: joinOutput(localResult.stderr, formatSubmoduleObservationFailure(submodule.path, nestedResult)),
        dirty_paths: dirtyPaths,
        head_commit: localResult.head_commit,
        head_tree: localResult.head_tree,
        hidden_index_paths: hiddenIndexPaths,
      });
    }
  }

  const status = dirtyPaths.length === 0 && hiddenIndexPaths.length === 0 ? "clean" : "dirty";
  return buildGuardResult({
    ok: status === "clean",
    status,
    worktree,
    command: localResult.command,
    exit_code: localResult.exit_code,
    stdout: localResult.stdout,
    stderr: localResult.stderr,
    dirty_paths: dirtyPaths,
    head_commit: localResult.head_commit,
    head_tree: localResult.head_tree,
    hidden_index_paths: hiddenIndexPaths,
  });
}

function observeSingleReviewedWorktree(reviewedWorktree, gitOptions) {
  const statusResult = safeGit(reviewedWorktree, REVIEW_GUARD_ARGS, gitOptions);
  const statusCommand = formatReviewGuardCommand(reviewedWorktree);

  if (!statusResult.ok) {
    return buildGuardResult({
      ok: false,
      status: "unverifiable",
      worktree: reviewedWorktree,
      command: statusCommand,
      exit_code: normalizeExitCode(statusResult.status),
      stdout: statusResult.stdout,
      stderr: statusResult.stderr,
      dirty_paths: [],
      head_commit: null,
      head_tree: null,
      hidden_index_paths: [],
    });
  }

  const dirtyPaths = statusResult.stdout.length === 0 ? [] : parseDirtyPaths(statusResult.stdout);
  const identityObservation = observeReviewedWorktreeIdentity(reviewedWorktree, gitOptions);
  if (!identityObservation.ok) {
    return buildGuardResult({
      ok: false,
      status: "unverifiable",
      worktree: reviewedWorktree,
      command: statusCommand,
      exit_code: normalizeExitCode(identityObservation.exit_code),
      stdout: statusResult.stdout,
      stderr: joinOutput(statusResult.stderr, identityObservation.error),
      dirty_paths: dirtyPaths,
      head_commit: null,
      head_tree: null,
      hidden_index_paths: [],
    });
  }

  const headResult = safeGit(reviewedWorktree, REVIEW_GUARD_HEAD_ARGS, gitOptions);
  if (!headResult.ok) {
    return buildGuardResult({
      ok: false,
      status: "unverifiable",
      worktree: reviewedWorktree,
      command: statusCommand,
      exit_code: normalizeExitCode(headResult.status),
      stdout: statusResult.stdout,
      stderr: joinOutput(
        statusResult.stderr,
        formatObservationFailure("head observation", formatReviewGuardHeadCommand(reviewedWorktree), headResult.stderr),
      ),
      dirty_paths: dirtyPaths,
      head_commit: null,
      head_tree: null,
      hidden_index_paths: [],
    });
  }

  const headObservation = parseHeadObservation(headResult.stdout, reviewedWorktree);
  if (!headObservation.ok) {
    return buildGuardResult({
      ok: false,
      status: "unverifiable",
      worktree: reviewedWorktree,
      command: statusCommand,
      exit_code: normalizeExitCode(headResult.status),
      stdout: statusResult.stdout,
      stderr: joinOutput(statusResult.stderr, headObservation.error),
      dirty_paths: dirtyPaths,
      head_commit: null,
      head_tree: null,
      hidden_index_paths: [],
    });
  }

  const hiddenIndexResult = listHiddenIndexPaths(reviewedWorktree, gitOptions);
  if (!hiddenIndexResult.ok) {
    return buildGuardResult({
      ok: false,
      status: "unverifiable",
      worktree: reviewedWorktree,
      command: statusCommand,
      exit_code: normalizeExitCode(hiddenIndexResult.status),
      stdout: statusResult.stdout,
      stderr: joinOutput(
        statusResult.stderr,
        formatObservationFailure(
          "hidden-index observation",
          formatReviewGuardHiddenIndexCommand(reviewedWorktree),
          hiddenIndexResult.stderr,
        ),
      ),
      dirty_paths: dirtyPaths,
      head_commit: headObservation.head_commit,
      head_tree: headObservation.head_tree,
      hidden_index_paths: [],
    });
  }

  const hiddenIndexPaths = Array.isArray(hiddenIndexResult.hidden_index_paths)
    ? hiddenIndexResult.hidden_index_paths
    : [];
  const ignoredPathsResult = listIgnoredUntrackedPaths(reviewedWorktree, gitOptions);
  if (!ignoredPathsResult.ok) {
    return buildGuardResult({
      ok: false,
      status: "unverifiable",
      worktree: reviewedWorktree,
      command: statusCommand,
      exit_code: normalizeExitCode(ignoredPathsResult.status),
      stdout: statusResult.stdout,
      stderr: joinOutput(
        statusResult.stderr,
        formatObservationFailure(
          "ignored-path observation",
          formatReviewGuardIgnoredCommand(reviewedWorktree),
          ignoredPathsResult.stderr,
        ),
      ),
      dirty_paths: dirtyPaths,
      head_commit: headObservation.head_commit,
      head_tree: headObservation.head_tree,
      hidden_index_paths: hiddenIndexPaths,
    });
  }

  const ignoredPaths = Array.isArray(ignoredPathsResult.ignored_paths)
    ? ignoredPathsResult.ignored_paths
    : [];
  const observedDirtyPaths = mergeDirtyPaths(dirtyPaths, ignoredPaths);
  const status = observedDirtyPaths.length === 0 && hiddenIndexPaths.length === 0 ? "clean" : "dirty";

  return buildGuardResult({
    ok: status === "clean",
    status,
    worktree: reviewedWorktree,
    command: statusCommand,
    exit_code: normalizeExitCode(statusResult.status),
    stdout: statusResult.stdout,
    stderr: statusResult.stderr,
    dirty_paths: observedDirtyPaths,
    head_commit: headObservation.head_commit,
    head_tree: headObservation.head_tree,
    hidden_index_paths: hiddenIndexPaths,
  });
}

function normalizeGuard(guard, reviewedWorktree) {
  if (!guard || typeof guard !== "object" || Array.isArray(guard)) {
    throw new Error("guard must be an object");
  }

  const expectedWorktree = reviewedWorktree == null ? null : requireText(reviewedWorktree, "reviewed_worktree");
  const guardWorktree = requireText(expectedWorktree || guard.worktree, "reviewed_worktree");
  if (expectedWorktree && guard.worktree && String(guard.worktree) !== expectedWorktree) {
    throw new Error("guard.worktree does not match reviewed_worktree");
  }

  const exitCode = Number.isInteger(guard.exit_code)
    ? guard.exit_code
    : Number.isInteger(guard.exitCode)
      ? guard.exitCode
      : 1;
  const stdout = typeof guard.stdout === "string" ? guard.stdout : "";
  const hiddenIndexPaths = normalizeList(guard.hidden_index_paths);
  const dirtyPaths = Array.isArray(guard.dirty_paths) ? guard.dirty_paths : parseDirtyPaths(stdout);
  const status = deriveGuardStatus({
    status: guard.status,
    exitCode,
    stdout,
    hiddenIndexPaths,
    dirtyPaths,
  });

  return {
    ok: status === "clean" && guard.ok !== false,
    status,
    worktree: guardWorktree,
    command: typeof guard.command === "string" && guard.command !== "" ? guard.command : formatReviewGuardCommand(guardWorktree),
    exit_code: exitCode,
    stdout,
    stderr: typeof guard.stderr === "string" ? guard.stderr : "",
    safe_git_policy: typeof guard.safe_git_policy === "string" && guard.safe_git_policy !== "" ? guard.safe_git_policy : SAFE_GIT_POLICY,
    head_commit: normalizeOptionalText(guard.head_commit),
    head_tree: normalizeOptionalText(guard.head_tree),
    dirty_paths: status === "dirty" ? dirtyPaths : [],
    hidden_index_paths: hiddenIndexPaths,
  };
}

function parseDirtyPaths(stdout) {
  return stdout
    .split(/\r?\n/u)
    .filter(Boolean)
    .map(parseDirtyPathLine);
}

function parseDirtyPathLine(line) {
  const xy = line.slice(0, 2);
  const indexStatus = xy[0] || " ";
  const worktreeStatus = xy[1] || " ";
  const { path, original_path } = parsePathSpec(line.slice(3));
  const conflicted = CONFLICT_CODES.has(xy);
  const ignored = xy === "!!";
  const untracked = xy === "??" || ignored;

  return {
    path,
    original_path,
    raw: line,
    xy,
    index_status: indexStatus,
    worktree_status: worktreeStatus,
    staged: !untracked && !conflicted && indexStatus !== " ",
    unstaged: !untracked && !conflicted && worktreeStatus !== " ",
    deleted: indexStatus === "D" || worktreeStatus === "D",
    conflicted,
    ignored,
    untracked,
  };
}

function parsePathSpec(value) {
  const text = value.trim();
  if (text === "") return { path: "", original_path: null };

  const renameSeparator = findRenameSeparator(text);
  if (renameSeparator === -1) {
    return {
      path: decodeGitPath(text),
      original_path: null,
    };
  }

  return {
    path: decodeGitPath(text.slice(renameSeparator + 4).trim()),
    original_path: decodeGitPath(text.slice(0, renameSeparator).trim()),
  };
}

function findRenameSeparator(value) {
  let quoted = false;

  for (let index = 0; index <= value.length - 4; index += 1) {
    const char = value[index];
    if (char === '"' && !isEscaped(value, index)) quoted = !quoted;
    if (!quoted && value.startsWith(" -> ", index)) return index;
  }

  return -1;
}

function isEscaped(value, index) {
  let slashCount = 0;

  for (let cursor = index - 1; cursor >= 0 && value[cursor] === "\\"; cursor -= 1) {
    slashCount += 1;
  }

  return slashCount % 2 === 1;
}

function decodeGitPath(value) {
  if (!value.startsWith('"') || !value.endsWith('"')) return value;

  let decoded = "";

  for (let index = 1; index < value.length - 1; index += 1) {
    const char = value[index];
    if (char !== "\\") {
      decoded += char;
      continue;
    }

    index += 1;
    if (index >= value.length - 1) {
      decoded += "\\";
      break;
    }

    const escaped = value[index];
    if (/[0-7]/u.test(escaped)) {
      let octal = escaped;
      for (let count = 1; count < 3 && /[0-7]/u.test(value[index + 1] || ""); count += 1) {
        index += 1;
        octal += value[index];
      }
      decoded += String.fromCharCode(Number.parseInt(octal, 8));
      continue;
    }

    decoded += C_STYLE_ESCAPES[escaped] ?? escaped;
  }

  return decoded;
}

function defaultBlockReason(guard) {
  if (guard?.status === "dirty") {
    const count = Array.isArray(guard.dirty_paths) ? guard.dirty_paths.length : 0;
    const hiddenIndexCount = Array.isArray(guard.hidden_index_paths) ? guard.hidden_index_paths.length : 0;
    const ignoredCount = Array.isArray(guard.dirty_paths)
      ? guard.dirty_paths.filter((path) => path?.ignored === true).length
      : 0;
    if (count > 0 && hiddenIndexCount > 0) {
      return `reviewer left reviewed worktree dirty (${count} git-visible ${count === 1 ? "path" : "paths"}; ${hiddenIndexCount} hidden-index ${hiddenIndexCount === 1 ? "path" : "paths"})`;
    }
    if (ignoredCount > 0 && count === ignoredCount) {
      return `reviewed worktree contains ignored untracked ${ignoredCount === 1 ? "path" : "paths"} (${ignoredCount})`;
    }
    if (hiddenIndexCount > 0) {
      return `reviewed worktree contains hidden index flags (${hiddenIndexCount} ${hiddenIndexCount === 1 ? "path" : "paths"})`;
    }
    if (count > 0) return `reviewer left reviewed worktree dirty (${count} git-visible ${count === 1 ? "path" : "paths"})`;
    return "reviewer left reviewed worktree dirty";
  }
  if (guard?.status === "unverifiable") return `reviewed worktree dirty-state could not be verified (git observation exit ${guard.exit_code})`;
  return "review output blocked by review guard";
}

function formatReviewGuardCommand(worktree) {
  return formatGitCommand(worktree, REVIEW_GUARD_ARGS);
}

function formatReviewGuardIdentityCommand(worktree) {
  return formatGitCommand(worktree, REVIEW_GUARD_IDENTITY_ARGS);
}

function formatReviewGuardHeadCommand(worktree) {
  return formatGitCommand(worktree, REVIEW_GUARD_HEAD_ARGS);
}

function formatReviewGuardHiddenIndexCommand(worktree) {
  return formatGitCommand(worktree, REVIEW_GUARD_HIDDEN_INDEX_ARGS);
}

function formatReviewGuardIgnoredCommand(worktree) {
  return formatGitCommand(worktree, REVIEW_GUARD_IGNORED_ARGS);
}

function formatReviewGuardSubmoduleCommand(worktree) {
  return formatGitCommand(worktree, REVIEW_GUARD_SUBMODULE_ARGS);
}

function formatGitCommand(worktree, args) {
  return `git -C ${shellQuote(worktree)} ${args.join(" ")}`;
}

function isGuardStatus(value) {
  return value === "clean" || value === "dirty" || value === "unverifiable";
}

function normalizeAttempt(value) {
  if (!Number.isInteger(value) || value < 1) throw new Error("attempt must be a positive integer");
  return value;
}

function requireText(value, name) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${name} must be a non-empty string`);
  }
  return value;
}

function normalizeSafeGitOptions(options) {
  if (!options || typeof options !== "object" || Array.isArray(options)) return {};

  return {
    env: options.env,
    maxBuffer: options.maxBuffer,
    timeout: options.timeout,
    spawnSync: options.spawnSync,
  };
}

function buildGuardResult({
  ok,
  status,
  worktree,
  command,
  exit_code,
  stdout,
  stderr,
  dirty_paths,
  head_commit,
  head_tree,
  hidden_index_paths,
}) {
  return {
    ok,
    status,
    worktree,
    command,
    exit_code,
    stdout,
    stderr,
    safe_git_policy: SAFE_GIT_POLICY,
    head_commit,
    head_tree,
    dirty_paths: Array.isArray(dirty_paths) ? dirty_paths : [],
    hidden_index_paths: Array.isArray(hidden_index_paths) ? hidden_index_paths : [],
  };
}

function normalizeExitCode(value) {
  return Number.isInteger(value) ? value : 1;
}

function parseHeadObservation(stdout, worktree) {
  const [head_commit = null, head_tree = null] = String(stdout)
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);

  if (!head_commit || !head_tree) {
    return {
      ok: false,
      head_commit: null,
      head_tree: null,
      error: `head observation returned malformed output for ${formatReviewGuardHeadCommand(worktree)}`,
    };
  }

  return {
    ok: true,
    head_commit,
    head_tree,
  };
}

function formatObservationFailure(label, command, stderr) {
  const detail = typeof stderr === "string" && stderr !== "" ? `\n${stderr}` : "";
  return `${label} failed while running ${command}${detail}`;
}

function formatSubmoduleObservationFailure(submodulePath, guard) {
  const detail = typeof guard?.stderr === "string" && guard.stderr !== "" ? `\n${guard.stderr}` : "";
  return `submodule observation failed for ${submodulePath}${detail}`;
}

function deriveGuardStatus({ status, exitCode, stdout, hiddenIndexPaths, dirtyPaths = [] }) {
  if (status === "unverifiable") return "unverifiable";
  if (exitCode !== 0) return "unverifiable";
  if (status === "dirty") return "dirty";
  if (dirtyPaths.length > 0) return "dirty";
  if (hiddenIndexPaths.length > 0) return "dirty";
  if (stdout.length > 0) return "dirty";
  return isGuardStatus(status) ? status : "clean";
}

function normalizeOptionalText(value) {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function normalizeList(value) {
  return Array.isArray(value) ? value : [];
}

function observeReviewedWorktreeIdentity(worktree, gitOptions) {
  const command = formatReviewGuardIdentityCommand(worktree);
  const result = safeGit(worktree, REVIEW_GUARD_IDENTITY_ARGS, gitOptions);
  if (!result.ok) {
    return {
      ok: false,
      exit_code: normalizeExitCode(result.status),
      error: formatObservationFailure("worktree-identity observation", command, result.stderr),
    };
  }

  const observedTopLevel = normalizeObservationLine(result.stdout);
  if (!observedTopLevel) {
    return {
      ok: false,
      exit_code: normalizeExitCode(result.status),
      error: `worktree-identity observation returned malformed output for ${command}`,
    };
  }

  try {
    const expectedWorktree = realpathSync.native(resolve(worktree));
    const observedWorktree = realpathSync.native(resolve(observedTopLevel));
    if (observedWorktree !== expectedWorktree) {
      return {
        ok: false,
        exit_code: normalizeExitCode(result.status),
        error: `worktree-identity observation reported ${observedWorktree} for ${command}, expected ${expectedWorktree}`,
      };
    }

    return {
      ok: true,
      exit_code: normalizeExitCode(result.status),
      worktree: observedWorktree,
    };
  } catch (error) {
    return {
      ok: false,
      exit_code: normalizeExitCode(result.status),
      error: `worktree-identity observation could not resolve paths for ${command}\n${normalizeErrorMessage(error)}`,
    };
  }
}

function listIgnoredUntrackedPaths(worktree, options = {}) {
  const result = safeGit(worktree, REVIEW_GUARD_IGNORED_ARGS, options);
  return {
    ...result,
    ignored_paths: result.ok ? parseIgnoredUntrackedPaths(result.stdout) : [],
  };
}

function listInitializedSubmodules(worktree, options = {}) {
  const result = safeGit(worktree, REVIEW_GUARD_SUBMODULE_ARGS, options);
  return {
    ...result,
    initialized_submodules: result.ok ? parseInitializedSubmodules(worktree, result.stdout) : [],
  };
}

function parseInitializedSubmodules(worktree, stdout) {
  const submodules = [];
  const seen = new Set();

  for (const line of String(stdout).split(/\r?\n/u).filter(Boolean)) {
    const entry = parseInitializedSubmoduleEntry(worktree, line);
    if (!entry || seen.has(entry.path)) continue;
    seen.add(entry.path);
    submodules.push(entry);
  }

  return submodules;
}

function parseInitializedSubmoduleEntry(worktree, line) {
  const separator = line.indexOf("\t");
  if (separator === -1) return null;

  const metadata = line.slice(0, separator).trim().split(/\s+/u);
  if (metadata[0] !== "160000") return null;

  const submodulePath = decodeGitPath(line.slice(separator + 1));
  if (!submodulePath) return null;

  const submoduleWorktree = resolve(worktree, submodulePath);
  if (!isInitializedSubmoduleWorktree(submoduleWorktree)) return null;

  return {
    path: submodulePath,
    worktree: submoduleWorktree,
  };
}

function isInitializedSubmoduleWorktree(worktree) {
  try {
    if (!existsSync(worktree)) return false;
    if (!statSync(worktree).isDirectory()) return false;
    return existsSync(resolve(worktree, ".git"));
  } catch {
    return false;
  }
}

function parseIgnoredUntrackedPaths(stdout) {
  return parseGitPathEntries(stdout).map(({ path, rawPath }) => buildIgnoredDirtyPath(path, rawPath));
}

function parseGitPathEntries(stdout) {
  const text = String(stdout);
  if (text === "") return [];

  if (text.includes("\u0000")) {
    const paths = text.split("\u0000");
    if (paths[paths.length - 1] === "") paths.pop();
    return paths.map((rawPath) => ({
      path: rawPath,
      rawPath,
    }));
  }

  return text
    .split(/\r?\n/u)
    .filter((line) => line !== "")
    .map((rawPath) => ({
      path: decodeGitPath(rawPath),
      rawPath,
    }));
}

function buildIgnoredDirtyPath(path, rawPath) {
  return {
    path,
    original_path: null,
    raw: `!! ${rawPath}`,
    xy: "!!",
    index_status: "!",
    worktree_status: "!",
    staged: false,
    unstaged: false,
    deleted: false,
    conflicted: false,
    ignored: true,
    untracked: true,
  };
}

function shouldIncludeNestedDirtyPath(entry, parentAlreadyMarksSubmoduleDirty) {
  if (!entry || typeof entry !== "object") return false;
  if (!parentAlreadyMarksSubmoduleDirty) return true;
  return entry.ignored === true;
}

function prefixDirtyPaths(prefix, dirtyPaths) {
  return (Array.isArray(dirtyPaths) ? dirtyPaths : []).map((entry) => prefixDirtyPath(prefix, entry));
}

function prefixDirtyPath(prefix, entry) {
  const path = prefixGitPath(prefix, entry?.path);
  const originalPath = entry?.original_path == null ? null : prefixGitPath(prefix, entry.original_path);
  return {
    ...entry,
    path,
    original_path: originalPath,
    raw: buildPrefixedDirtyRaw(entry?.xy, path, originalPath),
  };
}

function buildPrefixedDirtyRaw(xy, path, originalPath) {
  const status = typeof xy === "string" && xy.length === 2 ? xy : "??";
  return `${status} ${originalPath == null ? path : `${originalPath} -> ${path}`}`;
}

function prefixHiddenIndexPaths(prefix, hiddenIndexPaths) {
  return (Array.isArray(hiddenIndexPaths) ? hiddenIndexPaths : []).map((entry) => ({
    ...entry,
    path: prefixGitPath(prefix, entry?.path),
  }));
}

function prefixGitPath(prefix, path) {
  if (!prefix) return path;
  if (!path) return prefix;
  return `${prefix}/${path}`;
}

function mergeDirtyPaths(...groups) {
  const merged = [];
  const seen = new Set();

  for (const group of groups) {
    for (const entry of Array.isArray(group) ? group : []) {
      const key = `${entry?.xy || ""}\u0000${entry?.path || ""}\u0000${entry?.original_path || ""}`;
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(entry);
    }
  }

  return merged;
}

function mergeHiddenIndexPaths(...groups) {
  const merged = [];
  const seen = new Set();

  for (const group of groups) {
    for (const entry of Array.isArray(group) ? group : []) {
      const key = `${entry?.tag || ""}\u0000${entry?.path || ""}`;
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(entry);
    }
  }

  return merged;
}

function normalizeObservationLine(stdout) {
  return String(stdout)
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .find(Boolean) || "";
}

function normalizeErrorMessage(error) {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === "string") return error;
  return String(error ?? "");
}

function shellQuote(value) {
  if (/^[A-Za-z0-9_./:@-]+$/u.test(value)) return value;
  return `'${String(value).replace(/'/gu, "'\"'\"'")}'`;
}

function joinOutput(output, message) {
  const parts = [];
  if (typeof output === "string" && output !== "") parts.push(output);
  if (message) parts.push(String(message));
  return parts.join(parts.length > 1 ? "\n" : "");
}
