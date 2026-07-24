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
import { withDeliveryEnvelope } from "./helpers/delivery-envelope-fixture.js";
import { DEFAULT_CHECKED_EXECUTION_TIMEOUT_MS, MAX_CHECKED_EXECUTION_TIMEOUT_MS, MIN_CHECKED_EXECUTION_TIMEOUT_MS } from "../src/checked-execution-timeout.js";

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

  it("accepts only bounded plan-authoritative integration and artifact timeouts", () => {
    const valid = planWithCommands([FINAL_COMMAND]);
    valid.integration_gate.timeout_ms = DEFAULT_CHECKED_EXECUTION_TIMEOUT_MS;
    valid.delivery_envelope.delivery_units[0].verification_artifacts[0].timeout_ms = MIN_CHECKED_EXECUTION_TIMEOUT_MS;
    assert.equal(validateSlicesPlan(valid, { requireIntegrationGate: true }), valid);

    for (const timeout of [999, 1_800_001, 1.5, "600000"]) {
      const gate = planWithCommands([FINAL_COMMAND]);
      gate.integration_gate.timeout_ms = timeout;
      assert.throws(() => validateSlicesPlan(gate, { requireIntegrationGate: true }), /timeout_ms/u);

      const artifact = planWithCommands([FINAL_COMMAND]);
      artifact.delivery_envelope.delivery_units[0].verification_artifacts[0].timeout_ms = timeout;
      assert.throws(() => validateSlicesPlan(artifact, { requireIntegrationGate: true }), /timeout_ms/u);
    }
    assert.equal(MAX_CHECKED_EXECUTION_TIMEOUT_MS, 1_800_000);
  });

  it("requires explicit timeouts at new-plan admission while preserving accepted legacy reads", () => {
    const missingGateTimeout = planWithCommands([FINAL_COMMAND]);
    delete missingGateTimeout.integration_gate.timeout_ms;
    assert.throws(
      () => validateSlicesPlan(missingGateTimeout, { requireIntegrationGate: true }),
      (error) => validationIncludes(error, "plan.integration_gate.timeout_ms", "is required for newly produced and schema-v2 plans"),
    );
    assert.equal(validateSlicesPlan(missingGateTimeout, { requireIntegrationGate: true, allowLegacyExecutionTimeouts: true }), missingGateTimeout);

    const missingArtifactTimeout = planWithCommands([FINAL_COMMAND]);
    delete missingArtifactTimeout.delivery_envelope.delivery_units[0].verification_artifacts[0].timeout_ms;
    assert.throws(
      () => validateSlicesPlan(missingArtifactTimeout, { requireIntegrationGate: true }),
      (error) => validationIncludes(error, "plan.delivery_envelope.delivery_units[0].verification_artifacts[0].timeout_ms", "is required for newly produced and schema-v2 plans"),
    );
    assert.equal(validateSlicesPlan(missingArtifactTimeout, { requireIntegrationGate: true, allowLegacyExecutionTimeouts: true }), missingArtifactTimeout);
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
  return withDeliveryEnvelope({ slices: [plannedSlice()], integration_gate: { required_commands: structuredClone(requiredCommands) } }, { explicitExecutionTimeouts: true });
}

function plannedSlice() {
  return { id: "backend", stack: "backend", paths: ["src/**"], depends_on: [], acceptance: ["AC1"], test_plan: ["node --test test/backend.test.js"] };
}

function validationIncludes(error, path, message) {
  return error instanceof ValidationError && error.errors.some((item) => item.path === path && item.message === message);
}
