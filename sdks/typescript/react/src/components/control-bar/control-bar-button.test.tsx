// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ControlBarButton } from "./control-bar-button";
import { SkinProvider } from "../skin-context";

afterEach(cleanup);

describe("ControlBarButton", () => {
  it("keeps actions and pressed state on chalk icon chrome", () => {
    const onClick = vi.fn();

    render(<ControlBarButton active icon={<span aria-hidden="true">+</span>} label="Raise hand" onClick={onClick} seed="control-test" />);

    const button = screen.getByRole("button", { name: "Raise hand" });
    expect(button).toHaveAttribute("aria-pressed", "true");
    expect(button.querySelector("svg[data-chalk-chrome='true']")).toBeInTheDocument();

    fireEvent.click(button);
    expect(onClick).toHaveBeenCalledOnce();
  });

  it("restores the classic button structure without rough chrome", () => {
    render(
      <SkinProvider skin="classic">
        <ControlBarButton active icon={<span aria-hidden="true">+</span>} label="Raise hand" />
      </SkinProvider>,
    );

    const button = screen.getByRole("button", { name: "Raise hand" });
    expect(button).toHaveClass("group", "relative", "flex");
    expect(button.querySelector("svg[data-chalk-chrome='true']")).not.toBeInTheDocument();
  });
});
