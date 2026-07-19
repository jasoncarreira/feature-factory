import { validateAdmissionExtensionResult, validateDeliveryEnvelope } from "./extensions.js";

export function evaluateDeliveryEnvelopeAdmission({ plan } = {}) {
  if (plan?.delivery_envelope !== undefined) validateDeliveryEnvelope(plan.delivery_envelope, plan.slices);
  return validateAdmissionExtensionResult({
    schema_version: 1,
    extension: "delivery-envelope-admission",
    status: "inactive",
    grants_b4_authority: false,
    reason: "b4-admission-policy-inactive",
  });
}
