import { describe, expect, it, vi } from "vitest";

vi.mock("@hugeicons/core-free-icons/dist/esm/CallEnd01Icon", () => ({ default: "CallEnd01Icon" }));
vi.mock("@hugeicons/core-free-icons/dist/esm/Chat01Icon", () => ({ default: "Chat01Icon" }));
vi.mock("@hugeicons/core-free-icons/dist/esm/Mic01Icon", () => ({ default: "Mic01Icon" }));
vi.mock("@hugeicons/core-free-icons/dist/esm/MicOff01Icon", () => ({ default: "MicOff01Icon" }));
vi.mock("@hugeicons/core-free-icons/dist/esm/MoreHorizontalIcon", () => ({ default: "MoreHorizontalIcon" }));
vi.mock("@hugeicons/core-free-icons/dist/esm/Video01Icon", () => ({ default: "Video01Icon" }));
vi.mock("@hugeicons/core-free-icons/dist/esm/VideoOffIcon", () => ({ default: "VideoOffIcon" }));
vi.mock("@hugeicons/react-native", () => ({ HugeiconsIcon: "HugeiconsIcon" }));
vi.mock("react-native", () => ({
  Platform: { OS: "android" },
  Pressable: "Pressable",
  StyleSheet: { create: <T,>(styles: T) => styles },
  Text: "Text",
  View: "View",
}));
vi.mock("../../ui/native-theme", () => ({
  useNativeTheme: () => ({ colors: { controlsBackground: "#141418", darkCanvas: "#0a0a0b", error: "#ef4444", onDark: "#fbffff", primary: "#1bb6a6", primaryForeground: "#ffffff", border: "#1c1c1f" } }),
}));

import { SpaceBottomDockAndroid } from "./SpaceBottomDock.android";

describe("SpaceBottomDockAndroid", () => {
  it("disables both media controls on unsupported simulator media and caps unread badges", () => {
    const onToggleAudio = vi.fn();
    const onToggleVideo = vi.fn();
    const tree = SpaceBottomDockAndroid({
      simulatorMediaDisabled: true,
      isMuted: false,
      isCameraOff: true,
      unreadChatCount: 12,
      onToggleAudio,
      onToggleVideo,
      onOpenChat: vi.fn(),
      onOpenMore: vi.fn(),
      onLeave: vi.fn(),
    });

    const buttons = findElements(tree, "Pressable");
    expect(buttons).toHaveLength(5);
    expect(buttons[0]).toMatchObject({ props: { disabled: true, onPress: onToggleAudio } });
    expect(buttons[1]).toMatchObject({ props: { disabled: true, onPress: onToggleVideo } });
    expect(findText(tree)).toContain("9+");
  });
});

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
