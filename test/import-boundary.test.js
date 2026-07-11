import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, extname, isAbsolute, normalize, relative, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const helperPath = resolve(repositoryRoot, "test/helpers/git-fixture.js");
const JavaScriptExtensions = new Set([".js", ".mjs", ".cjs"]);
const childProcessSpecifiers = new Set(["child_" + "process", "node:" + "child_process"]);
const comment = String.raw`(?:\/\*(?:[^*]|\*(?!\/))*\*\/|\/\/[^\r\n]*(?:\r\n?|\n|$))`;
const trivia = String.raw`(?:\s|${comment})*`;
const quotedSpecifier = String.raw`(?<quote>["'])(?<specifier>(?:(?!\k<quote>)[^\\\r\n])*)\k<quote>`;
const declarationString = String.raw`(?:"(?:\\[^\r\n]|[^"\\\r\n])*"|'(?:\\[^\r\n]|[^'\\\r\n])*')`;
const declarationAtom = String.raw`(?:${comment}|${declarationString}|\s|[^\s/"';])`;
const namedExportAtom = String.raw`(?:${comment}|${declarationString}|\s|[^\s/"';}])`;

const loadPatterns = [
  {
    syntax: "static import",
    expression: new RegExp(
      String.raw`(?<![\w$.])\bimport${trivia}(?:(?:${declarationAtom})*?\bfrom${trivia})?${quotedSpecifier}`,
      "g",
    ),
  },
  {
    syntax: "export-from",
    expression: new RegExp(
      String.raw`(?<![\w$.])\bexport${trivia}(?:\*${trivia}(?:as${trivia}[A-Za-z_$][\w$]*${trivia})?|\{(?:${namedExportAtom})*\}${trivia})\bfrom${trivia}${quotedSpecifier}`,
      "g",
    ),
  },
  {
    syntax: "require",
    expression: new RegExp(
      String.raw`(?<![\w$.])\brequire${trivia}\(${trivia}${quotedSpecifier}${trivia}(?:\)|,)`,
      "g",
    ),
  },
  {
    syntax: "dynamic import",
    expression: new RegExp(
      String.raw`(?<![\w$.])\bimport${trivia}\(${trivia}${quotedSpecifier}${trivia}(?:\)|,)`,
      "g",
    ),
  },
];

describe("bounded import extraction", () => {
  const childProcess = "node:" + "child_process";
  const quote = (specifier, mark = '"') => `${mark}${specifier}${mark}`;

  const prohibitedForms = [
    ["static import", `import { spawnSync } from ${quote(childProcess)}`],
    ["static import", `import processApi from ${quote(childProcess, "'")}`],
    ["static import", `import * as processApi from\n  ${quote(childProcess)}`],
    ["static import", `import ${quote(childProcess)}`],
    ["export-from", `export { spawnSync } from ${quote(childProcess)}`],
    ["export-from", `export * from ${quote(childProcess, "'")}`],
    ["export-from", `export * as processApi from ${quote(childProcess)}`],
    ["require", `require ( ${quote(childProcess)} )`],
    ["require", `require(${quote(childProcess)}, { fixture: true })`],
    ["dynamic import", `import( ${quote(childProcess, "'")} )`],
    ["dynamic import", `import(${quote(childProcess)}, { with: { type: "json" } })`],
  ];

  it("recognizes the supported canonical quoted forms", () => {
    for (const [syntax, source] of prohibitedForms) {
      assert.deepEqual(
        extractLiteralLoads(source).map((load) => [load.syntax, load.specifier]),
        [[syntax, childProcess]],
        source,
      );
    }
  });

  it("rejects supported loads with legal comments between syntax tokens", () => {
    const syntheticTest = resolve(repositoryRoot, "test/support/comment-gaps.js");
    const target = quote(childProcess);
    const forms = [
      ["static import", `import/* declaration */{/* binding */spawnSync/* binding */}\nfrom// target\n${target}`],
      ["export-from", `export/* declaration */*/* exported */as/* alias */processApi/* source */from/* target */${target}`],
      ["require", `require/* callee */(/* target */${target}/* close */)`],
      ["dynamic import", `import/* callee */(/* target */${target}/* close */)`],
    ];

    for (const [syntax, source] of forms) {
      const violations = findViolations(syntheticTest, source, "test");
      assert.deepEqual(
        violations.map((violation) => violation.syntax),
        [syntax],
        source,
      );
    }
  });

  it("recognizes canonical static clauses despite comment delimiters and string-named bindings", () => {
    const syntheticTest = resolve(repositoryRoot, "test/support/static-clause-delimiters.js");
    const target = quote(childProcess);
    const forms = [
      [
        "static import",
        `import/* ' } \" */ { /* \" } ' */ "remote}name" as local /* { ' \" */ } from ${target}`,
      ],
      [
        "export-from",
        `export { /* } ' \" */ local as "remote}name" /* { \" ' */ } from ${target}`,
      ],
    ];

    for (const [syntax, source] of forms) {
      assert.deepEqual(
        findViolations(syntheticTest, source, "test").map((violation) => violation.syntax),
        [syntax],
        source,
      );
    }
  });

  it("deterministically treats direct-looking comments and strings as loads", () => {
    const direct = `import ${quote(childProcess)}`;
    const specimens = [`// ${direct}`, `/* ${direct} */`, `const fixtureProgram = '${direct}'`];

    for (const source of specimens) {
      assert.equal(extractLiteralLoads(source).some((load) => load.specifier === childProcess), true, source);
    }
  });

  it("excludes encoded, template, computed, indirect, member, alias, and unrelated forms", () => {
    const syntheticTest = resolve(repositoryRoot, "test/support/synthetic.js");
    const sources = [
      "import(`node:child_process`)",
      'import("node:%63hild_process")',
      'import("node:" + "child_process")',
      "import(moduleName)",
      'object.require("node:child_process")',
      'object.import("node:child_process")',
      'requireAlias("node:child_process")',
      'launch("node:child_process")',
      'import("node:\\x63hild_process")',
    ];

    for (const source of sources) assert.deepEqual(findViolations(syntheticTest, source, "test"), [], source);
  });

  it("reports syntax and line metadata", () => {
    const source = `const first = true;\n${prohibitedForms[0][1]}`;
    assert.deepEqual(extractLiteralLoads(source)[0], {
      syntax: "static import",
      specifier: childProcess,
      line: 2,
    });
  });

  it("starts require metadata at the require token on a multiline load", () => {
    const source = `const first = true;\n// spacer\n  require/* callee */(\n    ${quote(childProcess)}\n  )`;

    assert.deepEqual(extractLiteralLoads(source)[0], {
      syntax: "require",
      specifier: childProcess,
      line: 3,
    });
  });

  it("detects canonical test and production loads beyond the former declaration cap", () => {
    const longGap = "\n".repeat(20_000);
    const testFile = resolve(repositoryRoot, "test/support/large-imports.js");
    const productionFile = resolve(repositoryRoot, "src/nested/large-imports.js");
    const helperSpecifier = "../../test/helpers/git-fixture.js";
    const testSources = [
      `import { spawnSync }${longGap}from ${quote(childProcess)}`,
      `export { spawnSync }${longGap}from ${quote(childProcess)}`,
      `require(${longGap}${quote(childProcess)}, { fixture: true })`,
      `import(${longGap}${quote(childProcess)}, { with: { type: "json" } })`,
    ];
    const productionSources = [
      `import { fixture }${longGap}from ${quote(helperSpecifier)}`,
      `export { fixture }${longGap}from ${quote(helperSpecifier)}`,
      `require(${longGap}${quote(helperSpecifier)}, { fixture: true })`,
      `import(${longGap}${quote(helperSpecifier)}, { with: { type: "json" } })`,
    ];

    for (const source of testSources) assert.equal(findViolations(testFile, source, "test").length, 1, source);
    for (const source of productionSources) assert.equal(findViolations(productionFile, source, "production").length, 1, source);
  });

  it("continues past long comment-heavy incomplete declarations to later canonical loads", () => {
    const incompleteDeclaration = `import/*${"\n".repeat(24_000)}*/`;
    const source = `${incompleteDeclaration}\nimport ${quote(childProcess)}`;

    assert.deepEqual(extractLiteralLoads(source).map((load) => [load.syntax, load.specifier]), [["static import", childProcess]]);
  });
});

describe("import boundary policy", () => {
  const childProcess = "child_" + "process";
  const directChildProcessImport = `import ${JSON.stringify(childProcess)}`;

  it("allows the exact helper and production child-process loads only", () => {
    assert.deepEqual(findViolations(helperPath, directChildProcessImport, "test"), []);
    assert.deepEqual(findViolations(resolve(repositoryRoot, "src/git.js"), directChildProcessImport, "production"), []);

    const sibling = resolve(repositoryRoot, "test/helpers/git-fixture-copy.js");
    const nested = resolve(repositoryRoot, "test/helpers/nested/git-fixture.js");
    assert.equal(findViolations(sibling, directChildProcessImport, "test").length, 1);
    assert.equal(findViolations(nested, directChildProcessImport, "test").length, 1);
  });

  it("rejects both child-process spellings in recursively covered test modules", () => {
    const nestedTest = resolve(repositoryRoot, "test/support/nested/fixture.cjs");

    for (const specifier of [childProcess, "node:" + childProcess]) {
      for (const source of [
        `import { spawn } from ${JSON.stringify(specifier)}`,
        `export * from ${JSON.stringify(specifier)}`,
        `require(${JSON.stringify(specifier)})`,
        `import(${JSON.stringify(specifier)})`,
      ]) {
        assert.equal(findViolations(nestedTest, source, "test").length, 1, source);
      }
    }
  });

  it("rejects production loads resolving exactly to the helper", () => {
    const importer = resolve(repositoryRoot, "src/nested/module.js");
    const helperWithoutExtension = helperPath.slice(0, -3);
    const canonicalFileUrl = pathToFileURL(helperPath).href;
    const specifiers = [
      "../../test/helpers/git-fixture.js",
      "../../test/helpers/../helpers/git-fixture",
      "../../test/helpers/git-fixture.js?fixture=1",
      "../../test/helpers/git-fixture.js#fixture",
      "../../test/helpers/git-fixture.js?fixture=%2f#%23",
      helperPath,
      helperWithoutExtension,
      `${helperPath}?fixture=%2f#%23`,
      `${canonicalFileUrl}?fixture=1#fixture`,
      `${canonicalFileUrl}?fixture=%2f#%23`,
    ];

    for (const specifier of specifiers) {
      for (const source of [
        `import fixture from ${JSON.stringify(specifier)}`,
        `export { fixture } from ${JSON.stringify(specifier)}`,
        `require(${JSON.stringify(specifier)})`,
        `import(${JSON.stringify(specifier)})`,
      ]) {
        assert.equal(findViolations(importer, source, "production").length, 1, source);
      }
    }
  });

  it("allows near-name, encoded, bare, non-file URL, and computed helper loads", () => {
    const importer = resolve(repositoryRoot, "src/module.js");
    const sources = [
      'import "../test/helpers/git-fixtures.js"',
      'import "test/helpers/git-fixture.js"',
      'import "https://example.test/test/helpers/git-fixture.js"',
      'import "../test/helpers/git%2dfixture.js"',
      'import helperPath',
      'import("../test/helpers/" + "git-fixture.js")',
      'require(`../test/helpers/git-fixture.js`)',
    ];

    for (const source of sources) assert.deepEqual(findViolations(importer, source, "production"), [], source);
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
  const loads = [];

  for (const { syntax, expression } of loadPatterns) {
    expression.lastIndex = 0;
    for (const match of source.matchAll(expression)) {
      loads.push({
        syntax,
        specifier: match.groups.specifier,
        line: 1 + countLines(source, match.index),
      });
    }
  }

  return loads.sort((left, right) => left.line - right.line || left.syntax.localeCompare(right.syntax));
}

function countLines(source, end) {
  let count = 0;
  for (let index = 0; index < end; index += 1) if (source[index] === "\n") count += 1;
  return count;
}

function scanDirectory(directory, role) {
  return listJavaScriptFiles(directory).flatMap((file) => findViolations(file, readFileSync(file, "utf8"), role));
}

function listJavaScriptFiles(directory) {
  const files = [];

  for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) files.push(...listJavaScriptFiles(path));
    else if (entry.isFile() && JavaScriptExtensions.has(extname(entry.name))) files.push(path);
  }

  return files;
}

function findViolations(file, source, role) {
  const normalizedFile = normalize(file);
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
  const withoutSuffix = specifier.replace(/[?#].*$/, "");
  if (withoutSuffix.includes("%")) return false;
  let candidate;

  try {
    if (withoutSuffix.startsWith("file:")) candidate = fileURLToPath(withoutSuffix);
    else if (isAbsolute(withoutSuffix)) candidate = withoutSuffix;
    else if (withoutSuffix.startsWith("./") || withoutSuffix.startsWith("../")) {
      candidate = resolve(dirname(importer), withoutSuffix);
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
