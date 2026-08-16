// @vitest-environment happy-dom

import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ReactionsOverlay } from "./ReactionsOverlay";
import { ChalkProvider } from "../../bindings/context";
import { createSnapshot, createTestClient } from "../../test-support/test-client";

describe("ReactionsOverlay", () => {
  it("renders reactions in the live region", () => {
    const reaction = {
      eventId: "reaction-1",
      participantId: "participant-1",
      displayName: "Grace",
      reaction: "🎉",
      occurredAt: "2026-08-01T08:00:00.000Z",
      expiresAt: "2026-08-01T08:00:05.000Z",
    } as const;
    const client = createTestClient(createSnapshot());
    client.setSnapshot({ ...client.getSnapshot(), reactions: { active: [reaction] } });

    render(
      <ChalkProvider client={client}>
        <ReactionsOverlay />
      </ChalkProvider>,
    );

    expect(document.querySelector('[aria-live="polite"]')).toHaveTextContent("Grace reacted 🎉");
    expect(document.querySelector('svg[data-chalk-chrome="true"]')).toBeInTheDocument();
  });
});
