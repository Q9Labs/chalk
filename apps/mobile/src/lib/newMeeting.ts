import { createFriendlyRoomName } from "@q9labs/chalk-core";

export async function createHostedMeeting(apiUrl: string, getAccessToken: () => Promise<string>, random: () => number = Math.random, fetchImpl: typeof fetch = fetch) {
  const roomName = createFriendlyRoomName(random).label;
  const accessToken = await getAccessToken();
  const response = await fetchImpl(`${apiUrl}/api/v1/rooms`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ name: roomName }),
  });

  const data = (await response.json().catch(() => null)) as {
    id?: string;
    name?: string | null;
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
