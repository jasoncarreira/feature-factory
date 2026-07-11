import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, extname, isAbsolute, normalize, relative, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const helperPath = resolve(repositoryRoot, "test/helpers/git-fixture.js");
const JavaScriptExtensions = new Set([".js", ".mjs", ".cjs"]);
const childProcessSpecifiers = new Set(["child_" + "process", "node:" + "child_process"]);
const MAX_STATIC_DECLARATION_CHARS = 16_384;

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

  it("caps each malformed static declaration scan before continuing through long comment input", () => {
    const tooLongComment = `import/*${"\n".repeat(MAX_STATIC_DECLARATION_CHARS + 1)}*/`;
    const source = `${tooLongComment}\nimport ${quote(childProcess)}`;

    assert.deepEqual(extractLiteralLoads(source).map((load) => [load.syntax, load.specifier]), [
      ["static import", childProcess],
    ]);
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

  scanKeyword(source, "import", (index) => {
    addLoad(loads, source, "static import", index, scanStaticImport(source, index));
    addLoad(loads, source, "dynamic import", index, scanDirectCall(source, index + "import".length));
  });
  scanKeyword(source, "export", (index) => {
    addLoad(loads, source, "export-from", index, scanExportFrom(source, index));
  });
  scanKeyword(source, "require", (index) => {
    addLoad(loads, source, "require", index, scanDirectCall(source, index + "require".length));
  });

  return loads.sort((left, right) => left.line - right.line || left.syntax.localeCompare(right.syntax));
}

function addLoad(loads, source, syntax, index, specifier) {
  if (specifier !== null) loads.push({ syntax, specifier, line: 1 + countLines(source, index) });
}

function scanKeyword(source, keyword, callback) {
  let start = 0;

  while (start < source.length) {
    const index = source.indexOf(keyword, start);
    if (index === -1) return;
    if (isDirectKeyword(source, index, keyword)) callback(index);
    start = index + keyword.length;
  }
}

function isDirectKeyword(source, index, keyword) {
  const before = source[index - 1];
  const after = source[index + keyword.length];
  return before !== "." && !isIdentifierPart(before) && !isIdentifierPart(after);
}

function isIdentifierPart(character) {
  return character !== undefined && /[A-Za-z0-9_$]/.test(character);
}

function scanStaticImport(source, importIndex) {
  const end = Math.min(source.length, importIndex + "import".length + MAX_STATIC_DECLARATION_CHARS);
  const declarationStart = skipTrivia(source, importIndex + "import".length, end);
  if (declarationStart === null || source[declarationStart] === "(") return null;

  const directSpecifier = readQuotedSpecifier(source, declarationStart, end);
  if (directSpecifier !== null) return directSpecifier.specifier;
  return scanFromClause(source, declarationStart, end);
}

function scanExportFrom(source, exportIndex) {
  const end = Math.min(source.length, exportIndex + "export".length + MAX_STATIC_DECLARATION_CHARS);
  const declarationStart = skipTrivia(source, exportIndex + "export".length, end);
  if (declarationStart === null || !["*", "{"].includes(source[declarationStart])) return null;
  return scanFromClause(source, declarationStart + 1, end);
}

function scanFromClause(source, start, end) {
  let index = start;

  while (index < end) {
    const triviaEnd = skipTrivia(source, index, end);
    if (triviaEnd === null) return null;
    index = triviaEnd;
    if (index >= end || source[index] === ";") return null;

    if (source.startsWith("from", index) && isIdentifierBoundary(source[index - 1]) && isIdentifierBoundary(source[index + 4])) {
      const specifierStart = skipTrivia(source, index + 4, end);
      const specifier = specifierStart === null ? null : readQuotedSpecifier(source, specifierStart, end);
      if (specifier !== null) return specifier.specifier;
      index += 4;
      continue;
    }

    if (source[index] === '"' || source[index] === "'") {
      const stringEnd = skipDeclarationString(source, index, end);
      if (stringEnd === null) return null;
      index = stringEnd;
      continue;
    }

    index += 1;
  }

  return null;
}

function scanDirectCall(source, start) {
  const end = Math.min(source.length, start + MAX_STATIC_DECLARATION_CHARS);
  const openParenthesis = skipTrivia(source, start, end);
  if (openParenthesis === null || source[openParenthesis] !== "(") return null;

  const specifierStart = skipTrivia(source, openParenthesis + 1, end);
  const specifier = specifierStart === null ? null : readQuotedSpecifier(source, specifierStart, end);
  if (specifier === null) return null;

  const next = skipTrivia(source, specifier.end, end);
  return next !== null && [")", ","].includes(source[next]) ? specifier.specifier : null;
}

function skipTrivia(source, start, end) {
  let index = start;

  while (index < end) {
    if (/\s/.test(source[index])) {
      index += 1;
      continue;
    }
    if (source[index] !== "/" || (source[index + 1] !== "/" && source[index + 1] !== "*")) return index;

    const lineComment = source[index + 1] === "/";
    index += 2;
    while (index < end) {
      if (lineComment ? source[index] === "\n" || source[index] === "\r" : source[index] === "*" && source[index + 1] === "/") {
        index += lineComment ? 1 : 2;
        break;
      }
      index += 1;
    }
    if (index >= end && (!lineComment || source[index - 1] !== "\n")) return null;
  }

  return index;
}

function readQuotedSpecifier(source, start, end) {
  const quote = source[start];
  if (quote !== '"' && quote !== "'") return null;

  for (let index = start + 1; index < end; index += 1) {
    const character = source[index];
    if (character === quote) return { specifier: source.slice(start + 1, index), end: index + 1 };
    if (character === "\\" || character === "\n" || character === "\r") return null;
  }

  return null;
}

function skipDeclarationString(source, start, end) {
  const quote = source[start];

  for (let index = start + 1; index < end; index += 1) {
    if (source[index] === "\n" || source[index] === "\r") return null;
    if (source[index] === "\\") {
      index += 1;
      continue;
    }
    if (source[index] === quote) return index + 1;
  }

  return null;
}

function isIdentifierBoundary(character) {
  return !isIdentifierPart(character);
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
