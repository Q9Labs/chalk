// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it } from "vitest";
import { ChalkToast } from "./ChalkToast";

it("derives live-region attributes from the current announce prop in both directions", async () => {
  const container = document.createElement("div");
  const root = createRoot(container);
  const render = (announce: boolean) => act(async () => root.render(<ChalkToast message="Camera blocked" type="error" announce={announce} onDismiss={() => {}} />));
  try {
    await render(true);
    const toast = container.querySelector("[data-part=toast]");
    expect(toast?.getAttribute("role")).toBe("alert");
    await render(false);
    expect(container.querySelector("[data-part=toast]")).toBe(toast);
    expect(toast?.hasAttribute("role")).toBe(false);
    expect(toast?.hasAttribute("aria-live")).toBe(false);
    expect(toast?.hasAttribute("aria-atomic")).toBe(false);
    await render(true);
    expect(toast?.getAttribute("role")).toBe("alert");
    expect(toast?.getAttribute("aria-live")).toBe("assertive");
    expect(toast?.getAttribute("aria-atomic")).toBe("true");
  } finally {
    await act(async () => root.unmount());
  }
});
