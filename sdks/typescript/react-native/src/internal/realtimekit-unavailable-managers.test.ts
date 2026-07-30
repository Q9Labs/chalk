import { describe, expect, it } from "vitest";

import { unavailableChatManager, unavailableInteractionManager, unavailableRecordingManager, unavailableWhiteboardManager } from "./realtimekit-unavailable-managers";

describe("unavailable native managers", () => {
  it("exposes fail-closed state for capabilities without a canonical session store", async () => {
    const interactions = unavailableInteractionManager();
    const chat = unavailableChatManager();
    const recording = unavailableRecordingManager();
    const whiteboard = unavailableWhiteboardManager();

    expect(interactions.getState()).toMatchObject({ isHandRaised: false, raisedHandCount: 0 });
    expect(() => interactions.raiseHand()).toThrow("canonical session store");
    expect(chat.getState()).toMatchObject({ isEnabled: false, count: 0 });
    await expect(recording.start()).rejects.toThrow("Native recording is unavailable");
    expect(whiteboard.getState()).toMatchObject({ isOpen: false, canDraw: false });

    whiteboard.open();
    whiteboard.sendUpdate([]);
    expect(whiteboard.getState().isOpen).toBe(false);
  });
});
