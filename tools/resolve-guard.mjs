// Enforcement, not instruction: this stops a false green, so it earns its lines.
//
// A sandbox is a clone that lives INSIDE the operator checkout, at
// `<operator>/.factory-sandboxes/<run-id>/`. When it has no `node_modules` of its own,
// Node's bare-specifier lookup walks UP out of the sandbox, finds the operator's
// `node_modules/feature-factory -> ../packages/feature-factory`, and resolves it
// successfully. The suite then exercises the OPERATOR's production code while
// reporting green, and every downstream signal — review, evidence, merge — is bound to
// a run that never tested itself. Run 217 hit exactly this. Outside the operator tree
// the same mistake would die on ERR_MODULE_NOT_FOUND; the nesting is the only reason
// it is silent.
//
// Two scopes, both found by negative control rather than by reasoning:
//   - to the workspace's OWN package names, because under NODE_OPTIONS this hook sees
//     every node process and npm's own CLI legitimately lives outside the root;
//   - to importers INSIDE the root, because test/pack.test.js installs the built
//     tarball into a temp consumer and imports it from there on purpose.
//
// registerHooks is synchronous and so also covers `require()`. The async register()
// API intercepts `import` only, and a bare require() sailed straight through it.
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT_URL = new URL("../", import.meta.url);
const ROOT = ROOT_URL.href;

// Self-configuring on purpose: a guard that needs env vars set at every call site is a
// guard that is off wherever someone forgot.
function ownedPackageNames() {
  const root = JSON.parse(readFileSync(new URL("package.json", ROOT_URL), "utf8"));
  const names = new Set();
  for (const pattern of root.workspaces ?? []) {
    try {
      const manifest = new URL(`${pattern}/package.json`, ROOT_URL);
      names.add(JSON.parse(readFileSync(manifest, "utf8")).name);
    } catch {
      // A workspace glob that does not name one directory is not this guard's problem.
    }
  }
  return names;
}

const OWNED = ownedPackageNames();
const inRoot = (url) => typeof url === "string" && url.startsWith(ROOT);

registerHooks({
  resolve(specifier, context, nextResolve) {
    const resolved = nextResolve(specifier, context);
    const pkg = specifier.startsWith("@")
      ? specifier.split("/").slice(0, 2).join("/")
      : specifier.split("/")[0];
    const importer = context.parentURL ?? pathToFileURL(`${process.cwd()}/`).href;
    if (OWNED.has(pkg) && inRoot(importer) && resolved.url.startsWith("file:") && !inRoot(resolved.url)) {
      throw new Error(
        `workspace package '${pkg}' resolved to ${fileURLToPath(resolved.url)}, outside `
        + `the workspace root ${fileURLToPath(ROOT_URL)}. This checkout has no installed `
        + `node_modules, so Node resolved it from a parent checkout and these tests would `
        + `have exercised that tree instead of this one. Run 'npm ci' here.`);
    }
    return resolved;
  },
});
