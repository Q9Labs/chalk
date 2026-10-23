// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { ToastStack } from "./ToastStack";

afterEach(() => {
  vi.unstubAllGlobals();
});

it("shows the newest notice where ResizeObserver doesn't exist, as in jsdom tests and server rendering", async () => {
  vi.stubGlobal("ResizeObserver", undefined);
  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    await act(async () =>
      root.render(
        <ToastStack
          toasts={[
            { id: "a", message: "Nora joined" },
            { id: "b", message: "Malik joined" },
          ]}
          onDismiss={() => undefined}
        />,
      ),
    );
    const shown = [...container.querySelectorAll("[data-part='toast-stack'] [data-part='toast']")].map((toast) => toast.textContent);
    expect(shown.at(-1)).toBe("Malik joined");
    expect(container.querySelector("[data-measure]")?.childElementCount).toBe(0);
  } finally {
    await act(async () => root.unmount());
  }
});
