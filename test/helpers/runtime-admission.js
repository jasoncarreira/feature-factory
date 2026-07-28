import { resolve } from "node:path";

const HASH = `sha256:${"a".repeat(64)}`;
const binding = {
  package_cli: { source: resolve("test-package-cli"), hash: HASH },
  opencode: { source: process.execPath, hash: HASH },
};

export function withTestRuntimeAdmission(options = {}) {
  return {
    runtimeAdmissionFn: () => binding,
    runtimeRevalidateFn: () => process.execPath,
    ...options,
  };
}
