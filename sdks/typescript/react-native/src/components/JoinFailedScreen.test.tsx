import { Children, type ReactElement } from "react";
import { describe, expect, it, vi } from "vitest";

vi.mock("react-native", () => ({
  Pressable: "Pressable",
  ScrollView: "ScrollView",
  StyleSheet: { create: (styles: unknown) => styles },
  Text: "Text",
  View: "View",
}));

import { JoinFailedScreen } from "./JoinFailedScreen";

describe("JoinFailedScreen", () => {
  it("renders the room, failure message, and retry/home actions", () => {
    const element = JoinFailedScreen({ roomName: "Design review", message: "Sync unavailable", onRetry: vi.fn(), onHome: vi.fn() });
    const children = Children.toArray(element.props.children) as ReactElement[];
    const actionRow = children[3];
    const actions = Children.toArray(actionRow.props.children) as ReactElement[];

    expect(children[0]?.props.children).toBe("Couldn't enter");
    expect(children[1]?.props.children).toBe("Design review");
    expect(children[2]?.props.children).toBe("Sync unavailable");
    expect(actions.map((action) => action.props.accessibilityLabel)).toEqual(["Try entering the Space again", "Return home"]);
  });

  it("supports a custom failure title, selectable support code, and Entrance back semantics", () => {
    const element = JoinFailedScreen({ title: "Entrance timed out", message: "The Space took too long to prepare.", supportCode: "entrance-timeout-408", onRetry: vi.fn(), onBack: vi.fn() });
    const children = Children.toArray(element.props.children) as ReactElement[];
    const supportCode = children[3];
    const actionRow = children[4];
    const actions = Children.toArray(actionRow?.props.children) as ReactElement[];

    expect(children[1]?.props.children).toBe("Entrance timed out");
    expect(children[1]?.props.accessibilityRole).toBe("header");
    expect(children[2]?.props.accessibilityRole).toBe("alert");
    expect(Children.toArray(supportCode?.props.children)[1]?.props.selectable).toBe(true);
    expect(Children.toArray(supportCode?.props.children)[1]?.props.accessibilityLabel).toBe("Support code entrance-timeout-408");
    expect(actions.map((action) => action.props.accessibilityLabel)).toEqual(["Try entering the Space again", "Back to Entrance"]);
  });
});
