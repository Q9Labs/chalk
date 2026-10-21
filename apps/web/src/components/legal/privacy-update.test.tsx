// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { LegalPage } from "./LegalPage";
import { PRIVACY_EFFECTIVE_DATE } from "../../lib/privacy-policy";
import { PrivacyNotice } from "../privacy/PrivacyNotice";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-21T12:00:00Z"));
  localStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("Privacy Policy advance notice", () => {
  it.each(["privacy", "privacy-previous"] as const)("renders identical %s HTML before and after the replacement date without effects", (kind) => {
    const html = renderToStaticMarkup(<LegalPage kind={kind} />);
    for (const date of [PRIVACY_EFFECTIVE_DATE, "2027-01-01T00:00:00Z"]) {
      vi.setSystemTime(new Date(date));
      expect(renderToStaticMarkup(<LegalPage kind={kind} />)).toBe(html);
    }
    expect(html).not.toContain("current Privacy Policy");
    expect(html).not.toContain("Previous Privacy Policy");
    if (kind === "privacy") {
      expect(html).toContain('id="whats-changing"');
      expect(html).toContain('href="/privacy/previous"');
      expect(html).toContain("This version takes effect on 4 November 2026. Until then, the ");
      expect(html).toContain("Privacy Policy effective 7 August 2026");
    } else {
      expect(html).toContain("Privacy Policy effective 7 August 2026 (replaced on 4 November 2026)");
    }
  });
  it("shows the future effective date, summary, and current-version link", () => {
    render(<LegalPage kind="privacy" />);
    expect(screen.getByText("Effective 4 November 2026")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "What's changing" }).parentElement?.id).toBe("whats-changing");
    expect(screen.getByRole("link", { name: "Privacy Policy effective 7 August 2026" }).getAttribute("href")).toBe("/privacy/previous");
  });
  it("keeps the previous policy available with its original date and text", () => {
    vi.setSystemTime(new Date(PRIVACY_EFFECTIVE_DATE));
    render(<LegalPage kind="privacy-previous" />);
    expect(screen.getByText("Effective 7 August 2026")).toBeTruthy();
    expect(screen.getByText(/We keep your data while your account or tenant is active/)).toBeTruthy();
  });
  it("dismisses the dashboard notice persistently and links to the summary", () => {
    const notice = render(<PrivacyNotice />);
    expect(screen.getByRole("link", { name: "See what's changing." }).getAttribute("href")).toBe("/privacy#whats-changing");
    fireEvent.click(screen.getByRole("button", { name: "Dismiss Privacy Policy notice" }));
    expect(screen.queryByRole("complementary")).toBeNull();
    notice.unmount();
    render(<PrivacyNotice />);
    expect(screen.queryByRole("complementary")).toBeNull();
  });
  it("still supports dismissal when browser storage is unavailable", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new DOMException("blocked");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("blocked");
    });
    render(<PrivacyNotice />);
    fireEvent.click(screen.getByRole("button", { name: "Dismiss Privacy Policy notice" }));
    expect(screen.queryByRole("complementary")).toBeNull();
  });
  it("removes only the notice at the effective instant, even in an open tab", () => {
    vi.setSystemTime(new Date(Date.parse(PRIVACY_EFFECTIVE_DATE) - 1));
    render(
      <>
        <PrivacyNotice />
        <LegalPage kind="privacy" />
      </>,
    );
    expect(screen.getByRole("complementary")).toBeTruthy();
    act(() => vi.advanceTimersByTime(1));
    expect(screen.queryByRole("complementary")).toBeNull();
    expect(screen.getByRole("heading", { name: "What's changing" })).toBeTruthy();
    expect(screen.getByText("Effective 4 November 2026")).toBeTruthy();
  });
  it("does not announce a future update on or after the effective date", () => {
    vi.setSystemTime(new Date(PRIVACY_EFFECTIVE_DATE));
    render(
      <>
        <PrivacyNotice />
        <LegalPage kind="privacy" />
      </>,
    );
    expect(screen.queryByRole("complementary")).toBeNull();
    expect(screen.getByRole("heading", { name: "What's changing" })).toBeTruthy();
  });
});
