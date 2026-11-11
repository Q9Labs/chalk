import { useMemo, useState } from "react";

/**
 * Who raised a hand first. The client only says whether a hand is up, so this remembers the order
 * in which a list saw hands go up; a hand already up when someone appears counts from that moment.
 */
export function nextHandOrder(previous: readonly string[], raised: readonly string[]): readonly string[] {
  const kept = previous.filter((id) => raised.includes(id));
  const added = raised.filter((id) => !kept.includes(id));
  return added.length === 0 && kept.length === previous.length ? previous : [...kept, ...added];
}

/** Each raised hand's place in the queue, counting from 1, for the ids in `raised`. */
export function useHandOrder(raised: readonly string[]): ReadonlyMap<string, number> {
  const [order, setOrder] = useState<readonly string[]>([]);
  const next = nextHandOrder(order, raised);
  if (next !== order) setOrder(next);
  return useMemo(() => new Map(next.map((id, index) => [id, index + 1])), [next]);
}
