// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ChalkProvider } from "../../bindings/context";
import { SkinProvider } from "../skin-context";
import { createSnapshot, createTestClient } from "../../test-support/test-client";
import { ParticipantsPanel } from "./ParticipantsPanel";

afterEach(cleanup);

function createAdmissionClient(capabilities: Parameters<typeof createSnapshot>[0]) {
  const client = createTestClient(createSnapshot(capabilities));
  const snapshot = client.getSnapshot();
  client.setSnapshot({
    ...snapshot,
    self: { ...snapshot.self, participantId: "host", displayName: "Host" },
    participants: {
      ...snapshot.participants,
      admissionQueue: [{ requestId: "request-1", participantId: "guest", displayName: "Guest" }],
    },
  });
  return client;
}

describe("Participants admission section", () => {
  it("shows pending requests and capability-gated actions", () => {
    const client = createAdmissionClient(["manageAdmission"]);
    const admit = vi.spyOn(client.participants, "admit").mockResolvedValue(undefined);

    render(
      <ChalkProvider client={client}>
        <ParticipantsPanel variant="sidebar" />
      </ChalkProvider>,
    );

    expect(screen.getByRole("region", { name: "Admission requests" })).toBeInTheDocument();
    expect(screen.getByText("Guest")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Admit Guest" }));
    expect(admit).toHaveBeenCalledWith("request-1");
  });

  it("keeps the admission section visible for an authorized Participant with an empty queue", () => {
    const client = createTestClient(createSnapshot(["manageAdmission"]));

    render(
      <ChalkProvider client={client}>
        <ParticipantsPanel variant="sidebar" />
      </ChalkProvider>,
    );

    expect(screen.getByRole("region", { name: "Admission requests" })).toBeInTheDocument();
    expect(screen.getByText("No one is waiting to join")).toBeInTheDocument();
  });

  it("hides admission requests and actions without the canonical capability", () => {
    const client = createAdmissionClient(["sendChat"]);

    render(
      <ChalkProvider client={client}>
        <ParticipantsPanel variant="sidebar" />
      </ChalkProvider>,
    );

    expect(screen.queryByRole("region", { name: "Admission requests" })).not.toBeInTheDocument();
    expect(screen.queryByText("Guest")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Admit Guest" })).not.toBeInTheDocument();
  });
});

describe("Classic participants admission tabs", () => {
  it("opens on the Waiting tab when people are in the queue and admits from the flat list", () => {
    const client = createAdmissionClient(["manageAdmission"]);
    const admit = vi.spyOn(client.participants, "admit").mockResolvedValue(undefined);

    render(
      <ChalkProvider client={client}>
        <SkinProvider skin="classic">
          <ParticipantsPanel variant="sidebar" />
        </SkinProvider>
      </ChalkProvider>,
    );

    expect(screen.getByRole("tab", { name: /^Waiting/, selected: true })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Admission requests" })).toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "Search participants" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Admit Guest" }));
    expect(admit).toHaveBeenCalledWith("request-1");

    fireEvent.click(screen.getByRole("tab", { name: /^In Space/ }));
    expect(screen.getByRole("textbox", { name: "Search participants" })).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Admission requests" })).not.toBeInTheDocument();
  });

  it("starts on the roster with an empty queue and shows the empty Waiting tab on demand", () => {
    const client = createTestClient(createSnapshot(["manageAdmission"]));

    render(
      <ChalkProvider client={client}>
        <SkinProvider skin="classic">
          <ParticipantsPanel variant="sidebar" />
        </SkinProvider>
      </ChalkProvider>,
    );

    expect(screen.getByRole("tab", { name: /^In Space/, selected: true })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: /^Waiting/ }));
    expect(screen.getByText("No one is waiting to join")).toBeInTheDocument();
  });

  it("renders no tabs without the admission capability", () => {
    const client = createAdmissionClient(["sendChat"]);

    render(
      <ChalkProvider client={client}>
        <SkinProvider skin="classic">
          <ParticipantsPanel variant="sidebar" />
        </SkinProvider>
      </ChalkProvider>,
    );

    expect(screen.queryByRole("tablist")).not.toBeInTheDocument();
    expect(screen.queryByText("Guest")).not.toBeInTheDocument();
  });
});
