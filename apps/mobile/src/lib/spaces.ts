import type { AccessGrant, GetAccess, PublicSpaceArrival } from "@q9labsai/chalk-client";
import { createChalkPublicClient } from "@q9labsai/chalk-client/invites";
import { parseSpaceInviteLink as parseNativeSpaceInviteLink } from "@q9labsai/chalk-react-native/invites";
import * as SecureStore from "expo-secure-store";

const ARRIVAL_KEY_PREFIX = "chalk_mobile_public_arrival_v1.";
const ARRIVAL_INDEX_PREFIX = "chalk_mobile_public_arrival_index_v1.";

export type MobileRoute = { readonly kind: "home" } | SpaceRoute;

export type SpaceRoute = {
  readonly kind: "space";
  readonly space: string;
  readonly spaceInviteToken: string;
  readonly inviteLink: string;
  readonly spaceName?: string;
  readonly source: "space-link" | "created-space";
};

type SpaceInvite = {
  readonly slug: string;
  readonly spaceInviteToken: string;
};

export type StoredSpaceArrival = {
  readonly arrivalHandle: string;
  readonly guestCredential: string;
  readonly slug: string;
  readonly spaceInviteToken: string;
};

export type MobileSpaceArrival = {
  readonly access: AccessGrant;
  readonly credential: StoredSpaceArrival;
  readonly defaults: { readonly camera: boolean; readonly microphone: boolean };
  readonly displayName: string;
  readonly spaceName: string;
};

export type SpaceOperation = "create" | "arrive" | "pending" | "refresh" | "leave";
export type SpaceOperationState = "failed" | "observed" | "succeeded";
export type SpaceOperationObserver = (operation: SpaceOperation, state: SpaceOperationState) => void;

export function parseSpaceLink(input: string): SpaceRoute | null {
  const inviteLink = input.trim();
  const invite = parseNativeSpaceInviteLink(inviteLink);
  if (!invite) return null;
  return {
    kind: "space",
    space: invite.slug,
    spaceInviteToken: invite.spaceInviteToken,
    inviteLink,
    source: "space-link",
  };
}

export function getClipboardSpaceSuggestion(clipboardText: string | null | undefined, currentInput = ""): string | null {
  const candidate = clipboardText?.trim();
  if (!candidate || candidate === currentInput.trim()) return null;
  return parseSpaceLink(candidate) ? candidate : null;
}

export async function createPublicSpaceRoute({ apiBaseURL, displayName, onOperation }: { readonly apiBaseURL: string; readonly displayName: string; readonly onOperation?: SpaceOperationObserver }): Promise<{ readonly arrival: MobileSpaceArrival; readonly route: SpaceRoute }> {
  onOperation?.("create", "observed");
  try {
    const client = publicClient(apiBaseURL);
    const created = await client.createPublicSpace({ displayName }, { idempotencyKey: idempotencyKey() });
    const invite = parseSpaceLink(created.invite_link);
    if (!invite) throw new Error("Chalk returned an invalid Space invite link.");

    const arrival = storedArrival(created.arrival, { slug: invite.space, spaceInviteToken: invite.spaceInviteToken }, created.guest_credential);
    await persistArrival(arrival);
    const access = requiredAccess(created.arrival);
    onOperation?.("create", "succeeded");
    return {
      arrival: { access, credential: arrival, defaults: { camera: true, microphone: true }, displayName, spaceName: created.space.name },
      route: { ...invite, source: "created-space", spaceName: created.space.name },
    };
  } catch (cause) {
    onOperation?.("create", "failed");
    throw cause;
  }
}

export async function prepareSpaceArrival({ apiBaseURL, route, displayName, onOperation }: { readonly apiBaseURL: string; readonly route: SpaceRoute; readonly displayName: string; readonly onOperation?: SpaceOperationObserver }): Promise<MobileSpaceArrival> {
  onOperation?.("arrive", "observed");
  const stored = await loadArrival(route.spaceInviteToken);
  const client = publicClient(apiBaseURL, stored?.guestCredential);

  if (stored) {
    try {
      const status = await client.getSpacePublicInviteArrival({ arrivalHandle: stored.arrivalHandle, guestCredential: stored.guestCredential });
      if (status.state === "left" || status.state === "expired" || status.state === "rejected" || status.state === "unavailable") {
        await clearArrival(stored);
      } else {
        const resumed = await client.arriveBySpacePublicInvite({ displayName, spaceInviteToken: route.spaceInviteToken }, { arrivalHandle: stored.arrivalHandle, guestCredential: stored.guestCredential, idempotencyKey: idempotencyKey() });
        const arrival = storedArrival(resumed, { slug: route.space, spaceInviteToken: route.spaceInviteToken }, stored.guestCredential);
        await persistArrival(arrival);
        const access = requiredAccessForOperation(resumed, onOperation);
        onOperation?.("arrive", "succeeded");
        return { access, credential: arrival, defaults: { camera: true, microphone: true }, displayName, spaceName: route.spaceName ?? route.space };
      }
    } catch (cause) {
      if (!isTerminalArrivalError(cause)) throw cause;
      await clearArrival(stored);
    }
  }

  const arrived = await publicClient(apiBaseURL).arriveBySpacePublicInvite({ displayName, spaceInviteToken: route.spaceInviteToken }, { idempotencyKey: idempotencyKey() });
  const arrival = storedArrival(arrived, { slug: route.space, spaceInviteToken: route.spaceInviteToken });
  await persistArrival(arrival);
  const access = requiredAccessForOperation(arrived, onOperation);
  onOperation?.("arrive", "succeeded");
  return { access, credential: arrival, defaults: { camera: true, microphone: true }, displayName, spaceName: route.spaceName ?? route.space };
}

export function createGuestAccessGetter({ apiBaseURL, credential, initialAccess, onOperation }: { readonly apiBaseURL: string; readonly credential: StoredSpaceArrival; readonly initialAccess: AccessGrant; readonly onOperation?: SpaceOperationObserver }): GetAccess {
  let currentAccess = initialAccess;
  const client = publicClient(apiBaseURL, credential.guestCredential);

  return async ({ reason }) => {
    if (reason === "join") return currentAccess;
    try {
      const refreshed = await client.refreshSpacePublicInviteAccess({ arrivalHandle: credential.arrivalHandle, guestCredential: credential.guestCredential, mediaProof: mediaProof(currentAccess) }, { arrivalHandle: credential.arrivalHandle, guestCredential: credential.guestCredential });
      currentAccess = refreshed;
      onOperation?.("refresh", "succeeded");
      return refreshed;
    } catch (cause) {
      onOperation?.("refresh", "failed");
      throw cause;
    }
  };
}

export async function cleanupSpaceArrival({ apiBaseURL, credential, onOperation }: { readonly apiBaseURL: string; readonly credential: StoredSpaceArrival; readonly onOperation?: SpaceOperationObserver }): Promise<void> {
  const client = publicClient(apiBaseURL, credential.guestCredential);
  try {
    await client.leaveSpacePublicInviteArrival({ arrivalHandle: credential.arrivalHandle, guestCredential: credential.guestCredential });
    onOperation?.("leave", "succeeded");
  } catch (cause) {
    if (!isTerminalArrivalError(cause)) {
      onOperation?.("leave", "failed");
      throw cause;
    }
    onOperation?.("leave", "succeeded");
  }
  await clearArrival(credential);
}

export async function clearSpaceContext(route?: SpaceRoute): Promise<void> {
  if (!route) return;

  const arrivalHandle = await SecureStore.getItemAsync(`${ARRIVAL_INDEX_PREFIX}${route.spaceInviteToken}`);
  await Promise.all([...(arrivalHandle ? [SecureStore.deleteItemAsync(`${ARRIVAL_KEY_PREFIX}${arrivalHandle}`)] : []), SecureStore.deleteItemAsync(`${ARRIVAL_INDEX_PREFIX}${route.spaceInviteToken}`)]);
}

function publicClient(apiBaseURL: string, guestCredential?: string) {
  return createChalkPublicClient({ baseUrl: apiBaseURL, guestCredential, runtime: "react-native" });
}

function storedArrival(value: PublicSpaceArrival, route: SpaceInvite, guestCredential?: string): StoredSpaceArrival {
  const arrivalHandle = value.arrival_handle?.trim();
  const credential = guestCredential?.trim() ?? value.guest_credential?.trim();
  if (!arrivalHandle || !credential) throw new Error("Chalk did not return a Guest arrival credential.");
  return { arrivalHandle, guestCredential: credential, slug: route.slug, spaceInviteToken: route.spaceInviteToken };
}

function requiredAccess(value: PublicSpaceArrival): AccessGrant {
  if (!value.access) throw new Error(value.state === "pending" ? "This Space is waiting for approval." : "Chalk did not return Space access.");
  return value.access;
}

function requiredAccessForOperation(value: PublicSpaceArrival, onOperation?: SpaceOperationObserver): AccessGrant {
  try {
    return requiredAccess(value);
  } catch (cause) {
    if (value.state === "pending") onOperation?.("pending", "observed");
    else onOperation?.("arrive", "failed");
    throw cause;
  }
}

function mediaProof(value: AccessGrant): string {
  if (!isAccessWithMedia(value)) throw new Error("The current Space access grant has no media proof.");
  return value.media.token;
}

function isAccessWithMedia(value: AccessGrant): value is AccessGrant & { readonly media: { readonly token: string } } {
  if (typeof value !== "object" || value === null || !("media" in value)) return false;
  const media: unknown = value.media;
  if (typeof media !== "object" || media === null || !("token" in media)) return false;
  return typeof media.token === "string" && media.token.length > 0;
}

async function loadArrival(spaceInviteToken: string): Promise<StoredSpaceArrival | undefined> {
  const handle = await SecureStore.getItemAsync(`${ARRIVAL_INDEX_PREFIX}${spaceInviteToken}`);
  if (!handle) return undefined;
  const value = await SecureStore.getItemAsync(`${ARRIVAL_KEY_PREFIX}${handle}`);
  if (!value) {
    await clearArrivalByHandle(handle, spaceInviteToken);
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(value);
    if (isStoredArrival(parsed) && parsed.spaceInviteToken === spaceInviteToken) return parsed;
  } catch {
    // Invalid device state is removed below.
  }
  await clearArrivalByHandle(handle, spaceInviteToken);
  return undefined;
}

async function persistArrival(value: StoredSpaceArrival): Promise<void> {
  await Promise.all([SecureStore.setItemAsync(`${ARRIVAL_KEY_PREFIX}${value.arrivalHandle}`, JSON.stringify(value)), SecureStore.setItemAsync(`${ARRIVAL_INDEX_PREFIX}${value.spaceInviteToken}`, value.arrivalHandle)]);
}

async function clearArrival(value: StoredSpaceArrival): Promise<void> {
  await clearArrivalByHandle(value.arrivalHandle, value.spaceInviteToken);
}

async function clearArrivalByHandle(arrivalHandle: string, spaceInviteToken: string): Promise<void> {
  await Promise.all([SecureStore.deleteItemAsync(`${ARRIVAL_KEY_PREFIX}${arrivalHandle}`), SecureStore.deleteItemAsync(`${ARRIVAL_INDEX_PREFIX}${spaceInviteToken}`)]);
}

function isStoredArrival(value: unknown): value is StoredSpaceArrival {
  if (typeof value !== "object" || value === null) return false;
  if (!("arrivalHandle" in value) || !("guestCredential" in value) || !("slug" in value) || !("spaceInviteToken" in value)) return false;
  return typeof value.arrivalHandle === "string" && typeof value.guestCredential === "string" && typeof value.slug === "string" && typeof value.spaceInviteToken === "string";
}

function idempotencyKey(): string {
  return globalThis.crypto?.randomUUID?.() ?? `chalk-mobile-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function isTerminalArrivalError(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  if ("status" in value && (value.status === 404 || value.status === 410)) return true;
  if (!("error" in value) || typeof value.error !== "object" || value.error === null || !("code" in value.error)) return false;
  return value.error.code === "arrival.invalid_handle" || value.error.code === "arrival.unavailable" || value.error.code === "space_public_invite.unavailable";
}
