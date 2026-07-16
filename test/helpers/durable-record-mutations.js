import { createHash } from "node:crypto";

const HASH_A = `sha256:${"a".repeat(64)}`;
const HASH_B = `sha256:${"b".repeat(64)}`;
const HASH_C = `sha256:${"c".repeat(64)}`;
const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const SHA_C = "c".repeat(40);
const NOW = "2026-07-16T12:00:00.000Z";

export const DURABLE_MUTATION_FAMILIES = Object.freeze([
  "missing-key",
  "unknown-key",
  "wrong-schema",
  "wrong-kind",
  "wrong-time",
  "wrong-type",
  "wrong-ref",
  "wrong-hash",
  "wrong-bytes",
  "descriptor-key-shape-drift",
  "stale-identity",
  "cross-bound-identity",
]);

const AUTHORITY_CLASSES = Object.freeze([
  ["plan-slices-graph", "Plan and slices graph"],
  ["run-envelope-terminal-result", "Run envelope and terminal result"],
  ["gates-snapshot-handoff", "Gates, pending snapshot, and handoff receipt"],
  ["steps-acceptance-inheritance", "Steps and acceptance inheritance"],
  ["slices-review-evidence-bindings", "Slices and review/evidence bindings"],
  ["validator-security-pr-result", "Validator, security, and PR-created result"],
  ["continuation-planning-draft-reuse", "Continuation and planning/draft reuse"],
  ["post-pr-nested-records", "Post-PR nested records"],
  ["pr79-merged-slice-repair", "PR79 merged slice repair"],
]);

const POST_PR_PHASES = Object.freeze(["disabled", "awaiting-pr", "observing", "failure-recording", "remediation-planned", "remediation-running", "changes-observed", "committed", "revalidating", "validated", "push-pending", "remote-confirmed", "succeeded", "blocked", "needs-human"]);
const POST_PR_JOB_ACTIVITIES = Object.freeze(["canonical", "validator", "security"]);
const POST_PR_JOB_STATES = Object.freeze(["planned", "running", "retry-wait", "bound"]);

export const DURABLE_AUTHORITY_REQUIRED_RECORD_IDS = deepFreeze({
  "plan-slices-graph": [
    "plan-slices-json",
    "final-plan-descriptor",
  ],
  "run-envelope-terminal-result": [
    "run-envelope-running",
    "run-envelope-terminal",
    "terminal-result-completed",
    "terminal-result-blocked",
    "terminal-result-partial",
    "terminal-result-needs-human",
  ],
  "gates-snapshot-handoff": [
    "gate-pending",
    "gate-decided",
    "pending-snapshot",
    "handoff-receipt",
  ],
  "steps-acceptance-inheritance": [
    "step-running",
    "step-unaccepted",
    "step-accepted",
    "step-acceptance-binding",
    "step-inherited-acceptance",
  ],
  "slices-review-evidence-bindings": [
    "slice-pending-running",
    "slice-review",
    "slice-terminal",
    "slice-review-binding",
    "slice-attempt-review",
    "slice-evidence-sidecar",
    "slice-review-sidecar",
  ],
  "validator-security-pr-result": [
    "validator-verdict-binding",
    "security-verdict-binding",
    "pr-created-result",
  ],
  "continuation-planning-draft-reuse": [
    "continuation-envelope",
    "continuation-parent-binding",
    "continuation-selected-review",
    "continuation-target-binding",
    "continuation-parent-artifact-sidecar",
    "continuation-parent-evidence-sidecar",
    "continuation-parent-review-sidecar",
    "continuation-planning-reuse-ineligible",
    "continuation-planning-reuse-eligible",
    "continuation-draft-reuse",
    "continuation-post-pr-binding",
  ],
  "post-pr-nested-records": [
    "post-pr-phase-disabled",
    "post-pr-phase-awaiting-pr",
    "post-pr-phase-observing",
    "post-pr-phase-failure-recording",
    "post-pr-phase-remediation-planned",
    "post-pr-phase-remediation-running",
    "post-pr-phase-changes-observed",
    "post-pr-phase-committed",
    "post-pr-phase-revalidating",
    "post-pr-phase-validated",
    "post-pr-phase-push-pending",
    "post-pr-phase-remote-confirmed",
    "post-pr-phase-succeeded",
    "post-pr-phase-blocked",
    "post-pr-phase-needs-human",
    "post-pr-policy-disabled",
    "post-pr-policy-enabled",
    "post-pr-observation-null",
    "post-pr-observation-active",
    "post-pr-observation-last-error",
    "post-pr-observation-review-request",
    "post-pr-observation-snapshot",
    "post-pr-remediation-null",
    "post-pr-remediation-active",
    "post-pr-remediation-owner",
    "post-pr-remediation-changes",
    "post-pr-remediation-change-entry",
    "post-pr-dispatch-planned",
    "post-pr-dispatch-running",
    "post-pr-dispatch-returned",
    "post-pr-revalidation-empty",
    "post-pr-revalidation-bound",
    "post-pr-canonical-job-planned",
    "post-pr-canonical-job-running",
    "post-pr-canonical-job-retry-wait",
    "post-pr-canonical-job-bound",
    "post-pr-validator-job-planned",
    "post-pr-validator-job-running",
    "post-pr-validator-job-retry-wait",
    "post-pr-validator-job-bound",
    "post-pr-security-job-planned",
    "post-pr-security-job-running",
    "post-pr-security-job-retry-wait",
    "post-pr-security-job-bound",
    "post-pr-push-not-ready",
    "post-pr-push-pending",
    "post-pr-push-confirmed",
    "post-pr-push-last-error",
    "post-pr-evidence-sidecar",
    "post-pr-continuation-review-null",
    "post-pr-continuation-review-bound",
    "post-pr-terminal-fact-null",
    "post-pr-terminal-fact-account-switch-failed-github-auth",
    "post-pr-terminal-fact-account-switch-failed-push",
    "post-pr-terminal-fact-dispatch-start-unknown",
    "post-pr-terminal-fact-path-lane-violation",
    "post-pr-terminal-fact-remote-head-diverged",
    "post-pr-terminal-fact-panel-runner-result-malformed",
    "post-pr-terminal-fact-push-failed",
    "post-pr-terminal-fact-panel-attribution-unsafe",
  ],
  "pr79-merged-slice-repair": [
    "repair-reported",
    "repair-repairing",
    "repair-review-approve",
    "repair-review-reject",
    "repair-merged",
    "repair-blocked-from-reported",
    "repair-blocked-from-repairing",
    "repair-blocked-from-review",
  ],
});

const FAMILY_BY_CODE = Object.freeze({ m: "missing-key", u: "unknown-key", s: "wrong-schema", k: "wrong-kind", t: "wrong-time", y: "wrong-type", r: "wrong-ref", h: "wrong-hash", b: "wrong-bytes", d: "descriptor-key-shape-drift", i: "stale-identity", c: "cross-bound-identity" });

// This closed source-boundary registry is deliberately independent from RECORDS. Each value
// explicitly classifies the families excluded by that entry; every other family must be targeted.
const EXPLICIT_EXCLUDED_FAMILY_CODES = deepFreeze({
  "plan-slices-json": "sktrhb",
  "final-plan-descriptor": "",
  "run-envelope-running": "khbd",
  "run-envelope-terminal": "krhbd",
  "terminal-result-completed": "skthbd",
  "terminal-result-blocked": "sktrhbd",
  "terminal-result-partial": "sktrhbd",
  "terminal-result-needs-human": "sktrhbd",
  "gate-pending": "skthb",
  "gate-decided": "skrhbd",
  "pending-snapshot": "sk",
  "handoff-receipt": "rd",
  "step-running": "skthbd",
  "step-unaccepted": "skthbd",
  "step-accepted": "skthbd",
  "step-acceptance-binding": "skt",
  "step-inherited-acceptance": "sktd",
  "slice-pending-running": "skthbd",
  "slice-review": "skthbd",
  "slice-terminal": "skthbd",
  "slice-review-binding": "skt",
  "slice-attempt-review": "sktd",
  "slice-evidence-sidecar": "sktd",
  "slice-review-sidecar": "sktd",
  "validator-verdict-binding": "sktd",
  "security-verdict-binding": "sktd",
  "pr-created-result": "skthbd",
  "continuation-envelope": "rhbd",
  "continuation-parent-binding": "sktd",
  "continuation-selected-review": "std",
  "continuation-target-binding": "skthbd",
  "continuation-parent-artifact-sidecar": "std",
  "continuation-parent-evidence-sidecar": "std",
  "continuation-parent-review-sidecar": "std",
  "continuation-planning-reuse-ineligible": "sktrhbd",
  "continuation-planning-reuse-eligible": "sktd",
  "continuation-draft-reuse": "sktd",
  "continuation-post-pr-binding": "sktd",
  "post-pr-phase-disabled": "ktrhbd",
  "post-pr-phase-awaiting-pr": "ktrhbd",
  "post-pr-phase-observing": "ktrhbd",
  "post-pr-phase-failure-recording": "ktrhbd",
  "post-pr-phase-remediation-planned": "ktrhbd",
  "post-pr-phase-remediation-running": "ktrhbd",
  "post-pr-phase-changes-observed": "ktrhbd",
  "post-pr-phase-committed": "ktrhbd",
  "post-pr-phase-revalidating": "ktrhbd",
  "post-pr-phase-validated": "ktrhbd",
  "post-pr-phase-push-pending": "ktrhbd",
  "post-pr-phase-remote-confirmed": "ktrhbd",
  "post-pr-phase-succeeded": "ktrhbd",
  "post-pr-phase-blocked": "ktrhbd",
  "post-pr-phase-needs-human": "ktrhbd",
  "post-pr-policy-disabled": "sktrhb",
  "post-pr-policy-enabled": "sktrhb",
  "post-pr-observation-null": "sktrhbd",
  "post-pr-observation-active": "skrhb",
  "post-pr-observation-last-error": "skrhbd",
  "post-pr-observation-review-request": "skrhbd",
  "post-pr-observation-snapshot": "sktrhb",
  "post-pr-remediation-null": "sktrhbd",
  "post-pr-remediation-active": "td",
  "post-pr-remediation-owner": "strhbd",
  "post-pr-remediation-changes": "sktrb",
  "post-pr-remediation-change-entry": "skthb",
  "post-pr-dispatch-planned": "skrhbd",
  "post-pr-dispatch-running": "skrhbd",
  "post-pr-dispatch-returned": "skrhbd",
  "post-pr-revalidation-empty": "sktrhbd",
  "post-pr-revalidation-bound": "sktd",
  "post-pr-canonical-job-planned": "skrhbd",
  "post-pr-canonical-job-running": "skrhbd",
  "post-pr-canonical-job-retry-wait": "skrhbd",
  "post-pr-canonical-job-bound": "sktd",
  "post-pr-validator-job-planned": "skrhbd",
  "post-pr-validator-job-running": "skrhbd",
  "post-pr-validator-job-retry-wait": "skrhbd",
  "post-pr-validator-job-bound": "sktd",
  "post-pr-security-job-planned": "skrhbd",
  "post-pr-security-job-running": "skrhbd",
  "post-pr-security-job-retry-wait": "skrhbd",
  "post-pr-security-job-bound": "sktd",
  "post-pr-push-not-ready": "skrhbd",
  "post-pr-push-pending": "skrhbd",
  "post-pr-push-confirmed": "skrhbd",
  "post-pr-push-last-error": "skrhbd",
  "post-pr-evidence-sidecar": "sktd",
  "post-pr-continuation-review-null": "sktrhbd",
  "post-pr-continuation-review-bound": "sktd",
  "post-pr-terminal-fact-null": "sktrhbd",
  "post-pr-terminal-fact-account-switch-failed-github-auth": "rhbd",
  "post-pr-terminal-fact-account-switch-failed-push": "rhbd",
  "post-pr-terminal-fact-dispatch-start-unknown": "rhbd",
  "post-pr-terminal-fact-path-lane-violation": "rhbd",
  "post-pr-terminal-fact-remote-head-diverged": "rhbd",
  "post-pr-terminal-fact-panel-runner-result-malformed": "rhbd",
  "post-pr-terminal-fact-push-failed": "rhbd",
  "post-pr-terminal-fact-panel-attribution-unsafe": "rhbd",
  "repair-reported": "k",
  "repair-repairing": "k",
  "repair-review-approve": "k",
  "repair-review-reject": "k",
  "repair-merged": "k",
  "repair-blocked-from-reported": "k",
  "repair-blocked-from-repairing": "k",
  "repair-blocked-from-review": "k",
});

// Hashes are independent, immutable exact-value snapshots over writer, all readers, named tests,
// authority facts, and complete sidecar descriptors, in that order. They are not derived from RECORDS.
export const DURABLE_AUTHORITY_METADATA_MANIFEST = deepFreeze([
  ["plan-slices-json", "e5258dda3444db63ad094ba502fa54b13af0e91143f8461434d846b34e36cda7"],
  ["final-plan-descriptor", "23f136c298514958f67b51e594a096d7ebdbc7c6394b9df280ad5d080465985d"],
  ["run-envelope-running", "c6f4d9a441f2b8dbfa5b76f80809a8f1cb4dd26e980ede74b76e769f3f210361"],
  ["run-envelope-terminal", "3e06bd95d786c368e8e7ffe044b8276fb40f5660f577c5e0dd1c240efaeabb44"],
  ["terminal-result-completed", "8a3531e7938e59724fac9faaca4e9a87987ae5f7a507870b90f0e458bbce7da6"],
  ["terminal-result-blocked", "cf62484459595b22423bfdaacca3954f445e39f508cbd62bbe67311ec78a2883"],
  ["terminal-result-partial", "b11084bfa5d9403d34f6a2751cc66a0a51fd98a6cc5156ce6c3644c4014e3398"],
  ["terminal-result-needs-human", "992f61185792a4b0ff618f95de3e98d8a44cfaa0ae1f6a36e407e68981f79a99"],
  ["gate-pending", "b7b66cf36b8d08e52582b8be35c2ca7ea4767b7aaedaa5bf8aebe89d7529c129"],
  ["gate-decided", "8c794a87320f6cd71f9cddd7b33f77401bdd7d72bd79788750b22f3754cc1d9e"],
  ["pending-snapshot", "984557bdbe490de34a7dd2c818352c67ea364b87b6c0d7f02440919ed7213641"],
  ["handoff-receipt", "a38eb0d4d1b94e600acde5925b66152b3928ed4731f38a2939a780b8e4e2c976"],
  ["step-running", "7625f0de65b17ce30749be5aa29ec622fb0a8ba8416ee96fe86cac26c8331463"],
  ["step-unaccepted", "ff4db10368f8fd5a31a52b241b6c5c6afa877c7ea0826f8fc71578ee377932ca"],
  ["step-accepted", "5bf6680b3b0abe3862cf71b3045c12ed2eca9c9ee2ed03525a1bd16802a498d1"],
  ["step-acceptance-binding", "757365cec128381ca272d8b74a360d8a71955868512556c63475dab609280279"],
  ["step-inherited-acceptance", "aa9a362f77668d5995b13e4a2f293c41d3e43b81ec914042fa845180f1788a0d"],
  ["slice-pending-running", "0c14ad7fd4bcda31653df9407abbf5965e77f96e25cb94254ccce4263f00004a"],
  ["slice-review", "84178b8cd2cbb679addc6c0bd7645ed8827467ed7b92cbec572ea3e2ad7e981b"],
  ["slice-terminal", "2307db507c40cb524e1949945974b9b1529cc5bdda8c8ccd0355dcb3e0fa2cb1"],
  ["slice-review-binding", "a77ae12c990623809159cd97998991fe8b64ae604b7597399f8bb865b9a3fd95"],
  ["slice-attempt-review", "adbcb782b4c8dc897cc041d65329c3a600f513562fcc9f0a3a627c7d63932ee8"],
  ["slice-evidence-sidecar", "5f4e333a7c57fa236e792c3df5c332b49edb9fa9daff0abc8ceb8db9ea51542b"],
  ["slice-review-sidecar", "053e2b04ec62f157e752725527b7442ef4d77d94e7d6d5fd75f43749561ad708"],
  ["validator-verdict-binding", "8864cd3493cf3099c626370a12c7ad3e3696a4c8d178eaa44948ba2bb8e7c791"],
  ["security-verdict-binding", "d38bbc76683bc50a6762d32a1b2e443d8dce6c6abfeefd46cd9d6d2974fdb932"],
  ["pr-created-result", "2f2e6d8928fcdfdcef9af2f8de587a77691ee293ab3493d305b0602b7ed5ab47"],
  ["continuation-envelope", "7823394893cbcbbba6eca035374d770a58d3ad9e58c4fefa6a9f8070cb094669"],
  ["continuation-parent-binding", "0b4ff0fed34cbc4ba986fca22f53b2125b7ac01e3edce8f1ac85babcee366076"],
  ["continuation-selected-review", "141d89285b7c5d8a9390dd5625d2fb7a5e417640ffc50e4a930f7d1ad117a684"],
  ["continuation-target-binding", "02f21c706314106995917c5c160b162fc0185a98cf6913d1ea698bd630126aac"],
  ["continuation-parent-artifact-sidecar", "9292d51ea695ac7574a281ed5c6138971e243a361699abd3d2eff8a23013763f"],
  ["continuation-parent-evidence-sidecar", "20478b97668ecd24a9bc973d96d36bd4a2b6c4d90fcea1c43ccd38c6f42a0690"],
  ["continuation-parent-review-sidecar", "b55ba9fae296d0bdec0319618a2a8406f9e5a4a9789421d4f005e96fc5c72b4f"],
  ["continuation-planning-reuse-ineligible", "0cbe8013884a39466b2db0f901a8f9f3766e0ded60be0ca109d88f0ab9d8b57f"],
  ["continuation-planning-reuse-eligible", "af8d6bcd3123285a18e6e9419ed875e881ff9acd44e7b7dc7f49a15351eb5a75"],
  ["continuation-draft-reuse", "01133b62a8e20431276621521c7edfaf822ae2b4c24ef4396a26fbdd8b4b43f6"],
  ["continuation-post-pr-binding", "6fdddab0caf1953935819760fed3903213b7acc81277aa75a8ab03384287c7a1"],
  ["post-pr-phase-disabled", "b16fbc00df805c5ca4635b0d8cf290c59569fbbf0ad0a7fff750e5bc81bbb847"],
  ["post-pr-phase-awaiting-pr", "ed14b037923231393ce40a46f67004e9ee437e6ec2593880e6fd213a2e153429"],
  ["post-pr-phase-observing", "56c6ca33125251c4d4ef2638b5c7d57b554ef5e7fa7e6568c6490da367ad3ebc"],
  ["post-pr-phase-failure-recording", "a8d49363f8997eb2d172c5ce26ba3cbb992c6fa813ec636fb5bc51e0a36fefea"],
  ["post-pr-phase-remediation-planned", "f6588d23f9a7cb6214c0a47fea2fca03b771b6eef53bec9e55dc871c0ce93a62"],
  ["post-pr-phase-remediation-running", "1de7baee6ce3445cde132dabec943db5641b1e4f6a821d2d18e51feb1a255df7"],
  ["post-pr-phase-changes-observed", "d416cb81e5961f21ecaba98b8311407dcbb7259d424f1de7f65bfc009c46cae4"],
  ["post-pr-phase-committed", "7d84dd8addcbeed4c0d594bf74807f93f2c930a89e10b2ed37c30191447d58a6"],
  ["post-pr-phase-revalidating", "69f90f2f5f93857b9568654f9dcd5e8f3c5ba1dfb4e1b48b7bba11ce84d3803e"],
  ["post-pr-phase-validated", "fcda47917c7970b6095c727f2eb329b2b34cb0141b713f311ea7e52dce50728e"],
  ["post-pr-phase-push-pending", "81bf6fca142302c86f33c697ff40400beba78bcbeedf9758b72165cbc2ce329a"],
  ["post-pr-phase-remote-confirmed", "0819da6cb23aa6546ee43179489dd0553ea7d19e6afe9d651084d7120f987b53"],
  ["post-pr-phase-succeeded", "6b0e865881668078426b6247564d51e234f305295c4eb54ea8ba73e3a5a55014"],
  ["post-pr-phase-blocked", "cad681dcf9f032a1b0048ba33c6e91bc1f2570bd671e196308a3bf39238f704a"],
  ["post-pr-phase-needs-human", "4ebe1d45a0b0ca95a640be9451ab60cccecc66c29b3fb42b01ed092dc7b8cd3d"],
  ["post-pr-policy-disabled", "2b7d79a808aa640ca939bb29b269a0140e8d5536cfb18a8625afe82154a5336c"],
  ["post-pr-policy-enabled", "4ac4998d9e25df16fb2051e2ca2fff574a9bb42c16be50aab4a343c9b4e98255"],
  ["post-pr-observation-null", "4a64880749754846e9dbd25dd364077a16e63e797bdf672045788a94f8ee2eee"],
  ["post-pr-observation-active", "a428023e22dbecb36888caabe2670f837e47be03d6860f9c1557076cf4374fec"],
  ["post-pr-observation-last-error", "0300ce10365bf6416ad5a4795e0f85ca473d47f31e860df6c2e75122f586c290"],
  ["post-pr-observation-review-request", "0f57f8bd3388619463e3617edc743ae25e274951436f300f20f2b320bbfe15d6"],
  ["post-pr-observation-snapshot", "5ea14eaa996585e7b87953358ed4e900cc0648d904aa0dd5ae79e4e819ba3717"],
  ["post-pr-remediation-null", "2e57e48cea1718cb66bcc84645a36c5c0ac434a89769a6cdd0881139a9591d41"],
  ["post-pr-remediation-active", "edee803893ff9c6a84ecb55e93a97904e006fd2906cc7cadbbd5a205a5c9b4c5"],
  ["post-pr-remediation-owner", "083bdf973654b3e3ac6ce9e28ab9a8f4ebcde5504d86f4d74e36a1772dfbabea"],
  ["post-pr-remediation-changes", "9f02cd689a53293587dbd8713d86a7a1646117fa1e1b88b8b789a1a597535359"],
  ["post-pr-remediation-change-entry", "4dcb86d68738bb32eac18343ac747360919b6da5b0e0c33f6dec14474a17d835"],
  ["post-pr-dispatch-planned", "9fec33f6c315408e379ddff815af800acf5b17cbf7532280efcccaf17e887475"],
  ["post-pr-dispatch-running", "263f039b758e0deeea8b0a191ca7bed4b2a37687ec8c6f633601032e2616be27"],
  ["post-pr-dispatch-returned", "c7e3ffab6f3101d017182f43816a845a025410c07c8042d81b3b174ad618eb12"],
  ["post-pr-revalidation-empty", "cbc418ba8b6421145ad14b92875f8c755fc990b16edecde7e0d583aeb757e905"],
  ["post-pr-revalidation-bound", "4316c8e248b43d35ae47972e85a8c46be5940324de6117ab417631895a06cf39"],
  ["post-pr-canonical-job-planned", "a5d93bf3a86fd6b714276f721af3f21d39f968acf701bb362b813e3529372dc1"],
  ["post-pr-canonical-job-running", "c302c0bc6a51dc96a670f87c567a007571c991916acd8f4b7c4d19ef889401ef"],
  ["post-pr-canonical-job-retry-wait", "4229c893873da3bee1572fa405e370ddbce4cecac3b8fad9c9d31a9accda7370"],
  ["post-pr-canonical-job-bound", "7ba64bb5c623df49962bc27eb7c924b7e15633afa04aeb6e93b1ee7d27e76fd5"],
  ["post-pr-validator-job-planned", "159907355b65bd54ce6f5e08b65ac476d1531b7b36413fba05d8d753e3b10f71"],
  ["post-pr-validator-job-running", "021b0acd39a7b2822970312b9cc2ef801f7a5758322f2d908f3d942e0c7aca4e"],
  ["post-pr-validator-job-retry-wait", "1dbfc6c9bfd18df469ac5a58c55eb99ba26ecd86e4919f934d0794f100f3d9a4"],
  ["post-pr-validator-job-bound", "c91fddd9e61765c9d780023647f06998d8da60dcd91fe3d26fe3bac2aa5e8b10"],
  ["post-pr-security-job-planned", "8353d324c3bc009c790b2025e5940f8a5bfa90a45a6d0ac2eea28b31463016db"],
  ["post-pr-security-job-running", "ed4f530287b3baa56e317cc52bea24a441ff433afc2c9ecb8847ba8ded53937a"],
  ["post-pr-security-job-retry-wait", "56dd1d8a46e99cbb79d4181409d6389675315775e95ea0d4c307451fdb313a28"],
  ["post-pr-security-job-bound", "0708f5e4f3000c8d1bcdd9c53d7e566e442b990d29788ca41ddc9e10a84d4372"],
  ["post-pr-push-not-ready", "6103d7692f657076d741591b68fb38806315cfea86cfb0b2a0999ed18aa6cf11"],
  ["post-pr-push-pending", "960edb4390d8d376acdf76c4745f47612ebc621788183e84141aeeb8182c6258"],
  ["post-pr-push-confirmed", "7ba74a5117095fa97f02ce217d61144c5f5b91fedd6023ef14b17af30553ca50"],
  ["post-pr-push-last-error", "de7fc99c2a07562e3df950e22211f7c9bd2d1994f1641ece63d0f6f838713746"],
  ["post-pr-evidence-sidecar", "264cc8df6fbc0f6eea6b70310658c4073ef6ebabeede27234be812c716ca43f4"],
  ["post-pr-continuation-review-null", "a96115021becb9a77860cd6307e602d4d241fa3270b198f5028c9a226671870b"],
  ["post-pr-continuation-review-bound", "c5b6408579cbddc5b4a36705e30ff0a1719af9d28a724b8eadd479dbcaf8be27"],
  ["post-pr-terminal-fact-null", "ffae2e38b283ea1c9d4de3dbbc32d96afbfe1fc704ee6a06ed89ab087c027ec3"],
  ["post-pr-terminal-fact-account-switch-failed-github-auth", "bbdf6524cd57743055f3dcfd730def1266d8e73955c1f440ed799ac8561c5a04"],
  ["post-pr-terminal-fact-account-switch-failed-push", "3f87bfdee2d5155c62c6eaf42f5a257e800ca6e98ecdd357680dd2c57caabb99"],
  ["post-pr-terminal-fact-dispatch-start-unknown", "937eb5e5640580e0c0dccccf7970313cab9caa8962f5c19b7603b39b434b2b1a"],
  ["post-pr-terminal-fact-path-lane-violation", "2c9875537b58329cb73be50d0ef6a19bd46b06fbb52380878af109ae52f1c39c"],
  ["post-pr-terminal-fact-remote-head-diverged", "f7d7a9cda505468df3b863222e697bd2e00963561eb3c9398a35df5066571657"],
  ["post-pr-terminal-fact-panel-runner-result-malformed", "952369d5cd11ed0dd849c52dd512c4d7d0aac31493868824b40f0877fb4e6bea"],
  ["post-pr-terminal-fact-push-failed", "3f8b49186d704817065b798bf9e13145492eb44dc16471ce37cb7bc7a766af1e"],
  ["post-pr-terminal-fact-panel-attribution-unsafe", "3d728e9f632ddbb845ec377682a6dad6fe2a330790ecb4d0a7d009dfed28120a"],
  ["repair-reported", "fe884da6edefe039e4099aece0469d76c4f55e7f131b37d22061bb6ab3463586"],
  ["repair-repairing", "4204db3dc8d663bb94aa59b634e35620d66447d1014560b0fcd4285807a94eb0"],
  ["repair-review-approve", "dd6c805718b046b99135bd02c5ab6a54bb2ea82d89e20697251d7a962358261b"],
  ["repair-review-reject", "c18975415f24ce354db53e9b59f810931343a9a87b8429dc01324c4e7d6fcc53"],
  ["repair-merged", "378702aa207be39a913bcfdb413e129a594e77fe313057c863b6152a035d8464"],
  ["repair-blocked-from-reported", "104d9b149491915c729777577e31997f09fd40926d5ff4aae46c2524417ae6b7"],
  ["repair-blocked-from-repairing", "b671fbd1dcd0f3461acb02215b50a336071216e228638b6e3f728af25caadec8"],
  ["repair-blocked-from-review", "e3381d57eff331a562805265cfafb85971d1f8c849e1f5fe28602da945adb5c7"],
]);
const DURABLE_AUTHORITY_METADATA_BY_ID = new Map(DURABLE_AUTHORITY_METADATA_MANIFEST);

// Independently authored exact-value snapshots over each descriptor's complete targets and
// exclusions. The hash input is canonical JSON for { targets, exclusions }; it binds target
// order and every family, path, value, from, to, key, sidecar, and label without reading RECORDS.
export const DURABLE_AUTHORITY_DESCRIPTOR_MANIFEST = deepFreeze([
  ["plan-slices-json", "5615ea642b4ab7e7f4f596f806204c46e1f3b7bb3d77cfdaa0e00b75ada19391"],
  ["final-plan-descriptor", "bf79367770e0f0c60217ee0e05daf2e7d96471adf0545cc28ee8a0a0acac83dd"],
  ["run-envelope-running", "0dfdf9c52ba1ee909070da85617630bbb0cac990f109bdc3c7f25c4f686276dd"],
  ["run-envelope-terminal", "7e1272e9374eb193833d700f54b15b5453e92a8475a8f942c72f6f64ca5645cd"],
  ["terminal-result-completed", "3d17906cce62941bf26a4817e5b9ccb8c31d1804878280f1a18b7b69632a98a0"],
  ["terminal-result-blocked", "9e2aac2293e6a2aa0ff69725ec484565d1ba598e4f921be01c44267eaab6d231"],
  ["terminal-result-partial", "c7c56d99562df246e6e5219fb7ca002924103fea7be86bc2cab1b8c04eada6f6"],
  ["terminal-result-needs-human", "f10e0e1b566924c9b223e63b30426d6004b3210b0be12d884c63ec42310af5b9"],
  ["gate-pending", "d70533c9fc537f05cbde547e86f10c506e3f76d3d2afe7173122753ea333bfe6"],
  ["gate-decided", "e8a5f0aa5c350559d9dedb3c26815837d375ffdf169e89ca7dd0c5a493dff49a"],
  ["pending-snapshot", "78e4bb00d1b6b13bff01a2d917ce073f85eb27fa7f34aeede96ab839ceb49217"],
  ["handoff-receipt", "58e23ebcd17030b2cfa4866b0019183eee886d33130309abae4239043a54bcb6"],
  ["step-running", "c3c0602fa5bb98c69173989ce208f621a32f97d194ea33973954d5b49a4e6e7b"],
  ["step-unaccepted", "5e848d9b66c052700f913cec70973f9540f8353116442f379a818b3885d95b91"],
  ["step-accepted", "3410950dfd62131d5b0bb2af4b6edba1299a2a5ed9b966942c8702ec0efb3b6f"],
  ["step-acceptance-binding", "2add010067f1fac89b2a813351a5b2bfdeac8249a950dc2c92bf63081f144e8d"],
  ["step-inherited-acceptance", "89f696795438daef31ea897ff192d4290d8222917b908c819c674fa890aaf77e"],
  ["slice-pending-running", "3acddfcce109c5a9eb9b4273ec7248d5775502bda046b9583216d2ae84648a3f"],
  ["slice-review", "6bd682fac2d47133137131621f0e2257cbcda4426ff452e3151da2818b87c121"],
  ["slice-terminal", "3099c5701e189d736b24bb8e0a5e680c128d189725082dceddf07d22edadc88b"],
  ["slice-review-binding", "9760b016740fa49cb973b37306bc7063aa7d7ba0877b31fac495f5befc90b260"],
  ["slice-attempt-review", "687aa6cd4f82f5dfe53a31edc61d99d169f0825879a2994f0f20ae8c404627c7"],
  ["slice-evidence-sidecar", "dee23812ff8fab1766d3a97fbe23f81ecb9031fe6c324050567e30fc704e04e4"],
  ["slice-review-sidecar", "8b384799deb03803bb75ee60c8cc714751728c1a329fa2f27f288bf1985be3f4"],
  ["validator-verdict-binding", "e7cb4828eeb247f0bec58bce65cc8efd15e770602d9bb16787c9fea1e71ab018"],
  ["security-verdict-binding", "788a30ee97790fb5f9ba09915a2a281fb58ac542d15fe5bbf906548ffe45d110"],
  ["pr-created-result", "e37d53a5fb2e8a6007aa845a0b6dd1d18534ef406cd66e899b9f6c5568b30dbb"],
  ["continuation-envelope", "6bf3fb70f927af981715950d3e2d264bd72902599c95e07f82b01897fc4e05c9"],
  ["continuation-parent-binding", "2b011867bd950f95457ed8d4073d30911d3a9b85b579c20cb5b9301cae88220a"],
  ["continuation-selected-review", "7ce096ec80047c8df061dc7656446ad11bbf62cf633217e4ce56f5e1e8e4d6a8"],
  ["continuation-target-binding", "8a93c4d661ea231228107766a88c0455c78133c01cd302dfe7ee357a4b58cd78"],
  ["continuation-parent-artifact-sidecar", "1a62463f051598250f73d951ddfe53f8c27e3eaf4684f5c00e53e90f6d6163e9"],
  ["continuation-parent-evidence-sidecar", "7ed49126e2e4f28ab9d2191f059fe92b8ac4418eed4118205da7bafe4ea9b1b4"],
  ["continuation-parent-review-sidecar", "c000f120c08d85f52e53c82c2616b74d312719976e4ce4298c6c16c339c0694b"],
  ["continuation-planning-reuse-ineligible", "299b7ff7f60229ffe0b23917aa491d84f23bbc7e71677a7b88049ebbade3b130"],
  ["continuation-planning-reuse-eligible", "13accc56aa839eb2482f24a5292b78f014b02ae6889f498ed3a566664fea4b37"],
  ["continuation-draft-reuse", "a5bd5d78043f8381e376cadbb1628e46d220cf74f2d1bec147c5f798ca985be8"],
  ["continuation-post-pr-binding", "959836a883a8a206939b5a68bca2b498118d13ddcb784aa3caf44edb5751f467"],
  ["post-pr-phase-disabled", "513971086c59d58641e60d94eafbcd2bf14874ba9c6ccfc647232b41b7b07e34"],
  ["post-pr-phase-awaiting-pr", "bf1c21e663f13eb7e6a1be999f3909712e1c40b510ec6116c98d0cd01dc8e130"],
  ["post-pr-phase-observing", "278b11bb3583952da9b8ae74b828e57bff0896f3d03b8bd5b2b0dd780d6b4bdd"],
  ["post-pr-phase-failure-recording", "069fdc97c5857cb5f2db059b088a26c093745a7e57f97a2d205ff0bf602525f5"],
  ["post-pr-phase-remediation-planned", "e206193f01349bd009a9a3d0e7369fda199d609bafe325dea0db0290c6e9a401"],
  ["post-pr-phase-remediation-running", "754e04090cdda9c8cc099bc794c6154534fcfd616187e9633ac3cc739fbaac2c"],
  ["post-pr-phase-changes-observed", "fffea30b6bccd996c642f0a3641ebd6445c039580d03be1383acb1999e11e937"],
  ["post-pr-phase-committed", "a8e0409e277950e434a396269c5fe85d6e8d0e7b7eb05b33a020a19b79c8a50c"],
  ["post-pr-phase-revalidating", "3c0dae1595ed4570d0bc12c6b5c7807331dbd90e6f3cf7ee4bba48ac60ce7490"],
  ["post-pr-phase-validated", "c7f4dedf62825b7203213ad32306cda12f37f732ca25b5b483cf21aed9e1d75f"],
  ["post-pr-phase-push-pending", "8053e999b73cf43d539e860b9575f014944ce588b324e7cf2fec1c584a4cc588"],
  ["post-pr-phase-remote-confirmed", "d1066e16f865e4f172285d5376382dd7fc2f6e53c8e5084606dd5edd6bad4481"],
  ["post-pr-phase-succeeded", "f85af2b48c0926e215e4e52aa8ffd21c73009f3b83e3b58fa35ed98a1355a3f8"],
  ["post-pr-phase-blocked", "cb252153402eb377af2749e935a7c2fa95c5e38d2caa5320c2c0d5399d8679e1"],
  ["post-pr-phase-needs-human", "7cbad4902c5adc539c29f71d39d45bf7544e5d7fb0d670e46b750599a11caf5e"],
  ["post-pr-policy-disabled", "76f1b7264a0cb181f8b3884c890dff1e80662be726d05dff020e63d874a76bb0"],
  ["post-pr-policy-enabled", "298024312242448d270702936af48830268f6a1b61178959ac1728e1fa2d5aaa"],
  ["post-pr-observation-null", "6832f22ef92cdf429615e13b927440741ac4cfeca5e8fc353c6ea501d96a6252"],
  ["post-pr-observation-active", "e0f334f36636f4c4cd7fdfeef2e7de13a92c714272ca227205df487810ad7c54"],
  ["post-pr-observation-last-error", "732e1bb8f0c5dc307f0415288bd6c599681043994a26fe3a152d870c413a9af9"],
  ["post-pr-observation-review-request", "56615c1ed43d8357ceefc407b96b3a3458743c480e5bd650919528f99c0e64ed"],
  ["post-pr-observation-snapshot", "4d184a362df7a52c9c49a94419ace41595b7c2272d403298ead7643e2f019186"],
  ["post-pr-remediation-null", "a9699daf0f74cc82d9200448497a35f258e6bf1ff8c7abd6ccb45829f25e83e4"],
  ["post-pr-remediation-active", "ada46ba3e5fe393173303af8b5e97541618190011adc27323f4d8c1f601d1c24"],
  ["post-pr-remediation-owner", "d0de8ce88fb6d4fd46f561423ec15cbbd9c0d9f673d978803d181cb48f4e62ca"],
  ["post-pr-remediation-changes", "6407f76902b6e3e966837049a7a5be36002dfc1e391cb75fcda8c7d91b050572"],
  ["post-pr-remediation-change-entry", "c696de34634555c76db0c6a4818cba73e5cff137a1dc784ec5df4c599b5fb76a"],
  ["post-pr-dispatch-planned", "a71360216563456d2dad79c83a7018800b98727041b342e48ad81d69c7fccea7"],
  ["post-pr-dispatch-running", "3eab951f904a67218716f18047cbe976ef336b7f6e6488a578a5e6e91f4fe147"],
  ["post-pr-dispatch-returned", "2ffb3a5e416345718902ea9e864391547b0797c16646efe4d161cc5f32f6f70d"],
  ["post-pr-revalidation-empty", "302761cb949ccc43da4f9a602a7ebd091df624097011bb7958cfdeab319a80bc"],
  ["post-pr-revalidation-bound", "80abaaba81eedda77a8e7dae19a2a4d474bc85d5ccb5adb74437c0f7ad31417d"],
  ["post-pr-canonical-job-planned", "815d94caec57b7afa24ea0b6b45a8b9a57858cf06015f7c24e2d2cd9fdd5fc7f"],
  ["post-pr-canonical-job-running", "fc33c41aa3ce0fa4df42af7b33405415564d453763d5c9bc07654d90f4444c3e"],
  ["post-pr-canonical-job-retry-wait", "bd1c9e9194488a16122331b2f0342cf3d2fa1ba620e2cab0590f948d44247dd2"],
  ["post-pr-canonical-job-bound", "600eb75c7073f358ef3b92b23f03ecae3bb72de60694ba0274d230ad4003e3e0"],
  ["post-pr-validator-job-planned", "07fb026dbf33320ca36f905dc1755fe5752812c42379e250148b109809834884"],
  ["post-pr-validator-job-running", "1ab84f8d6b675ccb12ec6f266acd8710da74d8a1d10d596b963fd73393798d77"],
  ["post-pr-validator-job-retry-wait", "d05820c27e6c8f10a25e8818264da10b325c744eecbbc8dbd9870310fcfc2929"],
  ["post-pr-validator-job-bound", "b77581865f3c75ca0d682891570be23f9d2dea7150e36617400c3a719d0f0178"],
  ["post-pr-security-job-planned", "585ead6e646fa65a2c5f7ebcfda1ffee031a75b0d55565b8c7fe502b8f8a8ca5"],
  ["post-pr-security-job-running", "3a90f0cb1692ba8141b175585f345ac12406b1852de6aa1c35ce30ad1009beaa"],
  ["post-pr-security-job-retry-wait", "7d3734ebd954bbc2acad5a1ac1a7a50206586fca10f990fe6a13edd5f606c2f1"],
  ["post-pr-security-job-bound", "cfa50cf2a4df1ba81a5e5077fd46956b44869c7672934b4fe6a845dc70a053a5"],
  ["post-pr-push-not-ready", "395dc43d65cec206025ee43d80c11ac489507f58c5af5228eb6c6d6380d20815"],
  ["post-pr-push-pending", "ac97e631f9618c582a1b55b07229967e2531d271c8516065435155dba49123f9"],
  ["post-pr-push-confirmed", "70a523f94e9711765f33721aaeeb93603f6cf3b600fd28a49a3edd4f841f7b7c"],
  ["post-pr-push-last-error", "2488926b85aac8d01c8efabf743d157b64c52d9f5f511885ba895352389c30c8"],
  ["post-pr-evidence-sidecar", "7e1f2813cdbf989ddf2764bae919ecb9401fba296810cef54edcadc627f13ef0"],
  ["post-pr-continuation-review-null", "92960267c0c4fb308202f0ef2f90cfc52dec35df19e7e6e4da3f30d6b3aed05c"],
  ["post-pr-continuation-review-bound", "73f9ebd1ef1c52cd12bc8a4d381a85e780ee6f9ade46e7ea78a670e011342755"],
  ["post-pr-terminal-fact-null", "5aec52113785aff02962da6c7569a939245627f87cab4c98ec20837346b70063"],
  ["post-pr-terminal-fact-account-switch-failed-github-auth", "89db42abf207f47db3f5f2dcc28cb1f61ade51b7679e3e5b0be805d6d7b94436"],
  ["post-pr-terminal-fact-account-switch-failed-push", "a8a67f1c8e774c621d92c8a4e69bdbcd3b9cacb06da840cd55d0593e956bfa1a"],
  ["post-pr-terminal-fact-dispatch-start-unknown", "7a2d731df3167d87dec0923f1316a9ab4b0b4a919d31bf5344e09a7fecb4dee4"],
  ["post-pr-terminal-fact-path-lane-violation", "500e294346fe7f0d09dab8503578549c5bf1cb8deafd9e74102d5a9db690c20f"],
  ["post-pr-terminal-fact-remote-head-diverged", "7fe532840107a81679fc124cdde6e499aaf4e02313b791d6a44189eb5ce77432"],
  ["post-pr-terminal-fact-panel-runner-result-malformed", "78c5bc14d1c19f8bd3b449d2ba59160173d05698cbc61a6fab5f2b3e76e1ac2a"],
  ["post-pr-terminal-fact-push-failed", "2d49a423c4c8a2f70c1af4f3d598afdf6f22fad34df57b5cc323d4ac01c49511"],
  ["post-pr-terminal-fact-panel-attribution-unsafe", "7681ab4e932991797750ed39c61569748ed8690a291f27f6f0a4f91a5cd65844"],
  ["repair-reported", "ef3d9ae37c72a04894ce56d2e9c9f8f09aa3d65d7baf6c4f6b605b8f9830745b"],
  ["repair-repairing", "6062c58a7d49d7c4f7fe1f317013104b393a5fdbc25ecda125a837ebbfa39264"],
  ["repair-review-approve", "e224f1a3dc1c8e486c7963f575225c4d13154760db24643ead5a808c32c1446b"],
  ["repair-review-reject", "da2b33bb1df30abfb9e9c5d76c9d1db7fa13a8c0c67a22475bfd7ef6e62246c4"],
  ["repair-merged", "ba7f499cf894cf32b5c72841e49d15aa227b05a4a0e688845d45c54c5f920374"],
  ["repair-blocked-from-reported", "772b29a3b9bb10e02df054279568f292e02b5e91d57f362f402f9d647437eab0"],
  ["repair-blocked-from-repairing", "73fd358d7bfda416fd1ba881e3b557b28c9c4cbe5cba1b545ee026dcfd68d89d"],
  ["repair-blocked-from-review", "e0c16182c9ade7bcb8dce57cabb3292d5039dabc191ce1422a35aa6fd8398267"],
]);
const DURABLE_AUTHORITY_DESCRIPTOR_BY_ID = new Map(DURABLE_AUTHORITY_DESCRIPTOR_MANIFEST);

export function emitDurableRecordMutations(source, descriptor) {
  requireRecord(source, "source");
  requireRecord(descriptor, "descriptor");
  const recordName = requireText(descriptor.record, "descriptor.record");
  if (!Array.isArray(descriptor.targets)) throw new TypeError("descriptor.targets must be an array");
  requireRecord(descriptor.exclusions, "descriptor.exclusions");

  const targetsByFamily = new Map(DURABLE_MUTATION_FAMILIES.map((family) => [family, []]));
  for (const [index, mutationTarget] of descriptor.targets.entries()) {
    requireRecord(mutationTarget, `descriptor.targets[${index}]`);
    if (!targetsByFamily.has(mutationTarget.family)) throw new TypeError(`descriptor.targets[${index}].family is unknown`);
    requirePath(mutationTarget.path, `descriptor.targets[${index}].path`);
    if (mutationTarget.label !== undefined) requireText(mutationTarget.label, `descriptor.targets[${index}].label`);
    targetsByFamily.get(mutationTarget.family).push(mutationTarget);
  }

  for (const key of Object.keys(descriptor.exclusions)) {
    if (!targetsByFamily.has(key)) throw new TypeError(`descriptor.exclusions.${key} is unknown`);
  }

  const cases = [];
  for (const family of DURABLE_MUTATION_FAMILIES) {
    const targets = targetsByFamily.get(family);
    const hasExclusion = Object.hasOwn(descriptor.exclusions, family);
    if (targets.length > 0 && hasExclusion) throw new TypeError(`${recordName}.${family} cannot be both targeted and excluded`);
    if (targets.length === 0) {
      if (!hasExclusion) throw new TypeError(`${recordName}.${family} must have a target or a record-specific exclusion`);
      requireText(descriptor.exclusions[family], `descriptor.exclusions.${family}`);
      continue;
    }

    for (const mutationTarget of targets) {
      const record = structuredClone(source);
      try {
        applyMutation(record, family, mutationTarget);
      } catch (error) {
        throw new TypeError(`${recordName}: ${error.message}`, { cause: error });
      }
      const label = mutationTarget.label ?? renderPath(mutationTarget.path);
      cases.push({
        name: `${recordName}: ${family} (${label})`,
        family,
        recordName,
        record,
      });
    }
  }

  const names = cases.map(({ name }) => name);
  if (new Set(names).size !== names.length) throw new TypeError(`${recordName} mutation case names must be unique`);
  return cases;
}

export function assertDurableAuthorityCatalogComplete(catalog) {
  if (!Array.isArray(catalog)) throw new TypeError("durable authority catalog must be an array");
  const expectedClassIds = AUTHORITY_CLASSES.map(([id]) => id);
  const actualClassIds = catalog.map(({ id }) => id);
  if (!sameList(actualClassIds, expectedClassIds)) throw new TypeError("durable authority catalog must contain exactly the nine registered authority classes in order");
  const expectedManifestIds = Object.values(DURABLE_AUTHORITY_REQUIRED_RECORD_IDS).flat();
  if (!sameList(DURABLE_AUTHORITY_METADATA_MANIFEST.map(([id]) => id), expectedManifestIds)) throw new TypeError("independent metadata manifest must contain every required record id exactly once in source order");
  if (!sameList(DURABLE_AUTHORITY_DESCRIPTOR_MANIFEST.map(([id]) => id), expectedManifestIds)) throw new TypeError("independent descriptor manifest must contain every required record id exactly once in source order");
  if (!sameList(Object.keys(EXPLICIT_EXCLUDED_FAMILY_CODES), expectedManifestIds)) throw new TypeError("explicit family disposition registry must contain every required record id exactly once in source order");

  const seenRecordIds = new Set();
  for (const authorityClass of catalog) {
    requireText(authorityClass.name, `${authorityClass.id}.name`);
    if (!Array.isArray(authorityClass.records)) throw new TypeError(`${authorityClass.id}.records must register per-record entries`);
    const expectedRecordIds = DURABLE_AUTHORITY_REQUIRED_RECORD_IDS[authorityClass.id];
    const actualRecordIds = authorityClass.records.map(({ id }) => id);
    if (!sameList(actualRecordIds, expectedRecordIds)) throw new TypeError(`${authorityClass.id} must contain every required per-record and per-variant entry in order`);

    for (const record of authorityClass.records) {
      const path = `${authorityClass.id}.${record.id}`;
      if (seenRecordIds.has(record.id)) throw new TypeError(`${path} duplicates a record id`);
      seenRecordIds.add(record.id);
      if (record.authorityClassId !== authorityClass.id) throw new TypeError(`${path}.authorityClassId must match its containing class`);
      requireText(record.record, `${path}.record`);
      requireText(record.variant, `${path}.variant`);
      requireText(record.writer, `${path}.writer`);
      requireTextArray(record.readers, `${path}.readers`);
      requireTextArray(record.tests, `${path}.tests`);
      const expectedMetadataHash = DURABLE_AUTHORITY_METADATA_BY_ID.get(record.id);
      const actualMetadataHash = metadataHash(record);
      if (actualMetadataHash !== expectedMetadataHash) throw new TypeError(`${path} writer, readers, tests, facts, and sidecars must exactly match the independent metadata manifest`);
      requireRecord(record.source, `${path}.source`);
      requireRecord(record.descriptor, `${path}.descriptor`);
      if (record.descriptor.record !== record.id) throw new TypeError(`${path}.descriptor.record must equal the record id`);
      validateExpectedDescriptorDispositions(record, path);
      const expectedDescriptorHash = DURABLE_AUTHORITY_DESCRIPTOR_BY_ID.get(record.id);
      const actualDescriptorHash = descriptorHash(record.descriptor);
      if (actualDescriptorHash !== expectedDescriptorHash) throw new TypeError(`${path} mutation target definitions and exclusions must exactly match the independent descriptor manifest`);
      emitDurableRecordMutations(record.source, record.descriptor);
      validateRecordSidecars(record, path);
    }
  }
  return true;
}

const RECORDS = [
  recordEntry({
    authorityClassId: "plan-slices-graph", id: "plan-slices-json", record: "plan/slices.json", variant: "accepted graph",
    writer: "factory slices-seed (checked plan validation and seed transition)",
    readers: ["validateSlicesPlan", "factory slices-seed", "transitionRunSlice and transitionSliceMerged", "transitionMergedSliceRepair owner-lane checks"],
    source: { slices: [{ id: "B0.3", stack: "backend", paths: ["test/**"], depends_on: ["B0.2"], acceptance: ["AC3"], test_plan: ["node --test"] }] },
    requiredPath: ["slices"], typePath: ["slices"],
    targets: [drift(["slices", 0], "depends_on", "dependencies"), stale(["slices", 0, "id"], "stale-slice"), cross(["slices", 0, "depends_on", 0], "other-wave")],
  }),
  recordEntry({
    authorityClassId: "plan-slices-graph", id: "final-plan-descriptor", record: "final.plan.json descriptor", variant: "required descriptor",
    writer: "work-decomposer final plan write followed by reviewed planning acceptance",
    readers: ["work-reviewer decomposition review", "factory slices-seed descriptor consumption"],
    source: { schema_version: 1, kind: "final-plan", created_at: NOW, run_id: "catalog-run", descriptor: { kind: "slices-graph", ref: "plan/slices.json", hash: HASH_A }, sidecar_bytes: "{\"slices\":[]}" },
    requiredPath: ["descriptor", "kind"], typePath: ["descriptor"], sidecars: [sidecar("plan", ["descriptor", "ref"], ["descriptor", "hash"], ["sidecar_bytes"])],
    targets: [schema(["schema_version"]), kind(["descriptor", "kind"], "unknown-graph", "required descriptor.kind"), time(["created_at"]), ref(["descriptor", "ref"], "plan"), hash(["descriptor", "hash"], "plan"), bytes(["sidecar_bytes"], "plan"), drift(["descriptor"], "kind", "record_kind"), stale(["run_id"], "stale-run"), cross(["descriptor", "kind"], "other-boundary-kind", "descriptor boundary")],
  }),

  recordEntry({
    authorityClassId: "run-envelope-terminal-result", id: "run-envelope-running", record: "run.json", variant: "running",
    writer: "manifest bootstrap and transitionRunJson checked locked writers",
    readers: ["validateRun", "resumeFactory", "all checked run-state transitions through transitionRunJson", "factory status/list/watch eligibility readers"],
    source: { schema_version: 1, run_id: "catalog-run", status: "running", updated_at: NOW, base_commit: SHA_A, branch: "catalog-run", worktree: "/tmp/catalog-run", terminal_result: null },
    requiredPath: ["run_id"], typePath: ["status"], targets: [schema(["schema_version"]), time(["updated_at"]), ref(["worktree"]), stale(["base_commit"], SHA_B), cross(["run_id"], "other-run")],
  }),
  recordEntry({
    authorityClassId: "run-envelope-terminal-result", id: "run-envelope-terminal", record: "run.json", variant: "terminal envelope",
    writer: "transitionTerminalResult, transitionPrCreated, or transitionPostPrTerminal",
    readers: ["validateRun", "resumeFactory terminal check", "factory status/list/watch terminal readers", "cleanup eligibility readers"],
    source: { schema_version: 1, run_id: "catalog-run", status: "blocked", updated_at: NOW, terminal_result: { status: "blocked", run_id: "catalog-run", reason: "review-blocked" } },
    requiredPath: ["terminal_result"], typePath: ["status"], targets: [schema(["schema_version"]), time(["updated_at"]), stale(["status"], "running"), cross(["terminal_result", "run_id"], "other-run")],
  }),
  terminalResultEntry("terminal-result-completed", "completed", { pr_url: "https://github.com/acme/repo/pull/7", pr_number: 7, repository: "acme/repo", draft: false, artifacts: { test_report: "artifacts/test-report.md" } }, [ref(["artifacts", "test_report"]), stale(["pr_number"], 6)]),
  terminalResultEntry("terminal-result-blocked", "blocked", { reason: "review-blocked", summary: "Review blocked." }),
  terminalResultEntry("terminal-result-partial", "partial", { reason: "partial-completion", summary: "Some work completed." }),
  terminalResultEntry("terminal-result-needs-human", "needs-human", { reason: "operator-reconciliation", summary: "Operator action required." }),

  recordEntry({
    authorityClassId: "gates-snapshot-handoff", id: "gate-pending", record: "run.json.gates.<gate>", variant: "pending",
    writer: "transitionGateDecision pending transition",
    readers: ["validateRun gate validation", "transitionGateDecision decision admission", "approval handoff eligibility", "resume and protected-gate readers"],
    source: { gate: "story", status: "pending", artifact: "artifacts/story.md", question_ref: "gates/story.question.md", answer_ref: "gates/story.answer", pending_snapshot: {} },
    requiredPath: ["status"], typePath: ["pending_snapshot"], targets: [ref(["artifact"]), stale(["status"], "approved"), cross(["gate"], "brief"), drift([], "question_ref", "question")],
  }),
  recordEntry({
    authorityClassId: "gates-snapshot-handoff", id: "gate-decided", record: "run.json.gates.<gate>", variant: "approved/changes_requested/stopped",
    writer: "transitionGateDecision checked decision transition",
    readers: ["validateRun gate validation", "assertPrCreatedReadiness", "approval handoff eligibility", "step and terminal boundary guards"],
    source: { gate: "story", status: "approved", answer: "approve", approval_source: "external-driver", answered_at: NOW, handoff_receipt: null },
    requiredPath: ["status"], typePath: ["approval_source"], targets: [time(["answered_at"]), stale(["status"], "pending"), cross(["gate"], "pre_pr")],
  }),
  recordEntry({
    authorityClassId: "gates-snapshot-handoff", id: "pending-snapshot", record: "pending_snapshot", variant: "question/artifact/answer bindings",
    writer: "createPendingGateSnapshot inside transitionGateDecision",
    readers: ["validatePendingSnapshot", "transitionGateDecision fresh byte recheck", "validateApprovalHandoffReceipt"],
    source: { question_ref: "gates/story.question.md", question_hash: HASH_A, artifact_ref: "artifacts/story.md", artifact_hash: HASH_B, answer_ref: "gates/story.answer", answer_hash: HASH_C, created_at: NOW, sidecar_bytes: { question: "question", artifact: "story", answer: "approve\n" } },
    requiredPath: ["question_ref"], typePath: ["answer_hash"], sidecars: [sidecar("question", ["question_ref"], ["question_hash"], ["sidecar_bytes", "question"]), sidecar("artifact", ["artifact_ref"], ["artifact_hash"], ["sidecar_bytes", "artifact"]), sidecar("answer", ["answer_ref"], ["answer_hash"], ["sidecar_bytes", "answer"])],
    targets: [time(["created_at"]), ...sidecarTargets("question", ["question_ref"], ["question_hash"], ["sidecar_bytes", "question"]), ...sidecarTargets("artifact", ["artifact_ref"], ["artifact_hash"], ["sidecar_bytes", "artifact"]), ...sidecarTargets("answer", ["answer_ref"], ["answer_hash"], ["sidecar_bytes", "answer"]), drift([], "artifact_ref", "artifact"), stale(["answer_hash"], HASH_A), cross(["question_ref"], "gates/brief.question.md")],
  }),
  recordEntry({
    authorityClassId: "gates-snapshot-handoff", id: "handoff-receipt", record: "handoff_receipt", variant: "interactive approval bound",
    writer: "createApprovalHandoffReceipt inside transitionGateDecision",
    readers: ["validateGateHandoffReceipt", "validateApprovalHandoffReceipt", "transitionGateDecisionAndHandoff launch admission"],
    source: { schema_version: 1, kind: "interactive-approval-handoff", gate: "story", approval_fingerprint: HASH_A, pending_snapshot_hash: HASH_B, answer_hash: HASH_C, steering_generation: 0, accepted_at: NOW, sidecar_bytes: { pending_snapshot: "snapshot", answer: "approve\n" } },
    requiredPath: ["kind"], typePath: ["steering_generation"], sidecars: [sidecar("pending-snapshot", null, ["pending_snapshot_hash"], ["sidecar_bytes", "pending_snapshot"]), sidecar("answer", null, ["answer_hash"], ["sidecar_bytes", "answer"])],
    targets: [schema(["schema_version"]), kind(["kind"], "approval"), time(["accepted_at"]), hash(["pending_snapshot_hash"], "pending-snapshot"), bytes(["sidecar_bytes", "pending_snapshot"], "pending-snapshot"), hash(["answer_hash"], "answer"), bytes(["sidecar_bytes", "answer"], "answer"), stale(["steering_generation"], -1), cross(["gate"], "brief")],
  }),

  stepEntry("step-running", "running", null, null),
  stepEntry("step-unaccepted", "rejected/blocked", null, null),
  stepEntry("step-accepted", "accepted", { artifact_ref: "artifacts/technical-brief.md", review_ref: "reviews/spec-writer.json" }, null),
  recordEntry({
    authorityClassId: "steps-acceptance-inheritance", id: "step-acceptance-binding", record: "steps[].acceptance", variant: "artifact and optional review bound",
    writer: "transitionRunStep accepted transition",
    readers: ["validateRun step acceptance validation", "continuationPlanningReuse", "adoptContinuationPlanning", "accepted planning consumers"],
    source: { artifact_ref: "artifacts/technical-brief.md", artifact_hash: HASH_A, review_ref: "reviews/spec-writer.json", review_hash: HASH_B, sidecar_bytes: { artifact: "brief", review: "approve" } },
    requiredPath: ["artifact_ref"], typePath: ["artifact_hash"], sidecars: [sidecar("artifact", ["artifact_ref"], ["artifact_hash"], ["sidecar_bytes", "artifact"]), sidecar("review", ["review_ref"], ["review_hash"], ["sidecar_bytes", "review"])],
    targets: [...sidecarTargets("artifact", ["artifact_ref"], ["artifact_hash"], ["sidecar_bytes", "artifact"]), ...sidecarTargets("review", ["review_ref"], ["review_hash"], ["sidecar_bytes", "review"]), drift([], "artifact_ref", "artifact"), stale(["artifact_hash"], HASH_C), cross(["review_ref"], "reviews/security-reviewer.json")],
  }),
  recordEntry({
    authorityClassId: "steps-acceptance-inheritance", id: "step-inherited-acceptance", record: "steps[].inherited_acceptance", variant: "parent acceptance adopted",
    writer: "adoptContinuationPlanning checked adoption transition",
    readers: ["validateStepInheritedAcceptance", "continuation planning consumers", "blocked-run continuation audit readers"],
    source: { from_run_id: "parent-run", parent_spec_review_ref: "reviews/spec-writer.json", artifact_hash: HASH_A, review_hash: HASH_B, sidecar_bytes: { artifact: "brief", review: "approve" } },
    requiredPath: ["from_run_id"], typePath: ["artifact_hash"], sidecars: [sidecar("artifact", null, ["artifact_hash"], ["sidecar_bytes", "artifact"]), sidecar("review", ["parent_spec_review_ref"], ["review_hash"], ["sidecar_bytes", "review"])],
    targets: [hash(["artifact_hash"], "artifact"), bytes(["sidecar_bytes", "artifact"], "artifact"), ...sidecarTargets("review", ["parent_spec_review_ref"], ["review_hash"], ["sidecar_bytes", "review"]), stale(["from_run_id"], "stale-parent"), cross(["parent_spec_review_ref"], "reviews/other-run.json")],
  }),

  sliceEntry("slice-pending-running", "pending/running", { status: "running", attempts: 1 }),
  sliceEntry("slice-review", "review", { status: "review", attempts: 1, evidence_ref: "evidence/backend.json", review_ref: "reviews/backend.json" }),
  sliceEntry("slice-terminal", "merged/blocked", { status: "merged", attempts: 1, merge_commit: SHA_B }),
  recordEntry({
    authorityClassId: "slices-review-evidence-bindings", id: "slice-review-binding", record: "slices[].review_binding", variant: "current attempt review bound",
    writer: "transitionRunSlice review transition",
    readers: ["validateRun slice validation", "transitionSliceMerged", "slice remediation/review replay readers"],
    source: { attempt: 2, subject: "backend", reviewed_commit: SHA_B, review_ref: "reviews/backend.attempt-2.json", review_hash: HASH_A, sidecar_bytes: "approve" },
    requiredPath: ["attempt"], typePath: ["reviewed_commit"], sidecars: [sidecar("review", ["review_ref"], ["review_hash"], ["sidecar_bytes"])],
    targets: [...sidecarTargets("review", ["review_ref"], ["review_hash"], ["sidecar_bytes"]), drift([], "review_ref", "ref"), stale(["attempt"], 1), cross(["subject"], "frontend")],
  }),
  recordEntry({
    authorityClassId: "slices-review-evidence-bindings", id: "slice-attempt-review", record: "slices[].attempt_reviews[]", variant: "append-only prior attempt",
    writer: "transitionRunSlice review/rejection transition",
    readers: ["validateRun slice attempt history", "work-review remediation routing", "transitionSliceMerged current-attempt checks"],
    source: { attempt: 1, subject: "backend", review_ref: "reviews/backend.attempt-1.json", review_hash: HASH_A, verdict: "REJECT", sidecar_bytes: "reject" },
    requiredPath: ["attempt"], typePath: ["verdict"], sidecars: [sidecar("review", ["review_ref"], ["review_hash"], ["sidecar_bytes"])],
    targets: [...sidecarTargets("review", ["review_ref"], ["review_hash"], ["sidecar_bytes"]), stale(["attempt"], 0), cross(["subject"], "other-slice")],
  }),
  sidecarRecord("slices-review-evidence-bindings", "slice-evidence-sidecar", "evidence/<slice>.json", "slice evidence", "transitionRunSlice review transition", ["transitionRunSlice review admission", "work-reviewer evidence truth checks", "transitionSliceMerged"], "evidence/backend.attempt-2.json", "{\"status\":\"pass\"}"),
  sidecarRecord("slices-review-evidence-bindings", "slice-review-sidecar", "reviews/<slice>.json", "slice review", "transitionRunSlice review binding", ["transitionRunSlice review admission", "transitionSliceMerged", "remediation attempt routing"], "reviews/backend.attempt-2.json", "{\"verdict\":\"APPROVE\"}"),

  panelEntry("validator-verdict-binding", "run.json.validator", "implementation-validator", "GO", "artifacts/validation-report.md", "reviews/implementation-validator.json", "factory verdicts checked transition", ["assertPrCreatedReadiness", "post-PR revalidation", "terminal/panel remediation routing"]),
  panelEntry("security-verdict-binding", "run.json.security_review", "security-reviewer", "PASS", null, "reviews/security-reviewer.json", "factory verdicts checked transition", ["assertPrCreatedReadiness", "post-PR revalidation", "terminal/panel remediation routing"]),
  recordEntry({
    authorityClassId: "validator-security-pr-result", id: "pr-created-result", record: "PR-created terminal_result", variant: "completed external PR",
    writer: "transitionPrCreated after fenced external PR creation/re-observation",
    readers: ["validateRun terminal consistency", "resumeFactory terminal reader", "cleanup eligibility", "post-PR initialization and continuation admission"],
    source: { status: "completed", run_id: "catalog-run", pr_url: "https://github.com/acme/repo/pull/7", pr_number: 7, repository: "acme/repo", draft: false, head_sha: SHA_B },
    requiredPath: ["pr_url"], typePath: ["pr_number"], targets: [ref(["pr_url"]), stale(["head_sha"], SHA_A), cross(["repository"], "other/repo")],
  }),

  continuationEnvelopeEntry(),
  continuationParentEntry(),
  continuationReviewEntry(),
  continuationTargetEntry(),
  continuationContextEntry("continuation-parent-artifact-sidecar", "parent_artifacts[]", "artifact", "artifacts/story.md"),
  continuationContextEntry("continuation-parent-evidence-sidecar", "parent_evidence[]", "evidence", "evidence/test-verifier.json"),
  continuationContextEntry("continuation-parent-review-sidecar", "parent_reviews[]", "review", "reviews/implementation-validator.json"),
  recordEntry({
    authorityClassId: "continuation-planning-draft-reuse", id: "continuation-planning-reuse-ineligible", record: "continuation.planning_reuse", variant: "eligible false",
    writer: "factory continue planning reuse assessment",
    readers: ["validateContinuationPlanningReuse", "feature command payload normalization", "adoptContinuationPlanning refusal path"],
    source: { eligible: false }, requiredPath: ["eligible"], typePath: ["eligible"], targets: [stale(["eligible"], true), cross(["eligible"], "parent-accepted")],
  }),
  recordEntry({
    authorityClassId: "continuation-planning-draft-reuse", id: "continuation-planning-reuse-eligible", record: "continuation.planning_reuse", variant: "eligible true with accepted bytes",
    writer: "factory continue planning reuse assessment",
    readers: ["validateContinuationPlanningReuse", "feature command payload normalization", "adoptContinuationPlanning checked adoption"],
    source: { eligible: true, spec_review_ref: "reviews/spec-writer.json", spec_review_hash: HASH_A, spec_artifact_ref: "artifacts/technical-brief.md", spec_artifact_hash: HASH_B, sidecar_bytes: { review: "approve", artifact: "brief" } },
    requiredPath: ["eligible"], typePath: ["spec_review_hash"], sidecars: [sidecar("review", ["spec_review_ref"], ["spec_review_hash"], ["sidecar_bytes", "review"]), sidecar("artifact", ["spec_artifact_ref"], ["spec_artifact_hash"], ["sidecar_bytes", "artifact"])],
    targets: [...sidecarTargets("review", ["spec_review_ref"], ["spec_review_hash"], ["sidecar_bytes", "review"]), ...sidecarTargets("artifact", ["spec_artifact_ref"], ["spec_artifact_hash"], ["sidecar_bytes", "artifact"]), stale(["eligible"], false), cross(["spec_review_ref"], "reviews/other-run.json")],
  }),
  recordEntry({
    authorityClassId: "continuation-planning-draft-reuse", id: "continuation-draft-reuse", record: "continuation.draft_spec_reuse", variant: "unaccepted draft with remaining retry budget",
    writer: "factory continue draft reuse admission",
    readers: ["validateContinuationDraftSpecReuse", "feature command payload normalization", "spec-writer attempt/budget initialization"],
    source: { artifact_ref: "artifacts/technical-brief.md", artifact_hash: HASH_A, parent_step_status: "rejected", parent_step_attempts: 1, max_retries: 3, remaining_attempts: 2, sidecar_bytes: "draft" },
    requiredPath: ["artifact_ref"], typePath: ["remaining_attempts"], sidecars: [sidecar("draft", ["artifact_ref"], ["artifact_hash"], ["sidecar_bytes"])],
    targets: [...sidecarTargets("draft", ["artifact_ref"], ["artifact_hash"], ["sidecar_bytes"]), stale(["parent_step_attempts"], 0), cross(["remaining_attempts"], 3)] ,
  }),
  recordEntry({
    authorityClassId: "continuation-planning-draft-reuse", id: "continuation-post-pr-binding", record: "continuation.post_pr", variant: "blocked post-PR continuation context",
    writer: "factory continue post-PR continuation admission",
    readers: ["validateContinuationPostPr", "feature command payload normalization", "post-PR continuation workflow routing"],
    source: { pr_url: "https://github.com/acme/repo/pull/7", repository: "acme/repo", pr_number: 7, head_sha: SHA_A, disposition: "leave-unchanged", post_pr_hash: HASH_A, evidence_ref: "evidence/post-pr.json", evidence_hash: HASH_B, continuation_review_ref: "reviews/post-pr.json", continuation_review_hash: HASH_C, sidecar_bytes: { evidence: "red", review: "blocked" } },
    requiredPath: ["pr_url"], typePath: ["pr_number"], sidecars: [sidecar("evidence", ["evidence_ref"], ["evidence_hash"], ["sidecar_bytes", "evidence"]), sidecar("review", ["continuation_review_ref"], ["continuation_review_hash"], ["sidecar_bytes", "review"])],
    targets: [...sidecarTargets("evidence", ["evidence_ref"], ["evidence_hash"], ["sidecar_bytes", "evidence"]), ...sidecarTargets("review", ["continuation_review_ref"], ["continuation_review_hash"], ["sidecar_bytes", "review"]), ref(["pr_url"]), hash(["post_pr_hash"]), stale(["head_sha"], SHA_B), cross(["repository"], "other/repo")],
  }),

  ...POST_PR_PHASES.map(postPrPhaseEntry),
  postPrPolicyEntry("post-pr-policy-disabled", false),
  postPrPolicyEntry("post-pr-policy-enabled", true),
  postPrNullEntry("post-pr-observation-null", "post_pr.observation", "observation", "awaiting-pr", "transitionPrCreated initializes observation", ["validatePostPrObservation", "transitionPostPrState monotonic observation checks", "transitionPostPrTerminal observation preconditions"]),
  postPrObservationEntry(),
  postPrObservationNestedEntry("last-error"),
  postPrObservationNestedEntry("review-request"),
  postPrObservationNestedEntry("snapshot"),
  postPrNullEntry("post-pr-remediation-null", "post_pr.remediation", "remediation", "observing", "transitionPostPrFailure creates remediation", ["validatePostPrRemediation", "transitionPostPrFailure replay checks", "transitionPostPrTerminal failure preconditions"]),
  postPrRemediationEntry(),
  postPrRemediationNestedEntry("owner"),
  postPrRemediationNestedEntry("changes"),
  postPrRemediationNestedEntry("change-entry"),
  postPrDispatchEntry("post-pr-dispatch-planned", "planned", null, null),
  postPrDispatchEntry("post-pr-dispatch-running", "running", NOW, null),
  postPrDispatchEntry("post-pr-dispatch-returned", "returned", NOW, "2026-07-16T12:05:00.000Z"),
  postPrRevalidationEntry("post-pr-revalidation-empty", false),
  postPrRevalidationEntry("post-pr-revalidation-bound", true),
  ...POST_PR_JOB_ACTIVITIES.flatMap((activity) => POST_PR_JOB_STATES.map((state) => postPrJobEntry(activity, state))),
  postPrPushEntry("post-pr-push-not-ready", "not-ready", null, null),
  postPrPushEntry("post-pr-push-pending", "pending", SHA_A, null),
  postPrPushEntry("post-pr-push-confirmed", "confirmed", SHA_A, SHA_B),
  postPrPushLastErrorEntry(),
  sidecarRecord("post-pr-nested-records", "post-pr-evidence-sidecar", "post_pr.evidence_refs[]", "failure/remediation evidence", "transitionPostPrFailure or transitionPostPrState append", ["assertPostPrRefsConsistent", "bindPostPrContinuationReview", "transitionPostPrTerminal"], "evidence/post-pr-ci.attempt-1.json", "{\"verdict\":\"red\"}"),
  postPrNullEntry("post-pr-continuation-review-null", "post_pr.continuation_review", "continuation_review", "observing", "transitionPostPrTerminal binds only retry exhaustion", ["validatePostPr", "transitionPostPrTerminal retry-exhaustion checks", "factory continue post-PR admission"]),
  postPrContinuationReviewEntry(),
  postPrNullEntry("post-pr-terminal-fact-null", "post_pr.terminal_fact", "terminal_fact", "succeeded", "transitionPostPrTerminal writes null for non-fact terminal reasons", ["validatePostPrTerminalFact", "terminal status/readers"]),
  postPrTerminalFactEntry("account-switch-failed-github-auth"),
  postPrTerminalFactEntry("account-switch-failed-push"),
  postPrTerminalFactEntry("dispatch-start-unknown"),
  postPrTerminalFactEntry("path-lane-violation"),
  postPrTerminalFactEntry("remote-head-diverged"),
  postPrTerminalFactEntry("panel-runner-result-malformed"),
  postPrTerminalFactEntry("push-failed"),
  postPrTerminalFactEntry("panel-attribution-unsafe"),

  repairEntry("repair-reported", "reported", 0, {
    facts: ["defect-path", "owner-consumer", "plan-owner-snapshot", "original-evidence", "attempts-quiescence"],
    record: { defect_path: "src/owner/records.js" },
    sidecars: ["plan-owner", "original-evidence"],
  }),
  repairEntry("repair-repairing", "repairing", 1, {
    facts: ["defect-path", "owner-consumer", "plan-owner-snapshot", "baseline", "original-evidence", "attempts-quiescence"],
    record: { defect_path: "src/owner/records.js", baseline_commit: SHA_A, branch: "repair", worktree: "/tmp/repair" },
    sidecars: ["plan-owner", "original-evidence"],
  }),
  repairEntry("repair-review-approve", "review:APPROVE", 1, {
    facts: ["defect-path", "owner-consumer", "plan-owner-snapshot", "baseline", "original-evidence", "repair-evidence", "reviewed-commit-review-bytes", "review-verdict-approve", "attempts-quiescence"],
    record: { defect_path: "src/owner/records.js", baseline_commit: SHA_A, reviewed_commit: SHA_B, review_verdict: "APPROVE", review_ref: "reviews/repair-attempt-1.json", review_hash: HASH_C, repair_evidence_ref: "evidence/repair-attempt-1.json", repair_evidence_hash: HASH_C },
    sidecars: ["plan-owner", "original-evidence", "repair-evidence", "review"],
  }),
  repairEntry("repair-review-reject", "review:REJECT", 1, {
    facts: ["defect-path", "owner-consumer", "plan-owner-snapshot", "baseline", "original-evidence", "repair-evidence", "reviewed-commit-review-bytes", "review-verdict-reject", "attempts-quiescence"],
    record: { defect_path: "src/owner/records.js", baseline_commit: SHA_A, reviewed_commit: SHA_B, review_verdict: "REJECT", review_ref: "reviews/repair-attempt-1.json", review_hash: HASH_C, repair_evidence_ref: "evidence/repair-attempt-1.json", repair_evidence_hash: HASH_C },
    sidecars: ["plan-owner", "original-evidence", "repair-evidence", "review"],
  }),
  repairEntry("repair-merged", "merged", 1, {
    facts: ["defect-path", "owner-consumer", "plan-owner-snapshot", "baseline", "original-evidence", "repair-evidence", "reviewed-commit-review-bytes", "verification", "merge-commit-tree", "attempts-quiescence"],
    record: { defect_path: "src/owner/records.js", baseline_commit: SHA_A, reviewed_commit: SHA_B, review_ref: "reviews/repair-attempt-1.json", review_hash: HASH_C, repair_evidence_ref: "evidence/repair-attempt-1.json", repair_evidence_hash: HASH_C, verification_ref: "evidence/repair-verification.json", verification_hash: HASH_B, merge_commit: SHA_C, reviewed_tree: HASH_A, merge_tree: HASH_A },
    sidecars: ["plan-owner", "original-evidence", "repair-evidence", "review", "verification"],
  }),
  repairEntry("repair-blocked-from-reported", "blocked-from-reported", 0, {
    facts: ["defect-path", "owner-consumer", "plan-owner-snapshot", "original-evidence", "blocked-reason", "attempts-quiescence"],
    record: { defect_path: "src/owner/records.js", reason: "repair rejected" },
    sidecars: ["plan-owner", "original-evidence"],
  }),
  repairEntry("repair-blocked-from-repairing", "blocked-from-repairing", 1, {
    facts: ["defect-path", "owner-consumer", "plan-owner-snapshot", "baseline", "original-evidence", "blocked-reason", "attempts-quiescence"],
    record: { defect_path: "src/owner/records.js", baseline_commit: SHA_A, reason: "repair failed" },
    sidecars: ["plan-owner", "original-evidence"],
  }),
  repairEntry("repair-blocked-from-review", "blocked-from-review", 1, {
    facts: ["defect-path", "owner-consumer", "plan-owner-snapshot", "baseline", "original-evidence", "repair-evidence", "reviewed-commit-review-bytes", "review-verdict-reject", "blocked-reason", "attempts-quiescence"],
    record: { defect_path: "src/owner/records.js", baseline_commit: SHA_A, reviewed_commit: SHA_B, review_verdict: "REJECT", review_ref: "reviews/repair-attempt-1.json", review_hash: HASH_C, repair_evidence_ref: "evidence/repair-attempt-1.json", repair_evidence_hash: HASH_C, reason: "review rejected" },
    sidecars: ["plan-owner", "original-evidence", "repair-evidence", "review"],
  }),
];

const mutableCatalog = AUTHORITY_CLASSES.map(([id, name]) => ({
  id,
  name,
  records: RECORDS.filter(({ authorityClassId }) => authorityClassId === id),
}));

assertDurableAuthorityCatalogComplete(mutableCatalog);
export const DURABLE_AUTHORITY_CATALOG = deepFreeze(mutableCatalog);

export const DURABLE_AUTHORITY_EXCLUSIONS = deepFreeze([
  {
    records: ["run.json.debug_snapshot", "run.json.provenance", "run.json.cost_attribution"],
    reason: "Diagnostic records do not authorize workflow decisions and are outside the durable-authority integrity catalog.",
  },
  {
    records: ["heartbeat.json", "run.json.heartbeat_at"],
    reason: "Liveness records report activity only and do not authorize semantic state transitions.",
  },
  {
    records: ["factory.lock", "run-json.lock/owner.json", "process-launch.lock/owner.json"],
    reason: "Lock ownership records are transient coordination mechanisms, not records in this durable semantic-authority catalog.",
  },
  {
    records: ["process.json", "processes/*.log"],
    reason: "Process records and logs are sidecar execution evidence rather than durable semantic workflow authority.",
  },
]);

function terminalResultEntry(id, status, extras, targets = []) {
  return recordEntry({
    authorityClassId: "run-envelope-terminal-result", id, record: "run.json.terminal_result", variant: status,
    writer: status === "completed" ? "transitionPrCreated" : "transitionTerminalResult or transitionPostPrTerminal",
    readers: ["validateRun terminal consistency", "resumeFactory terminal check", "factory status/list/watch terminal readers", "cleanup eligibility readers"],
    source: { status, run_id: "catalog-run", reason: status === "completed" ? null : extras.reason, summary: extras.summary ?? "PR created.", ...extras },
    requiredPath: ["status"], typePath: ["run_id"], targets: [...targets, stale(["status"], "running"), cross(["run_id"], "other-run")],
  });
}

function stepEntry(id, variant, acceptance, inheritedAcceptance) {
  const status = id === "step-running" ? "running" : id === "step-accepted" ? "accepted" : "rejected";
  return recordEntry({
    authorityClassId: "steps-acceptance-inheritance", id, record: "run.json.steps[]", variant,
    writer: "transitionRunStep checked step transition",
    readers: ["validateRun step validation", "workflow dispatch/acceptance routing", "test-verifier and continuation eligibility readers"],
    source: { agent: "spec-writer", status, attempts: 1, artifact_ref: "artifacts/technical-brief.md", review_ref: status === "running" ? null : "reviews/spec-writer.json", acceptance, inherited_acceptance: inheritedAcceptance },
    requiredPath: ["agent"], typePath: ["attempts"], targets: [ref(["artifact_ref"]), stale(["attempts"], 0), cross(["agent"], "security-reviewer")],
  });
}

function sliceEntry(id, variant, extras) {
  return recordEntry({
    authorityClassId: "slices-review-evidence-bindings", id, record: "run.json.slices[]", variant,
    writer: "transitionRunSlice and transitionSliceMerged checked transitions",
    readers: ["validateRun slice validation", "builder-wave dependency scheduler", "transitionSliceMerged", "PR readiness and repair admission readers"],
    source: { id: "backend", stack: "backend", depends_on: ["schema"], branch: "feature--backend", worktree: "/tmp/backend", ...extras },
    requiredPath: ["id"], typePath: ["attempts"], targets: [ref(["worktree"]), stale(["attempts"], 0), cross(["id"], "frontend")],
  });
}

function sidecarRecord(authorityClassId, id, record, variant, writer, readers, refValue, sidecarBytes) {
  return recordEntry({
    authorityClassId, id, record, variant, writer, readers,
    source: { subject: "backend", attempt: 1, ref: refValue, hash: HASH_A, sidecar_bytes: sidecarBytes },
    requiredPath: ["subject"], typePath: ["attempt"], sidecars: [sidecar("sidecar", ["ref"], ["hash"], ["sidecar_bytes"])],
    targets: [...sidecarTargets("sidecar", ["ref"], ["hash"], ["sidecar_bytes"]), stale(["attempt"], 0), cross(["subject"], "other-subject")],
  });
}

function panelEntry(id, record, subject, verdict, reportRef, reviewRef, writer, readers) {
  const source = { subject, attempt: 1, verdict, report_ref: reportRef, review_ref: reviewRef, review_hash: HASH_A, reviewed_commit: SHA_B, sidecar_bytes: { review: `{\"verdict\":\"${verdict}\"}`, report: "panel report" } };
  const sidecars = [sidecar("review", ["review_ref"], ["review_hash"], ["sidecar_bytes", "review"])];
  const targets = [...sidecarTargets("review", ["review_ref"], ["review_hash"], ["sidecar_bytes", "review"]), stale(["attempt"], 0), cross(["subject"], "other-panel")];
  if (reportRef) {
    source.report_hash = HASH_B;
    sidecars.push(sidecar("report", ["report_ref"], ["report_hash"], ["sidecar_bytes", "report"]));
    targets.push(...sidecarTargets("report", ["report_ref"], ["report_hash"], ["sidecar_bytes", "report"]));
  }
  return recordEntry({ authorityClassId: "validator-security-pr-result", id, record, variant: `${verdict} bound`, writer, readers, source, requiredPath: ["verdict"], typePath: ["attempt"], sidecars, targets });
}

function continuationEnvelopeEntry() {
  return recordEntry({
    authorityClassId: "continuation-planning-draft-reuse", id: "continuation-envelope", record: "run.json.continuation", variant: "blocked-run continuation",
    writer: "factory continue checked child-run admission",
    readers: ["validateContinuation", "feature command payload normalization", "continuation workflow routing", "adoptContinuationPlanning"],
    source: { schema_version: 1, kind: "blocked-run-continuation", created_at: NOW, operator_summary: "Continue blocked run." },
    requiredPath: ["kind"], typePath: ["operator_summary"], targets: [schema(["schema_version"]), kind(["kind"], "resume"), time(["created_at"]), stale(["kind"], "existing-run-resume"), cross(["operator_summary"], "other run")],
  });
}

function continuationParentEntry() {
  return recordEntry({
    authorityClassId: "continuation-planning-draft-reuse", id: "continuation-parent-binding", record: "continuation.parent", variant: "blocked parent",
    writer: "factory continue checked parent admission",
    readers: ["validateContinuationParent", "factory continue source revalidation", "adoptContinuationPlanning"],
    source: { run_id: "parent-run", status: "blocked", run_ref: ".opencode/factory/parent-run/run.json", run_hash: HASH_A, branch: "parent", commit: SHA_A, worktree: ".opencode/worktrees/parent", sidecar_bytes: "parent run bytes" },
    requiredPath: ["run_id"], typePath: ["status"], sidecars: [sidecar("parent-run", ["run_ref"], ["run_hash"], ["sidecar_bytes"])],
    targets: [...sidecarTargets("parent-run", ["run_ref"], ["run_hash"], ["sidecar_bytes"]), stale(["commit"], SHA_B), cross(["run_id"], "child-run")],
  });
}

function continuationReviewEntry() {
  return recordEntry({
    authorityClassId: "continuation-planning-draft-reuse", id: "continuation-selected-review", record: "continuation.review", variant: "approved blocking review",
    writer: "factory continue selected-review admission",
    readers: ["validateContinuationReview", "validateContinuationSelectedReview", "continuation remediation decomposition"],
    source: { kind: "validator", ref: "reviews/remediation-review.json", hash: HASH_A, subject: "parent", verdict: "APPROVE", source: "run.validator.review_ref", required_fixes: ["fix"], sidecar_bytes: "approved review" },
    requiredPath: ["kind"], typePath: ["required_fixes"], sidecars: [sidecar("selected-review", ["ref"], ["hash"], ["sidecar_bytes"])],
    targets: [kind(["kind"], "unknown-review"), ...sidecarTargets("selected-review", ["ref"], ["hash"], ["sidecar_bytes"]), stale(["verdict"], "REJECT"), cross(["subject"], "other-branch")],
  });
}

function continuationTargetEntry() {
  return recordEntry({
    authorityClassId: "continuation-planning-draft-reuse", id: "continuation-target-binding", record: "continuation.target", variant: "fresh child target",
    writer: "factory continue checked child target allocation",
    readers: ["validateContinuationTarget", "feature command payload normalization", "child bootstrap and Git/worktree creation"],
    source: { run_id: "child-run", branch: "child", worktree: ".opencode/worktrees/child", base_ref: "main", base_commit: SHA_B },
    requiredPath: ["run_id"], typePath: ["base_commit"], targets: [ref(["worktree"]), stale(["base_commit"], SHA_A), cross(["run_id"], "parent-run")],
  });
}

function continuationContextEntry(id, record, kindValue, refValue) {
  return recordEntry({
    authorityClassId: "continuation-planning-draft-reuse", id, record: `continuation.${record}`, variant: `${kindValue} context binding`,
    writer: "factory continue parent context inventory",
    readers: ["validateContinuationRefHashArray", "feature command payload normalization", "continuation planning/remediation context loader"],
    source: { kind: kindValue, ref: refValue, hash: HASH_A, sidecar_bytes: `${kindValue} bytes` },
    requiredPath: ["kind"], typePath: ["kind"], sidecars: [sidecar(kindValue, ["ref"], ["hash"], ["sidecar_bytes"])],
    targets: [kind(["kind"], "other-kind"), ...sidecarTargets(kindValue, ["ref"], ["hash"], ["sidecar_bytes"]), stale(["hash"], HASH_B), cross(["ref"], `reviews/other-${kindValue}.json`)],
  });
}

function postPrPhaseEntry(phase) {
  const active = !["disabled", "awaiting-pr", "succeeded", "blocked", "needs-human"].includes(phase);
  return recordEntry({
    authorityClassId: "post-pr-nested-records", id: `post-pr-phase-${phase}`, record: "run.json.post_pr.phase", variant: phase,
    writer: phase === "disabled" || phase === "awaiting-pr" ? "createPostPrState policy initialization" : phase === "observing" ? "transitionPrCreated or transitionPostPrState observation transition" : ["blocked", "needs-human", "succeeded"].includes(phase) ? "transitionPostPrTerminal checked terminal transition" : phase === "failure-recording" ? "transitionPostPrFailure checked failure admission" : "transitionPostPrState checked phase transition",
    readers: ["validatePostPr phase/state consistency", "assertPostPrPhaseTransition", "assertPostPrMonotonicState", "post-PR workflow dispatch decision", "transitionPostPrTerminal reason preconditions", "resume and heartbeat eligibility"],
    source: { schema_version: 1, phase, attempt: active ? 1 : 0, run_status: ["blocked", "needs-human"].includes(phase) ? phase : phase === "succeeded" ? "completed" : "running" },
    requiredPath: ["phase"], typePath: ["attempt"], facts: [`phase:${phase}`, `run-status:${["blocked", "needs-human"].includes(phase) ? phase : phase === "succeeded" ? "completed" : "running"}`, `attempt:${active ? 1 : 0}`], targets: [schema(["schema_version"]), stale(["attempt"], active ? 0 : 1), cross(["phase"], phase === "disabled" ? "observing" : "disabled")],
  });
}

function postPrPolicyEntry(id, enabled) {
  return recordEntry({
    authorityClassId: "post-pr-nested-records", id, record: "post_pr.policy", variant: enabled ? "enabled" : "disabled",
    writer: "createPostPrState from effective start-time policy",
    readers: ["validatePostPrPolicy", "transitionPrCreated observation initialization", "all post-PR timing/retry/review decisions", "assertPostPrPhaseTransition immutable policy check"],
    source: { enabled, wait_ms: 3_600_000, initial_poll_ms: 30_000, max_poll_ms: 120_000, check_start_grace_ms: 300_000, max_transient_errors: 12, review: { required: enabled, reviewer_login: enabled ? "reviewer" : null, source: enabled ? "driver" : "none" } },
    requiredPath: ["enabled"], typePath: ["wait_ms"], targets: [stale(["max_transient_errors"], 0), cross(["review", "required"], !enabled), drift(["review"], "reviewer_login", "login")],
  });
}

function postPrNullEntry(id, record, key, phase, writer, readers) {
  return recordEntry({
    authorityClassId: "post-pr-nested-records", id, record, variant: "null",
    writer, readers,
    source: { phase, [key]: null }, requiredPath: [key], typePath: [key], targets: [stale(["phase"], "stale-phase"), cross([key], { from_other_attempt: true })],
  });
}

function postPrObservationEntry() {
  return recordEntry({
    authorityClassId: "post-pr-nested-records", id: "post-pr-observation-active", record: "post_pr.observation", variant: "active non-null epoch",
    writer: "transitionPrCreated initialization and transitionPostPrState observations",
    readers: ["validatePostPrObservation", "assertPostPrMonotonicState", "transitionPostPrFailure source/replay checks", "transitionPostPrTerminal preconditions"],
    source: { epoch: 1, expected_head_sha: SHA_A, started_at: NOW, deadline_at: "2026-07-16T13:00:00.000Z", next_poll_at: NOW, poll_count: 0, unchanged_count: 0, current_interval_ms: 30_000, consecutive_transient_errors: 0, last_observed_at: null, last_fingerprint: null, last_check_verdict: "pending", last_review_verdict: "pending", last_verdict: "pending", last_error: null },
    requiredPath: ["epoch"], typePath: ["poll_count"], targets: [time(["started_at"]), stale(["epoch"], 0), cross(["expected_head_sha"], SHA_B), drift([], "expected_head_sha", "head_sha")],
  });
}

function postPrObservationNestedEntry(kindName) {
  const definitions = {
    "last-error": {
      record: "post_pr.observation.last_error",
      writer: "transitionPostPrState observation error transition",
      readers: ["validatePostPrLastError", "assertPostPrMonotonicState result identity", "transitionPostPrTerminal infrastructure/account preconditions", "post-PR retry scheduler"],
      source: { class: "network", exit_code: 1, occurred_at: NOW, next_retry_at: "2026-07-16T12:01:00.000Z" },
      requiredPath: ["class"], typePath: ["exit_code"], facts: ["error-class:network", "exit-code:1", "occurred-at", "next-retry-at"],
      targets: [time(["occurred_at"]), stale(["next_retry_at"], NOW), cross(["class"], "account-auth")],
    },
    "review-request": {
      record: "post_pr.observation.review_request",
      writer: "transitionPostPrState reviewer-request transition",
      readers: ["validatePostPrReviewRequest", "assertMonotonicReviewerRequest", "post-PR review observation scheduler", "transitionPostPrTerminal review preconditions"],
      source: { status: "requested", attempts: 1, requested_at: NOW },
      requiredPath: ["status"], typePath: ["attempts"], facts: ["request-status:requested", "attempts:1", "requested-at"],
      targets: [time(["requested_at"]), stale(["attempts"], 0), cross(["status"], "pending")],
    },
    snapshot: {
      record: "post_pr.observation.snapshot",
      writer: "transitionPostPrState sanitized observation binding",
      readers: ["validatePostPrSanitizedSnapshot", "observationResultIdentity", "post-PR fingerprint/backoff decision", "terminal metadata safety decision"],
      source: { checks: [{ name: "ci", verdict: "red" }], reviews: [{ login: "reviewer", verdict: "pending" }] },
      requiredPath: ["checks"], typePath: ["reviews"], facts: ["sanitized-check-snapshot", "sanitized-review-snapshot"],
      targets: [drift([], "checks", "check_results"), stale(["checks", 0, "verdict"], "pending"), cross(["reviews", 0, "login"], "other-reviewer")],
    },
  };
  const definition = definitions[kindName];
  return recordEntry({
    authorityClassId: "post-pr-nested-records", id: `post-pr-observation-${kindName}`, record: definition.record, variant: "non-null",
    writer: definition.writer, readers: definition.readers, source: definition.source, requiredPath: definition.requiredPath, typePath: definition.typePath, facts: definition.facts, targets: definition.targets,
  });
}

function postPrRemediationEntry() {
  return recordEntry({
    authorityClassId: "post-pr-nested-records", id: "post-pr-remediation-active", record: "post_pr.remediation", variant: "active non-null attempt",
    writer: "transitionPostPrFailure and transitionPostPrState",
    readers: ["validatePostPrRemediation", "assertPostPrAttemptTransition", "assertPostPrMonotonicState", "post-PR revalidation/push/terminal decisions"],
    source: { schema_version: 1, attempt: 1, reason_code: "check-red", failure_fingerprint: HASH_A, failed_head_sha: SHA_A, failure_evidence_ref: "evidence/post-pr.json", failure_evidence_hash: HASH_B, owner: { kind: "slice", slice_id: "backend" }, route: "backend-builder", lane: "slice", stage: "planned", baseline_head_sha: SHA_A, sidecar_bytes: "failure evidence" },
    requiredPath: ["attempt"], typePath: ["owner"], sidecars: [sidecar("failure-evidence", ["failure_evidence_ref"], ["failure_evidence_hash"], ["sidecar_bytes"])],
    targets: [schema(["schema_version"]), ...sidecarTargets("failure-evidence", ["failure_evidence_ref"], ["failure_evidence_hash"], ["sidecar_bytes"]), kind(["owner", "kind"], "other-owner"), stale(["attempt"], 0), cross(["owner", "slice_id"], "frontend")],
  });
}

function postPrRemediationNestedEntry(kindName) {
  const definitions = {
    owner: {
      record: "post_pr.remediation.owner", writer: "transitionPostPrFailure owner attribution",
      readers: ["validatePostPrOwner", "post-PR route/lane dispatch decision", "assertPostPrMonotonicState owner immutability", "panel attribution and terminal owner safety decisions"],
      source: { kind: "slice", slice_id: "backend", stack: "backend", path_b64url: null, method: "check-slice-id" }, requiredPath: ["kind"], typePath: ["slice_id"], facts: ["owner-kind:slice", "slice-id:backend", "stack:backend", "method:check-slice-id"], targets: [kind(["kind"], "integration"), stale(["slice_id"], "stale-slice"), cross(["stack"], "frontend")],
    },
    changes: {
      record: "post_pr.remediation.changes", writer: "transitionPostPrState observed changes transition",
      readers: ["validatePostPrChanges", "assertPostPrMonotonicState changes immutability", "post-PR lane ownership decision", "assertPostPrCandidateGitState", "terminal path-lane fact validation"],
      source: { paths: ["src/backend.js"], entries: [], tree_hash: HASH_A }, requiredPath: ["paths"], typePath: ["entries"], facts: ["paths:src/backend.js", "entries:empty", "tree-hash"], targets: [hash(["tree_hash"]), drift([], "paths", "changed_paths"), stale(["tree_hash"], HASH_B), cross(["paths", 0], "src/frontend.js")],
    },
    "change-entry": {
      record: "post_pr.remediation.changes.entries[]", writer: "transitionPostPrState Git-observed change entry binding",
      readers: ["validatePostPrChangeEntry", "post-PR safe change-kind decision", "owner lane/path validation", "candidate Git state and terminal path-lane fact readers"],
      source: { source: "commit", status: "modified", index_status: null, worktree_status: null, path: "src/backend.js", previous_path: null, old_mode: "100644", new_mode: "100644" }, requiredPath: ["path"], typePath: ["status"], facts: ["source:commit", "status:modified", "path:src/backend.js", "mode:100644"], targets: [ref(["path"], undefined, "changed path"), drift([], "previous_path", "old_path"), stale(["old_mode"], "120000"), cross(["path"], "src/frontend.js")],
    },
  };
  const definition = definitions[kindName];
  return recordEntry({
    authorityClassId: "post-pr-nested-records", id: `post-pr-remediation-${kindName}`, record: definition.record, variant: "bound",
    writer: definition.writer, readers: definition.readers, source: definition.source, requiredPath: definition.requiredPath, typePath: definition.typePath, facts: definition.facts, targets: definition.targets,
  });
}

function postPrDispatchEntry(id, variant, startedAt, returnedAt) {
  return recordEntry({
    authorityClassId: "post-pr-nested-records", id, record: "post_pr.remediation.dispatch", variant,
    writer: "transitionPostPrState dispatch phase transition",
    readers: ["validatePostPrDispatch", "assertPostPrMonotonicState", "transitionPostPrTerminal dispatch-start reconciliation"],
    source: { id: "dispatch-1", status: variant, role: "backend-builder", subject: "backend", started_at: startedAt, returned_at: returnedAt },
    requiredPath: ["id"], typePath: ["status"], facts: [`dispatch-status:${variant}`, "dispatch-id:dispatch-1", "role:backend-builder", "subject:backend", `started-at:${startedAt === null ? "null" : "bound"}`, `returned-at:${returnedAt === null ? "null" : "bound"}`], targets: [time([variant === "returned" ? "returned_at" : "started_at"], "not-started"), stale(["status"], variant === "planned" ? "running" : "planned"), cross(["subject"], "other-slice")],
  });
}

function postPrRevalidationEntry(id, bound) {
  const source = bound
    ? { canonical_evidence_ref: "evidence/canonical.json", canonical_evidence_hash: HASH_A, canonical_verdict: "pass", validator_review_ref: "reviews/validator.json", validator_review_hash: HASH_B, validator_verdict: "GO", security_review_ref: "reviews/security.json", security_review_hash: HASH_C, security_verdict: "PASS", sidecar_bytes: { canonical: "pass", validator: "go", security: "pass" } }
    : { canonical_evidence_ref: null, canonical_evidence_hash: null, canonical_verdict: null, validator_review_ref: null, validator_review_hash: null, validator_verdict: null, security_review_ref: null, security_review_hash: null, security_verdict: null };
  const sidecars = bound ? [sidecar("canonical", ["canonical_evidence_ref"], ["canonical_evidence_hash"], ["sidecar_bytes", "canonical"]), sidecar("validator", ["validator_review_ref"], ["validator_review_hash"], ["sidecar_bytes", "validator"]), sidecar("security", ["security_review_ref"], ["security_review_hash"], ["sidecar_bytes", "security"])] : [];
  const targets = bound ? [...sidecarTargets("canonical", ["canonical_evidence_ref"], ["canonical_evidence_hash"], ["sidecar_bytes", "canonical"]), ...sidecarTargets("validator", ["validator_review_ref"], ["validator_review_hash"], ["sidecar_bytes", "validator"]), ...sidecarTargets("security", ["security_review_ref"], ["security_review_hash"], ["sidecar_bytes", "security"]), stale(["canonical_verdict"], "fail"), cross(["security_verdict"], "BLOCK")] : [stale(["canonical_verdict"], "pass"), cross(["validator_verdict"], "GO")];
  return recordEntry({
    authorityClassId: "post-pr-nested-records", id, record: "post_pr.remediation.revalidation", variant: bound ? "bound panel results" : "empty/unbound",
    writer: "transitionPostPrState revalidation transition",
    readers: ["validatePostPrRevalidation", "assertPostPrMonotonicState once-bound checks", "post-PR validated/push admission", "transitionPostPrTerminal panel-failure decisions"],
    source, requiredPath: ["canonical_verdict"], typePath: ["validator_verdict"], sidecars, targets,
  });
}

function postPrJobEntry(activity, state) {
  const bound = state === "bound";
  const source = { dispatch_id: `${activity}-dispatch-1`, status: state, action_token: state === "planned" ? null : `${activity}-token`, steering_generation: 2, started_at: state === "planned" ? null : NOW, returned_at: bound ? "2026-07-16T12:05:00.000Z" : null, result_ref: bound ? `${activity === "canonical" ? "evidence" : "reviews"}/post-pr-${activity}.json` : null, result_hash: bound ? HASH_A : null, verdict: bound ? (activity === "canonical" ? "pass" : activity === "validator" ? "GO" : "PASS") : null, transient_error_count: state === "retry-wait" ? 1 : 0, next_retry_at: state === "retry-wait" ? "2026-07-16T12:06:00.000Z" : null, last_error: state === "retry-wait" ? "network" : null, sidecar_bytes: bound ? `${activity} result bytes` : null };
  const resultSidecars = bound ? [sidecar(`${activity}-result`, ["result_ref"], ["result_hash"], ["sidecar_bytes"])] : [];
  const targets = bound ? [...sidecarTargets(`${activity}-result`, ["result_ref"], ["result_hash"], ["sidecar_bytes"]), stale(["verdict"], activity === "canonical" ? "red" : activity === "validator" ? "NO-GO" : "BLOCK"), cross(["dispatch_id"], "other-dispatch")] : [time([state === "retry-wait" ? "next_retry_at" : "started_at"]), stale(["steering_generation"], 1), cross(["dispatch_id"], "other-dispatch")];
  return recordEntry({
    authorityClassId: "post-pr-nested-records", id: `post-pr-${activity}-job-${state}`, record: `post_pr.remediation.revalidation.jobs.${activity}`, variant: state,
    writer: "transitionPostPrState revalidation job transition",
    readers: ["validatePostPrJob", "assertPostPrJobMonotonic", "post-PR revalidation dispatch/retry scheduler", "validated-state admission", "transitionPostPrTerminal dispatch/panel fact checks"],
    source, requiredPath: ["dispatch_id"], typePath: ["status"], sidecars: resultSidecars, facts: [`activity:${activity}`, `job-status:${state}`, `dispatch-id:${activity}-dispatch-1`, `result:${bound ? "bound" : "null"}`, `retry-count:${state === "retry-wait" ? 1 : 0}`], targets,
  });
}

function postPrPushEntry(id, status, localHead, remoteAfter) {
  return recordEntry({
    authorityClassId: "post-pr-nested-records", id, record: "post_pr.remediation.push", variant: status,
    writer: "transitionPostPrState checked push transition",
    readers: ["validatePostPrPush", "assertPostPrMonotonicState", "transitionPostPrTerminal push reconciliation", "remote-confirmed observation restart"],
    source: { status, remote_before_sha: SHA_A, local_head_sha: localHead, remote_after_sha: remoteAfter, consecutive_transient_errors: 0, next_retry_at: null, pushed_at: status === "confirmed" ? NOW : null },
    requiredPath: ["status"], typePath: ["consecutive_transient_errors"], targets: [time(["pushed_at"], "not-time"), stale(["remote_before_sha"], SHA_C), cross(["local_head_sha"], SHA_C)],
  });
}

function postPrPushLastErrorEntry() {
  return recordEntry({
    authorityClassId: "post-pr-nested-records", id: "post-pr-push-last-error", record: "post_pr.remediation.push.last_error", variant: "retryable network failure",
    writer: "transitionPostPrState checked push error transition",
    readers: ["validatePostPrPush last_error validation", "assertPostPrMonotonicState push retry checks", "post-PR push retry scheduler", "transitionPostPrTerminal push/account failure fact checks"],
    source: { operation: "fast-forward-push", observed_at: NOW, error_class: "network", exit_code: 1, classification: "transient", error_count: 1, error_limit: 12, expected_remote_sha: SHA_A, candidate_head_sha: SHA_B, next_retry_at: "2026-07-16T12:01:00.000Z" },
    requiredPath: ["operation"], typePath: ["exit_code"], facts: ["operation:fast-forward-push", "error-class:network", "classification:transient", "exit-code:1", "error-count:1", "error-limit:12", "expected-remote", "candidate-head", "observed-at", "next-retry-at"], targets: [time(["observed_at"]), stale(["next_retry_at"], NOW), cross(["candidate_head_sha"], SHA_C)],
  });
}

function postPrContinuationReviewEntry() {
  return recordEntry({
    authorityClassId: "post-pr-nested-records", id: "post-pr-continuation-review-bound", record: "post_pr.continuation_review", variant: "retry-exhaustion ref/hash bound",
    writer: "bindPostPrContinuationReview inside transitionPostPrTerminal",
    readers: ["validatePostPr retry-exhaustion consistency", "factory continue post-PR admission", "post-PR terminal audit readers"],
    source: { ref: "reviews/post-pr-continuation.json", hash: HASH_A, sidecar_bytes: "blocked review" },
    requiredPath: ["ref"], typePath: ["hash"], sidecars: [sidecar("continuation-review", ["ref"], ["hash"], ["sidecar_bytes"])],
    targets: [...sidecarTargets("continuation-review", ["ref"], ["hash"], ["sidecar_bytes"]), stale(["hash"], HASH_B), cross(["ref"], "reviews/other-run.json")],
  });
}

function postPrTerminalFactEntry(factVariant) {
  const definitions = {
    "account-switch-failed-github-auth": { kind: "account-switch-failed", source: { operation: "gh-auth-switch", github_account: "acme", error_class: "account-auth", exit_code: 1 }, facts: ["kind:account-switch-failed", "form:github-auth", "operation:gh-auth-switch", "github-account:acme", "error-class:account-auth", "exit-code:1"], crossPath: ["github_account"], crossValue: "other-account" },
    "account-switch-failed-push": { kind: "account-switch-failed", source: { attempt: 1, operation: "fast-forward-push", error_class: "permission", exit_code: 1, classification: "permanent", error_count: 1, error_limit: 12, expected_remote_sha: SHA_A, candidate_head_sha: SHA_B, next_retry_at: null }, facts: ["kind:account-switch-failed", "form:push", "operation:fast-forward-push", "attempt:1", "expected-remote", "candidate-head", "classification:permanent"], crossPath: ["candidate_head_sha"], crossValue: SHA_C },
    "dispatch-start-unknown": { kind: "dispatch-start-unknown", source: { attempt: 1, activity: "validator", dispatch_id: "validator-dispatch-1", dispatch_started_at: NOW, candidate_head_sha: SHA_B, outcome: "return-unknown" }, facts: ["kind:dispatch-start-unknown", "attempt:1", "activity:validator", "dispatch-id:validator-dispatch-1", "dispatch-started-at", "candidate-head", "outcome:return-unknown"], crossPath: ["dispatch_id"], crossValue: "other-dispatch" },
    "path-lane-violation": { kind: "path-lane-violation", source: { attempt: 1, lane: "slice", source: "remediation-diff", violation: "outside-lane", path_b64url: "c3JjL290aGVyLmpz", changes_hash: HASH_A }, facts: ["kind:path-lane-violation", "attempt:1", "lane:slice", "violation:outside-lane", "path-b64url", "changes-hash"], crossPath: ["lane"], crossValue: "test" },
    "remote-head-diverged": { kind: "remote-head-diverged", source: { attempt: 1, expected_remote_sha: SHA_A, candidate_head_sha: SHA_B, observed_remote_sha: SHA_C }, facts: ["kind:remote-head-diverged", "attempt:1", "expected-remote", "candidate-head", "observed-remote"], crossPath: ["candidate_head_sha"], crossValue: SHA_C },
    "panel-runner-result-malformed": { kind: "panel-runner-result-malformed", source: { attempt: 1, activity: "security", dispatch_id: "security-dispatch-1", candidate_head_sha: SHA_B, issue: "missing-verdict" }, facts: ["kind:panel-runner-result-malformed", "attempt:1", "activity:security", "dispatch-id:security-dispatch-1", "issue:missing-verdict"], crossPath: ["dispatch_id"], crossValue: "other-dispatch" },
    "push-failed": { kind: "push-failed", source: { attempt: 1, operation: "fast-forward-push", error_class: "network", exit_code: 1, classification: "exhausted", error_count: 12, error_limit: 12, expected_remote_sha: SHA_A, candidate_head_sha: SHA_B, next_retry_at: null }, facts: ["kind:push-failed", "attempt:1", "operation:fast-forward-push", "classification:exhausted", "error-count:12", "error-limit:12"], crossPath: ["candidate_head_sha"], crossValue: SHA_C },
    "panel-attribution-unsafe": { kind: "panel-attribution-unsafe", source: { attempt: 1, candidate_head_sha: SHA_B, panel: "combined", category: "mixed-owner", affected_paths_hash: "a".repeat(64) }, facts: ["kind:panel-attribution-unsafe", "attempt:1", "candidate-head", "panel:combined", "category:mixed-owner", "affected-paths-hash"], crossPath: ["panel"], crossValue: "validator" },
  };
  const definition = definitions[factVariant];
  return recordEntry({
    authorityClassId: "post-pr-nested-records", id: `post-pr-terminal-fact-${factVariant}`, record: "post_pr.terminal_fact", variant: factVariant,
    writer: "normalizedPostPrTerminalFact inside transitionPostPrTerminal",
    readers: ["validatePostPrTerminalFact kind-specific validation", "transitionPostPrTerminal fact/reason preconditions", "terminal idempotent replay", "terminal diagnostics/audit readers"],
    source: { schema_version: 1, kind: definition.kind, observed_at: NOW, ...definition.source },
    requiredPath: ["kind"], typePath: Object.hasOwn(definition.source, "attempt") ? ["attempt"] : ["exit_code"], facts: definition.facts, targets: [schema(["schema_version"]), kind(["kind"], "other-fact"), time(["observed_at"]), stale(Object.hasOwn(definition.source, "attempt") ? ["attempt"] : ["exit_code"], 0), cross(definition.crossPath, definition.crossValue)],
  });
}

function repairEntry(id, status, attempts, options) {
  const source = {
    schema_version: 1,
    plan_ref: "plan/slices.json",
    plan_hash: HASH_A,
    owner_slice_id: "owner",
    consumer_slice_id: "consumer",
    owner_snapshot: { paths: ["src/owner/**"], depends_on: [] },
    evidence_ref: "evidence/consumer-fail.json",
    evidence_hash: HASH_B,
    status,
    attempts,
    max_attempts: 2,
    quiescent: true,
    created_at: NOW,
    updated_at: NOW,
    sidecar_bytes: {
      "plan-owner": "owner plan bytes",
      "original-evidence": "failing reproduction",
      "repair-evidence": "changed paths",
      review: "approving review",
      verification: "passing reproduction",
    },
    ...options.record,
  };
  const definitions = {
    "plan-owner": sidecar("plan-owner", ["plan_ref"], ["plan_hash"], ["sidecar_bytes", "plan-owner"]),
    "original-evidence": sidecar("original-evidence", ["evidence_ref"], ["evidence_hash"], ["sidecar_bytes", "original-evidence"]),
    "repair-evidence": sidecar("repair-evidence", ["repair_evidence_ref"], ["repair_evidence_hash"], ["sidecar_bytes", "repair-evidence"]),
    review: sidecar("review", ["review_ref"], ["review_hash"], ["sidecar_bytes", "review"]),
    verification: sidecar("verification", ["verification_ref"], ["verification_hash"], ["sidecar_bytes", "verification"]),
  };
  const sidecars = options.sidecars.map((name) => definitions[name]);
  const targets = sidecars.flatMap((binding) => sidecarTargets(binding.name, binding.refPath, binding.hashPath, binding.bytesPath));
  targets.push(schema(["schema_version"]), time(["updated_at"]), ref(["defect_path"], undefined, "defect path"), stale(["attempts"], attempts === 0 ? 1 : attempts - 1), cross(["consumer_slice_id"], "owner"), drift(["owner_snapshot"], "paths", "owner_paths"));
  if (source.baseline_commit) targets.push(stale(["baseline_commit"], SHA_C));
  if (source.reviewed_commit) targets.push(cross(["reviewed_commit"], SHA_C));
  if (source.merge_commit) targets.push(stale(["merge_commit"], SHA_B), cross(["merge_tree"], HASH_C));
  return recordEntry({
    authorityClassId: "pr79-merged-slice-repair", id, record: "run.json.merged_slice_repair", variant: status,
    writer: `transitionMergedSliceRepair ${status} transition`,
    readers: ["validateMergedSliceRepair", "transitionMergedSliceRepair next-state checks", "mergedSliceRepairFence and resume eligibility", "slice/step/panel/gate/PR lifecycle fences"],
    source, requiredPath: ["status"], typePath: ["quiescent"], sidecars, facts: options.facts, targets,
  });
}

function recordEntry({ authorityClassId, id, record, variant, writer, readers, source, requiredPath, typePath, targets = [], sidecars = [], facts = [] }) {
  const commonTargets = [
    target("missing-key", requiredPath, "required field"),
    target("unknown-key", [], "record root", { key: "unexpected_authority_key", value: true }),
    target("wrong-type", typePath, "typed field"),
  ];
  return {
    authorityClassId,
    id,
    record,
    variant,
    writer,
    readers,
    tests: [`test/durable-record-mutations.test.js: ${id} mutation matrix`],
    sidecars,
    facts,
    source,
    descriptor: completeDescriptor(id, [...commonTargets, ...targets], explicitExclusionsFor(id)),
  };
}

function completeDescriptor(record, targets, exclusions = {}) {
  const targeted = new Set(targets.map(({ family }) => family));
  for (const family of DURABLE_MUTATION_FAMILIES) {
    const excluded = Object.hasOwn(exclusions, family);
    if (targeted.has(family) === excluded) throw new TypeError(`${record}.${family} must have exactly one explicitly authored target or exclusion`);
  }
  return { record, targets, exclusions: { ...exclusions } };
}

function explicitExclusionsFor(record) {
  const codes = EXPLICIT_EXCLUDED_FAMILY_CODES[record];
  if (typeof codes !== "string") throw new TypeError(`${record} must have an explicitly authored family disposition`);
  const exclusions = {};
  for (const code of codes) {
    const family = FAMILY_BY_CODE[code];
    if (!family || Object.hasOwn(exclusions, family)) throw new TypeError(`${record} has an invalid explicit family disposition code`);
    exclusions[family] = `${record}: ${family} is explicitly inapplicable because this record variant has no corresponding authoritative field or bound sidecar.`;
  }
  return exclusions;
}

function metadataHash(record) {
  const exactMetadata = {
    writer: record.writer,
    readers: record.readers,
    tests: record.tests,
    facts: record.facts,
    sidecars: record.sidecars,
  };
  return createHash("sha256").update(JSON.stringify(exactMetadata)).digest("hex");
}

function validateExpectedDescriptorDispositions(record, path) {
  const expectedExcludedFamilies = new Set([...EXPLICIT_EXCLUDED_FAMILY_CODES[record.id]].map((code) => FAMILY_BY_CODE[code]));
  for (const family of DURABLE_MUTATION_FAMILIES) {
    const targetCount = record.descriptor.targets.filter((mutationTarget) => mutationTarget.family === family).length;
    const hasExclusion = Object.hasOwn(record.descriptor.exclusions, family);
    const expectedExclusion = expectedExcludedFamilies.has(family);
    if (expectedExclusion ? targetCount !== 0 || !hasExclusion : targetCount === 0 || hasExclusion) {
      throw new TypeError(`${path}.${family} target-or-exclusion disposition must exactly match the independent family disposition registry`);
    }
  }
}

function descriptorHash(descriptor) {
  return createHash("sha256")
    .update(canonicalJson({ targets: descriptor.targets, exclusions: descriptor.exclusions }))
    .digest("hex");
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function validateRecordSidecars(record, path) {
  if (!Array.isArray(record.sidecars)) throw new TypeError(`${path}.sidecars must be an array`);
  for (const binding of record.sidecars) {
    requireText(binding.name, `${path}.sidecars.name`);
    requireTextArray(binding.requiredFamilies, `${path}.sidecars.${binding.name}.requiredFamilies`);
    for (const family of binding.requiredFamilies) {
      if (!record.descriptor.targets.some((mutationTarget) => mutationTarget.family === family && mutationTarget.sidecar === binding.name)) {
        throw new TypeError(`${path} sidecar ${binding.name} must target ${family} independently`);
      }
    }
  }
}

function sidecar(name, refPath, hashPath, bytesPath) {
  return {
    name,
    refPath,
    hashPath,
    bytesPath,
    requiredFamilies: [refPath === null ? null : "wrong-ref", hashPath === null ? null : "wrong-hash", "wrong-bytes"].filter(Boolean),
  };
}

function sidecarTargets(name, refPath, hashPath, bytesPath) {
  return [
    ...(refPath === null ? [] : [ref(refPath, name)]),
    ...(hashPath === null ? [] : [hash(hashPath, name)]),
    bytes(bytesPath, name),
  ];
}

function target(family, path, label, options = {}) {
  return { family, path, ...(label === undefined ? {} : { label }), ...options };
}

function schema(path) { return target("wrong-schema", path, "schema version", { value: 2 }); }
function kind(path, value = "unknown-kind", label = "kind") { return target("wrong-kind", path, label, { value }); }
function time(path, value = "not-an-iso-time") { return target("wrong-time", path, `timestamp ${renderPath(path)}`, { value }); }
function ref(path, sidecarName, label = `ref ${renderPath(path)}`) { return target("wrong-ref", path, sidecarName ? `${sidecarName} ref` : label, { value: "../outside.json", ...(sidecarName ? { sidecar: sidecarName } : {}) }); }
function hash(path, sidecarName) { return target("wrong-hash", path, sidecarName ? `${sidecarName} hash` : `hash ${renderPath(path)}`, { value: "sha256:short", ...(sidecarName ? { sidecar: sidecarName } : {}) }); }
function bytes(path, sidecarName) { return target("wrong-bytes", path, `${sidecarName} sidecar bytes`, { value: "tampered-sidecar-bytes", sidecar: sidecarName }); }
function drift(path, from, to) { return target("descriptor-key-shape-drift", path, `${from} renamed`, { from, to }); }
function stale(path, value) { return target("stale-identity", path, `stale ${renderPath(path)}`, { value }); }
function cross(path, value, label = `cross-bound ${renderPath(path)}`) { return target("cross-bound-identity", path, label, { value }); }

function applyMutation(record, family, mutationTarget) {
  if (family === "unknown-key") {
    const container = valueAt(record, mutationTarget.path, family);
    requireRecord(container, `${family} target`);
    const key = requireText(mutationTarget.key, `${family}.key`);
    if (Object.hasOwn(container, key)) throw new TypeError(`${family}.key must be absent from the source`);
    container[key] = cloneTargetValue(mutationTarget, true);
    return;
  }

  if (family === "descriptor-key-shape-drift") {
    const container = valueAt(record, mutationTarget.path, family);
    requireRecord(container, `${family} target`);
    const from = requireText(mutationTarget.from, `${family}.from`);
    const to = requireText(mutationTarget.to, `${family}.to`);
    if (!Object.hasOwn(container, from) || Object.hasOwn(container, to)) throw new TypeError(`${family} requires an existing from key and absent to key`);
    container[to] = container[from];
    delete container[from];
    return;
  }

  const { container, key } = parentAt(record, mutationTarget.path, family);
  if (family === "missing-key") {
    delete container[key];
    return;
  }

  const current = container[key];
  const replacement = Object.hasOwn(mutationTarget, "value")
    ? structuredClone(mutationTarget.value)
    : defaultReplacement(family, current);
  if (Object.is(current, replacement)) throw new TypeError(`${family} replacement must differ from the source value`);
  container[key] = replacement;
}

function cloneTargetValue(mutationTarget, fallback) {
  return structuredClone(Object.hasOwn(mutationTarget, "value") ? mutationTarget.value : fallback);
}

function defaultReplacement(family, current) {
  if (family === "wrong-schema") return current === 1 ? 2 : 1;
  if (family === "wrong-kind") return "unknown-kind";
  if (family === "wrong-time") return "not-an-iso-time";
  if (family === "wrong-ref") return "../outside.json";
  if (family === "wrong-hash") return "sha256:short";
  if (family === "wrong-bytes") return typeof current === "string" ? `${current}-tampered` : "tampered-bytes";
  if (family === "stale-identity") return typeof current === "number" ? current - 1 : `stale-${String(current)}`;
  if (family === "cross-bound-identity") return typeof current === "number" ? current + 1 : "other-boundary";
  if (family === "wrong-type") {
    if (Array.isArray(current)) return {};
    if (current !== null && typeof current === "object") return [];
    if (typeof current === "string") return 1;
    if (typeof current === "number") return "not-a-number";
    if (typeof current === "boolean") return "not-a-boolean";
    if (current === null) return {};
    return null;
  }
  throw new TypeError(`no mutation implementation for ${family}`);
}

function parentAt(root, path, label) {
  if (path.length === 0) throw new TypeError(`${label} requires a non-root value path`);
  const container = valueAt(root, path.slice(0, -1), label);
  const key = path.at(-1);
  if ((container === null || typeof container !== "object") || !Object.hasOwn(container, key)) {
    throw new TypeError(`${label} path ${renderPath(path)} does not resolve to an own property`);
  }
  return { container, key };
}

function valueAt(root, path, label) {
  let value = root;
  for (const key of path) {
    if ((value === null || typeof value !== "object") || !Object.hasOwn(value, key)) {
      throw new TypeError(`${label} path ${renderPath(path)} does not resolve`);
    }
    value = value[key];
  }
  return value;
}

function requirePath(path, label) {
  if (!Array.isArray(path)) throw new TypeError(`${label} must be an array`);
  for (const segment of path) {
    if (!(typeof segment === "string" && segment.length > 0) && !(Number.isInteger(segment) && segment >= 0)) {
      throw new TypeError(`${label} contains an invalid segment`);
    }
  }
}

function requireTextArray(value, label) {
  if (!Array.isArray(value) || value.length === 0) throw new TypeError(`${label} must be a non-empty array`);
  for (const [index, item] of value.entries()) requireText(item, `${label}[${index}]`);
}

function renderPath(path) {
  return path.length === 0 ? "<root>" : path.map(String).join(".");
}

function requireRecord(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${label} must be a record`);
  return value;
}

function requireText(value, label) {
  if (typeof value !== "string" || value.trim().length === 0) throw new TypeError(`${label} must be a non-empty string`);
  return value;
}

function sameList(actual, expected) {
  return actual.length === expected.length && actual.every((value, index) => value === expected[index]);
}

function deepFreeze(value) {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}
