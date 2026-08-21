// @vitest-environment happy-dom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { SpaceSnapshot } from "@q9labsai/chalk-client";

import { ChalkProvider } from "../../bindings/context";
import { SkinProvider } from "../skin-context";
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
    expect(document.querySelectorAll('svg[data-chalk-chrome="true"]').length).toBeGreaterThan(0);
  });

  it("restores the classic empty state without rough chrome", () => {
    render(
      <SkinProvider skin="classic">
        <ChalkProvider client={createTestClient(createSnapshot())}>
          <ParticipantGrid variant="desktop" />
        </ChalkProvider>
      </SkinProvider>,
    );

    const emptyState = screen.getByRole("status");
    expect(emptyState).toHaveClass("flex", "px-6", "py-10");
    expect(emptyState).toHaveTextContent("The Space is quiet");
    expect(emptyState.querySelector("svg[data-chalk-chrome='true']")).not.toBeInTheDocument();
  });

  it("derives participants from the provider store", () => {
    const client = createTestClient(createSnapshot());
    client.setSnapshot({
      ...client.getSnapshot(),
      self: { ...client.getSnapshot().self, participantId: "hasan", displayName: "Hasan" },
      participants: {
        roster: [{ participantId: "hasan", displayName: "Hasan", role: "member", eligibleRoles: [], capabilities: [], handRaised: false, media: { microphone: "inactive", camera: "active", screenShare: "inactive" }, presence: { state: "connected", speaking: false, activeSpeaker: false } }],
        admissionQueue: [],
      },
    });
    render(
      <ChalkProvider client={client}>
        <ParticipantGrid layout="grid" />
      </ChalkProvider>,
    );
    expect(screen.getByRole("button", { name: "Video tile for Hasan" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Video tile for Hasan" }).querySelector('svg[data-chalk-chrome="true"]')).toBeInTheDocument();
  });

  it("fills the stage for a single Participant", () => {
    const client = createTestClient(createSnapshot());
    client.setSnapshot({
      ...client.getSnapshot(),
      self: { ...client.getSnapshot().self, participantId: "hasan", displayName: "Hasan" },
      participants: {
        roster: [{ participantId: "hasan", displayName: "Hasan", role: "member", eligibleRoles: [], capabilities: [], handRaised: false, media: { microphone: "inactive", camera: "active", screenShare: "inactive" }, presence: { state: "connected", speaking: false, activeSpeaker: false } }],
        admissionQueue: [],
      },
    });
    render(
      <ChalkProvider client={client}>
        <ParticipantGrid layout="grid" />
      </ChalkProvider>,
    );

    expect(screen.getByRole("button", { name: "Video tile for Hasan" })).not.toHaveClass("aspect-video");
  });

  it("pages Participants beyond the visible cap and keeps the rest mounted", () => {
    const client = createTestClient(createSnapshot());
    const roster: SpaceSnapshot["participants"]["roster"] = ["hasan", "ada", "grace", "linus", "margaret"].map((participantId) => ({
      participantId,
      displayName: participantId,
      role: "member",
      eligibleRoles: [],
      capabilities: [],
      handRaised: false,
      media: { microphone: "inactive", camera: "active", screenShare: "inactive" },
      presence: { state: "connected", speaking: false, activeSpeaker: false },
    }));
    client.setSnapshot({
      ...client.getSnapshot(),
      self: { ...client.getSnapshot().self, participantId: "hasan", displayName: "Hasan" },
      participants: { roster, admissionQueue: [] },
    });

    render(
      <ChalkProvider client={client}>
        <ParticipantGrid variant="mobile" maxVisibleParticipants={4} />
      </ChalkProvider>,
    );

    expect(screen.getAllByRole("button", { name: /^Go to page \d+$/ })).toHaveLength(2);
    expect(screen.getAllByRole("button", { name: /^Video tile for/ })).toHaveLength(4);
    expect(screen.getByLabelText("Video tile for margaret")).toHaveAttribute("aria-hidden", "true");
  });
});
