import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

vi.mock("react-native", () => ({
  Alert: { alert: vi.fn() },
  FlatList: "FlatList",
  Modal: "Modal",
  Pressable: "Pressable",
  ScrollView: "ScrollView",
  StyleSheet: { create: <T,>(styles: T) => styles },
  Text: "Text",
  TextInput: "TextInput",
  View: "View",
}));
vi.mock("../../ui/native-theme", () => ({
  useNativeTheme: () => ({ colors: { background: "#0a0a0b", border: "#1c1c1f", card: "#141418", error: "#ef4444", foreground: "#fbffff", mutedForeground: "#71717a", placeholder: "#71717a", primary: "#1bb6a6", primaryForeground: "#ffffff" } }),
}));

import { selectSpaceReaction, SpaceActionMenu } from "./SpaceActionMenu";

const source = readFileSync(new URL("./SpaceActionMenu.tsx", import.meta.url), "utf8");

describe("SpaceActionMenu", () => {
  it("shows only capability-backed actions and closes after a layout selection", () => {
    const setActionsOpen = vi.fn();
    const setLayout = vi.fn();
    const controller = actionController({
      canInvite: true,
      canParticipants: false,
      canChat: true,
      canScreenShare: false,
      canHandRaise: true,
      canWhiteboard: false,
      canReactions: false,
      canSettings: true,
      setActionsOpen,
      layout: { layout: "grid", setLayout },
    });

    const tree = SpaceActionMenu({ controller });
    const labels = findText(tree);

    expect(labels).toEqual(expect.arrayContaining(["Invite participants", "Chat", "Raise hand", "Settings", "Grid layout (selected)", "Focus layout", "Presentation layout"]));
    expect(labels).not.toContain("Participants");
    expect(labels).not.toContain("Open whiteboard");

    const presentation = findElements(tree, "Pressable").find((element) => findText(element).length === 1 && findText(element).includes("Presentation layout"));
    const onPress = presentation?.props?.onPress;
    if (typeof onPress === "function") onPress();
    expect(setLayout).toHaveBeenCalledWith("presentation");
    expect(setActionsOpen).toHaveBeenCalledWith(false);
  });

  it("routes reaction selection through the controller", () => {
    const sendReaction = vi.fn();

    selectSpaceReaction({ sendReaction } as never, "🎉");

    expect(sendReaction).toHaveBeenCalledWith("🎉");
  });

  it("shows diagnostics only when its open handler is provided", () => {
    const setActionsOpen = vi.fn();
    const onOpenDiagnostics = vi.fn();
    const controller = actionController({ setActionsOpen });

    expect(findText(SpaceActionMenu({ controller }))).not.toContain("Diagnostics");

    const tree = SpaceActionMenu({ controller, onOpenDiagnostics });
    const diagnostics = findElements(tree, "Pressable").find((element) => findText(element).length === 1 && findText(element).includes("Diagnostics"));
    const onPress = diagnostics?.props?.onPress;
    if (typeof onPress === "function") onPress();

    expect(setActionsOpen).toHaveBeenCalledWith(false);
    expect(onOpenDiagnostics).toHaveBeenCalledTimes(1);
  });

  it("opens Feedback from the utility actions and closes the action sheet", () => {
    const setActionsOpen = vi.fn();
    const onOpenFeedback = vi.fn();
    const tree = SpaceActionMenu({ controller: actionController({ setActionsOpen }), onOpenFeedback });
    const feedback = findElements(tree, "Pressable").find((element) => findText(element).length === 1 && findText(element).includes("Feedback"));
    const onPress = feedback?.props?.onPress;
    if (typeof onPress === "function") onPress();

    expect(setActionsOpen).toHaveBeenCalledWith(false);
    expect(onOpenFeedback).toHaveBeenCalledOnce();
  });

  it("leaves chat and settings panel ownership to canonical mounted sheets", () => {
    expect(source).not.toContain("ChatPanel");
    expect(source).not.toContain("<SpacePanel");
  });

  it("does not invent a role catalog for customer-defined participant roles", () => {
    expect(source).not.toContain("Set collaborator role");
    expect(source).not.toContain("Set observer role");
    expect(source).not.toContain("setParticipantRole");
  });
});

function actionController(overrides: Record<string, unknown>): never {
  return {
    actionsOpen: true,
    canHandRaise: false,
    canInvite: false,
    canParticipants: false,
    canChat: false,
    canScreenShare: false,
    canWhiteboard: false,
    canReactions: false,
    canSettings: false,
    handRaised: false,
    screenShare: { isLocalSharing: false },
    whiteboard: { isOpen: false, toggle: vi.fn() },
    layout: { layout: "grid", setLayout: vi.fn() },
    handleLeave: vi.fn(),
    openPanel: vi.fn(),
    setActionsOpen: vi.fn(),
    setReactionPickerOpen: vi.fn(),
    ...overrides,
  } as never;
}

function findElements(value: unknown, type: string): { readonly props?: Record<string, unknown> }[] {
  if (Array.isArray(value)) return value.flatMap((child) => findElements(child, type));
  if (!value || typeof value !== "object") return [];
  const element = value as { readonly type?: unknown; readonly props?: Record<string, unknown> };
  const own = element.type === type ? [element] : [];
  return [...own, ...findElements(element.props?.children, type)];
}

function findText(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(findText);
  if (!value || typeof value !== "object") return [];
  return findText((value as { readonly props?: { readonly children?: unknown } }).props?.children);
}
