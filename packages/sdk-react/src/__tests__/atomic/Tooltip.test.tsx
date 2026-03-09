import { describe, it, expect } from "bun:test";
import { render, fireEvent } from "@testing-library/react";
import { Tooltip } from "../../components/atomic/Tooltip";

describe("Tooltip", () => {
  it("renders children", () => {
    const { getByText } = render(
      <Tooltip content="Helper text">
        <button type="button">Hover me</button>
      </Tooltip>,
    );
    expect(getByText("Hover me")).toBeDefined();
  });

  it("handles hover events without crashing", () => {
    const { getByText, queryByText } = render(
      <Tooltip content="Helper text" delay={0}>
        <button type="button">Hover me</button>
      </Tooltip>,
    );

    const trigger = getByText("Hover me");
    fireEvent.mouseOver(trigger);
    fireEvent.mouseMove(trigger);
    fireEvent.pointerLeave(trigger);
    expect(queryByText("Helper text")).toBeNull();
  });
});
