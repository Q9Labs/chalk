import type { LobbyParticipant } from "./types.js";

export type LobbyRoster = {
  readonly shown: readonly LobbyParticipant[];
  readonly rest: readonly LobbyParticipant[];
};

/** At most three names in the lobby line; every AI participant is named, and a single leftover person is named too instead of counted. */
export function lobbyRoster(participants: readonly LobbyParticipant[]): LobbyRoster {
  const ai = participants.filter((participant) => participant.identityKind === "agent").length;
  const room = Math.max(Math.min(Math.max(2, ai), 3) - ai, 0);
  const people = participants.filter((participant) => participant.identityKind !== "agent").slice(0, room);
  const shown = participants.filter((participant) => participant.identityKind === "agent" || people.includes(participant));
  const rest = participants.filter((participant) => !shown.includes(participant));
  return rest.length === 1 ? { shown: participants, rest: [] } : { shown, rest };
}
