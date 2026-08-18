// @vitest-environment happy-dom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

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
});
