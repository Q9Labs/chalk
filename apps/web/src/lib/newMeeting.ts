import { createAuthenticatedRoom } from "@q9labs/chalk-core";
import { fetchInternalAccessToken, getAccessTokenExpiryMs } from "./internalAuth";

export async function createInternalMeeting(apiUrl: string, roomName = "New meeting") {
  const accessToken = await fetchInternalAccessToken(apiUrl);
  const room = await createAuthenticatedRoom({
    apiUrl,
    accessToken,
    name: roomName,
  });

  return {
    roomId: room.id,
    roomName: room.name || roomName,
    accessToken,
    expiresAtMs: getAccessTokenExpiryMs(accessToken),
  };
}
