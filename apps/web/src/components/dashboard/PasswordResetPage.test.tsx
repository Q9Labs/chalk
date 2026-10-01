/* @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DashboardAPIError } from "../../lib/dashboard-api";
import { CompletePasswordResetPage, RequestPasswordResetPage } from "./PasswordResetPage";

const mocks = vi.hoisted(() => ({ request: vi.fn(), complete: vi.fn(), navigate: vi.fn() }));

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, to }: { children: React.ReactNode; to: string }) => <a href={to}>{children}</a>,
  useNavigate: () => mocks.navigate,
}));
vi.mock("@q9labsai/chalk-react", () => ({ Logo: () => null }));
vi.mock("../../lib/dashboard-api", async () => {
  const actual = await vi.importActual("../../lib/dashboard-api");
  return { ...actual, requestPasswordReset: mocks.request, completePasswordReset: mocks.complete };
});

beforeEach(() => {
  mocks.request.mockResolvedValue(undefined);
  mocks.complete.mockResolvedValue(undefined);
  mocks.navigate.mockResolvedValue(undefined);
});
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

describe("password reset", () => {
  it("shows the generic confirmation for accepted requests", async () => {
    render(<RequestPasswordResetPage />);
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "ada@example.com" } });
    fireEvent.submit(screen.getByRole("button", { name: "Send reset link" }).closest("form")!);

    expect((await screen.findByRole("status")).textContent).toBe("If an Account exists for that email, we sent a reset link");
    expect(mocks.request).toHaveBeenCalledWith("ada@example.com");
  });

  it.each([429, 403, 503])("allows retry after a request is rejected with %s", async (status) => {
    mocks.request.mockRejectedValue(new DashboardAPIError(status, "request.failed", "Unavailable"));
    render(<RequestPasswordResetPage />);
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "ada@example.com" } });
    fireEvent.submit(screen.getByRole("button", { name: "Send reset link" }).closest("form")!);
    expect((await screen.findByRole("alert")).textContent).toContain("Try again");
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.getByRole("button", { name: "Send reset link" }).hasAttribute("disabled")).toBe(false);
  });

  it("completes the reset and returns to sign-in", async () => {
    render(<CompletePasswordResetPage token="reset-token" />);
    fireEvent.change(screen.getByLabelText("New password", { exact: false }), { target: { value: "replacement-password" } });
    fireEvent.submit(screen.getByRole("button", { name: "Reset password" }).closest("form")!);

    await vi.waitFor(() => expect(mocks.complete).toHaveBeenCalledWith({ token: "reset-token", password: "replacement-password" }));
    expect(mocks.navigate).toHaveBeenCalledWith({ to: "/sign-in", replace: true });
  });

  it("does not submit without a reset token", () => {
    render(<CompletePasswordResetPage token="" />);
    expect(screen.getByRole("alert").textContent).toContain("Request a new link");
    expect(screen.queryByRole("button", { name: "Reset password" })).toBeNull();
  });

  it("keeps API reset errors actionable", async () => {
    mocks.complete.mockRejectedValue(new DashboardAPIError(400, "auth.invalid_reset_token", "This reset link could not be used. Request a new link."));
    render(<CompletePasswordResetPage token="reset-token" />);
    fireEvent.change(screen.getByLabelText("New password", { exact: false }), { target: { value: "replacement-password" } });
    fireEvent.submit(screen.getByRole("button", { name: "Reset password" }).closest("form")!);

    expect((await screen.findByRole("alert")).textContent).toContain("Request a new link");
  });
});
