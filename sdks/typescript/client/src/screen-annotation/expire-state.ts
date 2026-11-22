import type { ScreenAnnotationPresence, ScreenAnnotationState } from "./index";

export function expireAnnotationState(state: ScreenAnnotationState, now: number) {
  let nextExpiry = Infinity;
  const fresh = (value: { readonly expires_at_ms: number | null }): boolean => {
    const expiry = value.expires_at_ms;
    if (expiry === null) return true;
    if (expiry <= now) return false;
    nextExpiry = Math.min(nextExpiry, expiry);
    return true;
  };
  const marks = state.marks.filter(fresh);
  const requests = state.access.requests.filter(fresh);
  return { freshState: { ...state, marks, access: { ...state.access, requests } }, nextExpiry };
}

export function expireAnnotationPresence(presence: Map<string, ScreenAnnotationPresence>, now: number): number {
  let nextExpiry = Infinity;
  for (const [id, sample] of presence) {
    if (sample.expires_at_ms <= now) presence.delete(id);
    else nextExpiry = Math.min(nextExpiry, sample.expires_at_ms);
  }
  return nextExpiry;
}
