import type { PreparedPublicSpace, PublicInviteClient } from "../lib/chalk-access";
import { createCallStateClient, liveSnapshot } from "./fixtures";
export { createLocalSpaceRelease } from "../lib/local-space-client";
export { publicAPIBaseURL, resumePublicSpace } from "../lib/chalk-access";

// Only the isolated journey server replaces access and transport boundaries.
// SpacePage, LocalSpace, the theme provider and SDK controls remain the product code.
export function createLocalSpaceClient() {
  return createCallStateClient(liveSnapshot({ self: { camera: false, microphone: false }, others: [{ id: "guest", name: "Guest", camera: false, microphone: false }] }));
}
const arrival = { state: "admitted", arrival_handle: "fixture-arrival", space: { admission_mode: "open", slug: "design-lab", name: "Test call", maximum_episode_duration_seconds: 3600 } } as const;
export function createPublicInviteClient(): PublicInviteClient {
  const unexpected = async (): Promise<never> => {
    throw new Error("The invited journey must not request network credentials or create a call");
  };
  return {
    prepareSpaceEntrance: async () => undefined,
    arriveBySpacePublicInvite: async () => arrival,
    getSpacePublicInviteArrival: async () => arrival,
    createPublicSpace: unexpected,
    refreshSpacePublicInviteAccess: unexpected,
    leaveSpacePublicInviteArrival: async () => undefined,
  };
}
export function createPreparedPublicSpace(): Omit<PreparedPublicSpace, "connectionAccess"> {
  const reportExpiresAt = Date.now() + 300_000;
  return {
    arrival,
    credential: { apiBaseURL: "https://api.chalk.test", syncURL: "wss://sync.chalk.test/v1/sync", space: "design-lab" },
    getAccess: async () => {
      throw new Error("The preview client must not request network credentials");
    },
    finish: async () => undefined,
    subscribe: () => () => undefined,
    reportCredentialExpiresAt: () => reportExpiresAt,
    reportCredential: () => "fixture-proof",
    reloadMarker: () => ({ episodeId: "33333333-3333-4333-8333-333333333333", participantId: "you", participantGeneration: 1, mediaProof: "fixture-proof", arrivalHandle: "fixture-arrival" }),
  };
}
