// @vitest-environment happy-dom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { ChalkProvider } from "../../bindings/context";
import { createSnapshot, createTestClient } from "../../test-support/test-client";
import { ParticipantGrid } from "./ParticipantGrid";

afterEach(cleanup);

describe("ParticipantGrid", () => {
  it.each(["desktop", "mobile"] as const)("renders the empty state for the %s variant", (variant) => {
    const client = createTestClient(createSnapshot());
    render(
      <ChalkProvider client={client}>
        <ParticipantGrid variant={variant} />
      </ChalkProvider>,
    );
    expect(screen.getByRole("status")).toHaveTextContent("The Space is quiet");
  });

  it("derives participants from the provider store", () => {
    const client = createTestClient(createSnapshot());
    client.setSnapshot({
      ...client.getSnapshot(),
      self: { ...client.getSnapshot().self, participantId: "hasan", displayName: "Hasan" },
      participants: { roster: [{ participantId: "hasan", displayName: "Hasan", role: "member", eligibleRoles: [], capabilities: [], handRaised: false, media: { microphone: "inactive", camera: "active", screenShare: "inactive" } }], admissionQueue: [] },
    });
    render(
      <ChalkProvider client={client}>
        <ParticipantGrid layout="grid" />
      </ChalkProvider>,
    );
    expect(screen.getByRole("button", { name: "Video tile for Hasan" })).toBeInTheDocument();
  });

  it("fills the stage for a single Participant", () => {
    const client = createTestClient(createSnapshot());
    client.setSnapshot({
      ...client.getSnapshot(),
      self: { ...client.getSnapshot().self, participantId: "hasan", displayName: "Hasan" },
      participants: { roster: [{ participantId: "hasan", displayName: "Hasan", role: "member", eligibleRoles: [], capabilities: [], handRaised: false, media: { microphone: "inactive", camera: "active", screenShare: "inactive" } }], admissionQueue: [] },
    });
    render(
      <ChalkProvider client={client}>
        <ParticipantGrid layout="grid" />
      </ChalkProvider>,
    );

    expect(screen.getByRole("button", { name: "Video tile for Hasan" })).not.toHaveClass("aspect-video");
  });
});
