const CONTROL_PATTERN = /[\u0000-\u001f\u007f-\u009f]/u;

export function parseVerificationCommand(entry) {
  if (typeof entry !== "string" || entry.length === 0 || entry !== entry.trim() || CONTROL_PATTERN.test(entry)) {
    throw new Error("verification artifact test_plan_entry must be canonical command text");
  }
  const words = [];
  let word = "";
  let quote = null;
  let escaped = false;
  let started = false;
  for (const character of entry) {
    if (escaped) {
      word += character;
      escaped = false;
      started = true;
      continue;
    }
    if (quote === "'") {
      if (character === "'") quote = null;
      else word += character;
      started = true;
      continue;
    }
    if (quote === "\"") {
      if (character === "\"") quote = null;
      else if (character === "\\") escaped = true;
      else word += character;
      started = true;
      continue;
    }
    if (character === "'" || character === "\"") {
      quote = character;
      started = true;
      continue;
    }
    if (character === "\\") {
      escaped = true;
      started = true;
      continue;
    }
    if (/\s/u.test(character)) {
      if (started) {
        words.push(word);
        word = "";
        started = false;
      }
      continue;
    }
    if (/[|&;<>()`]/u.test(character)) throw new Error("verification artifact command must not contain shell operators");
    word += character;
    started = true;
  }
  if (escaped || quote !== null) throw new Error("verification artifact command has an unterminated escape or quote");
  if (started) words.push(word);
  if (words.length === 0 || words[0].length === 0) throw new Error("verification artifact command must contain a program");
  return { program: words[0], args: words.slice(1) };
}
