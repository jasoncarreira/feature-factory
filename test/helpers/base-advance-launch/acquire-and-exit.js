import { acquireLaunchFence } from "../../../src/process-evidence.js";

const runDir = process.argv[2];
const host = process.argv[3];
if (!runDir || !host) throw new Error("run directory and hostname are required");

const marker = "444";
const acquired = acquireLaunchFence(runDir, "base-advance", {
  hostname: host,
  platform: "linux",
  livenessProbe: (pid) => ({ status: pid === process.pid ? "live" : "absent" }),
  procReadFile: (path) => path.endsWith("/stat")
    ? `${process.pid} (node) S ${Array(18).fill("0").join(" ")} ${marker}\n`
    : "node\n",
  procReadlink: () => process.cwd(),
});

if (!acquired.acquired) throw new Error("base-advance launch fence was not acquired");
process.stdout.write(`${JSON.stringify({ path: acquired.path, owner_kind: acquired.owner_kind })}\n`);
