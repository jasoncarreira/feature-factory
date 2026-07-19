import { createHash } from "node:crypto";

const RECEIPT_PATTERN = /^evidence\/verification-artifact-[A-Za-z0-9_-]{43}-[A-Za-z0-9_-]{43}\.attempt-[1-9][0-9]*\.json$/u;
const LEGACY_RECEIPT_PATTERN = /^evidence\/[A-Za-z0-9][A-Za-z0-9_.-]*\.json$/u;

export function verificationArtifactExecutionReceiptRef(sliceId, artifactId, attempt) {
  if (typeof sliceId !== "string" || sliceId.length === 0) throw new Error("verification artifact slice id is invalid");
  if (typeof artifactId !== "string" || artifactId.length === 0) throw new Error("verification artifact id is invalid");
  if (!Number.isInteger(attempt) || attempt < 1) throw new Error("verification artifact attempt is invalid");
  return `evidence/verification-artifact-${utf8Identity(sliceId)}-${utf8Identity(artifactId)}.attempt-${attempt}.json`;
}

export function verificationArtifactExecutionClaimRef(receiptRef) {
  if (typeof receiptRef !== "string" || !RECEIPT_PATTERN.test(receiptRef) && !LEGACY_RECEIPT_PATTERN.test(receiptRef)) {
    throw new Error("checked verification artifact receipt ref is invalid");
  }
  return `${receiptRef.slice(0, -5)}.claim.json`;
}

function utf8Identity(value) {
  return createHash("sha256").update(Buffer.from(value, "utf8")).digest("base64url");
}
