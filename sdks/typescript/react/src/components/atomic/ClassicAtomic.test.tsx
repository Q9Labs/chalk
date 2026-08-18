// @vitest-environment happy-dom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { AudioIndicator } from "./AudioIndicator";
import { ConnectionQuality } from "./ConnectionQuality";
import { NameTag } from "./NameTag";
import { SkinProvider } from "../skin-context";

afterEach(cleanup);

describe("classic atomic visuals", () => {
  it("keeps the pre-chalk presentational output", () => {
    render(
      <SkinProvider skin="classic">
        <AudioIndicator variant="icon" level={70} />
        <ConnectionQuality quality={3} showLabel />
        <NameTag name="Grace" isLocal />
      </SkinProvider>,
    );

    expect(screen.getByRole("status", { name: "Microphone active" })).not.toHaveAttribute("data-chalk-chrome");
    expect(screen.getByRole("status", { name: "Connection quality: Good" }).querySelector("span")).toHaveTextContent("Good");
    expect(screen.getByText("Grace").parentElement).toHaveClass("rounded-lg");
    expect(document.querySelector("[data-chalk-chrome]"), "Classic output should not render chalk chrome").not.toBeInTheDocument();
  });

  it("switches skins without changing the public component", () => {
    const { rerender } = render(
      <SkinProvider skin="classic">
        <AudioIndicator variant="bars" level={70} />
      </SkinProvider>,
    );

    expect(document.querySelector("[data-chalk-chrome]")).not.toBeInTheDocument();

    rerender(
      <SkinProvider skin="chalk">
        <AudioIndicator variant="bars" level={70} />
      </SkinProvider>,
    );

    expect(document.querySelector("[data-chalk-chrome]")).toBeInTheDocument();
  });
});
