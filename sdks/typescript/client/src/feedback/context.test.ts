import { describe, expect, it } from "vitest";
import type { ConnectionLifecycleSnapshot } from "../connection";
import { safeSubject } from "./context";

const snapshotWithSubject = {
  state: "live",
  subject: {
    tenantId: "11111111-1111-4111-8111-111111111111",
    spaceId: "22222222-2222-4222-8222-222222222222",
    episodeId: "33333333-3333-4333-8333-333333333333",
    participantId: "44444444-4444-4444-8444-444444444444",
    participantGeneration: 7,
  },
  episode: { id: "33333333-3333-4333-8333-333333333333", startedAt: null, deadline: null },
  connection: { sync: "healthy", media: "healthy" },
  failure: null,
} satisfies ConnectionLifecycleSnapshot;

describe("Feedback context", () => {
  it("projects only the safe subject fields needed by evidence", () => {
    expect(safeSubject(snapshotWithSubject)).toEqual({
      tenant_id: "11111111-1111-4111-8111-111111111111",
      space_id: "22222222-2222-4222-8222-222222222222",
      episode_id: "33333333-3333-4333-8333-333333333333",
      participant_id: "44444444-4444-4444-8444-444444444444",
      participant_generation: 7,
    });
  });

  it("omits scope when the connection has no subject", () => {
    const snapshotWithoutSubject = { ...snapshotWithSubject, subject: null } satisfies ConnectionLifecycleSnapshot;

    expect(safeSubject(snapshotWithoutSubject)).toBeUndefined();
  });
});
