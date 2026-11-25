import type { Participant } from "@q9labsai/chalk-client";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ roster: [] as Participant[] }));

vi.mock("react-native", async () => {
  const React = await import("react");
  const host = (tag: string) => {
    return function Host({ children, ...props }: { readonly children?: React.ReactNode; readonly [key: string]: unknown }) {
      return React.createElement(tag, props, typeof children === "function" ? children({ pressed: false }) : children);
    };
  };
  const View = host("div");
  return {
    FlatList: function FlatList({ data, renderItem, ListHeaderComponent }: { readonly data: readonly { readonly key: string }[]; readonly renderItem: (input: { readonly item: unknown; readonly index: number }) => React.ReactNode; readonly ListHeaderComponent?: React.ReactNode }) {
      return React.createElement(
        React.Fragment,
        null,
        ListHeaderComponent,
        data.map((item, index) => React.createElement(React.Fragment, { key: item.key }, renderItem({ item, index }))),
      );
    },
    Pressable: host("button"),
    StyleSheet: { create: (styles: unknown) => styles },
    View,
  };
});

vi.mock("react-native-reanimated", async () => {
  const React = await import("react");
  return {
    default: { View: ({ children, ...props }: { readonly children?: React.ReactNode; readonly [key: string]: unknown }) => React.createElement("div", props, children) },
    Easing: { bezier: () => () => 0 },
  };
});

vi.mock("../../avatar/FaceAvatar", async () => {
  const React = await import("react");
  return { FaceAvatar: ({ name }: { readonly name: string }) => React.createElement("span", null, name.slice(0, 1)) };
});
vi.mock("../../context/space-client-context", () => ({
  useSpaceClient: () => ({ participants: { admit: vi.fn(), deny: vi.fn(), mute: vi.fn(), remove: vi.fn(), renameSelf: vi.fn() } }),
}));
vi.mock("../../hooks/space-hooks", () => ({
  useCan: () => false,
  useParticipants: () => ({ roster: state.roster, admissionQueue: [] }),
  useSelf: () => state.roster[0],
}));
vi.mock("../../icons/Icon", async () => {
  const React = await import("react");
  return { Icon: () => React.createElement("span") };
});
vi.mock("../../motion/press", () => ({ usePressAnimation: () => ({ onPressIn: vi.fn(), onPressOut: vi.fn(), scaleStyle: undefined }) }));
vi.mock("../../primitives/ChalkText", async () => {
  const React = await import("react");
  return {
    ChalkText: ({ children, testID }: { readonly children?: React.ReactNode; readonly testID?: string }) => React.createElement("span", { "data-testid": testID }, children),
  };
});
vi.mock("../../primitives/AIBadge", async () => {
  const React = await import("react");
  return { AIBadge: ({ testID }: { readonly testID?: string }) => React.createElement("span", { "data-testid": testID }, "AI") };
});
vi.mock("../../primitives/IconButton", async () => {
  const React = await import("react");
  return { IconButton: () => React.createElement("button") };
});
vi.mock("../../primitives/Menu", async () => {
  const React = await import("react");
  return { Menu: () => null, MenuItem: () => React.createElement("button") };
});
vi.mock("../../primitives/PillButton", async () => {
  const React = await import("react");
  return { PillButton: ({ label }: { readonly label: string }) => React.createElement("button", null, label) };
});
vi.mock("../../primitives/toast/ToastStack", () => ({ useToasts: () => ({ show: vi.fn() }) }));
vi.mock("../../theme/theme", () => ({ useTheme: () => ({ colors: { raised: "#fff", hover: "#eee", textMuted: "#777", text: "#111", warning: "#a80", dangerText: "#c00" } }) }));
vi.mock("./TextField", async () => {
  const React = await import("react");
  return { TextField: () => React.createElement("input") };
});

import { PeopleTab } from "./PeopleTab";

function participant(id: string, detail?: { readonly identityKind?: "agent"; readonly description?: string }): Participant {
  return {
    participantId: id,
    displayName: id === "agent" ? "Akash Rao" : "Alex",
    role: "guest",
    eligibleRoles: ["guest"],
    capabilities: [],
    handRaised: false,
    media: { microphone: "inactive", camera: "inactive", screenShare: "inactive" },
    ...detail,
  } as Participant;
}

beforeEach(() => {
  state.roster = [participant("self"), participant("agent", { identityKind: "agent", description: "AI teammate" })];
});

it("renders the agent badge and description in a people row", () => {
  const html = renderToStaticMarkup(<PeopleTab />);
  expect(html).toContain('data-testid="people.ai.agent"');
  expect(html).toContain('data-testid="people.description.agent"');
  expect(html).toContain("AI teammate");
  expect(html).not.toContain('data-testid="people.ai.self"');
  expect(html).not.toContain('data-testid="people.description.self"');
});
