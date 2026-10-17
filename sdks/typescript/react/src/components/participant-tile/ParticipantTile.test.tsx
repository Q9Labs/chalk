// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vitest";
import { ParticipantTileSurface } from "./ParticipantTile";

describe("ParticipantTile", () => {
  it("shows the participant avatar in the main area when the camera is off", async () => {
    const container = document.createElement("div");
    const root = createRoot(container);
    try {
      await act(async () => root.render(<ParticipantTileSurface participant={{ id: "nora", displayName: "Nora", isVideoEnabled: false }} mediaVisible={false} showName={false} showStatus={false} animatedAvatars={false} />));
      const avatar = container.querySelector('[role="img"][aria-label="Avatar for Nora"]');
      expect(avatar).not.toBeNull();
      expect(avatar?.parentElement?.getAttribute("aria-hidden")).toBe("true");
    } finally {
      await act(async () => root.unmount());
    }
  });
});
