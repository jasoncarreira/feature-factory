// The package boundary, asserted rather than intended.
//
// BUILD-PLAN-SMALL.md's contract: the factory is standalone with a CLI, the opencode
// integration depends on it and never writes state, and the dependency runs one way.
// Prose cannot hold that — the predecessor's plugin was read-only by convention and
// still reached mutation through imported dispatch-completion helpers.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const opencodePkg = resolve(here, "..");
const packages = resolve(opencodePkg, "..");
const factoryPkg = join(packages, "feature-factory");

function sources(dir, found = []) {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry.startsWith(".")) continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) sources(path, found);
    // .jsx too: the reactive component lives in one, and a scanner that reads only .js would let a
    // write primitive hide in exactly the file that was added last.
    else if ([".js", ".mjs", ".cjs", ".jsx"].some((extension) => entry.endsWith(extension))) found.push(path);
  }
  return found;
}

// Finding 7: an opencode helper invoked the CLI through an aliased node:child_process
// import and the boundary test passed. Shelling out to the CLI is the *documented*
// escape hatch, but it must be visible, so process-spawning is listed here too and a
// legitimate use has to be added deliberately.
// Matched as plain substrings against the whole file, comments included. That is intentional and
// it does bite: a comment *explaining* why a spawn is absent trips it just as a spawn would. The
// cost is occasional rewording; the benefit is a guard with no exceptions to reason about.
const WRITE_PRIMITIVES = [
  "withRunJsonLock", "writeProtectedJsonAtomic", "writeProtectedFileAtomic",
  "writeFileSync", "writeFile", "renameSync", "coordinateRunJsonTransition", "transition(",
  "node:child_process", "child_process", "execFile", "spawnSync", "spawn(", "exec(",
  "rmSync(", "rm(", "unlinkSync(", "unlink(", "mkdirSync(", "mkdir(", "rename(",
  "copyFileSync(", "copyFile(", "cpSync(", "cp(", "appendFileSync(", "appendFile(",
  "truncateSync(", "truncate(",
];

// Read-only by capability, not by convention: each name here can observe the filesystem and cannot
// change it. `lstatSync` was added for the sandbox container check — `statSync` follows a symlink and
// therefore cannot tell a real directory from a link to one, which is the whole question there.
const READ_ONLY_FS_IMPORTS = new Set(["existsSync", "lstatSync", "readdirSync", "readFileSync", "realpathSync", "statSync"]);
const FS_MUTATION_APIS = [
  "writeFile", "appendFile", "rm", "unlink", "mkdir", "rename", "copyFile", "cp", "truncate", "rmdir", "chmod", "chown", "utimes",
];

function filesystemOffenders(directory) {
  const offenders = [];
  for (const path of sources(directory)) {
    if (path.includes(`${directory}/test/`) || path.includes(`${directory}/tui/dist/`)) continue;
    const relativePath = path.slice(directory.length + 1);
    const text = readFileSync(path, "utf8");
    const imports = [...text.matchAll(/import\s+([\s\S]*?)\s+from\s*["'](node:fs(?:\/promises)?|fs(?:\/promises)?)["']/gu)];
    const mentions = text.match(/from\s*["'](?:node:)?fs(?:\/promises)?["']/gu)?.length ?? 0;
    if (imports.length !== mentions) offenders.push(`${relativePath} :: unrecognized fs import form`);
    for (const [, bindings, specifier] of imports) {
      const trimmed = bindings.trim();
      if (specifier.endsWith("/promises")) {
        offenders.push(`${relativePath} :: ${specifier} import`);
        continue;
      }
      const named = /^\{([\s\S]*)\}$/u.exec(trimmed)?.[1];
      if (named === undefined) {
        offenders.push(`${relativePath} :: non-allowlisted ${specifier} import form`);
        continue;
      }
      for (const name of named.split(",").map((entry) => entry.trim().split(/\s+as\s+/u)[0])) {
        if (name && !READ_ONLY_FS_IMPORTS.has(name)) offenders.push(`${relativePath} :: ${specifier} ${name}`);
      }
    }
    if (/\brequire\s*\(\s*["'](?:node:)?fs(?:\/promises)?["']\s*\)/u.test(text)) {
      offenders.push(`${relativePath} :: require fs module`);
    }
    for (const match of text.matchAll(new RegExp(`\\b[A-Za-z_$][\\w$]*\\s*\\.\\s*(?:promises\\s*\\.\\s*)?(${FS_MUTATION_APIS.join("|")})\\s*\\(`, "gu"))) {
      offenders.push(`${relativePath} :: filesystem mutation API ${match[1]}`);
    }
    for (const primitive of WRITE_PRIMITIVES) {
      if (text.includes(primitive)) offenders.push(`${relativePath} :: ${primitive}`);
    }
  }
  return offenders;
}

const IDENTIFIER_START = /[A-Za-z_$]/u;
const IDENTIFIER_PART = /[A-Za-z0-9_$]/u;
const REGEX_PREFIX_KEYWORDS = new Set([
  "await", "case", "delete", "do", "else", "in", "instanceof", "new", "of", "return", "throw", "typeof", "void", "yield",
]);
const CONTROL_PAREN_KEYWORDS = new Set(["catch", "for", "if", "switch", "while", "with"]);
const MULTI_CHARACTER_TOKENS = ["===", "!==", ">>>", "**=", "&&=", "||=", "??=", "=>", "==", "!=", "<=", ">=", "++", "--", "&&", "||", "??", "?.", "**", "<<", ">>", "+=", "-=", "*=", "/=", "%=", "&=", "|=", "^=", "...", ">>=", ">>>="]
  .sort((left, right) => right.length - left.length);

function sourceTokens(source) {
  const tokens = [];
  const lineStarts = [0];
  for (let index = 0; index < source.length; index += 1) {
    if (source[index] === "\n") lineStarts.push(index + 1);
  }

  function location(index) {
    let low = 0;
    let high = lineStarts.length;
    while (low + 1 < high) {
      const middle = Math.floor((low + high) / 2);
      if (lineStarts[middle] <= index) low = middle;
      else high = middle;
    }
    return { line: low + 1, column: index - lineStarts[low] + 1 };
  }

  function emit(type, value, start, end) {
    tokens.push({ type, value, start, end, ...location(start) });
    return tokens.at(-1);
  }

  function escapedValue(start) {
    const escaped = source[start + 1];
    if (escaped === undefined) return { value: "", end: start + 1 };
    if (escaped === "\n" || escaped === "\r") {
      return { value: "", end: start + (escaped === "\r" && source[start + 2] === "\n" ? 3 : 2) };
    }
    const simple = { b: "\b", f: "\f", n: "\n", r: "\r", t: "\t", v: "\v", 0: "\0" };
    if (simple[escaped] !== undefined) return { value: simple[escaped], end: start + 2 };
    if (escaped === "u" && source[start + 2] === "{") {
      const closing = source.indexOf("}", start + 3);
      const digits = closing === -1 ? "" : source.slice(start + 3, closing);
      if (/^[0-9A-Fa-f]{1,6}$/u.test(digits)) {
        return { value: String.fromCodePoint(Number.parseInt(digits, 16)), end: closing + 1 };
      }
    }
    const width = escaped === "x" ? 2 : escaped === "u" ? 4 : 0;
    const digits = width > 0 ? source.slice(start + 2, start + 2 + width) : "";
    if (width > 0 && new RegExp(`^[0-9A-Fa-f]{${width}}$`, "u").test(digits)) {
      return { value: String.fromCodePoint(Number.parseInt(digits, 16)), end: start + width + 2 };
    }
    return { value: escaped, end: start + 2 };
  }

  function quotedValue(start, quote) {
    let index = start + 1;
    let value = "";
    while (index < source.length) {
      const character = source[index];
      if (character === quote) return { value, end: index + 1 };
      if (character !== "\\") {
        value += character;
        index += 1;
        continue;
      }
      const escaped = escapedValue(index);
      value += escaped.value;
      index = escaped.end;
    }
    return { value, end: index };
  }

  function regexAllowed(previous) {
    if (!previous) return true;
    if (previous.regexPrefix) return true;
    if (previous.type === "identifier") return false;
    if (["number", "string", "regex", "template"].includes(previous.type)) return false;
    return ![")", "]", "}", "++", "--"].includes(previous.value);
  }

  function regexEnd(start) {
    let index = start + 1;
    let inClass = false;
    while (index < source.length) {
      const character = source[index];
      if (character === "\\") {
        index += 2;
        continue;
      }
      if (character === "[" && !inClass) inClass = true;
      else if (character === "]" && inClass) inClass = false;
      else if (character === "/" && !inClass) {
        index += 1;
        while (/[A-Za-z]/u.test(source[index] ?? "")) index += 1;
        return index;
      }
      if ((character === "\n" || character === "\r") && !inClass) return start + 1;
      index += 1;
    }
    return start + 1;
  }

  function templateEnd(start) {
    let index = start + 1;
    let value = "";
    let substituted = false;
    while (index < source.length) {
      if (source[index] === "\\") {
        const escaped = escapedValue(index);
        value += escaped.value;
        index = escaped.end;
        continue;
      }
      if (source[index] === "`") {
        const end = index + 1;
        return { end, token: substituted ? null : emit("template", value, start, end) };
      }
      if (source[index] === "$" && source[index + 1] === "{") {
        substituted = true;
        index = scan(index + 2, true);
        continue;
      }
      value += source[index];
      index += 1;
    }
    return { end: index, token: null };
  }

  function scan(start, stopAtClosingBrace) {
    let index = start;
    let braceDepth = 0;
    let previous = null;
    const parenthesisContexts = [];
    const braceContexts = [];
    let pendingFunctionDeclaration = false;
    let pendingClassDeclaration = false;
    while (index < source.length) {
      const character = source[index];
      if (/\s/u.test(character)) {
        index += 1;
        continue;
      }
      if (character === "/" && source[index + 1] === "/") {
        index += 2;
        while (index < source.length && source[index] !== "\n") index += 1;
        continue;
      }
      if (character === "/" && source[index + 1] === "*") {
        const end = source.indexOf("*/", index + 2);
        index = end === -1 ? source.length : end + 2;
        continue;
      }
      if (character === "'" || character === "\"") {
        const quoted = quotedValue(index, character);
        previous = emit("string", quoted.value, index, quoted.end);
        index = quoted.end;
        continue;
      }
      if (character === "`") {
        const template = templateEnd(index);
        index = template.end;
        previous = template.token ?? { type: "template", value: "" };
        continue;
      }
      if (character === "/" && regexAllowed(previous)
        && !(previous?.value === "<" && /[A-Za-z>]/u.test(source[index + 1] ?? ""))) {
        const end = regexEnd(index);
        if (end > index + 1) {
          previous = emit("regex", "", index, end);
          index = end;
          continue;
        }
      }
      if (IDENTIFIER_START.test(character)) {
        let end = index + 1;
        while (IDENTIFIER_PART.test(source[end] ?? "")) end += 1;
        const prior = previous;
        previous = emit("identifier", source.slice(index, end), index, end);
        const isMember = prior?.value === "." || prior?.value === "?.";
        previous.regexPrefix = REGEX_PREFIX_KEYWORDS.has(previous.value) && !isMember;
        previous.controlParen = CONTROL_PAREN_KEYWORDS.has(previous.value) && !isMember;
        const declarationPosition = !prior || [";", "{", "}"].includes(prior.value)
          || (prior.type === "identifier" && ["async", "default", "export"].includes(prior.value));
        if (previous.value === "function") pendingFunctionDeclaration = declarationPosition;
        if (previous.value === "class") pendingClassDeclaration = declarationPosition;
        index = end;
        continue;
      }
      if (/[0-9]/u.test(character)) {
        let end = index + 1;
        while (/[A-Za-z0-9_.]/u.test(source[end] ?? "")) end += 1;
        previous = emit("number", source.slice(index, end), index, end);
        index = end;
        continue;
      }
      if (character === "{") {
        braceDepth += 1;
        const classDeclarationBody = pendingClassDeclaration
          && (previous?.type === "identifier" || [")", "]", "}"].includes(previous?.value));
        const declarationBody = previous?.functionDeclarationClose === true || classDeclarationBody;
        braceContexts.push(declarationBody || !previous || previous.regexPrefix || previous.value === "=>"
          || previous.value === ";" || previous.value === "{"
          || (previous.type === "identifier" && ["do", "else", "finally", "try"].includes(previous.value)));
        if (classDeclarationBody) pendingClassDeclaration = false;
        previous = emit("punctuator", character, index, index + 1);
        index += 1;
        continue;
      }
      if (character === "}") {
        if (stopAtClosingBrace && braceDepth === 0) return index + 1;
        braceDepth = Math.max(0, braceDepth - 1);
        previous = emit("punctuator", character, index, index + 1);
        previous.regexPrefix = braceContexts.pop() ?? false;
        index += 1;
        continue;
      }
      const token = MULTI_CHARACTER_TOKENS.find((candidate) => source.startsWith(candidate, index)) ?? character;
      let regexPrefix = false;
      let functionDeclarationClose = false;
      if (token === "(") {
        parenthesisContexts.push({ control: previous?.controlParen === true, functionDeclaration: pendingFunctionDeclaration });
        pendingFunctionDeclaration = false;
      }
      if (token === ")") {
        const context = parenthesisContexts.pop();
        regexPrefix = context?.control ?? false;
        functionDeclarationClose = context?.functionDeclaration ?? false;
      }
      previous = emit("punctuator", token, index, index + token.length);
      previous.regexPrefix = regexPrefix;
      previous.functionDeclarationClose = functionDeclarationClose;
      index += token.length;
    }
    return index;
  }

  scan(0, false);
  return tokens;
}

function sourceEntries(input) {
  return input instanceof Map ? [...input.entries()] : Object.entries(input);
}

function tokenOffender(path, token, reason) {
  return `${path}:${token.line}:${token.column} :: ${reason}`;
}

function matchingPairs(tokens, opening, closing) {
  const pairs = new Map();
  const stack = [];
  for (let index = 0; index < tokens.length; index += 1) {
    if (tokens[index].value === opening) stack.push(index);
    else if (tokens[index].value === closing && stack.length > 0) {
      const start = stack.pop();
      pairs.set(start, index);
      pairs.set(index, start);
    }
  }
  return pairs;
}

function parenthesizedBounds(tokens, start, end, parentheses) {
  let first = start;
  let last = end;
  while (tokens[first - 1]?.value === "(" && parentheses.get(first - 1) === last + 1) {
    first -= 1;
    last += 1;
  }
  return { first, last };
}

function staticString(token) {
  return token?.type === "string" || token?.type === "template" ? token.value : null;
}

function expressionRanges(tokens, start, end) {
  const ranges = [];
  const depths = { "(": 0, "[": 0, "{": 0 };
  const closing = { ")": "(", "]": "[", "}": "{" };
  let rangeStart = start;
  for (let index = start; index < end; index += 1) {
    if (depths[tokens[index].value] !== undefined) depths[tokens[index].value] += 1;
    else if (closing[tokens[index].value]) depths[closing[tokens[index].value]] -= 1;
    else if (tokens[index].value === "," && Object.values(depths).every((depth) => depth === 0)) {
      ranges.push({ start: rangeStart, end: index });
      rangeStart = index + 1;
    }
  }
  ranges.push({ start: rangeStart, end });
  return ranges;
}

function staticRangeValue(tokens, range, parentheses) {
  let { start, end } = range;
  while (tokens[start]?.value === "(" && parentheses.get(start) === end - 1) {
    start += 1;
    end -= 1;
  }
  return end === start + 1 ? staticString(tokens[start]) : null;
}

function staticModuleArgument(tokens, opening, parentheses, invocation) {
  const closing = parentheses.get(opening);
  if (closing === undefined) return null;
  const arguments_ = expressionRanges(tokens, opening + 1, closing);
  const position = invocation === "direct" ? 0 : 1;
  const argument = arguments_[position];
  if (!argument) return null;
  if (invocation !== "apply") return staticRangeValue(tokens, argument, parentheses);
  if (tokens[argument.start]?.value !== "[" || tokens[argument.end - 1]?.value !== "]") return null;
  const applied = expressionRanges(tokens, argument.start + 1, argument.end - 1)[0];
  return applied ? staticRangeValue(tokens, applied, parentheses) : null;
}

function commonJsLoads(tokens) {
  const parentheses = matchingPairs(tokens, "(", ")");
  const loaders = new Set(["require"]);
  let changed = true;
  while (changed) {
    changed = false;
    for (let index = 0; index < tokens.length; index += 1) {
      if (tokens[index].value !== "=" || tokens[index - 1]?.type !== "identifier") continue;
      let expression = index + 1;
      while (tokens[expression]?.value === "(") expression += 1;
      const loaderAlias = tokens[expression]?.type === "identifier" && loaders.has(tokens[expression].value);
      const memberAlias = tokens[expression]?.type === "identifier"
        && ((tokens[expression + 1]?.value === "." && tokens[expression + 2]?.value === "require")
          || (tokens[expression + 1]?.value === "[" && staticString(tokens[expression + 2]) === "require"
            && tokens[expression + 3]?.value === "]"));
      if ((loaderAlias || memberAlias) && !loaders.has(tokens[index - 1].value)) {
        loaders.add(tokens[index - 1].value);
        changed = true;
      }
    }
  }

  const loads = [];
  const seen = new Set();
  function add(token, opening, invocation = "direct") {
    const module = staticModuleArgument(tokens, opening, parentheses, invocation);
    const key = `${token.start}:${module}`;
    if (seen.has(key)) return;
    seen.add(key);
    loads.push({ token, module });
  }
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.type === "identifier" && loaders.has(token.value)) {
      const bounds = parenthesizedBounds(tokens, index, index, parentheses);
      if (tokens[bounds.last + 1]?.value === "(") add(token, bounds.last + 1);
      if (tokens[bounds.last + 1]?.value === "." && ["call", "apply"].includes(tokens[bounds.last + 2]?.value)
        && tokens[bounds.last + 3]?.value === "(") add(token, bounds.last + 3, tokens[bounds.last + 2].value);
    }
    const dotMember = token.type === "identifier" && token.value === "require" && tokens[index - 1]?.value === ".";
    const computedMember = staticString(token) === "require" && tokens[index - 1]?.value === "["
      && tokens[index + 1]?.value === "]";
    const memberEnd = computedMember ? index + 1 : index;
    if ((dotMember || computedMember) && tokens[memberEnd + 1]?.value === "(") add(token, memberEnd + 1);
    if ((dotMember || computedMember) && tokens[memberEnd + 1]?.value === "."
      && ["call", "apply"].includes(tokens[memberEnd + 2]?.value) && tokens[memberEnd + 3]?.value === "(") {
      add(token, memberEnd + 3, tokens[memberEnd + 2].value);
    }
  }
  return loads;
}

function builtinModuleLoads(tokens) {
  const parentheses = matchingPairs(tokens, "(", ")");
  const loaders = new Set();
  let changed = true;
  while (changed) {
    changed = false;
    for (let index = 0; index < tokens.length; index += 1) {
      if (tokens[index].value !== "=" || tokens[index - 1]?.type !== "identifier") continue;
      let expression = index + 1;
      while (tokens[expression]?.value === "(") expression += 1;
      const loaderAlias = tokens[expression]?.type === "identifier" && loaders.has(tokens[expression].value);
      const memberAlias = tokens[expression]?.type === "identifier"
        && ((tokens[expression + 1]?.value === "." && tokens[expression + 2]?.value === "getBuiltinModule")
          || (tokens[expression + 1]?.value === "[" && staticString(tokens[expression + 2]) === "getBuiltinModule"
            && tokens[expression + 3]?.value === "]"));
      if ((loaderAlias || memberAlias) && !loaders.has(tokens[index - 1].value)) {
        loaders.add(tokens[index - 1].value);
        changed = true;
      }
    }
  }

  const loads = [];
  const seen = new Set();
  function add(token, opening, invocation = "direct") {
    const module = staticModuleArgument(tokens, opening, parentheses, invocation);
    const key = `${token.start}:${module}`;
    if (seen.has(key)) return;
    seen.add(key);
    loads.push({ token, module });
  }
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.type === "identifier" && loaders.has(token.value)) {
      const bounds = parenthesizedBounds(tokens, index, index, parentheses);
      if (tokens[bounds.last + 1]?.value === "(") add(token, bounds.last + 1);
      if (tokens[bounds.last + 1]?.value === "." && ["call", "apply"].includes(tokens[bounds.last + 2]?.value)
        && tokens[bounds.last + 3]?.value === "(") add(token, bounds.last + 3, tokens[bounds.last + 2].value);
    }
    const dotMember = token.type === "identifier" && token.value === "getBuiltinModule" && tokens[index - 1]?.value === ".";
    const computedMember = staticString(token) === "getBuiltinModule" && tokens[index - 1]?.value === "["
      && tokens[index + 1]?.value === "]";
    const memberEnd = computedMember ? index + 1 : index;
    if ((dotMember || computedMember) && tokens[memberEnd + 1]?.value === "(") add(token, memberEnd + 1);
    if ((dotMember || computedMember) && tokens[memberEnd + 1]?.value === "."
      && ["call", "apply"].includes(tokens[memberEnd + 2]?.value) && tokens[memberEnd + 3]?.value === "(") {
      add(token, memberEnd + 3, tokens[memberEnd + 2].value);
    }
  }
  return loads;
}

function moduleReferences(tokens) {
  const references = [];
  for (let index = 0; index < tokens.length; index += 1) {
    if (tokens[index].value !== "import" && tokens[index].value !== "export") continue;
    const kind = tokens[index].value;
    if (kind === "import" && tokens[index + 1]?.value === "(") {
      references.push({ kind: "dynamic", start: index, module: tokens[index + 2]?.type === "string" ? tokens[index + 2].value : null });
      continue;
    }
    let end = index + 1;
    while (end < tokens.length && tokens[end].value !== ";") end += 1;
    let moduleIndex = -1;
    if (kind === "import" && tokens[index + 1]?.type === "string") moduleIndex = index + 1;
    else {
      const from = tokens.findIndex((token, candidate) => candidate > index && candidate < end && token.value === "from");
      if (from !== -1 && tokens[from + 1]?.type === "string") moduleIndex = from + 1;
    }
    if (moduleIndex !== -1) references.push({ kind: "static", start: index, end, moduleIndex, module: tokens[moduleIndex].value });
  }
  return references;
}

function importShape(tokens, reference) {
  if (reference.kind !== "static" || tokens[reference.start].value !== "import") return { named: [], namespaces: [], defaults: [] };
  const from = tokens.findIndex((token, index) => index > reference.start && index < reference.moduleIndex && token.value === "from");
  if (from === -1) return { named: [], namespaces: [], defaults: [] };
  const named = [];
  const namespaces = [];
  const defaults = [];
  let index = reference.start + 1;
  while (index < from) {
    if (tokens[index].value === "{") {
      index += 1;
      while (index < from && tokens[index].value !== "}") {
        if (tokens[index].type !== "identifier") {
          index += 1;
          continue;
        }
        const imported = tokens[index].value;
        const local = tokens[index + 1]?.value === "as" && tokens[index + 2]?.type === "identifier"
          ? tokens[index + 2].value : imported;
        named.push({ imported, local, token: tokens[index] });
        index += local === imported ? 1 : 3;
      }
      index += 1;
      continue;
    }
    if (tokens[index].value === "*" && tokens[index + 1]?.value === "as" && tokens[index + 2]?.type === "identifier") {
      namespaces.push({ local: tokens[index + 2].value, token: tokens[index] });
      index += 3;
      continue;
    }
    if (tokens[index].type === "identifier") defaults.push({ local: tokens[index].value, token: tokens[index] });
    index += 1;
  }
  return { named, namespaces, defaults };
}

function createRequireLoaderOffenders(path, tokens) {
  const offenders = [];
  const factories = new Set();
  const namespaces = new Set();
  for (const reference of moduleReferences(tokens)) {
    if (reference.kind !== "static" || reference.module !== "node:module") continue;
    const shape = importShape(tokens, reference);
    for (const binding of shape.named) {
      if (binding.imported === "createRequire") factories.add(binding.local);
    }
    for (const binding of shape.namespaces) namespaces.add(binding.local);
  }
  if (factories.size === 0 && namespaces.size === 0) return offenders;

  const parentheses = matchingPairs(tokens, "(", ")");
  const factoryCalls = new Map();
  for (let index = 0; index < tokens.length; index += 1) {
    let opening = -1;
    if (tokens[index].type === "identifier" && factories.has(tokens[index].value) && tokens[index + 1]?.value === "(") opening = index + 1;
    if (tokens[index].type === "identifier" && namespaces.has(tokens[index].value)
      && tokens[index + 1]?.value === "." && tokens[index + 2]?.value === "createRequire" && tokens[index + 3]?.value === "(") opening = index + 3;
    if (opening !== -1 && parentheses.has(opening)) factoryCalls.set(index, { opening, closing: parentheses.get(opening) });
  }

  const loaders = new Set();
  for (let index = 0; index < tokens.length; index += 1) {
    if (tokens[index].value !== "=" || tokens[index - 1]?.type !== "identifier") continue;
    let expression = index + 1;
    while (tokens[expression]?.value === "(") expression += 1;
    const call = factoryCalls.get(expression);
    const bounds = call ? parenthesizedBounds(tokens, expression, call.closing, parentheses) : null;
    if (call && !(tokens[bounds.last + 1]?.value === "." && tokens[bounds.last + 2]?.value === "resolve")) {
      loaders.add(tokens[index - 1].value);
    }
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (let index = 0; index < tokens.length; index += 1) {
      if (tokens[index].value !== "=" || tokens[index - 1]?.type !== "identifier") continue;
      let expression = index + 1;
      while (tokens[expression]?.value === "(") expression += 1;
      if (tokens[expression]?.type === "identifier" && loaders.has(tokens[expression].value) && !loaders.has(tokens[index - 1].value)) {
        loaders.add(tokens[index - 1].value);
        changed = true;
      }
    }
  }

  const seen = new Set();
  function add(token) {
    const key = `${token.start}`;
    if (seen.has(key)) return;
    seen.add(key);
    offenders.push(tokenOffender(path, token, "createRequire result invoked as loader"));
  }
  for (const [start, call] of factoryCalls) {
    const bounds = parenthesizedBounds(tokens, start, call.closing, parentheses);
    const next = tokens[bounds.last + 1];
    if (next?.value === "(") add(tokens[start]);
    if (next?.value === "." && ["call", "apply"].includes(tokens[bounds.last + 2]?.value)
      && tokens[bounds.last + 3]?.value === "(") add(tokens[start]);
  }
  for (let index = 0; index < tokens.length; index += 1) {
    if (tokens[index].type !== "identifier" || !loaders.has(tokens[index].value)) continue;
    const bounds = parenthesizedBounds(tokens, index, index, parentheses);
    if (tokens[bounds.last + 1]?.value === "(") add(tokens[index]);
    if (tokens[bounds.last + 1]?.value === "." && ["call", "apply"].includes(tokens[bounds.last + 2]?.value)
      && tokens[bounds.last + 3]?.value === "(") add(tokens[index]);
  }
  return offenders;
}

const FILESYSTEM_READ_APIS = new Set([
  "access", "accessSync", "createReadStream", "exists", "existsSync", "fstat", "fstatSync", "glob", "globSync", "lstat", "lstatSync", "open", "openAsBlob", "openSync", "opendir", "opendirSync", "read", "readLines", "readSync", "readableWebStream", "readdir", "readdirSync", "readFile", "readFileSync", "readlink", "readlinkSync", "readv", "readvSync", "realpath", "realpathSync", "stat", "statSync", "statfs", "statfsSync", "watch", "watchFile",
]);

function isAllowedReaddirCall(tokens, index, closing) {
  return closing === index + 3 && tokens[index + 1]?.value === "(" && tokens[index + 2]?.value === "dir";
}

function isAllowedReadFileCall(tokens, index, closing) {
  return closing === index + 10
    && tokens[index + 1]?.value === "("
    && tokens[index + 2]?.value === "join"
    && tokens[index + 3]?.value === "("
    && tokens[index + 4]?.value === "dir"
    && tokens[index + 5]?.value === ","
    && tokens[index + 6]?.value === "file"
    && tokens[index + 7]?.value === ")"
    && tokens[index + 8]?.value === ","
    && tokens[index + 9]?.type === "string"
    && tokens[index + 9]?.value === "utf8";
}

function forbiddenConfigurationModule(specifier) {
  return specifier.endsWith(".json") || /(?:^|\/)\.(?:claude|opencode)(?:\/|$)/u.test(specifier)
    || /(?:^|\/)(?:profiles?|agents?)(?:\/|\.(?:json|mjs|cjs|js|md)|$)/u.test(specifier);
}

// This scanner is deliberately bounded to the registration pair. A new package-local module is not
// harmless plumbing: it would let registration move a configuration read or loader beyond the two
// sources this allowlist examines. Keep the existing import graph explicit; widening it requires
// expanding the scanner and its controls in the same change.
const ALLOWED_REGISTRATION_LOCAL_IMPORTS = {
  // Registration imports only the config module. `observe/runs.js` used to be re-exported here and
  // imported for a binding nothing used, which pulled the whole run-reading module into the
  // registration graph while this guard scanned only these two files — so an import-time read added
  // there would have executed during registration and failed neither guard. The TUI and the tests
  // import `observe/runs.js` directly, so nothing consumed those re-exports. Dropping the allowlist
  // entry is the load-bearing half: re-adding the import now fails as an unscanned package-local
  // static import rather than being waved through.
  "plugin/index.js": new Set(["./config.js"]),
  "plugin/config.js": new Set(),
};

function packageLocalRegistrationImport(specifier) {
  return specifier.startsWith("./") || specifier.startsWith("../");
}

function registrationReadOffenders(input) {
  const offenders = [];
  for (const [path, source] of sourceEntries(input)) {
    const tokens = sourceTokens(source);
    const references = moduleReferences(tokens);
    let allowedFsImports = 0;
    let allowedCreateRequireImports = 0;
    const filesystemImportTokens = new Set();
    const createRequireImportTokens = new Set();
    for (const reference of references) {
      const token = tokens[reference.start];
      if (reference.kind === "dynamic") {
        offenders.push(tokenOffender(path, token, "dynamic import"));
        continue;
      }
      if (packageLocalRegistrationImport(reference.module)
        && !ALLOWED_REGISTRATION_LOCAL_IMPORTS[path]?.has(reference.module)) {
        offenders.push(tokenOffender(path, token, "unscanned package-local static import"));
      }
      if (forbiddenConfigurationModule(reference.module)) {
        offenders.push(tokenOffender(path, token, "forbidden static configuration import"));
      }
      if (["fs", "node:fs/promises", "fs/promises"].includes(reference.module)) {
        offenders.push(tokenOffender(path, token, `forbidden filesystem module ${reference.module}`));
        continue;
      }
      if (reference.module === "node:fs") {
        for (let index = reference.start; index <= reference.end; index += 1) filesystemImportTokens.add(tokens[index]?.start);
        if (path !== "plugin/config.js") {
          offenders.push(tokenOffender(path, token, "node:fs import outside plugin/config.js"));
          continue;
        }
        const shape = importShape(tokens, reference);
        if (shape.namespaces.length > 0) offenders.push(tokenOffender(path, token, "namespace node:fs import"));
        else if (shape.defaults.length > 0) offenders.push(tokenOffender(path, token, "default node:fs import"));
        else if (shape.named.some((binding) => binding.imported !== binding.local)) offenders.push(tokenOffender(path, token, "aliased node:fs import"));
        else if (shape.named.length !== 2 || !shape.named.some((binding) => binding.imported === "readdirSync")
          || !shape.named.some((binding) => binding.imported === "readFileSync")) {
          offenders.push(tokenOffender(path, token, "unsupported node:fs import"));
        } else {
          allowedFsImports += 1;
          if (allowedFsImports > 1) offenders.push(tokenOffender(path, token, "duplicate allowed node:fs import"));
        }
      }
      if (reference.module === "node:module") {
        for (let index = reference.start; index <= reference.end; index += 1) createRequireImportTokens.add(tokens[index]?.start);
        const shape = importShape(tokens, reference);
        if (path === "plugin/config.js" && shape.named.length === 1 && shape.named[0].imported === "createRequire"
          && shape.named[0].local === "createRequire" && shape.namespaces.length === 0 && shape.defaults.length === 0) {
          allowedCreateRequireImports += 1;
          if (allowedCreateRequireImports > 1) offenders.push(tokenOffender(path, token, "duplicate allowed createRequire import"));
        } else {
          offenders.push(tokenOffender(path, token, "unsupported createRequire import"));
        }
      }
    }

    const parentheses = matchingPairs(tokens, "(", ")");
    let allowedReaddirCalls = 0;
    let allowedReadFileCalls = 0;
    let allowedCreateRequireCalls = 0;
    const allowedReadCallTokens = new Set();
    const allowedCreateRequireCallTokens = new Set();
    for (let index = 0; index < tokens.length; index += 1) {
      const token = tokens[index];
      if (token.type !== "identifier" || tokens[index + 1]?.value !== "(") continue;
      const closing = parentheses.get(index + 1);
      if (token.value === "createRequire") {
        const exactArgument = closing === index + 7
          && tokens[index + 2]?.value === "import"
          && tokens[index + 3]?.value === "."
          && tokens[index + 4]?.value === "meta"
          && tokens[index + 5]?.value === "."
          && tokens[index + 6]?.value === "url";
        const resolveOpening = closing === undefined ? -1 : closing + 3;
        const resolveClosing = parentheses.get(resolveOpening);
        const exactResolve = tokens[closing + 1]?.value === "."
          && tokens[closing + 2]?.value === "resolve"
          && tokens[resolveOpening]?.value === "("
          && resolveClosing === resolveOpening + 2
          && tokens[resolveOpening + 1]?.type === "string"
          && tokens[resolveOpening + 1]?.value === "feature-factory";
        if (path === "plugin/config.js" && exactArgument && exactResolve) {
          allowedCreateRequireCallTokens.add(token.start);
          allowedCreateRequireCalls += 1;
          if (allowedCreateRequireCalls > 1) offenders.push(tokenOffender(path, token, "duplicate allowed createRequire resolve"));
        } else {
          offenders.push(tokenOffender(path, token, "unsupported createRequire usage"));
        }
      }
      if (!FILESYSTEM_READ_APIS.has(token.value) || tokens[index - 1]?.value === ".") continue;
      if (path !== "plugin/config.js") {
        offenders.push(tokenOffender(path, token, `filesystem read outside plugin/config.js: ${token.value}`));
        continue;
      }
      if (token.value === "readdirSync" && isAllowedReaddirCall(tokens, index, closing)) {
        allowedReadCallTokens.add(token.start);
        allowedReaddirCalls += 1;
        if (allowedReaddirCalls > 1) offenders.push(tokenOffender(path, token, "duplicate allowed readdirSync"));
      } else if (token.value === "readFileSync" && isAllowedReadFileCall(tokens, index, closing)) {
        allowedReadCallTokens.add(token.start);
        allowedReadFileCalls += 1;
        if (allowedReadFileCalls > 1) offenders.push(tokenOffender(path, token, "duplicate allowed readFileSync"));
      } else if (token.value === "readdirSync" || token.value === "readFileSync") {
        offenders.push(tokenOffender(path, token, `extra direct ${token.value}`));
      } else {
        offenders.push(tokenOffender(path, token, `additional filesystem read API ${token.value}`));
      }
    }
    for (let index = 0; index < tokens.length; index += 1) {
      const token = tokens[index];
      if (token.type !== "identifier" || !FILESYSTEM_READ_APIS.has(token.value) || filesystemImportTokens.has(token.start)
        || allowedReadCallTokens.has(token.start) || tokens[index - 1]?.value === ".") continue;
      if (tokens[index + 1]?.value === "(") continue;
      const reason = ["readdirSync", "readFileSync"].includes(token.value)
        ? `extra direct ${token.value}` : `additional filesystem read API ${token.value}`;
      offenders.push(tokenOffender(path, token, reason));
    }
    for (const token of tokens) {
      if (token.type !== "identifier" || token.value !== "createRequire" || createRequireImportTokens.has(token.start)
        || allowedCreateRequireCallTokens.has(token.start)) continue;
      offenders.push(tokenOffender(path, token, "unsupported createRequire usage"));
    }
    for (let index = 1; index < tokens.length - 2; index += 1) {
      if (tokens[index].value !== "." || tokens[index + 1]?.type !== "identifier"
        || !FILESYSTEM_READ_APIS.has(tokens[index + 1].value) || tokens[index + 2]?.value !== "(") continue;
      offenders.push(tokenOffender(path, tokens[index + 1], `filesystem member read ${tokens[index + 1].value}`));
    }
    for (let index = 1; index < tokens.length - 3; index += 1) {
      const member = staticString(tokens[index + 1]);
      if (tokens[index].value !== "[" || !FILESYSTEM_READ_APIS.has(member) || tokens[index + 2]?.value !== "]"
        || tokens[index + 3]?.value !== "(") continue;
      offenders.push(tokenOffender(path, tokens[index + 1], `filesystem member read ${member}`));
    }
    for (const load of commonJsLoads(tokens)) {
      const reason = load.module === null ? "CommonJS require with variable argument" : "CommonJS require";
      offenders.push(tokenOffender(path, load.token, reason));
      if (load.module !== null && forbiddenConfigurationModule(load.module)) {
        offenders.push(tokenOffender(path, load.token, "CommonJS configuration load"));
      }
      if (["fs", "node:fs", "fs/promises", "node:fs/promises"].includes(load.module)) {
        offenders.push(tokenOffender(path, load.token, `CommonJS filesystem load ${load.module}`));
      }
    }
    for (const load of builtinModuleLoads(tokens)) {
      const reason = load.module === null
        ? "alternate built-in module acquisition with variable argument"
        : `alternate built-in module acquisition ${load.module}`;
      offenders.push(tokenOffender(path, load.token, reason));
    }
    offenders.push(...createRequireLoaderOffenders(path, tokens));
    if (path === "plugin/config.js") {
      if (allowedFsImports === 0) offenders.push(tokenOffender(path, tokens[0] ?? { line: 1, column: 1 }, "missing allowed node:fs import"));
      if (allowedCreateRequireImports === 0) offenders.push(tokenOffender(path, tokens[0] ?? { line: 1, column: 1 }, "missing allowed createRequire import"));
      if (allowedCreateRequireCalls === 0) offenders.push(tokenOffender(path, tokens[0] ?? { line: 1, column: 1 }, "missing allowed createRequire resolve"));
      if (allowedReaddirCalls === 0) offenders.push(tokenOffender(path, tokens[0] ?? { line: 1, column: 1 }, "missing allowed readdirSync call"));
      if (allowedReadFileCalls === 0) offenders.push(tokenOffender(path, tokens[0] ?? { line: 1, column: 1 }, "missing allowed readFileSync call"));
    }
  }
  return offenders;
}

function executionOffenders(input) {
  const offenders = [];
  for (const [path, source] of sourceEntries(input)) {
    const tokens = sourceTokens(source);
    for (const token of tokens) {
      if (token.type === "identifier" && token.value === "eval") offenders.push(tokenOffender(path, token, "executable eval identifier"));
      if (token.type === "identifier" && token.value === "Function") offenders.push(tokenOffender(path, token, "executable Function identifier"));
    }
    for (let index = 0; index < tokens.length - 2; index += 1) {
      if (tokens[index].value !== "[" || !["string", "template"].includes(tokens[index + 1]?.type)
        || tokens[index + 2]?.value !== "]") continue;
      if (tokens[index + 1].value === "eval") {
        const reason = tokens[index + 1].type === "template" ? "static template eval member" : "static eval member";
        offenders.push(tokenOffender(path, tokens[index + 1], reason));
      }
      if (tokens[index + 1].value === "Function") {
        const reason = tokens[index + 1].type === "template" ? "static template Function member" : "static Function member";
        offenders.push(tokenOffender(path, tokens[index + 1], reason));
      }
    }
    for (const reference of moduleReferences(tokens)) {
      if (reference.kind === "dynamic") offenders.push(tokenOffender(path, tokens[reference.start], "dynamic import"));
      if (reference.kind === "static" && ["node:vm", "vm"].includes(reference.module)) {
        offenders.push(tokenOffender(path, tokens[reference.start], "static vm import"));
      }
    }
    for (const load of commonJsLoads(tokens)) {
      if (["node:vm", "vm"].includes(load.module)) offenders.push(tokenOffender(path, load.token, "CommonJS vm load"));
    }
    for (const load of builtinModuleLoads(tokens)) {
      if (["node:vm", "vm"].includes(load.module)) offenders.push(tokenOffender(path, load.token, "built-in vm load"));
    }
    offenders.push(...createRequireLoaderOffenders(path, tokens));
  }
  return offenders;
}

function productionSources(directory) {
  return new Map(sources(directory)
    .filter((path) => !path.includes(`${directory}/test/`) && !path.includes(`${directory}/tui/dist/`))
    .map((path) => [path.slice(directory.length + 1), readFileSync(path, "utf8")]));
}

function registrationBaseline(addition = "") {
  return new Map([
    ["plugin/index.js", 'import { registerWorkflow } from "./config.js";\nexport { readRun } from "feature-factory";\n'],
    ["plugin/config.js", `import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { readRun } from "feature-factory";
const resolved = createRequire(import.meta.url).resolve("feature-factory");
function definitions(dir) {
  for (const file of readdirSync(dir)) readFileSync(join(dir, file), "utf8");
}
${addition}`],
  ]);
}

function assertReason(offenders, path, reason, context = path) {
  assert.ok(offenders.some((entry) => entry.startsWith(`${path}:`) && entry.endsWith(` :: ${reason}`)),
    `expected ${context} to report ${reason}; received ${offenders.join(" | ")}`);
}

describe("package boundary", () => {
  it("gives the opencode package no way to write run state", () => {
    assert.deepEqual(filesystemOffenders(opencodePkg), [], "the opencode package observes and renders; only the CLI writes");

    const root = mkdtempSync(join(tmpdir(), "ff-boundary-fs-bypasses-"));
    try {
      const fixtures = new Map([
        ["allowed.mjs", 'import { readFileSync as read } from "node:fs";\nread("run.json");\n'],
        ["named.js", 'import { writeFile as harmless } from "node:fs";\nharmless("run.json", "bad");\n'],
        ["default.js", 'import fs from "fs";\nfs.writeFile("run.json", "bad");\n'],
        ["namespace.mjs", 'import * as fs from "node:fs";\nfs.promises.rm("run.json");\n'],
        ["promise-default.cjs", 'import fs from "node:fs/promises";\nfs.appendFile("run.json", "bad");\n'],
        ["promise-named.js", 'import { writeFile as renamed } from "fs/promises";\nrenamed("run.json", "bad");\n'],
        ["require.cjs", 'const { mkdir: alias } = require("fs");\nalias("state");\n'],
      ]);
      for (const [file, contents] of fixtures) writeFileSync(join(root, file), contents);
      const offenders = filesystemOffenders(root);
      assert.equal(offenders.some((entry) => entry.startsWith("allowed.mjs ::")), false,
        "a named/aliased read-only node:fs import remains allowed");
      for (const file of [...fixtures.keys()].filter((name) => name !== "allowed.mjs")) {
        assert.ok(offenders.some((entry) => entry.startsWith(`${file} ::`)),
          `filesystem scanner must catch the ${file} import bypass`);
      }
      assert.ok(offenders.some((entry) => entry === "default.js :: filesystem mutation API writeFile"),
        "the scanner catches a representative default-import mutation API");
      assert.ok(offenders.some((entry) => entry === "namespace.mjs :: filesystem mutation API rm"),
        "the scanner catches a representative namespace promise mutation API");
      assert.ok(offenders.some((entry) => entry === "promise-default.cjs :: filesystem mutation API appendFile"),
        "the scanner catches a representative fs/promises mutation API");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("consumes only the schema and the read-only reader", () => {
    const imported = new Set();
    for (const path of sources(opencodePkg)) {
      if (path.includes(`${opencodePkg}/test/`)) continue;
      const text = readFileSync(path, "utf8");
      for (const [, names] of text.matchAll(/(?:import|export)\s*\{([^}]*)\}\s*from\s*["']feature-factory["']/gu)) {
        for (const name of names.split(",")) {
          const trimmed = name.trim().split(/\s+as\s+/u)[0];
          if (trimmed) imported.add(trimmed);
        }
      }
    }
    // Widening this list is the signal that the boundary is wrong, not that the
    // export surface is too small.
    // `transition` is deliberately absent: it no longer exists in the package root.
    const allowed = ["readRun", "readRunUnchecked", "nextAction", "validateRun", "SchemaError", "RUN_KEYS", "SCHEMA_VERSION", "CONTROL_PLANE"];
    const unexpected = [...imported].filter((name) => !allowed.includes(name));
    assert.deepEqual(unexpected, [], `unexpected imports from feature-factory: ${unexpected.join(", ")}`);
  });

  it("keeps the dependency one way", () => {
    const offenders = sources(factoryPkg)
      .filter((path) => /["']opencode-feature-factory["']|\.\.\/opencode-feature-factory/u.test(readFileSync(path, "utf8")))
      .map((path) => path.slice(factoryPkg.length + 1));
    assert.deepEqual(offenders, [], "the factory package must not know the opencode package exists");
  });

  it("declares the dependency in the manifest, in that direction only", () => {
    const factory = JSON.parse(readFileSync(join(factoryPkg, "package.json"), "utf8"));
    const opencode = JSON.parse(readFileSync(join(opencodePkg, "package.json"), "utf8"));

    assert.equal(opencode.dependencies?.["feature-factory"], factory.version,
      "the opencode package pins the factory version it was built against");
    assert.deepEqual(Object.keys(factory.dependencies ?? {}), [],
      "the standalone package takes no dependency at all, so it installs and tests with no opencode present");
    assert.ok(factory.bin?.factory, "the factory package ships the CLI");
    assert.equal(opencode.bin, undefined, "the opencode package ships no CLI of its own");
  });

  it("exposes exactly the read-only surface at runtime, under any alias", async () => {
    // Finding 4: the previous check was name-based, so
    //   export { transition as mutateRun } from "./transition.js";
    // reintroduced the exact defect and stayed green. This imports the package root and
    // asserts the actual export set, which an alias cannot escape: mutateRun is simply
    // not in the allowlist.
    const manifest = JSON.parse(readFileSync(join(factoryPkg, "package.json"), "utf8"));
    const root = (manifest.exports?.["."] ?? manifest.main).replace(/^\.\//u, "");
    const module = await import(new URL(`file://${join(factoryPkg, root)}`).href);
    // `nextAction` was added deliberately. Widening this list is normally the signal that the
    // boundary is wrong — but this is a pure read-only derivation over run state that both
    // `factory status` and the sidebar must agree on, and the alternative was a second copy of
    // resume order in the TUI. One read-only export removes a drift risk; it does not grant
    // authority, and the reachability check below still proves it cannot write.
    const allowed = [
      "readRun", "readRunUnchecked", "nextAction", "validateRun", "SchemaError", "RUN_KEYS", "SCHEMA_VERSION", "CONTROL_PLANE",
      "RUN_STATUSES", "TERMINAL_STATUSES", "MODES", "GATE_NAMES", "GATE_STATUSES",
      "STEP_STATUSES", "SLICE_STATUSES", "VALIDATOR_VERDICTS",
    ];
    const actual = Object.keys(module).sort();
    assert.deepEqual(actual, [...allowed].sort(),
      "the package root's runtime exports must be exactly the read-only surface");
    // And nothing exported may reach the write core, whatever it is called.
    for (const [name, value] of Object.entries(module)) {
      if (typeof value !== "function") continue;
      assert.equal(/coordinateRunJsonTransition|withRunJsonLock/u.test(String(value)), false,
        `exported ${name} reaches a write primitive`);
    }
  });

  it("does not expose a mutation entry point from the factory package root", () => {
    // Finding 6: state/index.js exported `transition` while package.json exposed that
    // module as the root, so the "read-only reader plus schema" public API handed out
    // mutation authority. The write path now lives in a module the manifest does not
    // export.
    const manifest = JSON.parse(readFileSync(join(factoryPkg, "package.json"), "utf8"));
    const root = manifest.exports?.["."] ?? manifest.main;
    const rootSource = readFileSync(join(factoryPkg, root.replace(/^\.\//u, "")), "utf8");
    assert.equal(/export\s+(async\s+)?function\s+transition\b/u.test(rootSource), false,
      "the package root must not export a write path");
    assert.equal(/coordinateRunJsonTransition/u.test(rootSource), false,
      "the package root must not reach the write core at all");
    const exported = Object.values(manifest.exports ?? {});
    assert.equal(exported.includes("./state/transition.js"), false,
      "the write path must not be reachable through any declared export");
  });

  it("names the factory package without an opencode prefix", () => {
    const factory = JSON.parse(readFileSync(join(factoryPkg, "package.json"), "utf8"));
    assert.equal(/opencode/u.test(factory.name), false,
      "a host-agnostic package must not be named after one host");
  });

  it("reads only the installed factory agent definitions during registration", () => {
    const registration = new Map([
      ["plugin/index.js", readFileSync(join(opencodePkg, "plugin/index.js"), "utf8")],
      ["plugin/config.js", readFileSync(join(opencodePkg, "plugin/config.js"), "utf8")],
    ]);
    assert.deepEqual(registrationReadOffenders(registration), []);
    assert.deepEqual(registrationReadOffenders(registrationBaseline()), []);
    assert.deepEqual(registrationReadOffenders(registrationBaseline('const quoted = "readFileSync";')), []);
    assert.deepEqual(registrationReadOffenders(registrationBaseline('const quoted = "createRequire";')), []);
    assert.deepEqual(registrationReadOffenders(registrationBaseline('const prompt = `readFileSync createRequire`;')), []);

    const controls = [
      ["discarded-direct.js", 'readFileSync("opencode.json", "utf8");', "extra direct readFileSync"],
      ["swallowed-foreign.js", 'try { readFileSync(".claude/settings.json", "utf8"); } catch {}', "extra direct readFileSync"],
      ["aliased-project.js", 'import { readFileSync as readProject } from "node:fs";\nreadProject(".opencode/opencode.json", "utf8");', "aliased node:fs import"],
      ["namespace.js", 'import * as fs from "node:fs";\nfs.readFileSync("opencode.json", "utf8");', "namespace node:fs import"],
      ["default.js", 'import fs from "node:fs";\nfs.readFileSync("opencode.json", "utf8");', "default node:fs import"],
      ["bare-fs.js", 'import { readFileSync as readProject } from "fs";\nreadProject("opencode.json", "utf8");', "forbidden filesystem module fs"],
      ["node-promises.js", 'import { readFile } from "node:fs/promises";\nawait readFile("opencode.json");', "forbidden filesystem module node:fs/promises"],
      ["bare-promises.js", 'import { readFile } from "fs/promises";\nawait readFile("opencode.json");', "forbidden filesystem module fs/promises"],
      ["commonjs.js", 'const fs = require("node:fs");\nfs.readFileSync("opencode.json", "utf8");', "CommonJS require"],
      ["dynamic-fs.js", 'await import("node:fs");', "dynamic import"],
      ["dynamic-foreign.js", 'await import(".claude/config.mjs");', "dynamic import"],
      ["static-config.js", 'import config from "../.opencode/opencode.json";', "forbidden static configuration import"],
      ["extra-api.js", 'existsSync("opencode.json");', "additional filesystem read API existsSync"],
      ["read-vector.js", 'readvSync(handle, buffers);', "additional filesystem read API readvSync"],
      ["aliased-read-vector.js", 'const inspect = readvSync;\ninspect(handle, buffers);', "additional filesystem read API readvSync"],
      ["filesystem-glob.js", 'globSync("**/opencode.json");', "additional filesystem read API globSync"],
      ["filesystem-statfs.js", 'statfsSync(".");', "additional filesystem read API statfsSync"],
      ["bracket-read.js", 'fs["readFileSync"]("opencode.json", "utf8");', "filesystem member read readFileSync"],
      ["aliased-commonjs-config.js", 'const load = require;\nload("../.claude/config.mjs");', "CommonJS configuration load"],
      ["member-commonjs-config.js", 'module.require("../.opencode/profiles.json");', "CommonJS configuration load"],
      ["member-call-commonjs-config.js", 'module.require.call("safe-this", "../.claude/config.mjs");', "CommonJS configuration load"],
      ["member-apply-commonjs-config.js", 'module.require.apply("safe-this", ["../.claude/config.mjs"]);', "CommonJS configuration load"],
      ["computed-commonjs-config.js", 'module["require"]("../.opencode/profiles.json");', "CommonJS configuration load"],
      ["computed-call-commonjs-config.js", 'module["require"].call("safe-this", "../.claude/config.mjs");', "CommonJS configuration load"],
      ["computed-apply-commonjs-config.js", 'module["require"].apply("safe-this", ["../.claude/config.mjs"]);', "CommonJS configuration load"],
      ["member-alias-commonjs-config.js", 'const load = module["require"];\nload("../.claude/settings.json");', "CommonJS configuration load"],
      ["variable-commonjs.js", 'const target = ".opencode/opencode.json";\nrequire(target);', "CommonJS require with variable argument"],
      ["called-commonjs-filesystem.js", 'require.call("safe-this", "node:fs");', "CommonJS filesystem load node:fs"],
      ["applied-commonjs-filesystem.js", 'require.apply("safe-this", ["node:fs/promises"]);', "CommonJS filesystem load node:fs/promises"],
      ["builtin-filesystem.js", 'process.getBuiltinModule("node:fs");', "alternate built-in module acquisition node:fs"],
      ["variable-builtin.js", 'const target = ".claude/settings.json";\nprocess.getBuiltinModule(target);', "alternate built-in module acquisition with variable argument"],
      ["aliased-builtin-filesystem.js", 'const builtin = process.getBuiltinModule;\nbuiltin("node:fs/promises");', "alternate built-in module acquisition node:fs/promises"],
      ["called-builtin-filesystem.js", 'process.getBuiltinModule.call(process, "node:fs");', "alternate built-in module acquisition node:fs"],
      ["applied-builtin-filesystem.js", 'process.getBuiltinModule.apply(process, ["node:fs/promises"]);', "alternate built-in module acquisition node:fs/promises"],
      ["computed-builtin-filesystem.js", 'process["getBuiltinModule"]("node:fs");', "alternate built-in module acquisition node:fs"],
      ["computed-call-builtin-filesystem.js", 'process["getBuiltinModule"].call(process, "node:fs");', "alternate built-in module acquisition node:fs"],
      ["computed-apply-builtin-filesystem.js", 'process["getBuiltinModule"].apply(process, ["node:fs/promises"]);', "alternate built-in module acquisition node:fs/promises"],
      ["duplicate-directory.js", "readdirSync(dir);", "duplicate allowed readdirSync"],
      ["duplicate-file.js", 'readFileSync(join(dir, file), "utf8");', "duplicate allowed readFileSync"],
      ["require-loader.js", 'createRequire(import.meta.url)("../.claude/config.mjs");', "createRequire result invoked as loader"],
    ];
    for (const [file, addition, reason] of controls) {
      const fixture = registrationBaseline(addition);
      const offenders = registrationReadOffenders(fixture);
      assertReason(offenders, "plugin/config.js", reason, file);
    }

    const importedHelper = registrationBaseline('import "./registration-helper.js";');
    importedHelper.set("plugin/registration-helper.js", [
      'import { readFileSync } from "node:fs";',
      'try { readFileSync(".claude/settings.json", "utf8"); } catch {}',
      "eval(source);",
    ].join("\n"));
    const helperOffenders = registrationReadOffenders(importedHelper);
    assertReason(helperOffenders, "plugin/config.js", "unscanned package-local static import",
      "a registration helper cannot hide a foreign configuration read");
    assertReason(helperOffenders, "plugin/registration-helper.js", "node:fs import outside plugin/config.js",
      "the imported helper's swallowed foreign read is still a registration offender");
    assertReason(executionOffenders(importedHelper), "plugin/registration-helper.js", "executable eval identifier",
      "the imported helper's configuration execution is still an execution offender");
  });

  it("cannot execute configuration content", () => {
    assert.deepEqual(executionOffenders(productionSources(opencodePkg)), []);
    const allowed = new Map([
      ["static-import.js", 'import { parse } from "safe-parser";\nparse("eval Function");'],
      ["resolver.js", 'import { createRequire } from "node:module";\nconst loader = createRequire(import.meta.url);\nloader.resolve("feature-factory");'],
      ["aliased-resolver.js", 'import { createRequire as makeRequire } from "node:module";\nconst loader = makeRequire(import.meta.url);\nloader.resolve("feature-factory");'],
      ["literal-text.js", '// eval(source); new Function(source);\nconst words = "eval Function";\nconst pattern = /eval\\s+Function[)]/giu;\nconst prompt = `eval and Function stay literal`;'],
      ["safe-template.js", 'const ratio = total / divisor / 2;\nconst text = `safe ${JSON.parse(value).name} ${"eval"} ${/Function/u} ${`nested ${"Function"}`}`;\nglobalThis[`safe`](value);\nvalue.match(/Function|eval/gu);\nif (ready) /eval|Function/u.test(value);'],
      ["post-block-regex.js", "if (ready) {} /eval|Function/u.test(value);"],
      ["post-function-regex.js", "function declared() {} /eval|Function/u.test(value);"],
      ["post-class-regex.js", "class Declared {} /eval|Function/u.test(value);"],
      ["safe-commonjs-this-arg.js", 'module.require.call("node:vm", "safe-module");\nmodule["require"].apply("node:vm", ["safe-module"]);'],
      ["safe-builtin-this-arg.js", 'process.getBuiltinModule.call("node:vm", "node:path");\nprocess["getBuiltinModule"].apply("node:vm", ["node:path"]);'],
    ]);
    assert.deepEqual(executionOffenders(allowed), []);

    const controls = [
      ["direct-eval.js", "eval(source);", "executable eval identifier"],
      ["eval-alias.js", "const execute = eval; execute(source);", "executable eval identifier"],
      ["indirect-eval.js", "(0, eval)(source);", "executable eval identifier"],
      ["division-eval.js", "const ratio = options.return / eval(source) / divisor;", "executable eval identifier"],
      ["bracket-eval.js", 'globalThis["eval"](source);', "static eval member"],
      ["template-bracket-eval.js", "globalThis[`eval`](source);", "static template eval member"],
      ["escaped-template-bracket-eval.js", "globalThis[`ev\\x61l`](source);", "static template eval member"],
      ["direct-function.js", "Function(source);", "executable Function identifier"],
      ["new-function.js", "new Function(source);", "executable Function identifier"],
      ["function-alias.js", "const Build = Function; Build(source);", "executable Function identifier"],
      ["dot-function.js", "globalThis.Function(source);", "executable Function identifier"],
      ["bracket-function.js", 'globalThis["Function"](source);', "static Function member"],
      ["template-bracket-function.js", "globalThis[`Function`](source);", "static template Function member"],
      ["escaped-template-bracket-function.js", "globalThis[`Fun\\u0063tion`](source);", "static template Function member"],
      ["template-eval.js", "const result = `${eval(source)}`;", "executable eval identifier"],
      ["nested-template-eval.js", "const result = `${`nested ${eval(source)}`}`;", "executable eval identifier"],
      ["template-function.js", "const result = `${(() => { const Build = Function; return Build(source); })()}`;", "executable Function identifier"],
      ["node-vm.js", 'import vm from "node:vm";', "static vm import"],
      ["bare-vm.js", 'import * as vm from "vm";', "static vm import"],
      ["require-vm.js", 'const vm = require("node:vm");', "CommonJS vm load"],
      ["aliased-require-vm.js", 'const load = require;\nconst vm = load("node:vm");', "CommonJS vm load"],
      ["member-require-vm.js", 'const vm = module.require("vm");', "CommonJS vm load"],
      ["member-call-require-vm.js", 'const vm = module.require.call("safe-this", "node:vm");', "CommonJS vm load"],
      ["member-apply-require-vm.js", 'const vm = module.require.apply("safe-this", ["vm"]);', "CommonJS vm load"],
      ["computed-require-vm.js", 'const vm = module["require"]("node:vm");', "CommonJS vm load"],
      ["computed-call-require-vm.js", 'const vm = module["require"].call("safe-this", "vm");', "CommonJS vm load"],
      ["computed-apply-require-vm.js", 'const vm = module["require"].apply("safe-this", ["node:vm"]);', "CommonJS vm load"],
      ["member-alias-require-vm.js", 'const load = module["require"];\nconst vm = load("node:vm");', "CommonJS vm load"],
      ["builtin-vm.js", 'const vm = process.getBuiltinModule("node:vm");', "built-in vm load"],
      ["called-builtin-vm.js", 'const vm = process.getBuiltinModule.call("safe-this", "node:vm");', "built-in vm load"],
      ["applied-builtin-vm.js", 'const vm = process.getBuiltinModule.apply("safe-this", ["vm"]);', "built-in vm load"],
      ["computed-builtin-vm.js", 'const vm = process["getBuiltinModule"]("node:vm");', "built-in vm load"],
      ["computed-call-builtin-vm.js", 'const vm = process["getBuiltinModule"].call("safe-this", "vm");', "built-in vm load"],
      ["computed-apply-builtin-vm.js", 'const vm = process["getBuiltinModule"].apply("safe-this", ["node:vm"]);', "built-in vm load"],
      ["dynamic-import.js", 'const parser = await import("safe-parser");', "dynamic import"],
      ["named-loader.js", 'import { createRequire } from "node:module";\nconst load = createRequire(import.meta.url);\nload("config.js");', "createRequire result invoked as loader"],
      ["aliased-loader.js", 'import { createRequire as makeRequire } from "node:module";\nconst load = makeRequire(import.meta.url);\nload("config.js");', "createRequire result invoked as loader"],
      ["namespace-loader.js", 'import * as moduleApi from "node:module";\nconst load = moduleApi.createRequire(import.meta.url);\nload("config.js");', "createRequire result invoked as loader"],
      ["result-alias.js", 'import { createRequire } from "node:module";\nconst load = createRequire(import.meta.url);\nconst alias = load;\nalias("config.js");', "createRequire result invoked as loader"],
      ["call-loader.js", 'import { createRequire } from "node:module";\nconst load = createRequire(import.meta.url);\nload.call(null, "config.js");', "createRequire result invoked as loader"],
      ["apply-loader.js", 'import { createRequire } from "node:module";\nconst load = createRequire(import.meta.url);\nload.apply(null, ["config.js"]);', "createRequire result invoked as loader"],
      ["parenthesized-loader.js", 'import { createRequire } from "node:module";\nconst load = createRequire(import.meta.url);\n(load)("config.js");', "createRequire result invoked as loader"],
      ["nested-parenthesized-loader.js", 'import { createRequire } from "node:module";\n((createRequire(import.meta.url)))("config.js");', "createRequire result invoked as loader"],
      ["nested-parenthesized-alias.js", 'import { createRequire } from "node:module";\nconst load = ((createRequire(import.meta.url)));\n(((load)))("config.js");', "createRequire result invoked as loader"],
      ["direct-loader.js", 'import { createRequire } from "node:module";\ncreateRequire(import.meta.url)("config.js");', "createRequire result invoked as loader"],
    ];
    for (const [file, source, reason] of controls) {
      const offenders = executionOffenders(new Map([[file, source]]));
      assertReason(offenders, file, reason);
    }
  });
});
