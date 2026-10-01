/* @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CreateAPIKeyDialog } from "./APIKeysPage";

vi.mock("@q9labsai/chalk-react/utils", () => ({ AnimatedCopy01Icon: () => null }));
vi.mock("./DashboardShell", () => ({ Icon: () => null, ResourcePageHeader: () => null }));
vi.mock("../../features/episode-debugger/EpisodeDiagnosticsLauncher", () => ({ EpisodeDiagnosticsLauncher: () => null }));

afterEach(cleanup);

function renderDialog(onClose: () => void, onContinue: () => void = vi.fn()) {
  render(<CreateAPIKeyDialog open name="" scopes={[]} expiresAt="2027-01-01" onClose={onClose} onNameChange={vi.fn()} onScopesChange={vi.fn()} onExpiresAtChange={vi.fn()} onContinue={onContinue} />);
}

describe("CreateAPIKeyDialog", () => {
  it("closes from Cancel and the close button without submitting the form", () => {
    const onClose = vi.fn();
    const onContinue = vi.fn();
    renderDialog(onClose, onContinue);

    fireEvent.click(screen.getByRole("button", { name: "Cancel", hidden: true }));
    fireEvent.click(screen.getByRole("button", { name: "Close dialog", hidden: true }));

    expect(onClose).toHaveBeenCalledTimes(2);
    expect(onContinue).not.toHaveBeenCalled();
  });

  it("words read and manage scopes differently", () => {
    renderDialog(vi.fn());

    expect(screen.getByText("Read Spaces")).toBeTruthy();
    expect(screen.getByText("Manage Spaces")).toBeTruthy();
    expect(screen.getByText("Read Episodes")).toBeTruthy();
    expect(screen.getByText("Manage Episodes")).toBeTruthy();
  });
});
