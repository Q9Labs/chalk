// @vitest-environment happy-dom

import type { ChalkIncomingMediaRequest } from "@q9labsai/chalk-client";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { IncomingMediaRequestDialog } from "./IncomingMediaRequestDialog";

describe("IncomingMediaRequestDialog", () => {
  it("renders the requested media action and moderator name", () => {
    const request: ChalkIncomingMediaRequest = {
      requestId: "request-1",
      kind: "unmute",
      actorParticipantSessionId: "host",
      actorDisplayName: "Grace",
      expiresAt: "2026-08-01T08:00:00.000Z",
    };

    render(<IncomingMediaRequestDialog request={request} onDecline={vi.fn()} onAllow={vi.fn()} />);

    expect(screen.getByRole("dialog", { name: "Unmute request" })).toHaveTextContent("Grace is asking you to unmute");
    expect(screen.getByRole("button", { name: "Not now" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Allow" })).toBeInTheDocument();
  });
});
