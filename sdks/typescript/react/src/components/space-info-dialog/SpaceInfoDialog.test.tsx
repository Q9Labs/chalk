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
    expect(screen.getByText("Design review")).toBeInTheDocument();
    expect(screen.getByText("01:01:01")).toBeInTheDocument();
    expect(screen.getByText("ID space-123")).toBeInTheDocument();
    expect(screen.getByText("Recording")).toBeInTheDocument();
    expect(screen.getByText("Transcribing")).toBeInTheDocument();
    expect(screen.getByText("720p · 30fps · 42 ms · 0.3% loss")).toBeInTheDocument();
    expect(screen.getByText("Lahore, PK")).toBeInTheDocument();
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
