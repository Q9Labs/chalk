import type { AccessGrant, GetAccess, PublicSpaceArrival } from "@q9labsai/chalk-client";
import { createChalkPublicClient } from "@q9labsai/chalk-client/invites";
import { clearArrival, loadArrival, persistArrival, type StoredSpaceArrival } from "./arrival-store";
import { parseSpaceLink, type SpaceRoute } from "./space-link";

type SpaceInvite = {
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

/** What every step of an arrival needs to know. */
type ArrivalContext = {
  readonly apiBaseURL: string;
  readonly route: SpaceRoute;
  readonly displayName: string;
  readonly onOperation?: SpaceOperationObserver;
};

/** A stored arrival ends in one of these states; the server has forgotten it. */
const ENDED_ARRIVAL_STATES: ReadonlySet<string> = new Set(["left", "expired", "rejected", "unavailable"]);

export async function createPublicSpaceRoute({ apiBaseURL, displayName, onOperation }: { readonly apiBaseURL: string; readonly displayName: string; readonly onOperation?: SpaceOperationObserver }): Promise<{ readonly arrival: MobileSpaceArrival; readonly route: SpaceRoute }> {
  onOperation?.("create", "observed");
  try {
    const client = publicClient(apiBaseURL);
    const created = await client.createPublicSpace({ displayName }, { idempotencyKey: idempotencyKey() });
    const invite = parseSpaceLink(created.invite_link);
    if (!invite) throw new Error("Chalk returned an invalid call link.");

    const arrival = storedArrival(created.arrival, { slug: created.space.slug, spaceInviteToken: invite.spaceInviteToken }, created.guest_credential);
    await persistArrival(arrival);
    const access = requiredAccess(created.arrival);
    const spaceName = callName(created.space.name, invite);
    onOperation?.("create", "succeeded");
    return {
      arrival: { access, credential: arrival, defaults: { camera: true, microphone: true }, displayName, spaceName },
      route: { ...invite, space: created.space.slug, source: "created-space", spaceName },
    };
  } catch (cause) {
    onOperation?.("create", "failed");
    throw cause;
  }
}

/**
 * Where an arrival stands: let in, waiting for the host to let them in, turned away, or the call is
 * full. The names match `ChalkArrival`'s states.
 */
export type SpaceArrivalStep =
  | { readonly state: "admitted"; readonly arrival: MobileSpaceArrival }
  | { readonly state: "knocking"; readonly credential: StoredSpaceArrival; readonly retryAfterMs: number; readonly spaceName: string }
  | { readonly state: "refused" | "full"; readonly spaceName: string };

export async function prepareSpaceArrival(context: ArrivalContext): Promise<SpaceArrivalStep> {
  context.onOperation?.("arrive", "observed");
  const stored = await loadArrival(context.route.spaceInviteToken);
  const resumed = stored ? await resumeStoredArrival({ ...context, credential: stored }) : undefined;
  return resumed ?? arriveAsNewParticipant(context);
}

/** Resumes the stored arrival while the server still knows it. One that has ended is forgotten, and the result is undefined. */
async function resumeStoredArrival(context: ArrivalContext & { readonly credential: StoredSpaceArrival }): Promise<SpaceArrivalStep | undefined> {
  const { apiBaseURL, credential } = context;
  try {
    const status = await publicClient(apiBaseURL, credential.guestCredential).getSpacePublicInviteArrival({ arrivalHandle: credential.arrivalHandle, guestCredential: credential.guestCredential });
    if (!ENDED_ARRIVAL_STATES.has(status.state)) return await resumeArrival(context);
  } catch (cause) {
    if (!isTerminalArrivalError(cause)) throw cause;
  }
  await clearArrival(credential);
  return undefined;
}

async function arriveAsNewParticipant(context: ArrivalContext): Promise<SpaceArrivalStep> {
  const { apiBaseURL, route, displayName, onOperation } = context;
  try {
    const arrived = await arriveRetryingEndingEpisode(() => publicClient(apiBaseURL).arriveBySpacePublicInvite({ displayName, spaceInviteToken: route.spaceInviteToken }, { idempotencyKey: idempotencyKey() }));
    const credential = storedArrival(arrived, { slug: route.space, spaceInviteToken: route.spaceInviteToken });
    await persistArrival(credential);
    return arrivalStep(arrived, { ...context, credential });
  } catch (cause) {
    if (arrivalErrorCode(cause) !== "episode.capacity_exceeded") throw cause;
    onOperation?.("arrive", "failed");
    return { state: "full", spaceName: route.spaceName ?? route.space };
  }
}

/** Checks a knocking arrival once more, after the `retryAfterMs` its last step asked for. */
export async function waitForAdmission(context: ArrivalContext & { readonly credential: StoredSpaceArrival }): Promise<SpaceArrivalStep> {
  const { apiBaseURL, credential } = context;
  const status = await publicClient(apiBaseURL, credential.guestCredential).getSpacePublicInviteArrival({ arrivalHandle: credential.arrivalHandle, guestCredential: credential.guestCredential });
  // An admitted arrival without access gets it by arriving again with the same handle.
  if (status.state === "admitted" && !status.access) return resumeArrival(context);
  return arrivalStep(status, context);
}

async function resumeArrival(context: ArrivalContext & { readonly credential: StoredSpaceArrival }): Promise<SpaceArrivalStep> {
  const { apiBaseURL, route, displayName, credential } = context;
  const resumed = await arriveRetryingEndingEpisode(() =>
    publicClient(apiBaseURL, credential.guestCredential).arriveBySpacePublicInvite({ displayName, spaceInviteToken: route.spaceInviteToken }, { arrivalHandle: credential.arrivalHandle, guestCredential: credential.guestCredential, idempotencyKey: idempotencyKey() }),
  );
  const refreshed = storedArrival(resumed, { slug: route.space, spaceInviteToken: route.spaceInviteToken }, credential.guestCredential);
  await persistArrival(refreshed);
  return arrivalStep(resumed, { ...context, credential: refreshed });
}

function arrivalStep(value: PublicSpaceArrival, { route, displayName, credential, onOperation }: ArrivalContext & { readonly credential: StoredSpaceArrival }): SpaceArrivalStep {
  const spaceName = callName(value.space?.name, route);
  if (value.access) {
    onOperation?.("arrive", "succeeded");
    return { state: "admitted", arrival: { access: value.access, credential, defaults: { camera: true, microphone: true }, displayName, spaceName } };
  }
  if (value.state === "pending") {
    onOperation?.("pending", "observed");
    return { state: "knocking", credential, retryAfterMs: retryDelay(value.retry_after), spaceName };
  }
  onOperation?.("arrive", "failed");
  if (value.state === "rejected") return { state: "refused", spaceName };
  throw new Error("Chalk did not return call access.");
}

/** The call's name, or the link's code for a call without one, as link previews show it. */
function callName(name: string | undefined, route: Pick<SpaceRoute, "space" | "spaceName">): string {
  return name?.trim() || route.spaceName || route.space;
}

function retryDelay(retryAfter: number | undefined): number {
  if (typeof retryAfter !== "number" || !Number.isFinite(retryAfter) || retryAfter < 0) return 1000;
  return Math.min(Math.max(retryAfter * 1000, 250), 30000);
}

/** Waits before each retry, about 5.5 s in all. */
const ENDING_EPISODE_RETRY_DELAYS_MS = [500, 1000, 1500, 2500];

/**
 * A Rejoin can land while the server is ending the old Episode, which answers `episode.not_active`.
 * Once that Episode has ended, the next arrival starts a fresh one, so retry for a few seconds first.
 */
async function arriveRetryingEndingEpisode<T>(arrive: () => Promise<T>): Promise<T> {
  for (const delayMs of ENDING_EPISODE_RETRY_DELAYS_MS) {
    const outcome = await arrive().then(
      (value) => ({ value }),
      (cause: unknown) => ({ cause }),
    );
    if ("value" in outcome) return outcome.value;
    if (arrivalErrorCode(outcome.cause) !== "episode.not_active") throw outcome.cause;
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  return arrive();
}

export function createGuestAccessGetter({ apiBaseURL, credential, initialAccess, onOperation }: { readonly apiBaseURL: string; readonly credential: StoredSpaceArrival; readonly initialAccess: AccessGrant; readonly onOperation?: SpaceOperationObserver }): GetAccess {
  let currentAccess = initialAccess;
  const client = publicClient(apiBaseURL, credential.guestCredential);

  return async ({ reason, replaceMediaConnection, signal }) => {
    if (reason === "join") return currentAccess;
    try {
      const refreshed = await client.refreshSpacePublicInviteAccess(
        { arrivalHandle: credential.arrivalHandle, guestCredential: credential.guestCredential, mediaProof: mediaProof(currentAccess), replaceMediaConnection, signal },
        { arrivalHandle: credential.arrivalHandle, guestCredential: credential.guestCredential },
      );
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

/**
 * Gives back an arrival whose participant has left or whose call has ended, and forgets it here, so the
 * next arrival is a new participant. A refused leave still forgets it: the old participant is already gone.
 */
export async function retireSpaceArrival({ apiBaseURL, credential }: { readonly apiBaseURL: string; readonly credential: StoredSpaceArrival }): Promise<void> {
  await cleanupSpaceArrival({ apiBaseURL, credential }).catch(() => clearArrival(credential));
}

function publicClient(apiBaseURL: string, guestCredential?: string) {
  return createChalkPublicClient({ baseUrl: apiBaseURL, guestCredential, headers: { "X-Chalk-Invite-Format": "code" }, runtime: "react-native" });
}

function storedArrival(value: PublicSpaceArrival, route: SpaceInvite, guestCredential?: string): StoredSpaceArrival {
  const arrivalHandle = value.arrival_handle?.trim();
  const credential = guestCredential?.trim() ?? value.guest_credential?.trim();
  if (!arrivalHandle || !credential) throw new Error("Chalk did not return a Guest arrival credential.");
  return { arrivalHandle, guestCredential: credential, slug: value.space?.slug?.trim() || route.slug, spaceInviteToken: route.spaceInviteToken };
}

function requiredAccess(value: PublicSpaceArrival): AccessGrant {
  if (!value.access) throw new Error("Chalk did not return call access.");
  return value.access;
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

function idempotencyKey(): string {
  return globalThis.crypto?.randomUUID?.() ?? `chalk-mobile-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function isTerminalArrivalError(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  if ("status" in value && (value.status === 404 || value.status === 410)) return true;
  const code = arrivalErrorCode(value);
  return code === "arrival.invalid_handle" || code === "arrival.unavailable" || code === "space_public_invite.unavailable";
}

function arrivalErrorCode(value: unknown): unknown {
  if (typeof value !== "object" || value === null || !("error" in value)) return undefined;
  const error: unknown = value.error;
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  return error.code;
}
