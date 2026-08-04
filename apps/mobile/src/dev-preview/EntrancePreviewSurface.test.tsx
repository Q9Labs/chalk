import { isValidElement, type ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@q9labsai/chalk-react-native", () => ({
  JoinFailedScreen: "JoinFailedScreen",
  JoiningScreen: "JoiningScreen",
  PreJoinScreen: "PreJoinScreen",
}));

import { EntrancePreviewSurface } from "./EntrancePreviewSurface";
import { DEFAULT_PREVIEW_SEARCH } from "./preview-state";

describe("EntrancePreviewSurface", () => {
  it("renders the production PreJoinScreen without requesting device access", () => {
    const onSearchChange = vi.fn();
    const onClose = vi.fn();
    const element = EntrancePreviewSurface({ onClose, search: DEFAULT_PREVIEW_SEARCH, onSearchChange });
    const entrance = findBy(element, (props) => props.previewMode === "disabled");

    expect(entrance.props).toMatchObject({
      initialAudioEnabled: true,
      initialVideoEnabled: true,
      onCancel: onClose,
      userName: "Hasan",
    });
    expect(Object.values(entrance.props)).toContain("Design review Space");

    const onJoin = entrance.props.onJoin;
    if (typeof onJoin !== "function") throw new Error("Production Entrance is missing onJoin");
    onJoin({ displayName: "Hasan", microphoneEnabled: false, cameraEnabled: true });

    expect(onSearchChange).toHaveBeenCalledWith({ camera: true, dialog: "none", mic: false, panel: "none", state: "happy", view: "space" });
  });

  it("keeps the production device warning copy on the warning state", () => {
    const element = EntrancePreviewSurface({ onClose: vi.fn(), search: { ...DEFAULT_PREVIEW_SEARCH, state: "warning" }, onSearchChange: vi.fn() });

    expect(findBy(element, (props) => props.previewMode === "disabled").props.error).toBe("Device access needs attention.");
  });

  it("uses the production loading and failure screens for Entrance lifecycle states", () => {
    expect(findByType(EntrancePreviewSurface({ onClose: vi.fn(), search: { ...DEFAULT_PREVIEW_SEARCH, state: "joining" }, onSearchChange: vi.fn() }), "JoiningScreen").props.message).toContain("Preparing to enter");
    expect(findByType(EntrancePreviewSurface({ onClose: vi.fn(), search: { ...DEFAULT_PREVIEW_SEARCH, state: "waiting" }, onSearchChange: vi.fn() }), "JoiningScreen").props.message).toContain("Waiting for admission");

    const onSearchChange = vi.fn();
    const failed = findByType(EntrancePreviewSurface({ onClose: vi.fn(), search: { ...DEFAULT_PREVIEW_SEARCH, state: "failure" }, onSearchChange }), "JoinFailedScreen");
    expect(failed.props.supportCode).toBe("entrance-failure-403");
    if (typeof failed.props.onRetry !== "function") throw new Error("Production Entrance failure retry callback missing");
    failed.props.onRetry();
    expect(onSearchChange).toHaveBeenCalledWith({ view: "entrance", state: "ready" });
  });
});

function findByType(node: ReactNode, typeName: string): { readonly props: Record<string, unknown>; readonly type: unknown } {
  return findBy(node, (props) => props.__typeName === typeName);
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
  if (typeof node.type === "function") {
    try {
      return findBy((node.type as (props: Record<string, unknown>) => ReactNode)(props), predicate);
    } catch {
      // Continue with this element's children when a production stub returns no tree.
    }
  }
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
  throw new Error("Fixture element not found");
}
