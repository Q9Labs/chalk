import { createCallStateClient, liveSnapshot } from "./fixtures";
export { createLocalSpaceRelease } from "../lib/local-space-client";
export { createPublicInviteClient, createPreparedPublicSpace, resumePublicSpace } from "../lib/chalk-access";

// Only the isolated journey server replaces access and transport boundaries.
// SpacePage, LocalSpace, the theme provider and SDK controls remain the product code.
export function createLocalSpaceClient() {
  return createCallStateClient(liveSnapshot({ self: { camera: false, microphone: false }, others: [{ id: "nora", name: "Nora", camera: false, microphone: false }] }));
}
export async function getAccount() {
  return { name: "Ada" };
}
export async function listAllAccountTenants() {
  return [{ tenant: { id: "fixture-tenant" } }];
}
export async function joinDashboardSpace() {
  return {
    credential: { apiBaseURL: "https://api.chalk.test", space: "design-lab", tenantId: "fixture-tenant" },
    getAccess: async () => {
      throw new Error("The preview client must not request network credentials");
    },
    leave: async () => undefined,
    reloadMarker: () => ({ episodeId: "33333333-3333-4333-8333-333333333333", participantId: "you", participantGeneration: 1, mediaProof: "fixture-proof", arrivalHandle: "fixture-arrival" }),
  };
}
