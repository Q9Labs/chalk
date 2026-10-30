// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { BoardIsland, type IslandProps } from "./BoardIsland";

const roots: ReturnType<typeof createRoot>[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount());
  document.body.replaceChildren();
});

it.each([
  { device: "native tablet", compact: false, primaryToolsFirst: true },
  { device: "native phone", compact: true, primaryToolsFirst: true },
  { device: "web desktop", compact: false, primaryToolsFirst: false },
  { device: "web phone", compact: true, primaryToolsFirst: false },
])("keeps every drawing tool selectable on $device", async ({ compact, primaryToolsFirst }) => {
  const onTool = vi.fn();
  const props = {
    tool: "pen",
    shape: "rectangle",
    color: "ink",
    width: "medium",
    surface: "paper",
    theme: "light",
    place: "bottom",
    compact,
    primaryToolsFirst,
    canUndo: false,
    canRedo: false,
    onTool,
    onColor: vi.fn(),
    onWidth: vi.fn(),
    onUndo: vi.fn(),
    onRedo: vi.fn(),
    onPlace: vi.fn(),
  } satisfies IslandProps;
  const container = document.body.appendChild(document.createElement("div"));
  const root = createRoot(container);
  roots.push(root);
  await act(async () => root.render(<BoardIsland {...props} />));
  if (compact) await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Drawing tools"]')?.click());
  for (const [label, tool] of [
    ["Select", "selection"],
    ["Hand", "hand"],
    ["Pen", "pen"],
    ["Highlighter", "highlighter"],
    ["Text", "text"],
    ["Sticky note", "note"],
    ["Eraser", "eraser"],
    ["Laser pointer", "laser"],
  ]) {
    const buttons = container.querySelectorAll<HTMLButtonElement>(`button[aria-label="${label}"]`);
    expect(buttons).toHaveLength(1);
    await act(async () => buttons[0]?.click());
    expect(onTool).toHaveBeenLastCalledWith(tool);
  }
});
