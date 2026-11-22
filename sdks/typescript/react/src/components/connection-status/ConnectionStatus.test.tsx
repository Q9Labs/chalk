// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ConnectionStatus, type ConnectionStatusProps } from "./ConnectionStatus";
import { RECONNECT_NOTICE_MS } from "./use-connection-phase";

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  document.body.replaceChildren();
});

function mount() {
  const frame = document.body.appendChild(document.createElement("div"));
  frame.className = "chalk-frame";
  frame.innerHTML = '<div data-part="dock-region"><button aria-label="Leave call">Leave</button></div>';
  const host = frame.appendChild(document.createElement("div"));
  const root = createRoot(host);
  const show = (props: ConnectionStatusProps) => act(() => root.render(<ConnectionStatus {...props} />));
  return { frame, host, show };
}

it("turns the reconnecting card into the lost card in place, so the veil and card never replay", () => {
  const { host, show } = mount();
  show({ phase: "reconnecting", since: Date.now() });
  act(() => void vi.advanceTimersByTime(RECONNECT_NOTICE_MS + 10));
  const dim = host.querySelector(".chalk-connection-dim");
  const card = host.querySelector("[data-part=connection-status]");
  expect(dim).not.toBeNull();
  expect(card?.textContent).toContain("Reconnecting");

  show({ phase: "failed", since: null, onRejoin: () => undefined });
  expect(host.querySelectorAll(".chalk-connection-dim")).toHaveLength(1);
  expect(host.querySelector(".chalk-connection-dim")).toBe(dim);
  expect(host.querySelector("[data-part=connection-status]")).toBe(card);
  expect(card?.textContent).toContain("Connection lost");
});

it("mounts the lost content as a fresh alertdialog with a name and a description", () => {
  const { host, show } = mount();
  show({ phase: "reconnecting", since: Date.now() });
  act(() => void vi.advanceTimersByTime(RECONNECT_NOTICE_MS + 10));
  const waiting = host.querySelector("[role=status]");
  expect(waiting?.textContent).toContain("Reconnecting");
  expect(host.querySelector("[role=alertdialog]")).toBeNull();

  show({ phase: "failed", since: null, onRejoin: () => undefined });
  const dialog = host.querySelector("[role=alertdialog]");
  expect(dialog).not.toBeNull();
  expect(host.querySelector("[role=status]")).toBeNull();
  expect(waiting?.isConnected).toBe(false);
  expect(host.querySelector(`#${dialog?.getAttribute("aria-labelledby")}`)?.textContent).toBe("Connection lost");
  expect(host.querySelector(`#${dialog?.getAttribute("aria-describedby")}`)?.textContent).toContain("rejoin");
});

it("moves focus to the dock's Leave button when the lost card closes", () => {
  const { frame, host, show } = mount();
  show({ phase: "failed", since: null, onRejoin: () => undefined });
  const rejoin = host.querySelector<HTMLButtonElement>(".chalk-connection-rejoin");
  rejoin?.focus();
  expect(document.activeElement).toBe(rejoin);

  show({ phase: "reconnecting", since: Date.now() });
  expect(document.activeElement).toBe(frame.querySelector("[aria-label='Leave call']"));
});

it("moves focus to Leave when Rejoin was pressed without taking focus, as in Safari or on touch", () => {
  const { frame, host, show } = mount();
  show({ phase: "failed", since: null, onRejoin: () => undefined });
  const rejoin = host.querySelector<HTMLButtonElement>(".chalk-connection-rejoin");
  rejoin?.dispatchEvent(new FocusEvent("focusout", { bubbles: true, relatedTarget: frame }));
  rejoin?.blur();
  expect(document.activeElement).toBe(document.body);
  rejoin?.dispatchEvent(new Event("pointerdown", { bubbles: true }));

  show({ phase: "reconnecting", since: Date.now() });
  expect(document.activeElement).toBe(frame.querySelector("[aria-label='Leave call']"));
});

it("leaves focus alone when the lost card closes and focus was never inside it", () => {
  const { frame, host, show } = mount();
  show({ phase: "failed", since: null });
  expect(document.activeElement).toBe(document.body);

  show({ phase: "reconnecting", since: Date.now() });
  expect(document.activeElement).toBe(document.body);
  expect(frame.querySelector("[aria-label='Leave call']")).not.toBe(document.activeElement);
  expect(host.querySelector(".chalk-connection-rejoin")).toBeNull();
});
