import { spawnSync } from "node:child_process";

const REVIEW_GUARD_ARGS = ["status", "--porcelain=v1", "--untracked-files=all"];
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
  const run = typeof options.spawnSync === "function" ? options.spawnSync : spawnSync;
  const args = ["-C", reviewedWorktree, ...REVIEW_GUARD_ARGS];
  const proc = run("git", args, {
    cwd: options.cwd || process.cwd(),
    encoding: "utf8",
    env: options.env,
    maxBuffer: options.maxBuffer || 1024 * 1024,
  });
  const exitCode = Number.isInteger(proc.status) ? proc.status : 1;
  const stdout = typeof proc.stdout === "string" ? proc.stdout : "";
  const stderr = joinOutput(proc.stderr, proc.error?.message);

  if (proc.error || exitCode !== 0) {
    return {
      ok: false,
      status: "unverifiable",
      worktree: reviewedWorktree,
      command: formatReviewGuardCommand(reviewedWorktree),
      exit_code: exitCode,
      stdout,
      stderr,
      dirty_paths: [],
    };
  }

  return {
    ok: stdout.length === 0,
    status: stdout.length === 0 ? "clean" : "dirty",
    worktree: reviewedWorktree,
    command: formatReviewGuardCommand(reviewedWorktree),
    exit_code: exitCode,
    stdout,
    stderr,
    dirty_paths: stdout.length === 0 ? [] : parseDirtyPaths(stdout),
  };
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
  const status = isGuardStatus(guard.status)
    ? guard.status
    : exitCode !== 0
      ? "unverifiable"
      : stdout.length === 0
        ? "clean"
        : "dirty";

  return {
    ok: typeof guard.ok === "boolean" ? guard.ok : status === "clean",
    status,
    worktree: guardWorktree,
    command: typeof guard.command === "string" && guard.command !== "" ? guard.command : formatReviewGuardCommand(guardWorktree),
    exit_code: exitCode,
    stdout,
    stderr: typeof guard.stderr === "string" ? guard.stderr : "",
    dirty_paths: status === "dirty"
      ? Array.isArray(guard.dirty_paths)
        ? guard.dirty_paths
        : parseDirtyPaths(stdout)
      : [],
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
  const untracked = xy === "??";

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
    if (count > 0) return `reviewer left reviewed worktree dirty (${count} git-visible ${count === 1 ? "path" : "paths"})`;
    return "reviewer left reviewed worktree dirty";
  }
  if (guard?.status === "unverifiable") return `reviewed worktree dirty-state could not be verified (git status exit ${guard.exit_code})`;
  return "review output blocked by review guard";
}

function formatReviewGuardCommand(worktree) {
  return `git -C ${shellQuote(worktree)} status --porcelain=v1 --untracked-files=all`;
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
