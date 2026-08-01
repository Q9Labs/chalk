import type { ChalkSessionSnapshot } from "@q9labsai/chalk-client";
import { describe, expect, it, vi } from "vitest";

const setDisplayName = vi.fn(async () => undefined);
const snapshot = {
  subject: { participantSessionId: "local" },
  participants: [
    { participantSessionId: "local", displayName: "Local", role: "participant" },
    { participantSessionId: "remote", displayName: "Remote", role: "participant" },
  ],
  participantMedia: { remote: { microphone: "active", camera: "inactive" } },
  localMedia: { microphone: { state: "enabled", track: null }, camera: { state: "disabled", track: null }, screen: { state: "disabled", track: null } },
  remoteMedia: [],
} as unknown as ChalkSessionSnapshot;

vi.mock("react", () => ({
  useCallback: <T>(callback: T) => callback,
  useMemo: <T>(factory: () => T) => factory(),
}));
vi.mock("../context/chalk-provider", () => ({
  useChalkSession: () => ({ setDisplayName }),
}));
vi.mock("./useChalkSnapshot", () => ({
  useChalkSnapshot: () => snapshot,
}));

describe("useMeetingParticipants", () => {
  it("projects the canonical snapshot for internal meeting consumers", async () => {
    const { useMeetingParticipants } = await import("./useMeetingParticipants");

    const result = useMeetingParticipants();

    expect(result.participantCount).toBe(2);
    expect(result.localParticipant?.id).toBe("local");
    expect(result.remoteParticipants.map((participant) => participant.id)).toEqual(["remote"]);
    expect(result.updateDisplayName).toBe(setDisplayName);
  });
});
