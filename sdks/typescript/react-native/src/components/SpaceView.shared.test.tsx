import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  controller: {
    actionsOpen: false,
    activeReactions: [],
    canChat: true,
    canParticipants: true,
    derived: { allParticipants: [], gridPages: [], isCompactViewport: false, isStageMode: false, primaryContent: "grid", screenShareTrack: null, screenSharer: null },
    handRaised: false,
    handleLeave: vi.fn(),
    isCameraOff: false,
    isMuted: false,
    layout: { layout: "grid" },
    openPanel: vi.fn(),
    panel: null,
    raisedHandCount: 0,
    reactionPickerOpen: false,
    selfName: "Taylor",
    setActionsOpen: vi.fn(),
    setReactionPickerOpen: vi.fn(),
    simulatorMediaDisabled: false,
    spaceName: "Design space",
    chat: { unreadCount: 0 },
    whiteboard: { canDraw: true, elements: [], isOpen: false, openParticipants: [] },
  },
  useSpaceViewController: vi.fn(),
}));

vi.mock("react-native", () => ({
  Alert: { alert: vi.fn() },
  StyleSheet: { create: <T,>(styles: T) => styles },
  Text: "Text",
  View: "View",
}));
vi.mock("../ui/theme", () => ({ Theme: { colors: { darkCanvas: "#0a0a0b", primary: "#1bb6a6", primaryForeground: "#ffffff" } } }));
vi.mock("../ui/native-theme", () => ({
  useNativeTheme: () => ({ colors: { darkCanvas: "#0a0a0b", primary: "#1bb6a6", primaryForeground: "#ffffff" } }),
}));
vi.mock("../utils/ios-simulator", () => ({ getIosSimulatorMediaMessage: () => "Media is unavailable in the simulator." }));
vi.mock("./ReactionPicker", () => ({ ReactionPicker: "ReactionPicker" }));
vi.mock("./native-space-view/SpaceActionMenu", () => ({ SpaceActionMenu: "SpaceActionMenu", selectSpaceReaction: vi.fn() }));
vi.mock("./native-space-view/SettingsSheet", () => ({ SettingsSheet: "SettingsSheet" }));
vi.mock("./native-space-view/SpacePanelSheet", () => ({ SpacePanelSheet: "SpacePanelSheet" }));
vi.mock("./native-space-view/SpaceBottomDock.android", () => ({ SpaceBottomDockAndroid: "SpaceBottomDockAndroid" }));
vi.mock("./native-space-view/SpaceGrid.android", () => ({ SpaceGridAndroid: "SpaceGridAndroid" }));
vi.mock("./native-space-view/SpaceStage.android", () => ({ SpaceStageAndroid: "SpaceStageAndroid" }));
vi.mock("./native-space-view/SpaceTopBar.android", () => ({ SpaceTopBarAndroid: "SpaceTopBarAndroid" }));
vi.mock("./native-space-view/SpaceWhiteboardSurface", () => ({ SpaceWhiteboardSurface: "SpaceWhiteboardSurface" }));
vi.mock("./native-space-view/useSpaceViewController", () => ({ useSpaceViewController: state.useSpaceViewController }));

import { SpaceViewShared } from "./SpaceView.shared";

describe("SpaceViewShared", () => {
  const source = readFileSync(new URL("./SpaceView.shared.tsx", import.meta.url), "utf8");

  beforeEach(() => {
    state.controller.whiteboard.isOpen = false;
    state.useSpaceViewController.mockClear();
    state.useSpaceViewController.mockReturnValue(state.controller);
  });

  afterEach(() => {
    state.controller.whiteboard.isOpen = false;
    state.useSpaceViewController.mockClear();
  });

  it("passes reconnecting state and capability-gated controls to the native surface", () => {
    const props = { onLeave: vi.fn(), reconnecting: true, logoUrl: "https://cdn.example.test/logo.png", spaceName: "Design space" };
    const tree = SpaceViewShared(props);

    expect(state.useSpaceViewController).toHaveBeenCalledWith(props);
    expect(findText(tree)).toContain("Reconnecting… controls will resume shortly.");
    expect(findElement(tree, "SpaceTopBarAndroid")).toMatchObject({ props: { logoUrl: props.logoUrl, spaceName: props.spaceName } });
    expect(findElement(tree, "SpaceBottomDockAndroid")).toMatchObject({ props: { onOpenChat: expect.any(Function), unreadChatCount: 0 } });
  });

  it("renders the whiteboard surface instead of a stage or grid when it is open", () => {
    state.controller.whiteboard.isOpen = true;

    const tree = SpaceViewShared({ onLeave: vi.fn() });

    expect(findElement(tree, "SpaceWhiteboardSurface")).toBeTruthy();
    expect(findElement(tree, "SpaceStageAndroid")).toBeUndefined();
    expect(findElement(tree, "SpaceGridAndroid")).toBeUndefined();
  });

  it("mounts the canonical panel sheet that owns the attachment composer", () => {
    const panelSource = readFileSync(new URL("./native-space-view/SpacePanelSheet.tsx", import.meta.url), "utf8");
    const chatSource = readFileSync(new URL("./native-space-view/SpaceChatSheet.tsx", import.meta.url), "utf8");

    expect(source).toContain("<SpacePanelSheet controller={controller} />");
    expect(source).not.toContain("<SpacePanel controller={controller} />");
    expect(source).toContain("<SettingsSheet controller={controller}");
    expect(panelSource).toContain("<SpaceChatSheet");
    expect(chatSource).toContain('accessibilityLabel="Attach file"');
    expect(chatSource).toContain("controller.removeChatAttachment(index)");
  });
});

function findElement(value: unknown, type: string): { readonly props?: Record<string, unknown> } | undefined {
  if (Array.isArray(value)) return value.map((child) => findElement(child, type)).find(Boolean);
  if (!value || typeof value !== "object") return undefined;
  const element = value as { readonly type?: unknown; readonly props?: Record<string, unknown> };
  if (element.type === type) return element;
  return findElement(element.props?.children, type);
}

function findText(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(findText);
  if (!value || typeof value !== "object") return [];
  return findText((value as { readonly props?: { readonly children?: unknown } }).props?.children);
}
