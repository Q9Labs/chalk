import { describe, expect, it } from "vitest";

import { initialChalkSessionSnapshot, projectChalkSessionSnapshot } from "./snapshot";

describe("ChalkSession snapshot projection", () => {
  it("creates a deeply immutable idle snapshot", () => {
    const snapshot = initialChalkSessionSnapshot();
    expect(snapshot).toMatchObject({ state: "idle", subject: null, connection: { sync: "idle", media: "idle" } });
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.localMedia)).toBe(true);
    expect(Object.isFrozen(snapshot.localMedia.camera)).toBe(true);
  });

  it("projects failed intended media without manufacturing tracks or healthy connections", () => {
    const snapshot = projectChalkSessionSnapshot({
      state: "failed",
      subject: null,
      sync: null,
      media: null,
      localTracks: new Map(),
      localIntent: { microphone: true, camera: false },
      failure: { code: "permission_denied", action: "join", recoverable: true, message: "denied" },
    });

    expect(snapshot.localMedia.microphone).toMatchObject({ state: "failed", track: null });
    expect(snapshot.localMedia.camera).toMatchObject({ state: "unavailable", track: null });
    expect(snapshot.failure).toMatchObject({ code: "permission_denied" });
  });
});
