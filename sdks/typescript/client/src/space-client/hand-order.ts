/**
 * Who raised a hand first. The client only says whether a hand is up, so this remembers the order
 * in which a list saw hands go up; a hand already up when someone appears counts from that moment.
 * Returns `previous` itself when nothing changed.
 */
export function nextHandOrder(previous: readonly string[], raised: readonly string[]): readonly string[] {
  const kept = previous.filter((id) => raised.includes(id));
  const added = raised.filter((id) => !kept.includes(id));
  return added.length === 0 && kept.length === previous.length ? previous : [...kept, ...added];
}
