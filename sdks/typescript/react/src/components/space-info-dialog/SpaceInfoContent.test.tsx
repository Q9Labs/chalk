// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SpaceInfoContent } from "./SpaceInfoContent";

afterEach(cleanup);

describe("SpaceInfoContent", () => {
  it("shows the optional description, QR invite, and connection details", () => {
    render(<SpaceInfoContent spaceDescription="A focused Space for design reviews." spaceId="space-123" inviteLink="https://chalk.test/s/design" onCopyLink={vi.fn()} stats={{ latency: 42, packetLoss: 0.3, resolution: "720p · 30fps", region: "Lahore, PK" }} />);

    expect(screen.getByText("A focused Space for design reviews.")).toBeInTheDocument();
    expect(screen.getByText("Invite link")).toBeInTheDocument();
    expect(screen.getByTitle("QR code for https://chalk.test/s/design")).toBeInTheDocument();
    expect(screen.getByText("space-123")).toBeInTheDocument();
    expect(screen.getByText("720p · 30fps · 42 ms · 0.3% loss")).toBeInTheDocument();
  });

  it("confirms invite copies and sends the safe diagnostic reference to feedback", () => {
    const onCopyLink = vi.fn();
    const onSendFeedback = vi.fn();
    render(<SpaceInfoContent inviteLink="https://chalk.test/s/design" onCopyLink={onCopyLink} diagnosticReference="chalkdiag:v1:safe-reference" onSendFeedback={onSendFeedback} />);

    fireEvent.click(screen.getByRole("button", { name: "Copy space link" }));
    expect(onCopyLink).toHaveBeenCalledOnce();
    expect(screen.getByRole("button", { name: "Space link copied" })).toHaveTextContent("Copied");

    fireEvent.click(screen.getByRole("button", { name: "Send feedback" }));
    expect(onSendFeedback).toHaveBeenCalledWith({ diagnosticReference: "chalkdiag:v1:safe-reference" });
  });
});
