// @vitest-environment happy-dom

import type { IncomingMediaRequest } from "@q9labsai/chalk-client";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { MediaRequestDialog } from "./MediaRequestDialog";

describe("MediaRequestDialog", () => {
  it("renders the requested media action and actor name", () => {
    const request: IncomingMediaRequest = {
      requestId: "request-1",
      kind: "unmute",
      actorParticipantId: "moderator",
      actorDisplayName: "Grace",
      expiresAt: "2026-08-01T08:00:00.000Z",
    };

    render(<MediaRequestDialog request={request} onDecline={vi.fn()} onAllow={vi.fn()} />);

    expect(screen.getByRole("dialog", { name: "Unmute request" })).toHaveTextContent("Grace is asking you to unmute");
    expect(screen.getByRole("button", { name: "Not now" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Allow" })).toBeInTheDocument();
  });

  it("uses role-neutral copy when the actor name is unavailable", () => {
    const request: IncomingMediaRequest = {
      requestId: "request-2",
      kind: "start_camera",
      actorParticipantId: "participant-2",
      actorDisplayName: null,
      expiresAt: "2026-08-01T08:00:00.000Z",
    };

    render(<MediaRequestDialog request={request} onDecline={vi.fn()} onAllow={vi.fn()} />);

    expect(screen.getByRole("dialog", { name: "Camera request" })).toHaveTextContent("A participant is asking you to start your camera");
  });
});
