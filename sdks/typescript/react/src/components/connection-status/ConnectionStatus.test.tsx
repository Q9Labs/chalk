// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { ConnectionStatus, formatElapsed, reconnectedToast, reconnectingCopy } from "./ConnectionStatus";

afterEach(() => {
  vi.useRealTimers();
  document.body.replaceChildren();
});

function mount(node: React.ReactNode) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);
  act(() => root.render(node));
  return { host, unmount: () => act(() => root.unmount()) };
}

it("writes the first 20 seconds, the long wait and offline in the words of the design", () => {
  expect(reconnectingCopy("reconnecting", 5, null)).toEqual({ title: "Reconnecting…", detail: "You’ll be back in the call on your own." });
  expect(reconnectingCopy("reconnecting", 20, null)).toEqual({ title: "Still reconnecting…", detail: "Check your Wi-Fi or mobile data." });
  expect(reconnectingCopy("offline", 3, null)).toEqual({ title: "You’re offline", detail: "You’ll rejoin when your connection is back." });
  expect(reconnectingCopy("reconnecting", 3, "3 messages").detail).toBe("3 messages will send when you’re back. You’ll be back in the call on your own.");
});

it("counts as minutes and seconds", () => {
  expect(formatElapsed(14)).toBe("0:14");
  expect(formatElapsed(75)).toBe("1:15");
});

it("shows nothing for a drop shorter than 2 seconds and the card after it", () => {
  vi.useFakeTimers();
  const { host, unmount } = mount(<ConnectionStatus phase="reconnecting" since={Date.now()} />);
  expect(host.querySelector('[data-part="connection-status"]')).toBeNull();
  act(() => vi.advanceTimersByTime(2_100));
  const card = host.querySelector('[data-part="connection-status"]');
  expect(card?.getAttribute("role")).toBe("status");
  expect(card?.textContent).toContain("Reconnecting…");
  expect(host.querySelector(".chalk-connection-time")?.getAttribute("aria-hidden")).toBe("true");
  unmount();
});

it("confirms the return with how long the person was away, as a bottom notice rather than over the stage", () => {
  expect(reconnectedToast(14_000)).toMatchObject({ type: "success", message: "Back in the call · Away 14 s" });
  const { host, unmount } = mount(<ConnectionStatus phase="reconnected" since={null} awayMs={14_000} />);
  expect(host.textContent).not.toContain("Back in the call");
  unmount();
});

it("offers Rejoin, Leave and Report a problem after a failure, keeps the failure code off the card, and focuses Rejoin", () => {
  const onRejoin = vi.fn();
  const onLeave = vi.fn();
  const onReportProblem = vi.fn();
  const { host, unmount } = mount(<ConnectionStatus phase="failed" since={null} onRejoin={onRejoin} onLeave={onLeave} onReportProblem={onReportProblem} />);
  const dialog = host.querySelector('[role="alertdialog"]');
  expect(dialog?.textContent).toContain("Connection lost");
  expect(dialog?.textContent).toContain("The call is still going, so you can rejoin.");
  expect(dialog?.textContent).not.toMatch(/connection\./);
  const buttons = [...host.querySelectorAll("button")];
  expect(document.activeElement?.textContent).toBe("Rejoin");
  const press = (label: string) => act(() => buttons.find((button) => button.textContent === label)?.click());
  press("Rejoin");
  press("Leave");
  press("Report a problem");
  expect([onRejoin, onLeave, onReportProblem].map((fn) => fn.mock.calls.length)).toEqual([1, 1, 1]);
  unmount();
});
