// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { dismissDashboardBoot } from "./dashboard-boot";

afterEach(() => {
  document.body.innerHTML = "";
  vi.useRealTimers();
});

it("reports the opening frame gone at once when the page never drew one", () => {
  let gone = 0;
  dismissDashboardBoot(() => {
    gone += 1;
  });
  expect(gone).toBe(1);
});

it("reports the opening frame gone only after it has faded out and left the page", () => {
  vi.useFakeTimers();
  document.body.innerHTML = `<div id="chalk-dashboard-boot"></div>`;
  let gone = 0;
  dismissDashboardBoot(() => {
    gone += 1;
  });
  expect(gone).toBe(0);
  vi.advanceTimersByTime(500);
  expect(document.getElementById("chalk-dashboard-boot")).toBeNull();
  expect(gone).toBe(1);
});
