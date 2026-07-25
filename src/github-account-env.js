import { homedir } from "node:os";
import { join } from "node:path";

const GITHUB_AUTH_ENV_KEYS = new Set([
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "GH_ENTERPRISE_TOKEN",
  "GITHUB_ENTERPRISE_TOKEN",
]);
const GITHUB_CHILD_ENV_KEYS = new Set([
  ...GITHUB_AUTH_ENV_KEYS,
  "GH_CONFIG_DIR",
  "GH_HOST",
  "GH_PROMPT_DISABLED",
  "GH_PAGER",
  "PAGER",
]);

export function githubAccountEnvironment(githubAccount, parentEnvironment = process.env) {
  if (typeof githubAccount !== "string" || !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/u.test(githubAccount)) {
    throw new Error("invalid GitHub login");
  }
  if (!parentEnvironment || typeof parentEnvironment !== "object" || Array.isArray(parentEnvironment)) {
    throw new TypeError("parent environment must be an object");
  }

  const environment = { ...parentEnvironment };
  for (const key of Object.keys(environment)) {
    if (GITHUB_CHILD_ENV_KEYS.has(key.toUpperCase())) delete environment[key];
  }
  environment.GH_CONFIG_DIR = githubAccountConfigDirectory(githubAccount);
  environment.GH_HOST = "github.com";
  environment.GH_PROMPT_DISABLED = "1";
  environment.GH_PAGER = "cat";
  environment.PAGER = "cat";
  return environment;
}

function githubAccountConfigDirectory(githubAccount) {
  return join(homedir(), ".config", "opencode-feature-factory", "gh", githubAccount);
}
