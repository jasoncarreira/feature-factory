import { validateAdmissionExtensionResult, validateDeliveryEnvelope } from "./extensions.js";
import { evaluateDeliveryEnvelopeAdmissionPolicy } from "./admission-policy.js";

export function evaluateDeliveryEnvelopeAdmission({ plan } = {}) {
  if (plan?.integration_gate === undefined) {
    if (plan?.delivery_envelope !== undefined) validateDeliveryEnvelope(plan.delivery_envelope, plan.slices);
    return validateAdmissionExtensionResult({
      schema_version: 1,
      extension: "delivery-envelope-admission",
      status: "inactive",
      grants_b4_authority: false,
      reason: "b4-admission-policy-inactive",
    });
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
