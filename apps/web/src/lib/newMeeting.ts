import { createAuthenticatedRoom } from "@q9labs/chalk-core";
import { fetchWebAccessToken, getAccessTokenExpiryMs } from "./webMeeting";

export async function createWebMeeting(apiUrl: string, roomName = "New meeting") {
  const accessToken = await fetchWebAccessToken(apiUrl);
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
