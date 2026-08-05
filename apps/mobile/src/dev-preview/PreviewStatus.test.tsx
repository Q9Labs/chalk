import { isValidElement, type ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

vi.mock("react-native", () => ({
  Pressable: "Pressable",
  StyleSheet: { create: (styles: unknown) => styles },
  Text: "Text",
  View: "View",
}));

import { PreviewStatus } from "./PreviewStatus";

describe("PreviewStatus", () => {
  it("projects the live status message and optional recovery actions", () => {
    const onBack = vi.fn();
    const onRetry = vi.fn();
    const element = PreviewStatus({ message: "Waiting for admission to Design review Space", onBack, onRetry, title: "Waiting for admission" });

    expect(element.props.accessibilityLiveRegion).toBe("polite");
    expect(findText(element, "Waiting for admission")).toBeDefined();
    expect(findText(element, "Waiting for admission to Design review Space")).toBeDefined();

    const buttons = findAllByType(element, "Pressable");
    expect(buttons).toHaveLength(2);
    const [back, retry] = buttons;
    if (!back || !retry) throw new Error("Status actions are missing");
    expect(findText(back.props.children as ReactNode, "Back")).toBeDefined();
    expect(findText(retry.props.children as ReactNode, "Try again")).toBeDefined();
    if (typeof back.props.onPress !== "function" || typeof retry.props.onPress !== "function") throw new Error("Status actions are missing onPress");
    back.props.onPress();
    retry.props.onPress();
    expect(onBack).toHaveBeenCalledOnce();
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it("does not render action controls when no recovery callbacks are supplied", () => {
    const element = PreviewStatus({ message: "The Space is unavailable.", title: "Could not enter the Space" });

    expect(findText(element, "Could not enter the Space")).toBeDefined();
    expect(findText(element, "The Space is unavailable.")).toBeDefined();
    expect(findAllByType(element, "Pressable")).toHaveLength(0);
  });
});

function findText(node: ReactNode, text: string): ElementInfo {
  return findBy(node, (props) => findTextValue(props.children) === text);
}

function findTextValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(findTextValue).join("");
  return "";
}

function findAllByType(node: ReactNode, typeName: string): readonly ElementInfo[] {
  if (!isValidElement(node)) {
    if (!Array.isArray(node)) return [];
    return node.flatMap((child) => findAllByType(child, typeName));
  }

  const props = node.props as Record<string, unknown>;
  const current = typeof node.type === "string" && node.type === typeName ? [{ props: { ...props, __typeName: node.type }, type: node.type }] : [];
  const children = Array.isArray(props.children) ? props.children : [props.children];
  return [...current, ...children.flatMap((child) => findAllByType(child, typeName))];
}

function findBy(node: ReactNode, predicate: (props: Record<string, unknown>) => boolean): ElementInfo {
  if (!isValidElement(node)) {
    if (Array.isArray(node)) {
      for (const child of node) {
        try {
          return findBy(child, predicate);
        } catch {
          continue;
        }
      }
    }
    throw new Error("Status element not found");
  }

  const props = node.props as Record<string, unknown>;
  const searchableProps = typeof node.type === "string" ? { ...props, __typeName: node.type } : props;
  if (predicate(searchableProps)) return { props: searchableProps, type: node.type };
  const children = Array.isArray(props.children) ? props.children : [props.children];
  for (const child of children) {
    try {
      return findBy(child, predicate);
    } catch {
      continue;
    }
  }
  throw new Error("Status element not found");
}

interface ElementInfo {
  readonly props: Record<string, unknown>;
  readonly type: unknown;
}
