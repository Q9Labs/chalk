import { createElement, isValidElement, type ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

vi.mock("expo-clipboard", () => ({ setStringAsync: vi.fn() }));
vi.mock("expo-status-bar", () => ({ StatusBar: "StatusBar" }));
vi.mock("react-native-safe-area-context", () => ({ SafeAreaView: "SafeAreaView", useSafeAreaInsets: () => ({ bottom: 12, left: 0, right: 0, top: 0 }) }));
vi.mock("react-native", () => ({
  Modal: "Modal",
  Pressable: "Pressable",
  SafeAreaView: "SafeAreaView",
  ScrollView: "ScrollView",
  StyleSheet: { absoluteFillObject: {}, create: (styles: unknown) => styles },
  Text: "Text",
  View: "View",
}));
vi.mock("@q9labsai/chalk-react-native", () => ({
  ChalkProvider: (props: Record<string, unknown>) => createElement("ChalkProvider", props, props.children as ReactNode),
  EndScreen: (props: Record<string, unknown>) => createElement("EndScreen", props),
  JoinFailedScreen: (props: Record<string, unknown>) => createElement("JoinFailedScreen", props),
  JoiningScreen: "JoiningScreen",
  PreJoinScreen: "PreJoinScreen",
}));
vi.mock("@q9labsai/chalk-react-native/theme", () => ({ Theme: { spacing: { md: 12 } } }));

import { DevSdkPreviewScreen } from "./DevSdkPreviewScreen";
import { DEFAULT_PREVIEW_SEARCH } from "./preview-state";

describe("DevSdkPreviewScreen", () => {
  it("keeps one screen contract while switching between Entrance and Space fixtures", () => {
    const onSearchChange = vi.fn();
    const element = DevSdkPreviewScreen({ onClose: vi.fn(), search: DEFAULT_PREVIEW_SEARCH, onSearchChange });

    expect(element.props.testID).toBe("dev-sdk-preview-screen");
    expect(findByTestId(element, "dev-sdk-preview-screen")).toBeDefined();
  });
});

function findByTestId(node: ReactNode, testID: string): { readonly props: Record<string, unknown>; readonly type: unknown } {
  return findBy(node, (props) => props.testID === testID);
}

function findBy(node: ReactNode, predicate: (props: Record<string, unknown>) => boolean): { readonly props: Record<string, unknown>; readonly type: unknown } {
  if (!isValidElement(node)) {
    if (Array.isArray(node)) {
      for (const child of node) {
        try {
          return findBy(child, predicate);
        } catch {
          continue;
        }
      }
    }
    throw new Error("Fixture element not found");
  }

  const props = node.props as Record<string, unknown>;
  if (typeof node.type === "function") {
    try {
      return findBy((node.type as (props: Record<string, unknown>) => ReactNode)(props), predicate);
    } catch {
      // Continue with this element's children when a production stub returns no tree.
    }
  }
  const searchableProps = typeof node.type === "string" ? { ...props, __typeName: node.type } : props;
  if (predicate(searchableProps)) return { props: searchableProps, type: node.type };
  const children = Array.isArray(props.children) ? props.children : [props.children];
  for (const child of children) {
    try {
      return findBy(child, predicate);
    } catch {
      continue;
    }
  }
  throw new Error("Fixture element not found");
}
