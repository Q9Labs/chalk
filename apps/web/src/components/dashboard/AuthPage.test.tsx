/* @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DashboardAPIError } from "../../lib/dashboard-api";
import { AuthPage } from "./AuthPage";

const mocks = vi.hoisted(() => ({ register: vi.fn(), login: vi.fn(), tenants: vi.fn(), navigate: vi.fn() }));

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, to }: { children: React.ReactNode; to: string }) => <a href={to}>{children}</a>,
  useNavigate: () => mocks.navigate,
}));
vi.mock("@q9labsai/chalk-react", () => ({ Logo: () => null }));
vi.mock("../../lib/dashboard-api", async () => {
  const actual = await vi.importActual("../../lib/dashboard-api");
  return { ...actual, registerAccount: mocks.register, loginAccount: mocks.login, listAllAccountTenants: mocks.tenants };
});

beforeEach(() => {
  mocks.register.mockResolvedValue({});
  mocks.login.mockResolvedValue({});
  mocks.tenants.mockResolvedValue([]);
});
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

function submit(mode: "sign-in" | "sign-up") {
  render(<AuthPage mode={mode} />);
  fireEvent.change(screen.getByLabelText("Email"), { target: { value: "signup@example.com" } });
  fireEvent.change(screen.getByLabelText("Password", { exact: false }), { target: { value: "password123" } });
  fireEvent.submit(screen.getByRole("button", { name: mode === "sign-up" ? "Create Account" : "Sign in" }).closest("form")!);
}

describe("Account entry feedback", () => {
  it("announces how to correct a rejected password", async () => {
    mocks.register.mockRejectedValue(new DashboardAPIError(400, "access.invalid_password", "Invalid password"));
    submit("sign-up");
    expect((await screen.findByRole("alert")).textContent).toContain("try a shorter one");
  });

  it("describes a failed Account creation accurately", async () => {
    mocks.register.mockRejectedValue(new TypeError("Failed to fetch"));
    submit("sign-up");
    expect((await screen.findByRole("alert")).textContent).toBe("Your Account could not be created. Try again.");
  });

  it.each(["sign-up", "sign-in"] as const)("names the pending %s operation", (mode) => {
    mocks.register.mockReturnValue(new Promise(() => undefined));
    mocks.login.mockReturnValue(new Promise(() => undefined));
    submit(mode);
    expect(screen.getByRole("button", { name: mode === "sign-up" ? "Creating Account…" : "Signing in…" })).toHaveProperty("disabled", true);
  });
});
