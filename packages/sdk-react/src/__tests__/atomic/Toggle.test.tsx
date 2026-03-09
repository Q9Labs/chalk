import { describe, it, expect } from "bun:test";
import { render } from "@testing-library/react";
import { Toggle } from "../../components/atomic/Toggle";

describe("Toggle", () => {
  it("renders correctly with label", () => {
    const { getByRole } = render(<Toggle checked={false} onChange={() => {}} label="Enable feature" />);
    const toggle = getByRole("switch");
    expect(toggle).toHaveAttribute("aria-checked", "false");
  });

  it("renders checked state", () => {
    const { getByRole } = render(<Toggle checked={true} onChange={() => {}} />);
    const toggle = getByRole("switch");
    expect(toggle).toHaveAttribute("aria-checked", "true");
  });

  it("can be disabled", () => {
    const { getByRole } = render(<Toggle checked={false} onChange={() => {}} disabled />);
    const button = getByRole("switch");
    expect(button).toHaveAttribute("aria-disabled", "true");
  });
});
