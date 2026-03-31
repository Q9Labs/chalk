import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { Spinner } from "../../components/atomic/Spinner";

describe("Spinner", () => {
  it("renders correctly", () => {
    const { getByRole } = render(<Spinner />);
    expect(getByRole("status")).toHaveAttribute("aria-label", "Loading");
  });

  it("applies size classes", () => {
    const { container } = render(<Spinner size="xl" />);
    expect(container.querySelector("svg")).toHaveClass("w-12");
    expect(container.querySelector("svg")).toHaveClass("h-12");
  });

  it("applies custom color", () => {
    const { container } = render(<Spinner color="red" />);
    const svg = container.querySelector("svg") as HTMLElement;
    expect(svg.style.color).toBe("red");
  });
});
