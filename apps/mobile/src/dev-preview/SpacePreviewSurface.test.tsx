import { createElement, isValidElement, type ReactNode } from "react";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

vi.mock("react-native", () => ({
  Pressable: "Pressable",
  StyleSheet: { create: (styles: unknown) => styles },
  Text: "Text",
  View: "View",
}));
vi.mock("@q9labsai/chalk-react-native", () => ({ Chalk: (props: Record<string, unknown>) => createElement("Chalk", props) }));

import { DEFAULT_PREVIEW_SEARCH } from "./preview-state";
import { SpacePreviewSurface } from "./SpacePreviewSurface";

describe("SpacePreviewSurface", () => {
  it("keeps Space failure recovery in a local status surface", () => {
    const onSearchChange = vi.fn();
    const search = { ...DEFAULT_PREVIEW_SEARCH, view: "space" as const, state: "failure" as const };
    const element = SpacePreviewSurface({ onClose: vi.fn(), search, onSearchChange });

    expect(findText(element, "Could not enter the Space")).toBe(true);
    const buttons = findAllByType(element, "Pressable");
    const retry = buttons.at(-1);
    if (!retry || typeof retry.props.onPress !== "function") throw new Error("Retry button missing");
    retry.props.onPress();
    expect(onSearchChange).toHaveBeenCalledWith({ view: "space", state: "happy" });
  });

  it("renders the canonical Chalk surface with a deterministic SpaceClient", () => {
    const search = { ...DEFAULT_PREVIEW_SEARCH, view: "space" as const, state: "happy" as const };
    const element = SpacePreviewSurface({ onClose: vi.fn(), search, onSearchChange: vi.fn() });
    const chalk = findByType(element, "Chalk");

    expect(chalk.props.spaceName).toBe("Design review Space");
    expect(chalk.props.layout).toBe("focus");
    expect(chalk.props.features).toMatchObject({ chat: true, handRaise: true, participants: true, whiteboard: true });
    expect((chalk.props.client as { getSnapshot: () => { connection: unknown } }).getSnapshot()).toHaveProperty("connection");
  });

  it("keeps empty and recoverable lifecycle states inside the canonical Chalk surface", () => {
    for (const state of ["empty", "reconnecting", "retry", "warning"] as const) {
      const element = SpacePreviewSurface({ onClose: vi.fn(), search: { ...DEFAULT_PREVIEW_SEARCH, view: "space", state }, onSearchChange: vi.fn() });
      expect(findByType(element, "Chalk")).toBeDefined();
    }
  });

  it("projects the whiteboard stage into the canonical client snapshot", () => {
    const element = SpacePreviewSurface({ onClose: vi.fn(), search: { ...DEFAULT_PREVIEW_SEARCH, view: "space", stage: "whiteboard" }, onSearchChange: vi.fn() });
    const chalk = findByType(element, "Chalk");
    const snapshot = (chalk.props.client as { getSnapshot: () => { whiteboard: { open: boolean } } }).getSnapshot();

    expect(snapshot.whiteboard.open).toBe(true);
  });

  it("keeps the canonical Chalk surface mounted while gallery controls change", () => {
    const people = findByType(SpacePreviewSurface({ onClose: vi.fn(), search: { ...DEFAULT_PREVIEW_SEARCH, view: "space", stage: "people" }, onSearchChange: vi.fn() }), "Chalk");
    const whiteboard = findByType(SpacePreviewSurface({ onClose: vi.fn(), search: { ...DEFAULT_PREVIEW_SEARCH, view: "space", layout: "presentation", panel: "participants", stage: "whiteboard", dialog: "settings" }, onSearchChange: vi.fn() }), "Chalk");

    expect(people.type).toBe(whiteboard.type);
    expect((whiteboard.props.client as { getSnapshot: () => { whiteboard: { open: boolean }; participants: unknown } }).getSnapshot()).toMatchObject({ whiteboard: { open: true } });
  });

  it("uses a local Episode-complete status for an ended Episode", () => {
    const onSearchChange = vi.fn();
    const element = SpacePreviewSurface({ onClose: vi.fn(), search: { ...DEFAULT_PREVIEW_SEARCH, view: "space", state: "ended" }, onSearchChange });

    expect(findText(element, "This Episode has ended.")).toBe(true);
    const buttons = findAllByType(element, "Pressable");
    const retry = buttons.at(-1);
    if (!retry || typeof retry.props.onPress !== "function") throw new Error("Episode retry button missing");
    retry.props.onPress();
    expect(onSearchChange).toHaveBeenCalledWith({ view: "space", state: "happy" });
  });

  it("keeps network and media APIs out of the production surface and fixture", () => {
    const surface = readFileSync(new URL("./SpacePreviewSurface.tsx", import.meta.url), "utf8");
    const fixture = readFileSync(new URL("./sdk-preview-store.ts", import.meta.url), "utf8");

    expect(`${surface}\n${fixture}`).not.toMatch(/\b(?:fetch|WebSocket|MediaStreamTrack|getUserMedia|telemetry)\b/u);
    expect(surface).not.toContain("key={`${search.");
  });
});

function findByType(node: ReactNode, typeName: string): { readonly props: Record<string, unknown>; readonly type: unknown } {
  return findBy(node, (props) => props.__typeName === typeName);
}

function findText(node: ReactNode, text: string): boolean {
  try {
    findBy(node, (props) => findTextValue(props.children).includes(text));
    return true;
  } catch {
    return false;
  }
}

function findTextValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(findTextValue).join("");
  return "";
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
