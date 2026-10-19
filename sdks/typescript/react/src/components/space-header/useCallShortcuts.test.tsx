// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { useCallShortcuts } from "./useCallShortcuts";

it("closes panels from the composer without intercepting typing shortcuts", async () => {
  const onClosePanel = vi.fn();
  const onToggleMute = vi.fn();
  const show = vi.fn();
  function Composer() {
    useCallShortcuts({ onClosePanel, onToggleMute }, show);
    return <textarea />;
  }
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<Composer />));
    const input = container.querySelector("textarea")!;
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "d", ctrlKey: true, bubbles: true }));
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "?", bubbles: true }));
    expect(onClosePanel).toHaveBeenCalledOnce();
    expect(onToggleMute).not.toHaveBeenCalled();
    expect(show).not.toHaveBeenCalled();
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
