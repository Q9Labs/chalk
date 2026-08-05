import { describe, expect, it, vi } from "vitest";
import { assertV1ControlSemantics, computeV1StateDigest, optimisticV1Control, V1ReplicaError } from "./v1-reducer";
import type { V1ControlState } from "./v1-types";

const ownerId = "018f2f65-2a77-7a44-8e9a-5b0b6f8d4e31";
const participantId = "018f2f65-2a77-7a44-8e9a-5b0b6f8d4e32";

describe("SyncEngine v1 reducer", () => {
  it("applies optimistic targets without mutating durable control", () => {
    const durable = controlState();
    const optimistic = optimisticV1Control(durable, ownerId, [
      { name: "set_hand_raised", payload: { raised: true } },
      { name: "set_display_name", payload: { display_name: "Renamed Owner" } },
      { name: "set_admission_policy", payload: { policy: "approval" } },
    ]);

    expect(optimistic.admissionPolicy).toBe("approval");
    expect(optimistic.participants[0]).toMatchObject({ displayName: "Renamed Owner", handRaised: true });
    expect(durable.participants[0]).toMatchObject({ displayName: "Owner", handRaised: false });
    expect(durable.admissionPolicy).toBe("open");
  });

  it("enforces role-capability invariants and hashes participant order canonically", async () => {
    const durable = controlState();
    expect(() => assertV1ControlSemantics(durable)).not.toThrow();
    expect(() => assertV1ControlSemantics({ ...durable, participants: [...durable.participants, durable.participants[0]!] })).toThrow(V1ReplicaError);
    expect(() => assertV1ControlSemantics({ ...durable, participants: [{ ...durable.participants[0]!, role: "unknown" }] })).toThrow("capability bundle");

    const reversed = { ...durable, participants: [...durable.participants].reverse() };
    expect(await computeV1StateDigest(reversed)).toBe(await computeV1StateDigest(durable));
  });

  it("verifies state without requiring Web Crypto from the runtime", async () => {
    const webCryptoDigest = vi.spyOn(globalThis.crypto.subtle, "digest").mockRejectedValue(new Error("Web Crypto is unavailable"));

    await expect(computeV1StateDigest(controlState())).resolves.toMatch(/^[0-9a-f]{64}$/u);
    expect(webCryptoDigest).not.toHaveBeenCalled();
  });
});

function controlState(): V1ControlState {
  const roleCapabilities: V1ControlState["roleCapabilities"] = {
    owner: ["subscribe", "assignRoles"],
    reviewer: ["subscribe"],
    observer: ["subscribe"],
  };
  return {
    revision: 7,
    stateSchemaVersion: 1,
    stateDigest: "00".repeat(32),
    status: "active",
    admissionPolicy: "open",
    deadlineAtMs: 2_000_000_000_000,
    deadlineGeneration: 3,
    roleCapabilities,
    recording: null,
    admissionRequests: [],
    participants: [
      {
        participantId: ownerId,
        displayName: "Owner",
        handRaised: false,
        admissionRevision: 1,
        role: "owner",
        eligibleRoles: ["owner", "reviewer"],
        capabilities: [...roleCapabilities.owner],
      },
      {
        participantId: participantId,
        displayName: "Participant",
        handRaised: false,
        admissionRevision: 2,
        role: "reviewer",
        eligibleRoles: ["reviewer", "observer"],
        capabilities: [...roleCapabilities.reviewer],
      },
    ],
  };
}
