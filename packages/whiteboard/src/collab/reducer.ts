import { compareElementOrder } from "./order";
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
