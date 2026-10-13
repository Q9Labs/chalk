import type { WhiteboardWireElement } from "./wire";

export function mergeWhiteboardElements(current: readonly WhiteboardWireElement[], incoming: readonly WhiteboardWireElement[]): readonly WhiteboardWireElement[] {
  const merged = new Map(current.map((element) => [element.id, element]));

  for (const candidate of incoming) {
    const existing = merged.get(candidate.id);
    if (!existing || wins(candidate, existing)) {
      merged.set(candidate.id, candidate);
    }
  }

  return [...merged.values()].sort(compareElementOrder);
}

function wins(candidate: WhiteboardWireElement, existing: WhiteboardWireElement): boolean {
  if (candidate.version !== existing.version) return candidate.version > existing.version;
  return candidate.version_nonce < existing.version_nonce;
}

// Order keys compare as plain strings, code unit by code unit: "aZ" comes before "aa". A locale puts "aa" first.
function compareElementOrder(left: WhiteboardWireElement, right: WhiteboardWireElement): number {
  if (left.index !== right.index) return left.index < right.index ? -1 : 1;
  if (left.id === right.id) return 0;
  return left.id < right.id ? -1 : 1;
}
