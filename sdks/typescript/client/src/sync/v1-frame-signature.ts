import { canonicalJsonBytesFromUnknown } from "./canonical";

export function frameSignature(frame: unknown): string {
  return new TextDecoder().decode(canonicalJsonBytesFromUnknown(frame));
}

export function rememberBoundedEvidence(evidence: Map<number, string>, sequence: number, signature: string, capacity: number): void {
  evidence.set(sequence, signature);
  if (evidence.size <= capacity) return;
  const oldest = evidence.keys().next().value;
  if (oldest !== undefined) evidence.delete(oldest);
}
