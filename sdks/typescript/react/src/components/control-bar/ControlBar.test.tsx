// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ControlBar } from "./ControlBar";
import { ChalkProvider } from "../../bindings/context";
import { SkinProvider } from "../skin-context";
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

  it("renders chalk chrome for compact media controls", () => {
    const { container } = render(
      <ChalkProvider client={createTestClient()}>
        <ControlBar placement="floating" density="compact" buttons={["mic", "leave"]} />
      </ChalkProvider>,
    );

    expect(container.querySelectorAll("svg[data-chalk-chrome='true']").length).toBeGreaterThanOrEqual(3);
    expect(screen.getByRole("button", { name: "Unmute" })).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByRole("button", { name: "Leave space" })).toBeInTheDocument();
  });

  it("uses the classic control layout without rough chrome", () => {
    render(
      <SkinProvider skin="classic">
        <ChalkProvider client={createTestClient()}>
          <ControlBar placement="floating" density="comfortable" buttons={["mic", "leave"]} />
        </ChalkProvider>
      </SkinProvider>,
    );

    const toolbar = screen.getByRole("toolbar", { name: "Space controls" });
    expect(toolbar).toHaveClass("pointer-events-auto");
    expect(toolbar.querySelector("svg[data-chalk-chrome='true']")).not.toBeInTheDocument();
  });

  it("condenses optional desktop controls until hover or keyboard focus", () => {
    render(
      <SkinProvider skin="classic">
        <ChalkProvider client={createTestClient(createSnapshot(["sendReaction"]))}>
          <ControlBar placement="floating" density="comfortable" buttons={["mic", "reactions", "leave"]} onOpenReactions={vi.fn()} />
        </ChalkProvider>
      </SkinProvider>,
    );

    const optionalControls = screen.getByRole("button", { name: "React" }).parentElement?.parentElement?.parentElement;
    expect(optionalControls).toHaveClass("-ml-2", "grid-cols-[0fr]", "opacity-0", "group-hover:grid-cols-[1fr]", "group-focus-within:opacity-100");
    expect(optionalControls?.firstElementChild).toHaveClass("-my-2", "overflow-hidden", "py-2");
  });

  it("keeps the comfortable floating shell transparent", () => {
    const { container } = render(
      <ChalkProvider client={createTestClient()}>
        <ControlBar placement="floating" density="comfortable" buttons={["mic", "leave"]} />
      </ChalkProvider>,
    );

    const toolbar = screen.getByRole("toolbar", { name: "Space controls" });
    expect(toolbar).toHaveClass("bg-transparent");
    expect(toolbar.querySelector("[data-chalk-layer='base-fill']")).not.toBeInTheDocument();
    expect(container.querySelector("svg[data-chalk-chrome='true']")).toBeInTheDocument();
  });

  it("does not expose the unwired Transcript action in the default Space controls", () => {
    render(
      <ChalkProvider client={createTestClient()}>
        <ControlBar placement="floating" density="comfortable" onToggleTranscription={vi.fn()} />
      </ChalkProvider>,
    );

    expect(screen.queryByRole("button", { name: "Transcript" })).not.toBeInTheDocument();
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
