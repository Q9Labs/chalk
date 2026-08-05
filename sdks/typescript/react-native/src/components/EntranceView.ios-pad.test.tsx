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
    mutedForeground: "#909192",
    error: "#dc2626",
    card: "#202122",
    surface: "#303132",
    border: "#707172",
    ring: "#808182",
    darkCanvas: "#010203",
    controlsBackground: "#606162",
  },
}));

vi.mock("react-native", () => {
  class AnimatedValue {
    interpolate(input: unknown): { readonly input: unknown } {
      return { input };
    }
  }

  return {
    ActivityIndicator: "ActivityIndicator",
    Animated: {
      Value: AnimatedValue,
      View: "Animated.View",
      delay: vi.fn(),
      loop: vi.fn(),
      sequence: vi.fn(),
      spring: vi.fn(),
      stagger: vi.fn(),
      timing: vi.fn(),
    },
    KeyboardAvoidingView: "KeyboardAvoidingView",
    Platform: { OS: "ios" },
    Pressable: "Pressable",
    StyleSheet: { absoluteFillObject: {}, create: <T,>(styles: T) => styles },
    Text: "Text",
    TextInput: "TextInput",
    View: "View",
  };
});
vi.mock("@hugeicons/react-native", () => ({ HugeiconsIcon: "HugeiconsIcon" }));
vi.mock("./FaceAvatar", () => ({ FaceAvatar: "FaceAvatar" }));
vi.mock("./RtcVideoView", () => ({ RtcVideoView: "RtcVideoView", hasRtcVideoView: () => false }));
vi.mock("../ui/native-theme", () => ({ useNativeTheme: () => theme }));
vi.mock("../utils/ios-simulator", () => ({ getIosSimulatorMediaMessage: () => "Media is unavailable in the simulator." }));
vi.mock("./native-animation-controller", () => ({ createAnimationRefController: () => () => undefined }));
vi.mock("./native-entrance/useEntranceController", () => ({ useEntranceController: () => controller }));

import { EntranceViewIosPad } from "./EntranceView.ios-pad";

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

describe("EntranceViewIosPad", () => {
  it("composes the immersive surface with themed title, media controls, and cancel action", () => {
    const onCancel = vi.fn();
    const { result } = renderHook(() => EntranceViewIosPad({ onCancel, onJoin: vi.fn(), spaceName: "Design review" }));
    const tree = result.current;

    const screen = findElement(tree, "KeyboardAvoidingView");
    const cancel = findElement(tree, "Pressable", (element) => element.props.accessibilityLabel === "Cancel and leave Entrance");
    const microphone = findElement(tree, "Pressable", (element) => element.props.accessibilityLabel === "Mute microphone");
    const camera = findElement(tree, "Pressable", (element) => element.props.accessibilityLabel === "Turn camera off");
    const join = findElement(tree, "Pressable", (element) => element.props.accessibilityLabel === "Enter Space");

    expect(screen?.props.style).toEqual(expect.arrayContaining([expect.objectContaining({ backgroundColor: theme.colors.background })]));
    expect(findText(tree)).toContain("Design review");
    expect(cancel).toBeDefined();
    expect(microphone).toBeDefined();
    expect(camera).toBeDefined();
    expect(join?.props.accessibilityState).toEqual({ disabled: false });

    cancel?.props.onPress();
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it("uses the avatar fallback and disables joining until a name is entered", () => {
    controller.displayName = "";

    const { result } = renderHook(() => EntranceViewIosPad({ onJoin: vi.fn(), spaceName: "Quiet Space" }));
    const tree = result.current;
    const join = findElement(tree, "Pressable", (element) => element.props.accessibilityLabel === "Enter Space");

    expect(findElement(tree, "FaceAvatar")).toBeDefined();
    expect(findElement(tree, "RtcVideoView")).toBeUndefined();
    expect(join?.props.accessibilityState).toEqual({ disabled: true });
    expect(findText(tree)).toContain("Quiet Space");
  });
});

interface NativeElementProps {
  readonly accessibilityLabel?: string;
  readonly accessibilityState?: unknown;
  readonly children?: ReactNode;
  readonly onPress?: () => void;
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
