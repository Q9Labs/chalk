// @vitest-environment happy-dom
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { NoticeButton } from "../toast-stack/NoticeButton";
import { SpacePresentation } from "./SpacePresentation";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

it("keeps the header awake while notices wait behind its notice button", async () => {
  vi.useFakeTimers();
  // A mouse on a wide screen, where the header fades after three idle seconds.
  vi.spyOn(window, "matchMedia").mockImplementation((query) => ({ matches: true, media: query, onchange: null, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => true }));
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const render = (notices?: ReactNode) => act(async () => root.render(<SpacePresentation stageBackground={false} header={{ spaceName: "Maths", notices }} stage={null} controls={null} />));
  const idle = () => container.querySelector("main")?.dataset.idle;
  await render();
  await act(async () => vi.advanceTimersByTime(3_100));
  expect(idle()).toBe("true");
  await render(<NoticeButton toasts={[{ id: "join", message: "Nora joined" }]} onDismiss={() => undefined} />);
  await act(async () => vi.advanceTimersByTime(6_100));
  expect(idle()).toBe("false");
  await act(async () => root.unmount());
});
