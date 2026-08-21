// @vitest-environment happy-dom

import type { IncomingMediaRequest } from "@q9labsai/chalk-client";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { MediaRequestDialog } from "./MediaRequestDialog";

afterEach(cleanup);

describe("MediaRequestDialog", () => {
  it("renders the requested media action and actor name", () => {
    const request: IncomingMediaRequest = {
      requestId: "request-1",
      kind: "unmute",
      actorParticipantId: "moderator",
      actorDisplayName: "Grace",
      expiresAt: "2099-08-01T08:00:00.000Z",
    };

    const view = render(<MediaRequestDialog request={request} onDecline={vi.fn()} onAllow={vi.fn()} />);

    expect(screen.getByRole("dialog", { name: "Unmute request" })).toHaveTextContent("Grace is asking you to unmute");
    expect(screen.getByRole("button", { name: "Not now" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Allow" })).toBeInTheDocument();
    expect(view.container.querySelector("svg[data-chalk-chrome='true']")).toBeInTheDocument();
  });

  it("uses role-neutral copy when the actor name is unavailable", () => {
    const request: IncomingMediaRequest = {
      requestId: "request-2",
      kind: "start_camera",
      actorParticipantId: "participant-2",
      actorDisplayName: null,
      expiresAt: "2099-08-01T08:00:00.000Z",
    };

    render(<MediaRequestDialog request={request} onDecline={vi.fn()} onAllow={vi.fn()} />);

    expect(screen.getByRole("dialog", { name: "Camera request" })).toHaveTextContent("A participant is asking you to start your camera");
  });

  it("disables actions and explains when a request has expired", () => {
    const request: IncomingMediaRequest = {
      requestId: "request-expired",
      kind: "unmute",
      actorParticipantId: "participant-3",
      actorDisplayName: "Ari",
      expiresAt: "2020-01-01T00:00:00.000Z",
    };

    render(<MediaRequestDialog request={request} onDecline={vi.fn()} onAllow={vi.fn()} />);

    expect(screen.getByRole("status")).toHaveTextContent("This request has expired.");
    expect(screen.getByRole("button", { name: "Not now" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Expired" })).toBeDisabled();
  });

  it("reports a rejected action while keeping the request visible for recovery", async () => {
    const onAllow = vi.fn().mockRejectedValue(new Error("Microphone permission changed"));
    const onActionError = vi.fn();
    const request: IncomingMediaRequest = {
      requestId: "request-failure",
      kind: "unmute",
      actorParticipantId: "participant-4",
      actorDisplayName: "Sam",
      expiresAt: "2099-01-01T00:00:00.000Z",
    };

    render(<MediaRequestDialog request={request} onDecline={vi.fn()} onAllow={onAllow} onActionError={onActionError} />);

    fireEvent.click(screen.getByRole("button", { name: "Allow" }));

    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Microphone permission changed"));
    expect(onActionError).toHaveBeenCalledWith("Microphone permission changed", "allow");
  });
});
