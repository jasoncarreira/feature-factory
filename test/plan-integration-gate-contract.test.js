import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { validateSlices } from "../src/factory.js";
import {
  MAX_INTEGRATION_GATE_ARG_BYTES,
  MAX_INTEGRATION_GATE_ARGS,
  MAX_INTEGRATION_GATE_COMMANDS,
  MAX_INTEGRATION_GATE_ENCODED_BYTES,
  MAX_INTEGRATION_GATE_PROGRAM_BYTES,
  ValidationError,
  parseSlicesPlanBytes,
  validateSlicesPlan,
} from "../src/validate.js";

const FINAL_COMMAND = Object.freeze({ program: "npm", args: Object.freeze(["run", "check"]) });

describe("plan integration_gate command contract", () => {
  it("keeps explicit legacy reads valid but requires the gate in creation mode", () => {
    const legacy = { slices: [plannedSlice()] };

    assert.equal(validateSlicesPlan(legacy), legacy);
    assert.throws(
      () => validateSlicesPlan(legacy, { requireIntegrationGate: true }),
      (error) => validationIncludes(error, "plan.integration_gate", "is required for newly produced and schema-v2 plans"),
    );
    assert.throws(
      () => validateSlices(legacy),
      (error) => validationIncludes(error, "plan.integration_gate", "is required for newly produced and schema-v2 plans"),
    );
  });

  it("accepts 1-32 ordered structured argv commands with npm run check exactly once and last", () => {
    const one = planWithCommands([FINAL_COMMAND]);
    const thirtyTwo = planWithCommands([
      ...Array.from({ length: MAX_INTEGRATION_GATE_COMMANDS - 1 }, (_, index) => ({ program: "node", args: ["--test", `test/acceptance-${index}.test.js`] })),
      FINAL_COMMAND,
    ]);

    assert.equal(validateSlicesPlan(one, { requireIntegrationGate: true }), one);
    assert.equal(validateSlicesPlan(thirtyTwo, { requireIntegrationGate: true }), thirtyTwo);
    assert.deepEqual(thirtyTwo.integration_gate.required_commands.at(-1), { program: "npm", args: ["run", "check"] });
    assert.equal(thirtyTwo.integration_gate.required_commands.filter((command) => command.program === "npm" && command.args.join("\0") === "run\0check").length, 1);
  });

  it("closes the plan, gate, and command entry shapes", () => {
    const valid = planWithCommands([FINAL_COMMAND]);
    for (const [mutation, path] of [
      [{ ...valid, unexpected: true }, "plan.unexpected"],
      [{ ...valid, integration_gate: { ...valid.integration_gate, command: "npm run check" } }, "plan.integration_gate.command"],
      [planWithCommands([{ ...FINAL_COMMAND, shell: true }]), "plan.integration_gate.required_commands[0].shell"],
    ]) {
      assert.throws(() => validateSlicesPlan(mutation, { requireIntegrationGate: true }), (error) => validationIncludes(error, path, "is not allowed"));
    }
    assert.throws(
      () => validateSlicesPlan({ slices: [plannedSlice()], integration_gate: "npm run check" }, { requireIntegrationGate: true }),
      (error) => validationIncludes(error, "plan.integration_gate", "must be an object"),
    );
    assert.throws(
      () => validateSlicesPlan({ slices: [plannedSlice()], integration_gate: {} }, { requireIntegrationGate: true }),
      (error) => validationIncludes(error, "plan.integration_gate.required_commands", "must be an array"),
    );
  });

  it("enforces command count, program UTF-8 byte, trim, and control-character bounds", () => {
    assert.equal(MAX_INTEGRATION_GATE_COMMANDS, 32);
    assert.equal(MAX_INTEGRATION_GATE_PROGRAM_BYTES, 255);
    const cases = [
      [[], "must contain 1-32 commands"],
      [[...Array.from({ length: 32 }, () => ({ program: "node", args: [] })), FINAL_COMMAND], "must contain 1-32 commands"],
      [[{ program: "", args: [] }, FINAL_COMMAND], "must be non-empty and trimmed"],
      [[{ program: " node", args: [] }, FINAL_COMMAND], "must be non-empty and trimmed"],
      [[{ program: "x".repeat(256), args: [] }, FINAL_COMMAND], "must be 1-255 UTF-8 bytes"],
      [[{ program: "é".repeat(128), args: [] }, FINAL_COMMAND], "must be 1-255 UTF-8 bytes"],
      [[{ program: "node\n", args: [] }, FINAL_COMMAND], "must not contain NUL or control characters"],
      [[{ program: "node\0", args: [] }, FINAL_COMMAND], "must not contain NUL or control characters"],
      [[{ program: "\ud800", args: [] }, FINAL_COMMAND], "must be valid UTF-8 text"],
    ];
    for (const [commands, message] of cases) {
      assert.throws(
        () => validateSlicesPlan(planWithCommands(commands), { requireIntegrationGate: true }),
        (error) => error instanceof ValidationError && error.errors.some((item) => item.message === message),
        message,
      );
    }
  });

  it("enforces argv count, UTF-8 byte, NUL, and aggregate encoded-list bounds", () => {
    assert.equal(MAX_INTEGRATION_GATE_ARGS, 64);
    assert.equal(MAX_INTEGRATION_GATE_ARG_BYTES, 4096);
    assert.equal(MAX_INTEGRATION_GATE_ENCODED_BYTES, 65536);
    const invalid = [
      [[{ program: "node", args: "--test" }, FINAL_COMMAND], "must be an array"],
      [[{ program: "node", args: Array.from({ length: 65 }, () => "x") }, FINAL_COMMAND], "must contain at most 64 arguments"],
      [[{ program: "node", args: ["x".repeat(4097)] }, FINAL_COMMAND], "must be at most 4096 UTF-8 bytes"],
      [[{ program: "node", args: ["é".repeat(2049)] }, FINAL_COMMAND], "must be at most 4096 UTF-8 bytes"],
      [[{ program: "node", args: ["bad\0arg"] }, FINAL_COMMAND], "must not contain NUL"],
      [[{ program: "node", args: ["\ud800"] }, FINAL_COMMAND], "must be valid UTF-8 text"],
      [[{ program: "node", args: Array.from({ length: 16 }, () => "x".repeat(4096)) }, FINAL_COMMAND], "encoded command list must be at most 65536 UTF-8 bytes"],
    ];
    for (const [commands, message] of invalid) {
      assert.throws(
        () => validateSlicesPlan(planWithCommands(commands), { requireIntegrationGate: true }),
        (error) => error instanceof ValidationError && error.errors.some((item) => item.message === message),
        message,
      );
    }
  });

  it("rejects missing, duplicate, non-final, and non-exact npm run check commands", () => {
    const cases = [
      [[{ program: "node", args: ["--test"] }], "must contain exactly one npm run check command"],
      [[FINAL_COMMAND, FINAL_COMMAND], "must contain exactly one npm run check command"],
      [[FINAL_COMMAND, { program: "node", args: ["--test"] }], "npm run check must be the final command"],
      [[{ program: "npm", args: ["run", "check", "--silent"] }], "must contain exactly one npm run check command"],
      [[{ program: "npm run check", args: [] }], "must contain exactly one npm run check command"],
    ];
    for (const [commands, message] of cases) {
      assert.throws(
        () => validateSlicesPlan(planWithCommands(commands), { requireIntegrationGate: true }),
        (error) => validationIncludes(error, "plan.integration_gate.required_commands", message),
        message,
      );
    }
  });

  it("fatally decodes raw plan UTF-8 while keeping shell-wrapper argv schema-valid", () => {
    const shellWrapper = planWithCommands([{ program: "sh", args: ["-c", "node --test"] }, FINAL_COMMAND]);
    assert.equal(validateSlicesPlan(shellWrapper, { requireIntegrationGate: true }), shellWrapper);

    const validBytes = Buffer.from(JSON.stringify(shellWrapper), "utf8");
    const marker = validBytes.indexOf(Buffer.from("node --test", "utf8"));
    assert.notEqual(marker, -1);
    const invalidBytes = Buffer.concat([validBytes.subarray(0, marker), Buffer.from([0xc3, 0x28]), validBytes.subarray(marker + 2)]);
    assert.throws(() => parseSlicesPlanBytes(invalidBytes, { requireIntegrationGate: true }), /must contain valid UTF-8/u);
  });
});

function planWithCommands(requiredCommands) {
  return { slices: [plannedSlice()], integration_gate: { required_commands: structuredClone(requiredCommands) } };
}

function plannedSlice() {
  return { id: "backend", stack: "backend", paths: ["src/**"], depends_on: [], acceptance: ["AC1"], test_plan: ["node --test test/backend.test.js"] };
}

function validationIncludes(error, path, message) {
  return error instanceof ValidationError && error.errors.some((item) => item.path === path && item.message === message);
}
