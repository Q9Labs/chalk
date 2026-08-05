// @vitest-environment happy-dom
import type { ReactElement, ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

import { renderHook } from "../test-support/test-renderer";

vi.mock("react-native", () => {
  class AnimatedValue {
    interpolate(input: unknown): { readonly input: unknown } {
      return { input };
    }
  }

  return {
    Animated: {
      Value: AnimatedValue,
      createAnimatedComponent: (component: unknown) => component,
    },
  };
});
vi.mock("react-native-svg", () => ({ Circle: "Circle", Ellipse: "Ellipse", G: "G", Path: "Path", Rect: "Rect", default: "Svg" }));
vi.mock("./native-animation-controller", () => ({ createAnimationRefController: () => () => undefined }));

import Svg from "react-native-svg";
import { LogoElements } from "./LogoElements";

describe("LogoElements", () => {
  it("uses the requested size and keeps the complete canonical mark composition", () => {
    const { result } = renderHook(() => LogoElements({ size: 96 }));
    const tree = result.current;

    expect(tree.type).toBe(Svg);
    expect(tree.props).toMatchObject({ height: 96, viewBox: "0 0 64 64", width: 96 });
    expect(findElements(tree, "Path")).toHaveLength(1);
    expect(findElements(tree, "Circle")).toHaveLength(3);
    expect(findElements(tree, "Rect")).toHaveLength(4);
    expect(findElements(tree, "Ellipse")).toHaveLength(4);
  });

  it("preserves the brand palette across each logo bar and particle", () => {
    const { result } = renderHook(() => LogoElements({}));
    const tree = result.current;
    const fills = findElements(tree, "Rect").map((element) => element.props.fill);
    const particleFills = findElements(tree, "Circle").map((element) => element.props.fill);

    expect(fills).toEqual(["#A8D5A2", "#F5D76E", "#7EC8E3", "#F0A0A0"]);
    expect(particleFills).toEqual(["#A8D5A2", "#F5D76E", "#7EC8E3"]);
  });
});

function findElements(node: ReactNode, type: string): ReactElement<{ readonly fill?: string }>[] {
  if (!isElement(node)) return [];
  const matches = node.type === type ? [node] : [];
  const children = node.props.children;
  return matches.concat((Array.isArray(children) ? children : [children]).flatMap((child) => findElements(child, type)));
}

function isElement(node: ReactNode): node is ReactElement<{ readonly children?: ReactNode; readonly fill?: string }> {
  return typeof node === "object" && node !== null && "type" in node && "props" in node;
}
