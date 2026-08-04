import { describe, expect, it, vi } from "vitest";

vi.mock("@hugeicons/core-free-icons/dist/esm/UserGroupIcon", () => ({ default: "UserGroupIcon" }));
vi.mock("@hugeicons/react-native", () => ({ HugeiconsIcon: "HugeiconsIcon" }));
vi.mock("react-native", () => ({
  Image: "Image",
  Platform: { OS: "android" },
  StyleSheet: { create: <T,>(styles: T) => styles },
  Text: "Text",
  View: "View",
}));
vi.mock("../../ui/native-theme", () => ({
  useNativeTheme: () => ({ colors: { darkCanvas: "#0a0a0b", border: "#1c1c1f", foreground: "#fbffff", mutedForeground: "#71717a", success: "#22c55e", surface: "#141418" } }),
}));

import { SpaceTopBarAndroid } from "./SpaceTopBar.android";

describe("SpaceTopBarAndroid", () => {
  it("keeps the space identity, elapsed duration, and participant count visible", () => {
    const tree = SpaceTopBarAndroid({ spaceName: "Design space", participantCount: 4, formattedDuration: "1:02", logoUrl: "https://cdn.example.test/logo.png" });

    const images = findElements(tree, "Image");
    expect(images).toHaveLength(1);
    expect(images[0]).toMatchObject({ props: { accessibilityLabel: "Chalk", source: { uri: "https://cdn.example.test/logo.png" } } });
    expect(findText(tree)).toEqual(expect.arrayContaining(["Design space", "1:02", "4"]));
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
  if (typeof value === "number") return [String(value)];
  if (Array.isArray(value)) return value.flatMap(findText);
  if (!value || typeof value !== "object") return [];
  return findText((value as { readonly props?: { readonly children?: unknown } }).props?.children);
}
