import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = resolve(root, "packages/feature-factory/WORKFLOW.md");
const bytes = readFileSync(source);
if (bytes.length === 0) throw new Error(`empty canonical workflow: ${source}`);
const integrations = process.argv.slice(2);
if (integrations.length === 0) integrations.push("opencode-feature-factory", "prime-agent-feature-factory");
for (const integration of integrations) {
  const skill = resolve(root, "packages", integration, "skills/feature/SKILL.md");
  if (!existsSync(skill)) throw new Error(`missing platform skill: ${skill}`);
  const target = resolve(dirname(skill), "WORKFLOW.md");
  const temporary = `${target}.tmp-${process.pid}`;
  mkdirSync(dirname(target), { recursive: true });
  try {
    writeFileSync(temporary, bytes, { flag: "wx" });
    renameSync(temporary, target);
  } finally {
    rmSync(temporary, { force: true });
  }
}
