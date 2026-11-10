// @vitest-environment jsdom
import { act, useRef } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useClearBoard } from "./BoardClear";
import type { BoardToast } from "./board-toasts";

function Host({ engine, toast, people, canDraw = true }: { readonly engine: { readonly clearWithUndo: () => Promise<() => Promise<void>> }; readonly toast: (toast: BoardToast) => void; readonly people: number; readonly canDraw?: boolean }) {
  const root = useRef<HTMLDivElement>(null);
  const clearBoard = useClearBoard({ engine, canDraw, toast, people, sheet: false, container: root });
  return (
    <div ref={root}>
      <button type="button" onClick={clearBoard.ask}>
        Open clear
      </button>
      {clearBoard.dialog}
    </div>
  );
}

let host: HTMLElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

const button = (name: string) => [...document.querySelectorAll("button")].find((candidate) => candidate.textContent?.trim() === name);
const press = (name: string) => act(async () => void button(name)?.click());

it("asks first, and cancelling leaves the board alone", async () => {
  const engine = { clearWithUndo: vi.fn(async () => async () => undefined) };
  await act(async () => root.render(<Host engine={engine} toast={vi.fn()} people={3} />));
  expect(document.querySelector('[role="alertdialog"]')).toBeNull();

  await press("Open clear");
  const dialog = document.querySelector('[role="alertdialog"]');
  expect(dialog?.textContent).toContain("Clear the board for everyone?");
  expect(dialog?.textContent).toContain("Everything on it goes for the 3 people here. You can undo right after.");
  expect(engine.clearWithUndo).not.toHaveBeenCalled();

  await press("Cancel");
  expect(engine.clearWithUndo).not.toHaveBeenCalled();
  expect(document.querySelector('[role="alertdialog"]')).toBeNull();
});

it("clears after the confirm and keeps the Undo toast, which puts the drawing back", async () => {
  const restore = vi.fn(async () => undefined);
  const engine = { clearWithUndo: vi.fn(async () => restore) };
  const toast = vi.fn();
  await act(async () => root.render(<Host engine={engine} toast={toast} people={2} />));

  await press("Open clear");
  await press("Clear board");
  expect(engine.clearWithUndo).toHaveBeenCalledTimes(1);
  expect(document.querySelector('[role="alertdialog"]')).toBeNull();
  const shown: BoardToast = toast.mock.calls[0]![0];
  expect(shown.message).toBe("Board cleared");
  expect(shown.action?.label).toBe("Undo");

  expect(restore).not.toHaveBeenCalled();
  shown.action?.onClick();
  expect(restore).toHaveBeenCalledTimes(1);
});

it("says so plainly when the clear fails, and offers no Undo", async () => {
  const engine = { clearWithUndo: vi.fn(async () => Promise.reject(new Error("offline"))) };
  const toast = vi.fn();
  await act(async () => root.render(<Host engine={engine} toast={toast} people={1} />));

  await press("Open clear");
  expect(document.querySelector('[role="alertdialog"]')?.textContent).toContain("Everything on it goes. You can undo right after.");
  await press("Clear board");
  expect(toast).toHaveBeenCalledWith({ type: "error", message: "Could not clear the board. Try again." });
});
