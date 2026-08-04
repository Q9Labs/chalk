import { createElement, isValidElement, type ReactNode } from "react";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

vi.mock("react-native", () => ({
  StyleSheet: { create: (styles: unknown) => styles },
  View: "View",
}));
vi.mock("@q9labsai/chalk-react-native", () => ({
  ChalkProvider: (props: Record<string, unknown>) => createElement("ChalkProvider", props, props.children as ReactNode),
  ConferenceView: (props: Record<string, unknown>) => createElement("SpaceView", props),
  EndScreen: (props: Record<string, unknown>) => createElement("EndScreen", props),
  JoinFailedScreen: (props: Record<string, unknown>) => createElement("JoinFailedScreen", props),
}));

import { DEFAULT_PREVIEW_SEARCH } from "./preview-state";
import { SpacePreviewSurface } from "./SpacePreviewSurface";

const TRANSPORT_MARKERS = ["createClient", "createChalk"].map((prefix) => `${prefix}${["S", "ession"].join("")}`);

describe("SpacePreviewSurface", () => {
  it("keeps Space failure mounted and wires production recovery callbacks", () => {
    const onSearchChange = vi.fn();
    const search = { ...DEFAULT_PREVIEW_SEARCH, view: "space" as const, state: "failure" as const };
    const element = SpacePreviewSurface({ onClose: vi.fn(), search, onSearchChange });

    expect(findByTestId(element, "dev-preview-space")).toBeDefined();
    const failed = findByType(element, "JoinFailedScreen");
    const onRetry = failed.props.onRetry;
    if (typeof onRetry !== "function") throw new Error("Production JoinFailedScreen retry callback missing");
    onRetry();
    expect(onSearchChange).toHaveBeenCalledWith({ view: "space", state: "happy" });
  });

  it("renders ChalkProvider and the production Space view with the deterministic store", () => {
    const search = { ...DEFAULT_PREVIEW_SEARCH, view: "space" as const, state: "happy" as const };
    const element = SpacePreviewSurface({ onClose: vi.fn(), search, onSearchChange: vi.fn() });
    const provider = findByType(element, "ChalkProvider");
    const spaceView = findByType(element, "SpaceView");

    expect(provider).toBeDefined();
    expect(Object.values(spaceView.props)).toContain("Design review Space");
    expect(spaceView.props.initialState).toMatchObject({ layout: "focus", panel: null, settingsOpen: false, whiteboardOpen: false });
  });

  it("keeps empty and recoverable lifecycle states inside the production Space view", () => {
    for (const state of ["empty", "reconnecting", "retry", "warning"] as const) {
      const element = SpacePreviewSurface({ onClose: vi.fn(), search: { ...DEFAULT_PREVIEW_SEARCH, view: "space", state }, onSearchChange: vi.fn() });
      expect(findByType(element, "SpaceView")).toBeDefined();
    }
  });

  it("routes the whiteboard stage to the production whiteboard surface", () => {
    const element = SpacePreviewSurface({ onClose: vi.fn(), search: { ...DEFAULT_PREVIEW_SEARCH, view: "space", stage: "whiteboard" }, onSearchChange: vi.fn() });
    const spaceView = findByType(element, "SpaceView");

    expect(spaceView.props.features).toMatchObject({ whiteboard: true });
    expect(spaceView.props.initialState).toMatchObject({ whiteboardOpen: true });
    expect(spaceView.props.controlledState).toMatchObject({ whiteboardOpen: true });
  });

  it("keeps the production Space mounted while gallery controls change", () => {
    const people = findByType(SpacePreviewSurface({ onClose: vi.fn(), search: { ...DEFAULT_PREVIEW_SEARCH, view: "space", stage: "people" }, onSearchChange: vi.fn() }), "SpaceView");
    const whiteboard = findByType(
      SpacePreviewSurface({
        onClose: vi.fn(),
        search: { ...DEFAULT_PREVIEW_SEARCH, view: "space", layout: "presentation", panel: "participants", stage: "whiteboard", dialog: "settings" },
        onSearchChange: vi.fn(),
      }),
      "SpaceView",
    );

    expect(whiteboard.props.key).toBeUndefined();
    expect(whiteboard.props.controlledState).toMatchObject({ layout: "presentation", panel: "participants", settingsOpen: true, whiteboardOpen: true });
    expect(people.type).toBe(whiteboard.type);
  });

  it("uses the production EndScreen for an ended Episode", () => {
    const onSearchChange = vi.fn();
    const element = SpacePreviewSurface({ onClose: vi.fn(), search: { ...DEFAULT_PREVIEW_SEARCH, view: "space", state: "ended" }, onSearchChange });
    const ended = findByType(element, "EndScreen");

    expect(Object.values(ended.props.data as Record<string, unknown>)).toEqual(expect.arrayContaining(["preview-space", "Design review Space"]));
    if (typeof ended.props.onRejoin !== "function") throw new Error("Production EndScreen rejoin callback missing");
    ended.props.onRejoin();
    expect(onSearchChange).toHaveBeenCalledWith({ view: "space", state: "happy" });
  });

  it("keeps network and media APIs out of the production surface and fixture", () => {
    const surface = readFileSync(new URL("./SpacePreviewSurface.tsx", import.meta.url), "utf8");
    const fixture = readFileSync(new URL("./sdk-preview-store.ts", import.meta.url), "utf8");

    const forbiddenTransportPattern = new RegExp(`\\b(?:${[...TRANSPORT_MARKERS, "fetch", "WebSocket", "MediaStreamTrack", "getUserMedia", "telemetry"].join("|")})\\b`, "u");
    expect(`${surface}\n${fixture}`).not.toMatch(forbiddenTransportPattern);
    expect(surface).not.toContain("key={`${search.");
  });
});

function findByTestId(node: ReactNode, testID: string): { readonly props: Record<string, unknown>; readonly type: unknown } {
  return findBy(node, (props) => props.testID === testID);
}

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
