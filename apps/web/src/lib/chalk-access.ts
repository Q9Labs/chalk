import { createChalkPublicClient, createPublicSpaceSession, resumePublicSpaceSession, type ChalkPublicClient, type PublicSpaceArrival, type PublicSpaceSession, type ReloadRejoinMarker } from "@q9labsai/chalk-client";
import { DEFAULT_API_BASE_URL, defaultSyncUrl } from "@q9labsai/chalk-client/effect";

export type PublicSpaceCredential = {
  readonly apiBaseURL: string;
  readonly syncURL: string;
  /** Direct Sync URL tried before `syncURL`; absent unless the build sets VITE_CHALK_SYNC_DIRECT_URL. */
  readonly syncDirectURL?: string;
  /** `off` keeps Sync and SFU signalling on the Tunnel; set by `?direct=off` for the trial's control arm. */
  readonly directPath?: "off";
  readonly space: string;
};

/** An admitted public arrival: the access it holds, what the server said about it, and where its Space connects. */
export type PublicSpaceAdmission = {
  readonly session: PublicSpaceSession;
  readonly arrival: PublicSpaceArrival;
  readonly credential: PublicSpaceCredential;
};

export function createPublicInviteClient(): ChalkPublicClient {
  return createChalkPublicClient({ baseUrl: publicAPIBaseURL(), credentials: "include" });
}

export function admitPublicSpace(client: ChalkPublicClient, arrival: PublicSpaceArrival): PublicSpaceAdmission {
  if (!arrival.access || !arrival.arrival_handle) throw new Error("This Space is not ready yet.");
  const session = createPublicSpaceSession(client, { arrivalHandle: arrival.arrival_handle, access: arrival.access });
  return { session, arrival, credential: publicSpaceCredential(arrival) };
}

export async function resumePublicSpace(client: ChalkPublicClient, marker: ReloadRejoinMarker, expectedSlug?: string): Promise<PublicSpaceAdmission> {
  const { session, arrival } = await resumePublicSpaceSession(client, marker, expectedSlug);
  return { session, arrival, credential: publicSpaceCredential(arrival) };
}

/** Where this build's Space `space` connects: the API origin, the Sync URLs and the direct-path switch. */
export function webSpaceCredential(space: string): PublicSpaceCredential {
  const apiBaseURL = publicAPIBaseURL();
  return { apiBaseURL, syncURL: publicSyncURL(apiBaseURL), ...publicSyncDirectURL(), ...publicDirectPathControl(), space };
}

function publicSpaceCredential(arrival: PublicSpaceArrival): PublicSpaceCredential {
  const space = arrival.space?.slug?.trim();
  if (!space) throw new Error("This Space is unavailable.");
  return webSpaceCredential(space);
}

export function publicAPIBaseURL(): string {
  const configured = import.meta.env.VITE_API_URL?.trim();
  if (configured) return configured;
  if (globalThis.location?.origin) return globalThis.location.origin;
  return DEFAULT_API_BASE_URL;
}

export function publicDirectPathControl(): { readonly directPath?: "off" } {
  return new URLSearchParams(globalThis.location?.search).get("direct") === "off" ? { directPath: "off" } : {};
}

export function publicSyncDirectURL(): { readonly syncDirectURL?: string } {
  if (publicDirectPathControl().directPath) return {};
  const configured = import.meta.env.VITE_CHALK_SYNC_DIRECT_URL?.trim();
  return configured ? { syncDirectURL: configured } : {};
}

export function publicSyncURL(apiBaseURL: string): string {
  return import.meta.env.VITE_CHALK_SYNC_URL?.trim() || defaultSyncUrl(apiBaseURL);
}
