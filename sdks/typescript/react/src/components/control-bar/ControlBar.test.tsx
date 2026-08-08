// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ControlBar } from "./ControlBar";
import { ChalkProvider } from "../../bindings/context";
import { createSnapshot, createTestClient } from "../../test-support/test-client";

afterEach(cleanup);

describe("ControlBar", () => {
  it("uses context commands for every rendered bare-provider control", () => {
    const client = createTestClient(createSnapshot(["publishScreen", "raiseHand"]));

    render(
      <ChalkProvider client={client}>
        <ControlBar placement="floating" density="comfortable" buttons={["mic", "video", "screenshare", "handraise", "leave", "chat", "settings"]} />
      </ChalkProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Unmute microphone" }));
    fireEvent.click(screen.getByRole("button", { name: "Turn on camera" }));
    fireEvent.click(screen.getByRole("button", { name: "Share" }));
    fireEvent.click(screen.getByRole("button", { name: "Raise" }));
    fireEvent.click(screen.getByRole("button", { name: "Leave" }));

    expect(client.media.setMicrophoneEnabled).toHaveBeenCalledWith(true);
    expect(client.media.setCameraEnabled).toHaveBeenCalledWith(true);
    expect(client.media.setScreenShareEnabled).toHaveBeenCalledWith(true);
    expect(client.participants.raiseHand).toHaveBeenCalledOnce();
    expect(client.leave).toHaveBeenCalledOnce();
    expect(screen.queryByRole("button", { name: "Chat" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Settings" })).not.toBeInTheDocument();
  });

  it("uses app control tokens for compact media controls", () => {
    const { container } = render(
      <ChalkProvider client={createTestClient()}>
        <ControlBar placement="floating" density="compact" buttons={["mic", "leave"]} />
      </ChalkProvider>,
    );

    expect(container.querySelector('[class*="chalk-app-control-primary"]')).toBeInTheDocument();
    expect(container.querySelector('[class*="chalk-app-danger"]')).toBeInTheDocument();
  });

  it("surfaces bare-provider command failures", async () => {
    const client = createTestClient();
    vi.spyOn(client.media, "setMicrophoneEnabled").mockRejectedValueOnce(new Error("Microphone update failed"));

    render(
      <ChalkProvider client={client}>
        <ControlBar placement="floating" density="comfortable" buttons={["mic"]} />
      </ChalkProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Unmute microphone" }));

    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Microphone update failed"));
  });
});
