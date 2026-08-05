import { isValidElement, type ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

const getUserMedia = vi.hoisted(() => vi.fn());

vi.mock("react-native", () => ({
  Pressable: "Pressable",
  StyleSheet: { create: (styles: unknown) => styles },
  Text: "Text",
  TextInput: "TextInput",
  View: "View",
}));
vi.mock("@cloudflare/react-native-webrtc", () => ({ mediaDevices: { getUserMedia } }));

import { EntrancePreviewSurface } from "./EntrancePreviewSurface";
import { DEFAULT_PREVIEW_SEARCH } from "./preview-state";

describe("EntrancePreviewSurface", () => {
  it("renders the canonical Entrance settings boundary without requesting device access", () => {
    const onSearchChange = vi.fn();
    const onClose = vi.fn();
    const element = EntrancePreviewSurface({ onClose, search: DEFAULT_PREVIEW_SEARCH, onSearchChange });
    const entrance = findByTestId(element, "dev-preview-entrance");

    expect(entrance.props.testID).toBe("dev-preview-entrance");
    expect(getUserMedia).not.toHaveBeenCalled();

    const enterButton = findByLabel(element, "Enter Space");
    if (typeof enterButton.props.onPress !== "function") throw new Error("Entrance fixture is missing onPress");
    enterButton.props.onPress();

    expect(onSearchChange).toHaveBeenCalledWith({ camera: true, mic: true, state: "happy", view: "space" });
  });

  it("keeps the canonical device warning copy on the warning state", () => {
    const element = EntrancePreviewSurface({ onClose: vi.fn(), search: { ...DEFAULT_PREVIEW_SEARCH, state: "warning" }, onSearchChange: vi.fn() });

    expect(findByTestId(element, "dev-preview-entrance")).toBeDefined();
    expect(findText(element, "Device access needs attention.")).toBe(true);
  });

  it("uses a local status surface for Entrance lifecycle states", () => {
    expect(findText(EntrancePreviewSurface({ onClose: vi.fn(), search: { ...DEFAULT_PREVIEW_SEARCH, state: "joining" }, onSearchChange: vi.fn() }), "Preparing to enter")).toBe(true);
    expect(findText(EntrancePreviewSurface({ onClose: vi.fn(), search: { ...DEFAULT_PREVIEW_SEARCH, state: "waiting" }, onSearchChange: vi.fn() }), "Waiting for admission")).toBe(true);

    const onSearchChange = vi.fn();
    const failed = EntrancePreviewSurface({ onClose: vi.fn(), search: { ...DEFAULT_PREVIEW_SEARCH, state: "failure" }, onSearchChange });
    const buttons = findAllByType(failed, "Pressable");
    const retry = buttons.at(-1);
    if (!retry || typeof retry.props.onPress !== "function") throw new Error("Retry button missing");
    retry.props.onPress();
    expect(onSearchChange).toHaveBeenCalledWith({ view: "entrance", state: "ready" });
  });
});

function findByTestId(node: ReactNode, testID: string): { readonly props: Record<string, unknown>; readonly type: unknown } {
  return findBy(node, (props) => props.testID === testID);
}

function findByLabel(node: ReactNode, accessibilityLabel: string): { readonly props: Record<string, unknown>; readonly type: unknown } {
  return findBy(node, (props) => props.accessibilityLabel === accessibilityLabel);
}

function findText(node: ReactNode, text: string): boolean {
  try {
    findBy(node, (props) => findTextValue(props.children).includes(text));
    return true;
  } catch {
    return false;
  }
}

function findAllByType(node: ReactNode, typeName: string): readonly { readonly props: Record<string, unknown>; readonly type: unknown }[] {
  if (!isValidElement(node)) {
    if (!Array.isArray(node)) return [];
    return node.flatMap((child) => findAllByType(child, typeName));
  }

  const props = node.props as Record<string, unknown>;
  const current = typeof node.type === "string" && node.type === typeName ? [{ props: { ...props, __typeName: node.type }, type: node.type }] : [];
  const rendered = typeof node.type === "function" ? (node.type as (props: Record<string, unknown>) => ReactNode)(props) : null;
  const children = Array.isArray(props.children) ? props.children : [props.children];
  return [...current, ...findAllByType(rendered, typeName), ...children.flatMap((child) => findAllByType(child, typeName))];
}

function findTextValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(findTextValue).join("");
  return "";
}

function findBy(node: ReactNode, predicate: (props: Record<string, unknown>) => boolean): { readonly props: Record<string, unknown>; readonly type: unknown } {
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
    throw new Error("Fixture element not found");
  }

  const props = node.props as Record<string, unknown>;
  const searchableProps = typeof node.type === "string" ? { ...props, __typeName: node.type } : props;
  if (predicate(searchableProps)) return { props: searchableProps, type: node.type };
  if (typeof node.type === "function") {
    try {
      return findBy((node.type as (props: Record<string, unknown>) => ReactNode)(props), predicate);
    } catch {
      // Continue with the original element's children when a function component does not match.
    }
  }
  const children = Array.isArray(props.children) ? props.children : [props.children];
  for (const child of children) {
    try {
      return findBy(child, predicate);
    } catch {
      continue;
    }
  }
  throw new Error("Fixture element not found");
}
