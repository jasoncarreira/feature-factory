export function createRunRecord(overrides = {}) {
  return {
    schema_version: 1,
    run_id: "fixture-run",
    status: "running",
    gates: {},
    ...overrides,
  };
}
