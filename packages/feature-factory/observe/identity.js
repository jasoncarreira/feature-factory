import { spawnSync } from "node:child_process";

// Enforcement (false green): publishing under an account other than the run's recorded identity. This
// was driver prose that required the host to return stdout, stderr and status separately; Prime's bash
// returns them combined, so a compliant Prime driver could never observe the identity (#365). The CLI
// owns the pipes now, so the verdict no longer depends on what the host's shell tool can report.
export const IDENTITY_ARGV = Object.freeze(["api", "--method", "GET", "/user", "--jq", ".login"]);
const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/u;
const SHORT = new Map([[8, "\\b"], [9, "\\t"], [10, "\\n"], [12, "\\f"], [13, "\\r"]]);

// Deterministic ASCII-only JSON string: printable ASCII literal except quote and backslash, the fixed
// short escapes, and every other UTF-16 code unit as lowercase \uXXXX. Slash stays unescaped.
export function asciiJson(value) {
  let rendered = "\"";
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (SHORT.has(unit)) rendered += SHORT.get(unit);
    else if (unit === 34 || unit === 92) rendered += `\\${value[index]}`;
    else if (unit >= 0x20 && unit <= 0x7e) rendered += value[index];
    else rendered += `\\u${unit.toString(16).padStart(4, "0")}`;
  }
  return `${rendered}"`;
}

// Observable only as numeric zero, zero-byte stderr, and exactly one login plus one LF. Nothing is
// trimmed, retried, or recovered from a partial value.
export function classifyIdentity({ status, stdout, stderr }) {
  if (status !== 0 || !Buffer.isBuffer(stdout) || !Buffer.isBuffer(stderr) || stderr.length !== 0) return null;
  if (stdout.length < 2 || stdout[stdout.length - 1] !== 10 || stdout.subarray(0, -1).some((byte) => byte > 0x7f)) return null;
  const login = stdout.subarray(0, -1).toString("ascii");
  return LOGIN.test(login) ? login : null;
}

export function identityReason(declared, observed) {
  const name = asciiJson(declared);
  if (observed === null) return `publishing identity unobservable: declared ${name}; launch with inherited GH_TOKEN for ${name} as documented in OPERATING.md and retry.`;
  return observed === declared ? null : `publishing identity mismatch: declared ${name}, observed ${asciiJson(observed)}; authenticate as ${name} and retry.`;
}

// A missing or empty GH_TOKEN never reaches gh, the network, or stored authentication.
export function observeIdentity(cwd, env = process.env, timeout = 60000) {
  if (typeof env.GH_TOKEN !== "string" || env.GH_TOKEN.length === 0) return null;
  return classifyIdentity(spawnSync("gh", IDENTITY_ARGV, { cwd, env, stdio: ["ignore", "pipe", "pipe"], timeout }));
}
