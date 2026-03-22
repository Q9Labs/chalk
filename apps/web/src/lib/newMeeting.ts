import { fetchInternalAccessToken } from "./internalAuth";

type CreateRoomResponse = {
  id?: string;
  name?: string | null;
};

export async function createInternalMeeting(apiUrl: string, roomName = "New meeting") {
  const accessToken = await fetchInternalAccessToken(apiUrl);
  const response = await fetch(`${apiUrl}/api/v1/rooms`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ name: roomName }),
  });

  const data = (await response.json().catch(() => null)) as CreateRoomResponse & {
    error?: string;
  } | null;

  if (!response.ok) {
    throw new Error(data?.error || `failed to create room (${response.status})`);
  }

  if (!data?.id) {
    throw new Error("missing room id");
  }

  return {
    roomId: data.id,
    roomName: data.name || roomName,
  };
}
