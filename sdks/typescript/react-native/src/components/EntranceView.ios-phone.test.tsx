// @vitest-environment happy-dom
import type { ReactElement, ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { renderHook } from "../test-support/test-renderer";

const controller = vi.hoisted(() => ({
  displayName: "Ada",
  audioEnabled: true,
  videoEnabled: true,
  isSubmitting: false,
  isInputFocused: false,
  previewError: null,
  previewStream: null as { toURL: () => string } | null,
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
  Platform: { OS: "ios" },
  Pressable: "Pressable",
  StyleSheet: { absoluteFillObject: {}, create: <T,>(styles: T) => styles },
  Text: "Text",
  TextInput: "TextInput",
  View: "View",
}));
vi.mock("@cloudflare/react-native-webrtc", () => ({ RTCView: "RTCView" }));
vi.mock("@hugeicons/react-native", () => ({ HugeiconsIcon: "HugeiconsIcon" }));
vi.mock("./FaceAvatar", () => ({ FaceAvatar: "FaceAvatar" }));
vi.mock("../ui/native-theme", () => ({ useNativeTheme: () => theme }));
vi.mock("../utils/ios-simulator", () => ({ getIosSimulatorMediaMessage: () => "Media is unavailable in the simulator." }));
vi.mock("./native-entrance/useEntranceController", () => ({ useEntranceController: () => controller }));

import { EntranceViewIosPhone } from "./EntranceView.ios-phone";

beforeEach(() => {
  controller.displayName = "Ada";
  controller.audioEnabled = true;
  controller.videoEnabled = true;
  controller.isSubmitting = false;
  controller.isInputFocused = false;
  controller.previewError = null;
  controller.previewStream = null;
  controller.simulatorMediaDisabled = false;
  controller.setDisplayName.mockReset();
  controller.setInputFocused.mockReset();
  controller.toggleAudio.mockReset();
  controller.toggleVideo.mockReset();
  controller.handleJoin.mockReset();
});

describe("EntranceViewIosPhone", () => {
  it("renders the phone preview sheet with the canonical Space title and join controls", () => {
    const onCancel = vi.fn();
    const { result } = renderHook(() => EntranceViewIosPhone({ onCancel, onJoin: vi.fn(), spaceName: "Design review" }));
    const tree = result.current;
    const screen = findElement(tree, "KeyboardAvoidingView");
    const cancel = findElement(tree, "Pressable", (element) => element.props.accessibilityLabel === "Cancel and leave Entrance");
    const textInput = findElement(tree, "TextInput");
    const join = findText(tree).find((text) => text === "Enter Space");

    expect(screen?.props.style).toEqual(expect.arrayContaining([expect.objectContaining({ backgroundColor: theme.colors.background })]));
    expect(findText(tree)).toContain("Design review");
    expect(cancel).toBeDefined();
    expect(textInput?.props.placeholder).toBe("Enter your name");
    expect(join).toBe("Enter Space");

    cancel?.props.onPress();
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it("mounts the RTC preview only when the controller supplies an enabled stream", () => {
    controller.previewStream = { toURL: () => "stream://preview" };

    const { result } = renderHook(() => EntranceViewIosPhone({ onJoin: vi.fn(), spaceName: "Live Space" }));
    const preview = findElement(result.current, "RTCView");

    expect(preview?.props).toMatchObject({ mirror: true, objectFit: "cover", streamURL: "stream://preview" });
  });
});

interface NativeElementProps {
  readonly accessibilityLabel?: string;
  readonly children?: ReactNode;
  readonly onPress?: () => void;
  readonly placeholder?: string;
  readonly props?: unknown;
  readonly style?: unknown;
}

function findElement(node: ReactNode, type: string, matches: (element: ReactElement<NativeElementProps>) => boolean = () => true): ReactElement<NativeElementProps> | undefined {
  if (!isElement(node)) return undefined;
  if (node.type === type && matches(node)) return node;

  const children = node.props.children;
  for (const child of Array.isArray(children) ? children : [children]) {
    const found = findElement(child, type, matches);
    if (found) return found;
  }
  return undefined;
}

function findText(node: ReactNode): string[] {
  if (typeof node === "string") return [node];
  if (!isElement(node)) return [];
  const children = node.props.children;
  return (Array.isArray(children) ? children : [children]).flatMap(findText);
}

function isElement(node: ReactNode): node is ReactElement<NativeElementProps> {
  return typeof node === "object" && node !== null && "type" in node && "props" in node;
}
