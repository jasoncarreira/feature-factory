import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, extname, isAbsolute, normalize, relative, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { init, parse } from "es-module-lexer";

await init;

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const helperPath = resolve(repositoryRoot, "test/helpers/git-fixture.js");
const scannedExtensions = new Set([".js", ".mjs", ".cjs"]);
const childProcessSpecifiers = new Set(["child_" + "process", "node:" + "child_process"]);

describe("ESM import extraction", () => {
  const childProcess = "node:" + "child_process";

  it("recognizes static imports, export-from, and literal dynamic imports", () => {
    const forms = [
      ["static import", `import { spawnSync } from "${childProcess}"`],
      ["static import", `import processApi from '${childProcess}'`],
      ["static import", `import * as processApi from\n  "${childProcess}"`],
      ["static import", `import "${childProcess}"`],
      ["export-from", `export { spawnSync } from "${childProcess}"`],
      ["export-from", `export * from '${childProcess}'`],
      ["export-from", `export * as processApi from "${childProcess}"`],
      ["dynamic import", `import("${childProcess}")`],
      ["dynamic import", `import("${childProcess}", { with: { type: "json" } })`],
    ];

    for (const [syntax, source] of forms) {
      assert.deepEqual(
        extractLiteralLoads(source).map((load) => [load.syntax, load.specifier]),
        [[syntax, childProcess]],
        source,
      );
    }
  });

  it("uses JavaScript syntax rather than matching comments, strings, calls, or CommonJS", () => {
    const sources = [
      `// import "${childProcess}"`,
      `/* import "${childProcess}" */`,
      `const fixtureProgram = 'import "${childProcess}"'`,
      `object.import("${childProcess}")`,
      `require("${childProcess}")`,
      `import(moduleName)`,
      `import("node:" + "child_process")`,
    ];

    for (const source of sources) assert.deepEqual(extractLiteralLoads(source), [], source);
  });

  it("handles comments and long whitespace without a repository-owned grammar", () => {
    const source = `import/* declaration */{ spawnSync }${"\n".repeat(20_000)}from/* target */"${childProcess}"`;

    assert.deepEqual(extractLiteralLoads(source).map((load) => load.specifier), [childProcess]);
  });

  it("reports syntax and line metadata", () => {
    const source = `const first = true;\nexport * from "${childProcess}"`;

    assert.deepEqual(extractLiteralLoads(source)[0], {
      syntax: "export-from",
      specifier: childProcess,
      line: 2,
    });
  });
});

describe("import boundary policy", () => {
  const childProcess = "child_" + "process";

  it("allows native child-process loads only from the exact test helper", () => {
    const source = `import { spawnSync } from ${JSON.stringify(childProcess)}`;

    assert.deepEqual(findViolations(helperPath, source, "test"), []);
    assert.equal(findViolations(resolve(repositoryRoot, "test/helpers/git-fixture-copy.js"), source, "test").length, 1);
    assert.equal(findViolations(resolve(repositoryRoot, "test/helpers/nested/git-fixture.js"), source, "test").length, 1);
    assert.deepEqual(findViolations(resolve(repositoryRoot, "src/git.js"), source, "production"), []);
  });

  it("rejects both child-process spellings through supported ESM forms", () => {
    const testFile = resolve(repositoryRoot, "test/support/nested/fixture.js");

    for (const specifier of [childProcess, `node:${childProcess}`]) {
      for (const source of [
        `import { spawn } from ${JSON.stringify(specifier)}`,
        `export * from ${JSON.stringify(specifier)}`,
        `import(${JSON.stringify(specifier)})`,
      ]) {
        assert.equal(findViolations(testFile, source, "test").length, 1, source);
      }
    }
  });

  it("rejects production ESM loads resolving exactly to the helper", () => {
    const importer = resolve(repositoryRoot, "src/nested/module.js");
    const helperWithoutExtension = helperPath.slice(0, -3);
    const canonicalFileUrl = pathToFileURL(helperPath).href;
    const specifiers = [
      "../../test/helpers/git-fixture.js",
      "../../test/helpers/../helpers/git-fixture",
      "../../test/helpers/git-fixture.js?fixture=1",
      "../../test/helpers/git-fixture.js#fixture",
      "../../test/helpers/git-fixture.js?fixture=%2f#%23",
      "../../test/helpers/git%2dfixture.js",
      helperPath,
      helperWithoutExtension,
      `${canonicalFileUrl}?fixture=1#fixture`,
    ];

    for (const specifier of specifiers) {
      for (const source of [
        `import fixture from ${JSON.stringify(specifier)}`,
        `export { fixture } from ${JSON.stringify(specifier)}`,
        `import(${JSON.stringify(specifier)})`,
      ]) {
        assert.equal(findViolations(importer, source, "production").length, 1, source);
      }
    }
  });

  it("allows unrelated, near-name, bare, non-file, and computed loads", () => {
    const importer = resolve(repositoryRoot, "src/module.js");
    const sources = [
      'import "../test/helpers/git-fixtures.js"',
      'import "test/helpers/git-fixture.js"',
      'import "https://example.test/test/helpers/git-fixture.js"',
      'import "../test/helpers/git%2dfixtures.js"',
      "import(helperPath)",
      'import("../test/helpers/" + "git-fixture.js")',
    ];

    for (const source of sources) assert.deepEqual(findViolations(importer, source, "production"), [], source);
  });

  it("fails explicitly when CommonJS enters the guarded source tree", () => {
    const cjsFile = resolve(repositoryRoot, "test/support/fixture.cjs");

    assert.deepEqual(findViolations(cjsFile, "module.exports = {};", "test"), [{
      file: normalize(cjsFile),
      line: 1,
      syntax: "CommonJS",
      specifier: ".cjs",
      reason: "guarded source uses unsupported CommonJS; decide and add an explicit boundary policy",
    }]);
  });

  it("finds no violations in the recursive repository corpora", () => {
    const findings = [
      ...scanDirectory(resolve(repositoryRoot, "test"), "test"),
      ...scanDirectory(resolve(repositoryRoot, "src"), "production"),
    ].sort(compareFindings);

    assert.deepEqual(findings, [], formatFindings(findings));
  });
});

function extractLiteralLoads(source) {
  const [imports] = parse(source);
  let cursor = 0;
  let line = 1;

  return imports.flatMap((entry) => {
    for (let newline = source.indexOf("\n", cursor); newline !== -1 && newline < entry.ss; newline = source.indexOf("\n", cursor)) {
      line += 1;
      cursor = newline + 1;
    }
    if (entry.n === undefined || entry.n === null || entry.d === -2) return [];
    const statement = source.slice(entry.ss, entry.se);
    const syntax = entry.d >= 0
      ? "dynamic import"
      : /^\s*export\b/u.test(statement)
        ? "export-from"
        : "static import";

    return [{
      syntax,
      specifier: entry.n,
      line,
    }];
  });
}

function scanDirectory(directory, role) {
  return listJavaScriptFiles(directory).flatMap((file) => findViolations(file, readFileSync(file, "utf8"), role));
}

function listJavaScriptFiles(directory) {
  const files = [];

  for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) files.push(...listJavaScriptFiles(path));
    else if (entry.isFile() && scannedExtensions.has(extname(entry.name))) files.push(path);
  }

  return files;
}

function findViolations(file, source, role) {
  const normalizedFile = normalize(file);
  if (extname(normalizedFile) === ".cjs") {
    return [{
      file: normalizedFile,
      line: 1,
      syntax: "CommonJS",
      specifier: ".cjs",
      reason: "guarded source uses unsupported CommonJS; decide and add an explicit boundary policy",
    }];
  }

  const isExactHelper = normalizedFile === normalize(helperPath);
  return extractLiteralLoads(source).flatMap((load) => {
    if (role === "test" && !isExactHelper && childProcessSpecifiers.has(load.specifier)) {
      return [{ file: normalizedFile, ...load, reason: "test module directly loads child process" }];
    }
    if (role === "production" && resolvesToHelper(load.specifier, normalizedFile)) {
      return [{ file: normalizedFile, ...load, reason: "production module loads the test Git fixture helper" }];
    }
    return [];
  });
}

function resolvesToHelper(specifier, importer) {
  const withoutSuffix = specifier.replace(/[?#].*$/u, "");
  let candidate;

  try {
    if (withoutSuffix.startsWith("file:")) candidate = fileURLToPath(new URL(withoutSuffix));
    else if (isAbsolute(withoutSuffix) || withoutSuffix.startsWith("./") || withoutSuffix.startsWith("../")) {
      const importerDirectory = pathToFileURL(`${dirname(importer)}/`);
      candidate = fileURLToPath(new URL(withoutSuffix, importerDirectory));
    } else return false;
  } catch {
    return false;
  }

  const normalizedCandidate = normalize(candidate);
  return normalizedCandidate === normalize(helperPath) || `${normalizedCandidate}.js` === normalize(helperPath);
}

function compareFindings(left, right) {
  return left.file.localeCompare(right.file) || left.line - right.line || left.syntax.localeCompare(right.syntax);
}

function formatFindings(findings) {
  return findings
    .map((finding) => {
      const file = relative(repositoryRoot, finding.file) || finding.file;
      return `${file}:${finding.line}: ${finding.reason} (${finding.syntax}: ${finding.specifier})`;
    })
    .join("\n");
}
