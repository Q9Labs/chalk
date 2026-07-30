import { isValidElement, type ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

vi.mock("react", async (importOriginal) => {
  const react = await importOriginal<typeof import("react")>();
  return {
    ...react,
    useCallback: (callback: unknown) => callback,
    useMemo: (factory: () => unknown) => factory(),
    useState: (initial: unknown) => [initial, vi.fn()],
  };
});
vi.mock("react-native", () => ({
  Pressable: "Pressable",
  StyleSheet: { create: <Styles,>(styles: Styles) => styles },
  Text: "Text",
  View: "View",
}));
vi.mock("react-native-safe-area-context", () => ({
  SafeAreaView: "SafeAreaView",
}));
vi.mock("@q9labsai/chalk-react-native", () => ({
  ChalkEmbeddedWhiteboard: "ChalkEmbeddedWhiteboard",
}));
vi.mock("@q9labsai/chalk-react-native/theme", () => ({
  Theme: {
    colors: {
      background: "#000000",
      border: "#222222",
      error: "#ff0000",
      foreground: "#ffffff",
      mutedForeground: "#aaaaaa",
      secondary: "#333333",
    },
    radius: { lg: 12 },
    spacing: { sm: 8, md: 12, lg: 16 },
  },
}));

import { MobileWhiteboardPlayground, createMobileWhiteboardPlaygroundJourneyId } from "./MobileWhiteboardPlayground";

describe("MobileWhiteboardPlayground", () => {
  it("labels its renderer as local-only and grants local drawing capabilities", () => {
    expect(createMobileWhiteboardPlaygroundJourneyId(42)).toBe("local-whiteboard-42");

    const tree = MobileWhiteboardPlayground({ onClose: vi.fn() });
    const renderer = findByTestId(tree, "mobile-whiteboard-renderer-playground");

    expect(renderer).toMatchObject({
      canClear: true,
      canDraw: true,
      journeyId: expect.stringMatching(/^local-whiteboard-\d+$/u),
      theme: "light",
    });
    expect(flattenText(tree)).toContain("Local only · no meeting collaboration");
  });
});

function findByTestId(node: ReactNode, testID: string): Record<string, unknown> {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findByTestIdOrNull(child, testID);
      if (found) return found;
    }
  }
  const found = findByTestIdOrNull(node, testID);
  if (!found) throw new Error(`Could not find ${testID}`);
  return found;
}

function findByTestIdOrNull(node: ReactNode, testID: string): Record<string, unknown> | null {
  if (!isValidElement(node)) return null;
  const props = node.props as { readonly children?: ReactNode; readonly testID?: string };
  if (props.testID === testID) return props as Record<string, unknown>;
  const children = Array.isArray(props.children) ? props.children : [props.children];
  for (const child of children) {
    const found = findByTestIdOrNull(child, testID);
    if (found) return found;
  }
  return null;
}

function flattenText(node: ReactNode): string {
  if (typeof node === "string") return node;
  if (Array.isArray(node)) return node.map(flattenText).join(" ");
  if (!isValidElement(node)) return "";
  return flattenText((node.props as { readonly children?: ReactNode }).children);
}
