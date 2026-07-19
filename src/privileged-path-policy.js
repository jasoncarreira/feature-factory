const EXACT_PRIVILEGED_PATHS = new Set([
  ".gitlab-ci.yml", "azure-pipelines.yml", "bitbucket-pipelines.yml", "Jenkinsfile",
  "package.json", "package-lock.json", "npm-shrinkwrap.json", "pnpm-lock.yaml", "yarn.lock", "bun.lock", "bun.lockb",
  "pyproject.toml", "poetry.lock", "Pipfile", "Pipfile.lock", "requirements.txt", "uv.lock", "setup.py", "setup.cfg",
  "Cargo.toml", "Cargo.lock", "go.mod", "go.sum", "go.work", "go.work.sum", "Gemfile", "Gemfile.lock",
  "composer.json", "composer.lock", "pom.xml", "build.gradle", "build.gradle.kts", "settings.gradle", "settings.gradle.kts",
  "gradle.properties", "mix.exs", "mix.lock", "pubspec.yaml", "pubspec.lock", "Package.swift", "Package.resolved",
  "Makefile", "GNUmakefile", "CMakeLists.txt", "Justfile", "Taskfile.yml", "Taskfile.yaml",
  "Dockerfile", "docker-compose.yml", "docker-compose.yaml", "compose.yml", "compose.yaml", "Procfile",
  "serverless.yml", "serverless.yaml", "fly.toml", "vercel.json", "netlify.toml", "render.yaml",
  ".nvmrc", ".node-version", ".npmrc", ".yarnrc", ".yarnrc.yml", "opencode.json", "opencode.jsonc",
]);

const PRIVILEGED_PREFIXES = [
  ".opencode/", ".github/", ".gitea/", ".gitlab/", ".circleci/", ".buildkite/", ".teamcity/",
  ".drone/", ".woodpecker/", ".azure-pipelines/", ".jenkins/", ".bitrise/", ".appveyor/", ".travis/",
  ".semaphore/", ".cirrus/", ".tekton/", "ci/",
  "assets/agent/", "assets/skills/", "assets/command/", "assets/commands/",
  "deploy/", "deployment/", "k8s/", "kubernetes/", "helm/", "charts/", "infra/", "terraform/",
  "dist/", "build/", "coverage/", "generated/",
];

const PRIVILEGED_SEGMENTS = new Set(["migrations", "migration", "migrate", "generated", "dist", "build", "coverage", "node_modules", ".yarn"]);
const DEPENDENCY_OR_BUILD_BASENAME = /^(?:requirements(?:[._-][A-Za-z0-9_-]+)?\.txt|tsconfig(?:\.[^.]+)?\.json|(?:eslint|prettier|babel|webpack|vite|vitest|jest|rollup|esbuild|postcss|tailwind)\.config\.[A-Za-z0-9]+|Dockerfile(?:\.[A-Za-z0-9_-]+)?|.*\.(?:csproj|fsproj|vbproj|sln|tf|tfvars))$/u;
const GENERATED_BASENAME = /(?:^|\.)generated\.[^/]+$/u;
const ROOT_AGENT_INSTRUCTION_FILE = /^(?:agents?|claude|codex|gemini|copilot)(?:\.local)?\.md$/u;
const ROOT_CI_FILES = new Set([
  ".travis.yml", ".travis.yaml", ".drone.yml", ".drone.yaml", ".woodpecker.yml", ".woodpecker.yaml",
  "azure-pipelines.yml", "azure-pipelines.yaml", "jenkinsfile", "bitrise.yml", "bitrise.yaml",
  "appveyor.yml", "appveyor.yaml", "buildkite.yml", "buildkite.yaml", "circle.yml",
  "semaphore.yml", "semaphore.yaml", ".cirrus.yml", ".cirrus.yaml",
]);

export function privilegedControlPlanePathReason(value) {
  if (typeof value !== "string" || value === "" || value.startsWith("/") || value.includes("\\") || value.includes("\0")) return "invalid-path";
  const segments = value.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) return "invalid-path";
  const basename = segments.at(-1);
  const lowerValue = value.toLowerCase();
  if (segments.length === 1 && (ROOT_AGENT_INSTRUCTION_FILE.test(lowerValue) || ROOT_CI_FILES.has(lowerValue) || lowerValue === ".cursorrules")) {
    return "root-agent-or-ci-configuration";
  }
  if (EXACT_PRIVILEGED_PATHS.has(value) || EXACT_PRIVILEGED_PATHS.has(basename)) return "dependency-build-deployment-manifest";
  if (PRIVILEGED_PREFIXES.some((prefix) => value.startsWith(prefix))) return "control-plane-directory";
  if (segments.some((segment) => PRIVILEGED_SEGMENTS.has(segment))) return "migration-or-generated-artifact";
  if (DEPENDENCY_OR_BUILD_BASENAME.test(basename)) return "dependency-build-deployment-manifest";
  if (GENERATED_BASENAME.test(basename)) return "generated-artifact";
  if (basename === ".env" || basename.startsWith(".env.")) return "runtime-configuration";
  return null;
}

export function isPrivilegedControlPlanePath(value) {
  return privilegedControlPlanePathReason(value) !== null;
}
