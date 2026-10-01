/* @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { InvitePeopleDialog } from "./InvitePeopleDialog";

const mocks = vi.hoisted(() => ({ issue: vi.fn() }));

vi.mock("../../lib/dashboard-api", async () => {
  const actual = await vi.importActual("../../lib/dashboard-api");
  return { ...actual, issueTenantInvitation: mocks.issue };
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function issued(emailDelivered: boolean) {
  return { invitation: { id: "i1", tenant_id: "t1", email: "new@example.com", role: "observer", expires_at: "2027-01-01T00:00:00Z", created_at: "2026-12-25T00:00:00Z" }, accept_link: "https://chalk.test/invitations/accept#token=abc", email_delivered: emailDelivered };
}

function sendInvitation() {
  fireEvent.change(screen.getByLabelText("Email"), { target: { value: "new@example.com" } });
  fireEvent.change(screen.getByLabelText("Role"), { target: { value: "observer" } });
  fireEvent.click(screen.getByRole("button", { name: "Send invitation" }));
}

describe("InvitePeopleDialog", () => {
  it("closes from Cancel without issuing an invitation", () => {
    const onClose = vi.fn();
    render(<InvitePeopleDialog tenantID="t1" onClose={onClose} onIssued={vi.fn()} />);

    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "new@example.com" } });
    fireEvent.click(screen.getByRole("button", { name: "Cancel", hidden: true }));

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(mocks.issue).not.toHaveBeenCalled();
  });

  it("says an email was sent and shows no link when delivery worked", async () => {
    mocks.issue.mockResolvedValue(issued(true));
    render(<InvitePeopleDialog tenantID="t1" onClose={vi.fn()} onIssued={vi.fn()} />);

    sendInvitation();

    await waitFor(() => expect(screen.getByText(/We sent an email to new@example.com/)).toBeTruthy());
    expect(mocks.issue).toHaveBeenCalledWith("t1", { email: "new@example.com", role: "observer" });
    expect(screen.queryByRole("button", { name: "Copy link" })).toBeNull();
  });

  it("shows the link with a Copy button when the email was not delivered", async () => {
    mocks.issue.mockResolvedValue(issued(false));
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    render(<InvitePeopleDialog tenantID="t1" onClose={vi.fn()} onIssued={vi.fn()} />);

    sendInvitation();

    const link = await screen.findByLabelText("Invitation link");
    expect(link).toHaveProperty("value", "https://chalk.test/invitations/accept#token=abc");
    expect(screen.getByText(/Send them this link yourself/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Copy link" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("https://chalk.test/invitations/accept#token=abc"));
  });
});
