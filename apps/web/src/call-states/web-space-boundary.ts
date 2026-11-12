import type { ChalkPublicClient, PublicSpaceArrival } from "@q9labsai/chalk-client";
import type { PublicSpaceAdmission } from "../lib/chalk-access";
import { createCallStateClient, liveSnapshot } from "./fixtures";
export { publicAPIBaseURL, publicSyncDirectURL, publicSyncURL } from "../lib/chalk-access";

// Only the isolated journey server replaces access and transport boundaries.
// SpacePage, LocalSpace, the theme provider and SDK controls remain the product code.
export function createLocalSpaceClient() {
  return createCallStateClient(liveSnapshot({ self: { camera: false, microphone: false }, others: [{ id: "guest", name: "Guest", camera: false, microphone: false }] }));
}
const arrival: PublicSpaceArrival = { state: "admitted", arrival_handle: "fixture-arrival", space: { admission_mode: "open", slug: "design-lab", name: "Test call", maximum_episode_duration_seconds: 3600 } };
export function createPublicInviteClient(): ChalkPublicClient {
  const arrive = async () => arrival;
  const status = async () => arrival;
  const leave = async () => undefined;
  return { prepareSpaceEntrance: async () => undefined, arrive, arriveBySpacePublicInvite: arrive, create: unexpected, createPublicSpace: unexpected, getSpacePublicInviteArrival: status, status, leave, leaveSpacePublicInviteArrival: leave, refresh: unexpected, refreshSpacePublicInviteAccess: unexpected };
}
export function admitPublicSpace(): PublicSpaceAdmission {
  const reportExpiresAt = Date.now() + 300_000;
  return {
    arrival,
    credential: { apiBaseURL: "https://api.chalk.test", syncURL: "wss://sync.chalk.test/v1/sync", space: "design-lab" },
    session: {
      getAccess: async () => {
        throw new Error("The preview client must not request network credentials");
      },
      connectionAccess: unexpected,
      leave: async () => undefined,
      subscribe: () => () => undefined,
      mediaExpiresAt: () => reportExpiresAt,
      mediaProof: () => "fixture-proof",
      reloadMarker: () => ({ episodeId: "33333333-3333-4333-8333-333333333333", participantId: "you", participantGeneration: 1, mediaProof: "fixture-proof", arrivalHandle: "fixture-arrival" }),
    },
  };
}
export async function resumePublicSpace(): Promise<PublicSpaceAdmission> {
  return admitPublicSpace();
}
async function unexpected(): Promise<never> {
  throw new Error("The invited journey must not request network credentials or create a call");
}
