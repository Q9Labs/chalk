// @vitest-environment happy-dom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@q9labsai/facehash/react", () => ({
  Facehash: ({ name }: { readonly name: string }) => <span data-testid="facehash-avatar">{name}</span>,
}));

import { SkinProvider } from "../skin-context";
import { ParticipantTile } from "./ParticipantTile";

afterEach(cleanup);

describe("ParticipantTile", () => {
  it("restores the classic tile structure without rough chrome", () => {
    render(
      <SkinProvider skin="classic">
        <ParticipantTile participant={{ id: "hasan", displayName: "Hasan" }} />
      </SkinProvider>,
    );

    const tile = screen.getByRole("region", { name: "Video tile for Hasan" });
    expect(tile).toHaveClass("rounded-[8px]", "border-transparent");
    expect(tile.querySelector("svg[data-chalk-chrome='true']")).not.toBeInTheDocument();
  });

  it.each(["classic", "chalk"] as const)("uses the generated avatars preference throughout the %s tile", (skin) => {
    const view = render(
      <SkinProvider skin={skin}>
        <ParticipantTile participant={{ id: "hasan", displayName: "Hasan" }} generatedAvatars />
      </SkinProvider>,
    );

    expect(screen.getAllByTestId("facehash-avatar")).toHaveLength(2);

    view.rerender(
      <SkinProvider skin={skin}>
        <ParticipantTile participant={{ id: "hasan", displayName: "Hasan" }} generatedAvatars={false} />
      </SkinProvider>,
    );

    expect(screen.queryByTestId("facehash-avatar")).not.toBeInTheDocument();
    expect(screen.getAllByText("H")).toHaveLength(2);
  });

  it("shows the voice halo only for an unmuted speaker with the camera off", () => {
    const participant = { id: "hasan", displayName: "Hasan", isSpeaking: true, isMuted: false, isVideoEnabled: false };
    const view = render(<ParticipantTile participant={participant} />);
    const tile = screen.getByRole("region", { name: "Video tile for Hasan" });

    expect(tile.querySelector(".chalk-voice-halo")).toBeInTheDocument();

    view.rerender(<ParticipantTile participant={{ ...participant, isMuted: true }} />);
    expect(tile.querySelector(".chalk-voice-halo")).not.toBeInTheDocument();
  });
});
