import type { JoinOptions } from "./core";
import { ChalkErrorClass } from "./core";

export interface RealtimeKitAdmissionRequest {
  readonly accessToken: string;
  readonly apiUrl: string;
  readonly fetchImplementation?: typeof fetch;
  readonly options: JoinOptions;
  readonly roomId: string;
}

export async function requestRealtimeKitToken({ accessToken, apiUrl, fetchImplementation = globalThis.fetch, options, roomId }: RealtimeKitAdmissionRequest): Promise<string> {
  if (typeof fetchImplementation !== "function") throw new ChalkErrorClass("A fetch implementation is required to join");
  const response = await fetchImplementation(`${apiUrl.replace(/\/+$/u, "")}/api/v1/rooms/${encodeURIComponent(roomId)}/participants`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      display_name: options.userName,
      role: options.role ?? "participant",
      ...(options.metadata ? { metadata: options.metadata } : {}),
    }),
  });
  const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  if (!response.ok) {
    const message = readableString(body?.message) ?? readableString(body?.error) ?? `Participant admission failed with HTTP ${response.status}`;
    throw new ChalkErrorClass(message);
  }
  const authToken = readableString(body?.auth_token) ?? readableString(body?.authToken);
  if (!authToken) throw new ChalkErrorClass("Participant admission did not return a RealtimeKit token");
  return authToken;
}

function readableString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized || null;
}
