// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { dismissDashboardBoot } from "./dashboard-boot";

afterEach(() => {
  document.body.innerHTML = "";
  vi.useRealTimers();
});

it("reports the opening frame gone at once when the page never drew one", () => {
  const gone = vi.fn();
  dismissDashboardBoot(gone);
  expect(gone).toHaveBeenCalledTimes(1);
});

it("reports the opening frame gone only after it has faded out and left the page", () => {
  vi.useFakeTimers();
  document.body.innerHTML = `<div id="chalk-dashboard-boot"></div>`;
  const gone = vi.fn();
  dismissDashboardBoot(gone);
  expect(gone).not.toHaveBeenCalled();
  vi.advanceTimersByTime(500);
  expect(document.getElementById("chalk-dashboard-boot")).toBeNull();
  expect(gone).toHaveBeenCalledTimes(1);
});
