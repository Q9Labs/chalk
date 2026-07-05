import { recordManualRequest } from "./dev-diagnostics";
import { createFriendlyRoomName } from "./room-names";

export async function createHostedMeeting(apiUrl: string, getAccessToken: () => Promise<string>, roomNameOverride?: string, random: () => number = Math.random, fetchImpl: typeof fetch = fetch) {
  const roomName = roomNameOverride || createFriendlyRoomName(random).label;
  const accessToken = await getAccessToken();
  const response = await fetchImpl(`${apiUrl}/api/v1/rooms`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ name: roomName }),
  });
  const responseMeta = {
    statusCode: response.status,
    requestId: response.headers?.get?.("x-request-id") ?? null,
    traceId: response.headers?.get?.("x-chalk-trace-id") ?? null,
    cfRay: response.headers?.get?.("cf-ray") ?? null,
  };

  const data = (await response.json().catch(() => null)) as {
    id?: string;
    name?: string | null;
    error?: string;
  } | null;

  if (!response.ok) {
    recordManualRequest({
      eventType: "api.request",
      method: "POST",
      path: "/api/v1/rooms",
      url: `${apiUrl}/api/v1/rooms`,
      outcome: "error",
      statusCode: responseMeta.statusCode,
      requestId: responseMeta.requestId,
      traceId: responseMeta.traceId,
      cfRay: responseMeta.cfRay,
      errorMessage: data?.error || `failed to create room (${response.status})`,
    });
    throw new Error(data?.error || `failed to create room (${response.status})`);
  }

  if (!data?.id) {
    throw new Error("missing room id");
  }

  recordManualRequest({
    eventType: "api.request",
    method: "POST",
    path: "/api/v1/rooms",
    url: `${apiUrl}/api/v1/rooms`,
    outcome: "success",
    statusCode: responseMeta.statusCode,
    requestId: responseMeta.requestId,
    traceId: responseMeta.traceId,
    cfRay: responseMeta.cfRay,
  });

  return {
    roomId: data.id,
    roomName: data.name || roomName,
  };
}
