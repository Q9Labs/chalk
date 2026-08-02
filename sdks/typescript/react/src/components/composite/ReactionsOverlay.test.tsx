// @vitest-environment happy-dom

import type { ChalkRoomReaction } from "@q9labsai/chalk-client";
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ReactionsOverlay } from "./ReactionsOverlay";

describe("ReactionsOverlay", () => {
  it("renders reactions in the live region", () => {
    const reactions: readonly ChalkRoomReaction[] = [
      {
        eventId: "reaction-1",
        participantSessionId: "participant-1",
        displayName: "Grace",
        reaction: "🎉",
        occurredAt: "2026-08-01T08:00:00.000Z",
        expiresAt: "2026-08-01T08:00:05.000Z",
      },
    ];

    render(<ReactionsOverlay reactions={reactions} />);

    expect(document.querySelector('[aria-live="polite"]')).toHaveTextContent("Grace reacted 🎉");
  });
});
