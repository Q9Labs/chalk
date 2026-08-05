import { isValidElement, type ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

vi.mock("react-native", () => ({
  Pressable: "Pressable",
  StyleSheet: { create: (styles: unknown) => styles },
  Text: "Text",
  TextInput: "TextInput",
  View: "View",
}));

import { EntrancePreviewFixture } from "./EntrancePreviewFixture";

describe("EntrancePreviewFixture", () => {
  it("renders deterministic preview settings and forwards a join without device access", () => {
    const onCancel = vi.fn();
    const onJoin = vi.fn();
    const element = EntrancePreviewFixture({
      defaultDisplayName: "Ada Lovelace",
      defaults: { camera: false, microphone: true },
      error: "Device access needs attention.",
      onCancel,
      onJoin,
      spaceName: "Design review Space",
    });

    expect(findByTestId(element, "dev-preview-entrance")).toBeDefined();
    expect(findText(element, "Design review Space")).toBeDefined();
    expect(findText(element, "AL")).toBeDefined();
    expect(findText(element, "Microphone: On")).toBeDefined();
    expect(findText(element, "Camera: Off")).toBeDefined();
    expect(findText(element, "Device access needs attention.")).toBeDefined();

    const enter = findByLabel(element, "Enter Space");
    expect(enter.props.disabled).toBe(false);
    expect(enter.props.accessibilityState).toEqual({ disabled: false });
    if (typeof enter.props.onPress !== "function") throw new Error("Enter button is missing onPress");
    enter.props.onPress();
    expect(onJoin).toHaveBeenCalledWith({ camera: false, displayName: "Ada Lovelace", microphone: true });

    const cancel = findByLabel(element, "Cancel and leave Entrance");
    if (typeof cancel.props.onPress !== "function") throw new Error("Cancel button is missing onPress");
    cancel.props.onPress();
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it("shows a non-interactive entering state while preserving the chosen defaults", () => {
    const onJoin = vi.fn();
    const element = EntrancePreviewFixture({
      defaultDisplayName: "Grace Hopper",
      defaults: { camera: true, microphone: false },
      joining: true,
      onJoin,
      spaceName: "Engineering Space",
    });

    const enter = findByLabel(element, "Enter Space");
    expect(enter.props.disabled).toBe(true);
    expect(enter.props.accessibilityState).toEqual({ disabled: true });
    expect(findText(element, "Entering…")).toBeDefined();
    expect(findText(element, "Microphone: Off")).toBeDefined();
    expect(findText(element, "Camera: On")).toBeDefined();
    expect(onJoin).not.toHaveBeenCalled();
  });
});

function findByTestId(node: ReactNode, testID: string): ElementInfo {
  return findBy(node, (props) => props.testID === testID);
}

function findByLabel(node: ReactNode, accessibilityLabel: string): ElementInfo {
  return findBy(node, (props) => props.accessibilityLabel === accessibilityLabel);
}

function findText(node: ReactNode, text: string): ElementInfo {
  return findBy(node, (props) => findTextValue(props.children) === text);
}

function findTextValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(findTextValue).join("");
  return "";
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
    throw new Error("Preview fixture element not found");
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
  throw new Error("Preview fixture element not found");
}

interface ElementInfo {
  readonly props: Record<string, unknown>;
  readonly type: unknown;
}
