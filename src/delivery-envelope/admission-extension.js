import { DeliveryContractValidationError, validateAdmissionExtensionResult } from "./extensions.js";
import { evaluateDeliveryEnvelopeAdmissionPolicy } from "./admission-policy.js";

export function evaluateDeliveryEnvelopeAdmission({ plan } = {}) {
  if (plan?.integration_gate === undefined) {
    throw new DeliveryContractValidationError([{ path: "plan.integration_gate", message: "is required" }]);
  }

  const policy = evaluateDeliveryEnvelopeAdmissionPolicy({ plan });
  return validateAdmissionExtensionResult({
    schema_version: 1,
    extension: "delivery-envelope-admission",
    status: "active",
    grants_b4_authority: policy.decision === "admit",
    decision: policy.decision,
    reasons: policy.reasons,
  });
}
