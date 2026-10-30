// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { SpaceHeader } from "./SpaceHeader";

it.each([
  { variant: "desktop", phone: false },
  { variant: "phone", phone: true },
])("shows the full call name in the $variant trigger title", async ({ phone }) => {
  vi.spyOn(window, "matchMedia").mockImplementation((query) => ({ matches: phone && query === "(max-width: 640px)", media: query, onchange: null, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => true }));
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const spaceName = "Physics – Grade 9 with a very long list of participants";
  try {
    await act(async () => root.render(<SpaceHeader spaceName={spaceName} />));
    const trigger = container.querySelector<HTMLButtonElement>('button[data-part="call-name"]');
    expect(trigger).not.toBeNull();
    expect(trigger?.classList.contains("chalk-call-name-phone")).toBe(phone);
    expect(trigger?.title).toBe(spaceName);
    expect(trigger?.getAttribute("aria-label")).toBe("Call details");
    await act(async () => trigger?.click());
    expect(trigger?.getAttribute("aria-expanded")).toBe("true");
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain(spaceName);
  } finally {
    await act(async () => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  }
});
