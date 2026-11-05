// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { ChalkToast } from "./ChalkToast";

vi.mock("./ToastIcon", () => {
  throw new Error("Failed to fetch dynamically imported module");
});

it("keeps the archive message and Undo usable when the decorative chunk fails to load", async () => {
  const container = document.createElement("div");
  const root = createRoot(container);
  const undo = vi.fn();
  try {
    await act(async () => {
      root.render(<ChalkToast message="Call archived" action={{ label: "Undo", onClick: undo }} onDismiss={() => {}} />);
    });
    expect(container.querySelector('[data-part="toast-message"]')?.textContent).toBe("Call archived");
    const button = container.querySelector("button");
    expect(button?.textContent).toBe("Undo");
    await act(async () => button?.click());
    expect(undo).toHaveBeenCalledOnce();
  } finally {
    await act(async () => root.unmount());
  }
});
