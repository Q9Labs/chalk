import type { Participant, SpaceClient, SpaceSnapshot } from "@q9labsai/chalk-client";
import type { ReactNode } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { expect, it, vi } from "vitest";
import { DeviceLayoutProvider } from "../../frame/device-layout";
import { PortalProvider } from "../../frame/portal";
import { ChalkProvider } from "../../context/space-client-context";
import { ToastProvider } from "../../primitives/toast/ToastStack";
import { PeopleTab } from "./PeopleTab";

type HostProps = { readonly children?: ReactNode | ((state: { readonly pressed: boolean }) => ReactNode); readonly [key: string]: unknown };

vi.mock("react-native", async () => {
  const { createElement } = await import("react");
  const host = (tag: string) => {
    function Host(props: HostProps) {
      const { children, ...rest } = props;
      return createElement(tag, rest, children instanceof Function ? children({ pressed: false }) : children);
    }
    return Host;
  };
  return {
    BackHandler: { addEventListener: () => ({ remove: () => undefined }) },
    AccessibilityInfo: { announceForAccessibility: () => undefined },
    FlatList: function FlatList({ data, renderItem, ListHeaderComponent }: { readonly data: readonly { readonly key: string }[]; readonly renderItem: (input: { readonly item: unknown; readonly index: number }) => ReactNode; readonly ListHeaderComponent?: ReactNode }) {
      return createElement("FlatList", null, ListHeaderComponent, ...data.map((item, index) => createElement("Row", { key: item.key }, renderItem({ item, index }))));
    },
    Keyboard: { addListener: () => ({ remove: () => undefined }) },
    Platform: { OS: "ios", select: (choices: { readonly ios?: unknown }) => choices.ios },
    Pressable: host("Pressable"),
    StyleSheet: { create: <Styles,>(styles: Styles) => styles, absoluteFill: {}, hairlineWidth: 1 },
    Text: host("Text"),
    TextInput: host("TextInput"),
    View: host("View"),
    findNodeHandle: () => null,
  };
});

vi.mock("react-native-reanimated", () => ({
  default: { View: "AnimatedView" },
  Easing: { bezier: () => () => 0, out: (easing: unknown) => easing, cubic: () => 0 },
  ReduceMotion: { System: "system" },
  cancelAnimation: () => undefined,
  runOnUI: (work: () => void) => work,
  useAnimatedStyle: () => ({}),
  useReducedMotion: () => false,
  useSharedValue: (value: unknown) => ({ value }),
  withDelay: (_delay: number, value: unknown) => value,
  withRepeat: (value: unknown) => value,
  withSequence: (...values: unknown[]) => values[0],
  withTiming: (value: unknown) => value,
}));

vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaFrame: () => ({ x: 0, y: 0, width: 390, height: 844 }),
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

vi.mock("react-native-svg", () => ({ default: "Svg", Circle: "Circle", G: "G", Path: "Path", Rect: "Rect", Text: "SvgText" }));

function participant(id: string, displayName: string, detail: Partial<Participant> = {}): Participant {
  return {
    participantId: id,
    displayName,
    role: "guest",
    eligibleRoles: ["guest"],
    capabilities: [],
    handRaised: false,
    media: { microphone: "inactive", camera: "inactive", screenShare: "inactive" },
    ...detail,
  } as Participant;
}

function spaceClient(roster: readonly Participant[]): SpaceClient {
  const snapshot = {
    participants: { roster, admissionQueue: [] },
    self: { ...roster[0], can: () => false },
  } as unknown as SpaceSnapshot;
  return {
    getSnapshot: () => snapshot,
    subscribe: () => () => undefined,
    participants: {},
  } as unknown as SpaceClient;
}

function render(roster: readonly Participant[]): ReactTestRenderer {
  let renderer: ReactTestRenderer | undefined;
  act(() => {
    renderer = create(
      <ChalkProvider client={spaceClient(roster)}>
        <DeviceLayoutProvider>
          <PortalProvider>
            <ToastProvider>
              <PeopleTab />
            </ToastProvider>
          </PortalProvider>
        </DeviceLayoutProvider>
      </ChalkProvider>,
    );
  });
  if (!renderer) throw new Error("PeopleTab did not render");
  return renderer;
}

it("renders the agent badge and description in a people row", () => {
  const renderer = render([participant("self", "Alex"), participant("agent", "Akash Rao", { identityKind: "agent", description: "AI teammate" })]);
  expect(renderer.root.findAllByProps({ testID: "people.ai.agent" })).not.toHaveLength(0);
  expect(renderer.root.findAllByProps({ testID: "people.description.agent" })).not.toHaveLength(0);
  expect(JSON.stringify(renderer.toJSON())).toContain("AI teammate");
  expect(renderer.root.findAllByProps({ testID: "people.ai.self" })).toHaveLength(0);
  expect(renderer.root.findAllByProps({ testID: "people.description.self" })).toHaveLength(0);
});
