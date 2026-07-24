export const LEGACY_CHECKED_EXECUTION_TIMEOUT_MS = 300_000;
export const DEFAULT_CHECKED_EXECUTION_TIMEOUT_MS = 600_000;
export const MIN_CHECKED_EXECUTION_TIMEOUT_MS = 1_000;
export const MAX_CHECKED_EXECUTION_TIMEOUT_MS = 1_800_000;

export function effectiveCheckedExecutionTimeoutMs(value) {
  return value === undefined ? LEGACY_CHECKED_EXECUTION_TIMEOUT_MS : value;
}

export function isCheckedExecutionTimeoutMs(value) {
  return Number.isInteger(value) && value >= MIN_CHECKED_EXECUTION_TIMEOUT_MS && value <= MAX_CHECKED_EXECUTION_TIMEOUT_MS;
}
