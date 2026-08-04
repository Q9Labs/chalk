import { isValidElement, type ReactElement, type ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

const controller = vi.hoisted(() => ({
  displayName: "Ada",
  audioEnabled: true,
  videoEnabled: true,
  isSubmitting: false,
  isInputFocused: false,
  previewError: null,
  previewStream: null,
  simulatorMediaDisabled: false,
  setDisplayName: vi.fn(),
  setInputFocused: vi.fn(),
  toggleAudio: vi.fn(),
  toggleVideo: vi.fn(),
  handleJoin: vi.fn(),
}));

const theme = vi.hoisted(() => ({
  colors: {
    background: "#101112",
    foreground: "#f7f8f9",
    primary: "#12ab89",
    primaryForeground: "#ffffff",
    muted: "#343536",
    mutedForeground: "#909192",
    error: "#dc2626",
    card: "#202122",
    surface: "#303132",
    raisedSurface: "#404142",
    insetSurface: "#505152",
    controlsBackground: "#606162",
    border: "#707172",
    ring: "#808182",
    darkCanvas: "#010203",
  },
}));

vi.mock("react-native", () => ({
  KeyboardAvoidingView: "KeyboardAvoidingView",
  Platform: { OS: "android" },
  Pressable: "Pressable",
  StyleSheet: { absoluteFillObject: {}, create: <T,>(styles: T) => styles },
  Text: "Text",
  TextInput: "TextInput",
  View: "View",
}));
vi.mock("@hugeicons/react-native", () => ({ HugeiconsIcon: "HugeiconsIcon" }));
vi.mock("../media/native-webrtc", () => ({ RTCView: "RTCView" }));
vi.mock("../ui/native-theme", () => ({ useNativeTheme: () => theme }));
vi.mock("./FaceAvatar", () => ({ FaceAvatar: "FaceAvatar" }));
vi.mock("./native-entrance/useEntranceController", () => ({ useEntranceController: () => controller }));

import { EntranceViewAndroid } from "./EntranceView.android";

describe("EntranceViewAndroid", () => {
  it("applies the active theme to its native surface and media controls", () => {
    const entrance = EntranceViewAndroid({ onJoin: vi.fn(), spaceName: "Design review" });
    const screen = findElements(entrance, (element) => element.type === "KeyboardAvoidingView")[0];
    const mediaControl = findElements(entrance, (element) => element.type === "Pressable" && !element.props.accessibilityLabel)[0];
    const mediaStyle = mediaControl?.props.style as ((state: { readonly pressed: boolean }) => unknown) | undefined;

    expect(JSON.stringify(screen?.props.style)).toContain(theme.colors.background);
    expect(JSON.stringify(mediaStyle?.({ pressed: false }))).toContain(theme.colors.controlsBackground);
  });

  it("omits the Android cancel control when no cancellation handler is supplied", () => {
    const withoutCancel = EntranceViewAndroid({ onJoin: vi.fn(), spaceName: "Design review" });
    const withCancel = EntranceViewAndroid({ onCancel: vi.fn(), onJoin: vi.fn(), spaceName: "Design review" });

    expect(findElements(withoutCancel, (element) => element.props.accessibilityLabel === "Cancel and leave Entrance")).toHaveLength(0);
    expect(findElements(withCancel, (element) => element.props.accessibilityLabel === "Cancel and leave Entrance")).toHaveLength(1);
  });
});

interface NativeElementProps {
  readonly accessibilityLabel?: string;
  readonly children?: ReactNode;
  readonly style?: unknown;
}

function findElements(node: ReactNode, matches: (element: ReactElement<NativeElementProps>) => boolean): ReactElement<NativeElementProps>[] {
  const found: ReactElement<NativeElementProps>[] = [];
  if (!isValidElement<NativeElementProps>(node)) {
    return found;
  }

  if (matches(node)) {
    found.push(node);
  }

  const children = node.props.children;
  for (const child of Array.isArray(children) ? children : [children]) {
    if (child !== undefined && child !== null) {
      found.push(...findElements(child, matches));
    }
  }
  return found;
}
