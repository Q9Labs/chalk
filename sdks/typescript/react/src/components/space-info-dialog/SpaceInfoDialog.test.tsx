// @vitest-environment happy-dom

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SpaceInfoDialog } from "./SpaceInfoDialog";

afterEach(cleanup);

describe("SpaceInfoDialog", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders no dialog while closed and exposes the live Space details when open", () => {
    const onClose = vi.fn();
    const onCopyLink = vi.fn();
    const view = render(<SpaceInfoDialog isOpen={false} onClose={onClose} onCopyLink={onCopyLink} spaceName="Design review" inviteLink="https://chalk.test/s/design" />);

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    view.rerender(
      <SpaceInfoDialog isOpen onClose={onClose} onCopyLink={onCopyLink} spaceName="Design review" spaceId="space-123" inviteLink="https://chalk.test/s/design" duration={3661} isRecording isTranscribing stats={{ latency: 42, packetLoss: 0.3, resolution: "720p · 30fps", region: "Lahore, PK" }} />,
    );

    expect(screen.getByRole("dialog", { name: "Space details" })).toBeInTheDocument();
    expect(screen.getByRole("dialog", { name: "Space details" }).querySelector("[data-chalk-chrome]")).toBeInTheDocument();
    expect(screen.getByRole("dialog", { name: "Space details" })).toHaveClass("border-[var(--chalk-app-line-strong)]", "bg-[var(--chalk-app-panel)]", "text-[var(--chalk-app-text)]");
    expect(screen.getByText("Design review")).toBeInTheDocument();
    expect(screen.getByText("01:01:01")).toBeInTheDocument();
    expect(screen.getByText("space-123")).toBeInTheDocument();
    expect(screen.getByText("Recording")).toBeInTheDocument();
    expect(screen.getByText("Transcribing")).toBeInTheDocument();
    expect(screen.getByText("720p · 30fps · 42 ms · 0.3% loss")).toBeInTheDocument();
    expect(screen.getByText("Lahore, PK")).toBeInTheDocument();
    expect(screen.getByTitle("QR code for https://chalk.test/s/design")).toBeInTheDocument();
  });

  it("copies a safe diagnostic reference and opens host-provided feedback", () => {
    const onCopyDiagnosticReference = vi.fn();
    const onSendFeedback = vi.fn();
    render(<SpaceInfoDialog isOpen onClose={vi.fn()} onCopyLink={vi.fn()} onCopyDiagnosticReference={onCopyDiagnosticReference} onSendFeedback={onSendFeedback} spaceName="Design review" inviteLink="https://chalk.test/s/design" diagnosticReference="chalkdiag:v1:safe-reference" />);

    fireEvent.click(screen.getByRole("button", { name: "Copy diagnostic reference" }));
    expect(onCopyDiagnosticReference).toHaveBeenCalledWith("chalkdiag:v1:safe-reference");
    expect(screen.getByRole("button", { name: "Diagnostic reference copied" })).toHaveTextContent("Copied");

    fireEvent.click(screen.getByRole("button", { name: "Send feedback" }));
    expect(onSendFeedback).toHaveBeenCalledWith({ diagnosticReference: "chalkdiag:v1:safe-reference" });
  });

  it("shows the optional Space description and omits the invite section when no link exists", () => {
    render(<SpaceInfoDialog isOpen onClose={vi.fn()} spaceName="Design review" spaceDescription="Critiques, focused work, and product decisions." />);

    expect(screen.getByText("Critiques, focused work, and product decisions.")).toBeInTheDocument();
    expect(screen.queryByText("Invite link")).not.toBeInTheDocument();
  });

  it("copies the invite link and closes only from the dialog close affordance or backdrop", () => {
    const onClose = vi.fn();
    const onCopyLink = vi.fn();
    const view = render(<SpaceInfoDialog isOpen onClose={onClose} onCopyLink={onCopyLink} spaceName="Design review" inviteLink="https://chalk.test/s/design" />);

    fireEvent.mouseDown(screen.getByRole("dialog", { name: "Space details" }));
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Copy space link" }));
    expect(onCopyLink).toHaveBeenCalledOnce();
    expect(screen.getByRole("button", { name: "Space link copied" })).toHaveTextContent("Copied");

    act(() => vi.advanceTimersByTime(2_000));
    expect(screen.getByRole("button", { name: "Copy space link" })).toHaveTextContent("Copy");

    fireEvent.click(screen.getByRole("button", { name: "Close space details" }));
    expect(onClose).toHaveBeenCalledOnce();
    fireEvent.mouseDown(view.container.firstElementChild!);
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});
