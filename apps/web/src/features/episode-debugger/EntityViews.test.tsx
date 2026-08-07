// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EpilogueView, ParticipantsView } from "./EntityViews";
import { snapshotFixture } from "./test-fixtures";

afterEach(cleanup);

const participant = {
  schemaVersion: "ParticipantProjection/v1" as const,
  participantId: "participant-7",
  anonymousLabel: "Participant 7",
  identityKind: "agent" as const,
  state: "reconnecting" as const,
  joinedAt: "2026-08-04T10:00:00.000Z",
  visibility: "not_observable" as const,
  visibilityGaps: ["remote_track"],
  operationCount: 3,
  issueCount: 1,
  display: { label: { value: "Operator" }, rawIdentity: { value: "private-user" } },
};

describe("EntityViews", () => {
  it("keeps Participant identity opaque while exposing trace and gap actions", () => {
    const onSelect = vi.fn();
    const onOpenRelated = vi.fn();
    render(<ParticipantsView snapshot={snapshotFixture(8, { participants: [participant] })} onSelect={onSelect} onOpenRelated={onOpenRelated} />);

    expect(screen.getByText("Operator")).toBeTruthy();
    expect(screen.getByText("unknown: raw identity omitted")).toBeTruthy();
    expect(screen.getByText("remote_track")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Open trace" }));
    expect(onOpenRelated).toHaveBeenCalledWith({ schemaVersion: "DiagnosticFilter/v1", participantId: participant.participantId });
    fireEvent.click(screen.getByRole("button", { name: "Inspect Participant" }));
    expect(onSelect).toHaveBeenCalledWith({ kind: "participant", value: participant });
  });

  it("selects Epilogue branches and keeps late work visible", () => {
    const onSelect = vi.fn();
    const branch = { id: "branch-cleanup", kind: "cleanup" as const, state: "running" as const, leaseEndsAt: "2026-08-04T10:05:00.000Z", attempts: 1, lateObservations: 2 };
    render(<EpilogueView snapshot={snapshotFixture(8, { branches: [branch] })} onSelect={onSelect} />);

    expect(screen.getByText("2 late")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /cleanup.*attempts 1/ }));
    expect(onSelect).toHaveBeenCalledWith({ kind: "branch", value: branch });
  });
});
