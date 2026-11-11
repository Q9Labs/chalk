import { useState } from "react";

type Seat = { readonly participantId: string; readonly presence: { readonly state: string } };

/** The people who have shown as connected at some point in this call, so a seat that never joined is not called reconnecting. */
export function useSeenConnected(roster: readonly Seat[]): ReadonlySet<string> {
  const [seen, setSeen] = useState<ReadonlySet<string>>(() => new Set());
  const arrivals = roster.filter((person) => person.presence.state === "connected" && !seen.has(person.participantId));
  if (arrivals.length > 0) setSeen(new Set([...seen, ...arrivals.map((person) => person.participantId)]));
  return seen;
}
