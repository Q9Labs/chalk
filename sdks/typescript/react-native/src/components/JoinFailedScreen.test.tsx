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

    expect(children[0]?.props.children).toBe("Join failed");
    expect(children[1]?.props.children).toBe("Design review");
    expect(children[2]?.props.children).toBe("Sync unavailable");
    expect(actions.map((action) => action.props.accessibilityLabel)).toEqual(["Retry joining", "Return home"]);
  });
});
