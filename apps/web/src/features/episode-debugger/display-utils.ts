import { SAFE_ID_CLASSES, type SafeIdentifier } from "@q9labsai/diagnostics-contracts";

export function safeIdentifierDisplay(identifier: SafeIdentifier): string {
  const rule = SAFE_ID_CLASSES[identifier.idClass as keyof typeof SAFE_ID_CLASSES];
  if (rule?.storage === "raw" && identifier.value) return identifier.value;
  if (rule?.storage === "hmac") return "unknown: opaque identifier omitted";
  return `unknown: ${(identifier.unknownReason ?? "not_retained").replaceAll("_", " ")}`;
}

export function participantIdentityDisplay(identity: Readonly<{ value?: string; unknownReason?: string }>): string {
  if (identity.value) return "unknown: raw identity omitted";
  return `unknown: ${(identity.unknownReason ?? "not_retained").replaceAll("_", " ")}`;
}

export function safeReferenceLabel(value: unknown): string {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return "unknown";
  return safeIdentifierDisplay(value as SafeIdentifier);
}
