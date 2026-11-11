import type { ParticipantListParticipant } from "./ParticipantsPanel";

export interface ParticipantGroups {
  readonly you: readonly ParticipantListParticipant[];
  readonly hands: readonly ParticipantListParticipant[];
  readonly others: readonly ParticipantListParticipant[];
}

/**
 * You first, then raised hands in the order they went up, then hosts, then everyone else in roster order.
 * Nobody is sorted by name, so a row never moves while someone reads it.
 */
export function orderParticipants(participants: readonly ParticipantListParticipant[]): ParticipantGroups {
  const others = participants.filter((person) => !person.isLocal);
  const hands = others.filter((person) => person.isHandRaised).sort((a, b) => (a.handOrder ?? Infinity) - (b.handOrder ?? Infinity));
  const rest = others.filter((person) => !person.isHandRaised);
  return {
    you: participants.filter((person) => person.isLocal),
    hands,
    others: [...rest.filter((person) => person.isHost), ...rest.filter((person) => !person.isHost)],
  };
}

/** A hand number helps only when it tells hands apart, so it shows from two hands up. */
export function handNumbers(participants: readonly ParticipantListParticipant[]): boolean {
  return participants.filter((person) => person.isHandRaised).length > 1;
}
