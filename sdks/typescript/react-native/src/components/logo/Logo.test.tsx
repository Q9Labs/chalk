// @vitest-environment happy-dom
import type { ReactElement, ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { act, renderHook } from "../../test-support/test-renderer";

const mocks = vi.hoisted(() => {
  const animationStops: ReturnType<typeof vi.fn>[] = [];
  const createAnimation = (config?: unknown) => {
    const stop = vi.fn();
    animationStops.push(stop);
    return { config, start: vi.fn(), stop };
  };
  class AnimatedValue {
    readonly initial: number;
    readonly setValue = vi.fn();
    readonly stopAnimation = vi.fn();
    constructor(initial: number) {
      this.initial = initial;
    }
    interpolate(input: unknown): { readonly input: unknown } {
      return { input };
    }
  }

  return {
    accessibilityInfo: {
      addEventListener: vi.fn(() => ({ remove: vi.fn() })),
      isReduceMotionEnabled: vi.fn(() => Promise.resolve(false)),
    },
    animationStops,
    animation: {
      delay: vi.fn((duration: number) => createAnimation({ duration })),
      loop: vi.fn((animation: unknown) => createAnimation({ animation })),
      parallel: vi.fn((animations: readonly unknown[]) => createAnimation({ animations })),
      sequence: vi.fn((animations: readonly unknown[]) => createAnimation({ animations })),
      timing: vi.fn((_value: unknown, config: unknown) => createAnimation(config)),
      Value: AnimatedValue,
    },
  };
});

vi.mock("react-native", () => ({ AccessibilityInfo: mocks.accessibilityInfo, Animated: { ...mocks.animation, createAnimatedComponent: (component: unknown) => component }, Pressable: "Pressable" }));
vi.mock("react-native-svg", () => ({ Defs: "Defs", Ellipse: "Ellipse", G: "G", LinearGradient: "LinearGradient", Path: "Path", Stop: "Stop", Text: "SvgText", default: "Svg" }));

import { Logo } from "./Logo";

describe("Logo", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.animationStops.length = 0;
    mocks.accessibilityInfo.isReduceMotionEnabled.mockResolvedValue(false);
  });

  it("uses the canonical mark geometry and keeps the wordmark static", () => {
    const { result } = renderHook(() => Logo({ accessibilityLabel: "Brand", color: "#123456", height: 96 }));
    const pressable = result.current;
    const svg = findElement(pressable, "Svg");

    expect(svg).toMatchObject({ props: { accessibilityLabel: "Brand", accessible: true, color: "#123456", height: 96, viewBox: "0 0 200 80", width: 240 } });
    expect(findElements(svg, "Path")).toHaveLength(4);
    expect(findElements(svg, "Ellipse")).toHaveLength(4);
    expect(findElements(svg, "SvgText")).toMatchObject([{ props: { fill: "currentColor", children: "chalk" } }]);
    expect(findElements(svg, "G")).toHaveLength(5);
    expect(findElements(svg, "SvgText")[0].props).not.toHaveProperty("rotation");
  });

  it("renders the mark fallback without adding an announced button", () => {
    const { result } = renderHook(() => Logo({ accessibilityLabel: null, height: 24, motion: "none", variant: "mark" }));
    const pressable = result.current;
    const svg = findElement(pressable, "Svg");

    expect(pressable.props).toMatchObject({ accessible: false });
    expect(svg).toMatchObject({ props: { accessible: false, height: 24, viewBox: "0 0 68 80", width: 20.4 } });
    expect(findElements(svg, "SvgText")).toHaveLength(0);
  });

  it("uses orbit by default and switches only the sticks to burst while active", async () => {
    const { result } = renderHook(() => Logo({}));
    await act(async () => await Promise.resolve());

    const initialTimingCount = mocks.animation.timing.mock.calls.length;
    act(() => {
      result.current.props.onHoverIn();
    });

    expect(mocks.animation.timing.mock.calls.length).toBeGreaterThan(initialTimingCount);
    expect(mocks.animation.timing.mock.calls.slice(initialTimingCount).map(([, config]) => (config as { readonly toValue: number }).toValue)).toEqual(expect.arrayContaining([-14, -9, -4, -14, 14, -6, 11, 12, 1.14, 1.16, 1.13]));
    expect(findElements(result.current, "SvgText")[0].props).not.toHaveProperty("rotation");

    act(() => {
      result.current.props.onHoverOut();
    });
    expect(mocks.animation.timing.mock.calls.length).toBeGreaterThan(initialTimingCount + 12);
  });

  it("does not start animations when reduced motion is enabled and removes the listener", async () => {
    mocks.accessibilityInfo.isReduceMotionEnabled.mockResolvedValue(true);
    const { result, unmount } = renderHook(() => Logo({}));
    await act(async () => await Promise.resolve());

    expect(mocks.animation.timing).not.toHaveBeenCalled();
    unmount();
    expect(mocks.accessibilityInfo.addEventListener.mock.results[0]?.value.remove).toHaveBeenCalledTimes(1);
    expect(findElements(result.current, "Svg")).toHaveLength(1);
  });

  it("stops the active orbit when the logo unmounts", async () => {
    const { unmount } = renderHook(() => Logo({}));
    await act(async () => await Promise.resolve());

    unmount();

    expect(mocks.animationStops.some((stop) => stop.mock.calls.length > 0)).toBe(true);
  });
});

function findElement(node: ReactNode, type: string): ReactElement<{ readonly children?: ReactNode; readonly [key: string]: unknown }> {
  if (isElement(node) && node.type === type) return node;
  if (!isElement(node)) throw new Error(`Expected ${type}`);
  const children = Array.isArray(node.props.children) ? node.props.children : [node.props.children];
  for (const child of children) {
    if (isElement(child) && child.type === type) return child;
    if (isElement(child)) {
      try {
        return findElement(child, type);
      } catch {
        continue;
      }
    }
  }
  throw new Error(`Expected ${type}`);
}

function findElements(node: ReactNode, type: string): ReactElement<{ readonly children?: ReactNode; readonly [key: string]: unknown }>[] {
  if (!isElement(node)) return [];
  const matches = node.type === type ? [node] : [];
  const children = Array.isArray(node.props.children) ? node.props.children : [node.props.children];
  return matches.concat(children.flatMap((child) => findElements(child, type)));
}

function isElement(node: ReactNode): node is ReactElement<{ readonly children?: ReactNode; readonly [key: string]: unknown }> {
  return typeof node === "object" && node !== null && "type" in node && "props" in node;
}
