import { describe, expect, it, vi } from "vitest";

const animationState = vi.hoisted(() => ({
  cleanups: [] as Array<() => void>,
  loops: [] as Array<{ readonly start: ReturnType<typeof vi.fn>; readonly stop: ReturnType<typeof vi.fn> }>,
  values: [] as Array<{ readonly initial: number; readonly interpolate: ReturnType<typeof vi.fn> }>,
}));

vi.mock("react", () => ({
  useEffect: (effect: () => (() => void) | undefined) => {
    const cleanup = effect();
    if (cleanup) animationState.cleanups.push(cleanup);
  },
  useRef: <T,>(current: T) => ({ current }),
}));
vi.mock("react-native", () => ({
  Animated: {
    Value: class {
      readonly initial: number;

      interpolate = vi.fn((config: unknown) => ({ config, source: this }));

      constructor(initial: number) {
        this.initial = initial;
        animationState.values.push(this);
      }
    },
    createAnimatedComponent: (component: unknown) => component,
    delay: vi.fn((duration: number) => ({ duration, kind: "delay" })),
    loop: vi.fn(() => {
      const animation = { start: vi.fn(), stop: vi.fn() };
      animationState.loops.push(animation);
      return animation;
    }),
    sequence: vi.fn((animations: readonly unknown[]) => ({ animations, kind: "sequence" })),
    timing: vi.fn((value: unknown, config: unknown) => ({ config, kind: "timing", value })),
  },
}));
vi.mock("react-native-svg", () => ({
  Circle: "Circle",
  Ellipse: "Ellipse",
  G: "G",
  Path: "Path",
  Rect: "Rect",
  default: "Svg",
}));

import { BrandMark } from "./BrandMark";

describe("BrandMark", () => {
  it("renders the canonical mark at the requested size and animates its four layers", () => {
    animationState.cleanups.length = 0;
    animationState.loops.length = 0;
    animationState.values.length = 0;

    const rendered = BrandMark({ size: 96 });
    const children = rendered.props.children as readonly unknown[];

    expect(rendered.type).toBe("Svg");
    expect(rendered.props).toMatchObject({ height: 96, viewBox: "0 0 64 64", width: 96 });
    expect(children).toHaveLength(8);
    expect(animationState.values).toHaveLength(4);
    expect(animationState.loops).toHaveLength(4);
    expect(animationState.loops.every(({ start }) => start.mock.calls.length === 1)).toBe(true);
  });

  it("stops every animation when the mark unmounts", () => {
    animationState.cleanups.length = 0;
    animationState.loops.length = 0;
    animationState.values.length = 0;

    BrandMark({});

    expect(animationState.cleanups).toHaveLength(1);
    animationState.cleanups[0]?.();
    expect(animationState.loops.every(({ stop }) => stop.mock.calls.length === 1)).toBe(true);
  });
});
