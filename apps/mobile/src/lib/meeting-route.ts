import { createFriendlyRoomName } from "@q9labs/chalk-core";
import type { LobbyRoute } from "./chalk";

export function createNewMeetingLobbyRoute(random: () => number = Math.random): LobbyRoute {
  const friendlyRoom = createFriendlyRoomName(random);
  const roomId = `instant-meeting-${friendlyRoom.slug}-${random().toString(36).slice(2, 8)}`;

  return {
    kind: "lobby",
    roomId,
    roomName: friendlyRoom.label,
    role: "host",
    source: "new-meeting",
  };
}
