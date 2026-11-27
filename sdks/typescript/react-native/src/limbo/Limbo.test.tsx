import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";

vi.mock("react-native", async () => {
  const React = await import("react");
  const host = (tag: string) =>
    function Host({ children, ...props }: { readonly children?: React.ReactNode; readonly [key: string]: unknown }) {
      return React.createElement(tag, props, typeof children === "function" ? children({ pressed: false }) : children);
    };
  return {
    AccessibilityInfo: { setAccessibilityFocus: vi.fn() },
    findNodeHandle: () => null,
    Platform: { OS: "ios", select: (choices: { readonly ios?: unknown }) => choices.ios },
    Pressable: host("button"),
    StyleSheet: { create: (styles: unknown) => styles },
    Text: host("span"),
    View: host("div"),
  };
});
vi.mock("react-native-reanimated", async () => {
  const React = await import("react");
  return {
    default: { View: ({ children }: { readonly children?: React.ReactNode }) => React.createElement("div", null, children) },
    cancelAnimation: vi.fn(),
    Easing: { bezier: () => 0, inOut: () => 0, linear: 0 },
    useAnimatedStyle: (value: unknown) => (typeof value === "function" ? (value as () => unknown)() : value),
    ReduceMotion: { Always: "always", Never: "never", System: "system" },
    useReducedMotion: () => true,
    useSharedValue: (value: unknown) => ({ value }),
    withDelay: (_delay: number, value: unknown) => value,
    withRepeat: (value: unknown) => value,
    withSequence: (value: unknown) => value,
    withTiming: (value: unknown) => value,
  };
});
vi.mock("react-native-svg", () => {
  const React = require("react") as typeof import("react");
  const host =
    (tag: string) =>
    ({ children }: { readonly children?: React.ReactNode }) =>
      React.createElement(tag, null, children);
  return { default: host("svg"), Circle: host("circle"), G: host("g"), Path: host("path"), Rect: host("rect"), Text: host("text") };
});

import { Limbo } from "./Limbo";

it("renders the pre-join roster and AI disclosure in the knocking lobby", () => {
  const markup = renderToStaticMarkup(
    <Limbo
      state={{ kind: "knocking", onCancel: () => undefined }}
      callName="Test call"
      recording={false}
      participants={[
        { displayName: "Ada", identityKind: "user" },
        { displayName: "AI teammate", identityKind: "agent", notice: "A supplied notice is in this call." },
        { displayName: "Sam", identityKind: "user" },
      ]}
    />,
  );
  expect(markup).toContain("Ada and AI teammate and 1 others are in this call");
  expect(markup).toContain("A supplied notice is in this call.");
  expect(markup).toContain("limbo.lobby.ai.0");
});
