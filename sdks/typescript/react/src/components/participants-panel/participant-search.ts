import type { ParticipantListParticipant } from "./ParticipantsPanel";

const normalize = (value: string) => value.trim().toLocaleLowerCase();

export function matchParticipants(participants: readonly ParticipantListParticipant[], query: string): ParticipantListParticipant[] {
  const needle = normalize(query);
  return participants.filter((person) => person.displayName.toLocaleLowerCase().includes(needle));
}

/** Splits a name around the first match of `query`, so the match can be highlighted. */
export function splitMatch(name: string, query: string): readonly [before: string, match: string, after: string] {
  const needle = normalize(query);
  const lowered = name.toLocaleLowerCase();
  const start = needle && lowered.length === name.length ? lowered.indexOf(needle) : -1;
  if (start < 0) return [name, "", ""];
  return [name.slice(0, start), name.slice(start, start + needle.length), name.slice(start + needle.length)];
}
