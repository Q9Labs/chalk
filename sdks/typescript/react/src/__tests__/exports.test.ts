import { describe, expect, it } from "vitest";

import "../public-surface.contract";
import * as components from "../components";
import * as sdk from "../index";

describe("React SDK public exports", () => {
  it("exports the turnkey component and context-connected prebuilt set", () => {
    expect(components.Chalk).toBeDefined();
    expect(components.Entrance).toBeDefined();
    for (const component of [components.ControlBar, components.ParticipantGrid, components.ChatPanel, components.ParticipantsPanel, components.AdmissionPanel, components.SettingsPanel, components.ReactionsOverlay, components.ScreenShareView]) expect(component).toBeDefined();
    expect("TranscriptPanel" in components).toBe(false);
  });

  it("exports the closed React binding surface from the package root", () => {
    const hooks = ["useSpaceClient", "useConnection", "useSelf", "useParticipants", "useMedia", "useChat", "useReactions", "useWhiteboard", "useCan"] as const;

    expect(sdk.Chalk).toBeDefined();
    expect(sdk.ChalkProvider).toBeDefined();
    expect(sdk.Entrance).toBeDefined();
    for (const hook of hooks) expect(sdk[hook]).toBeTypeOf("function");
    expect("useChalkSession" in sdk).toBe(false);
    expect("useChalkSelector" in sdk).toBe(false);
    expect("useLocalMedia" in sdk).toBe(false);
    expect("useRemoteMedia" in sdk).toBe(false);
  });
});
