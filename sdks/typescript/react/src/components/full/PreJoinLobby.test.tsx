// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PreJoinLobby } from "./PreJoinLobby";

afterEach(cleanup);

describe("PreJoinLobby", () => {
  it("passes the chosen identity and media preferences to the consumer", () => {
    const onJoin = vi.fn();
    render(<PreJoinLobby defaultDisplayName="Ada" initialMicrophoneEnabled initialCameraEnabled onJoin={onJoin} />);

    fireEvent.click(screen.getByRole("button", { name: "Mute" }));
    fireEvent.click(screen.getByRole("button", { name: "Stop video" }));
    fireEvent.change(screen.getByLabelText("Your name"), { target: { value: "Ada Lovelace" } });
    fireEvent.click(screen.getByRole("button", { name: "Join meeting" }));

    expect(onJoin).toHaveBeenCalledWith({ displayName: "Ada Lovelace", microphoneEnabled: false, cameraEnabled: false });
  });

  it("does not offer a blank identity to the session creator", () => {
    render(<PreJoinLobby defaultDisplayName="" onJoin={vi.fn()} />);

    expect(screen.getByRole("button", { name: "Join meeting" })).toBeDisabled();
  });

  it("uses a consumer-provided logo without assuming an application asset path", () => {
    const { rerender } = render(<PreJoinLobby defaultDisplayName="Ada" onJoin={vi.fn()} />);
    expect(screen.queryByRole("img", { name: "Chalk" })).not.toBeInTheDocument();
    expect(screen.getByText("Chalk")).toBeInTheDocument();

    rerender(<PreJoinLobby logoUrl="/chalk.svg" defaultDisplayName="Ada" onJoin={vi.fn()} />);
    expect(screen.getByRole("img", { name: "Chalk" })).toHaveAttribute("src", "/chalk.svg");
  });
});
