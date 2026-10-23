/* @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { hydrateRoot } from "react-dom/client";
import { LegalPage } from "./LegalPage";
import { PRIVACY_EFFECTIVE_DATE } from "../../lib/privacy-policy";
import { PrivacyNotice } from "../privacy/PrivacyNotice";

vi.mock("@q9labsai/chalk-react", () => ({ Logo: () => <span>Chalk</span> }));

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-21T12:00:00Z"));
  const stored = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => {
      stored.set(key, value);
    },
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("Privacy Policy advance notice", () => {
  it("keeps the static notice shell time-independent across the effective instant", () => {
    const before = renderToStaticMarkup(<PrivacyNotice />);
    vi.setSystemTime(new Date(PRIVACY_EFFECTIVE_DATE));
    expect(renderToStaticMarkup(<PrivacyNotice />)).toBe(before);
    expect(before).not.toContain("We're updating");
  });
  it("hydrates a pre-deadline shell after the deadline without an obsolete notice or mismatch", async () => {
    const container = document.createElement("div");
    container.innerHTML = renderToStaticMarkup(<PrivacyNotice />);
    vi.setSystemTime(new Date(PRIVACY_EFFECTIVE_DATE));
    const recoverableError = vi.fn();
    let root: ReturnType<typeof hydrateRoot> | undefined;
    try {
      await act(async () => {
        root = hydrateRoot(container, <PrivacyNotice />, { onRecoverableError: recoverableError });
      });
      expect(container.querySelector("aside")).toBeNull();
      expect(recoverableError).not.toHaveBeenCalled();
    } finally {
      act(() => root?.unmount());
    }
  });
  it.each(["privacy", "privacy-previous"] as const)("renders identical %s HTML before and after the replacement date without effects", (kind) => {
    const html = renderToStaticMarkup(<LegalPage kind={kind} />);
    for (const date of [PRIVACY_EFFECTIVE_DATE, "2027-01-01T00:00:00Z"]) {
      vi.setSystemTime(new Date(date));
      expect(renderToStaticMarkup(<LegalPage kind={kind} />)).toBe(html);
    }
    expect(html).not.toContain("Previous Privacy Policy");
    if (kind === "privacy") {
      expect(html).toContain('id="whats-changing"');
      expect(html).toContain('href="/privacy/previous"');
      expect(html).not.toContain("Until then");
      expect(html).toContain("apply when this page is published");
      expect(html).toContain("Archived Privacy Policy");
    } else {
      expect(html).toContain("Archived Privacy Policy — 7 August 2026");
      expect(html).toContain("not the current Privacy Policy");
      expect(html).toContain('href="/privacy"');
    }
  });
  it("shows the future effective date, summary, and current-version link", () => {
    render(<LegalPage kind="privacy" />);
    expect(screen.getByText("Effective 6 November 2026")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "What's changing" }).parentElement?.id).toBe("whats-changing");
    expect(screen.getByRole("link", { name: "Archived Privacy Policy" }).getAttribute("href")).toBe("/privacy/previous");
  });
  it("keeps the previous policy available with its original date and text", () => {
    vi.setSystemTime(new Date(PRIVACY_EFFECTIVE_DATE));
    render(<LegalPage kind="privacy-previous" />);
    expect(screen.getByText("Originally effective 7 August 2026")).toBeTruthy();
    expect(screen.getByText(/We keep your data while your account or tenant is active/)).toBeTruthy();
  });
  it("keys participation retention to the tenant that owns the Space, not a host account", () => {
    render(<LegalPage kind="privacy" />);
    expect(screen.getByText(/Space, Episode, and participant records/).textContent).toContain("while the tenant that owns the Space exists");
    expect(screen.queryByText(/host's Chalk account/)).toBeNull();
  });
  it("discloses the client-readable theme cookie and its one-year lifetime", () => {
    render(<LegalPage kind="privacy" />);
    const row = screen.getByText("chalk_theme").closest("tr");
    expect(row?.textContent).toContain("theme preference");
    expect(row?.textContent).toContain("Client-readable");
    expect(row?.textContent).toContain("1 year");
  });
  it("discloses problem-report retention separately from short-lived operational logs", () => {
    render(<LegalPage kind="privacy" />);
    const retention = screen.getByText(/Account records remain stored until deleted/).textContent;
    expect(retention).toContain("Problem reports remain in our Discord channel until we delete them");
    expect(retention).toContain("Chalk does not automatically expire problem reports");
  });
  it("uses one Discord recipient disclosure for alerts and the exact opt-in report payload", () => {
    render(<LegalPage kind="privacy" />);
    const recipients = screen.getAllByText("Discord");
    expect(recipients).toHaveLength(1);
    const disclosure = recipients[0]?.closest("li")?.textContent;
    for (const field of [
      "operational alerts",
      "problem reports",
      "description",
      "display name and role",
      "call name and ID",
      "only if you opt in",
      "connection status",
      "last error code",
      "browser or user agent",
      "app version",
      "do not add your account email address",
      "each field and the description/diagnostics pair",
      "deliberate evasion by a credential's own holder",
      "regardless of length",
      "at least 16 normalized characters",
      "is not covered",
      "known secret formats",
      "Other text you provide is sent as written",
      "http://",
      "https://",
      "www.",
      "non-clickable text",
      "query strings and fragments removed",
      "Stack traces and commit IDs",
    ]) {
      expect(disclosure).toContain(field);
    }
    expect(screen.getByText("Effective 6 November 2026")).toBeTruthy();
  });
  it("discloses webhook content and endpoint retention criteria", () => {
    render(<LegalPage kind="privacy" />);
    expect(screen.getByText(/Webhook event bodies, deliveries, and attempt logs/).textContent).toContain("cleanup after 30 days");
    expect(screen.getByText(/Webhook event bodies, deliveries, and attempt logs/).textContent).toContain("Endpoint settings and revision history");
    expect(screen.getByText(/Webhook event bodies, deliveries, and attempt logs/).textContent).toContain("tenant is purged");
  });
  it("discloses Google Fonts request data and transfer safeguards", () => {
    render(<LegalPage kind="privacy" />);
    const provider = screen.getByText("Google Fonts").closest("li");
    expect(provider?.textContent).toContain("IP address and user agent");
    expect(provider?.textContent).toContain("fonts.googleapis.com");
    expect(provider?.textContent).toContain("fonts.gstatic.com");
    expect(screen.getByText(/Google relies on the EU-US Data Privacy Framework/).textContent).toContain("EU Standard Contractual Clauses");
  });
  it.each([
    ["Google sign-in", "authorization code", "IP address", "authenticate"],
    ["Apple sign-in", "authorization code", "user agent", "authenticate"],
    ["jsDelivr", "cdn.jsdelivr.net", "IP address", "MathJax"],
    ["esm.sh", "whiteboard fonts", "user agent", "request URL"],
  ])("discloses %s and its request data and purpose", (name, ...details) => {
    render(<LegalPage kind="privacy" />);
    const recipient = screen.getByText(name).closest("li");
    for (const detail of details) expect(recipient?.textContent).toContain(detail);
  });
  it("distinguishes user-chosen embeds from Chalk's own processing", () => {
    render(<LegalPage kind="privacy" />);
    expect(screen.getByText(/External whiteboard content/).closest("li")?.textContent).toContain("YouTube");
    expect(screen.getByText(/External whiteboard content/).closest("li")?.textContent).toContain("Vimeo");
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
    vi.spyOn(localStorage, "getItem").mockImplementation(() => {
      throw new DOMException("blocked");
    });
    vi.spyOn(localStorage, "setItem").mockImplementation(() => {
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
    expect(screen.getByText("Effective 6 November 2026")).toBeTruthy();
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
