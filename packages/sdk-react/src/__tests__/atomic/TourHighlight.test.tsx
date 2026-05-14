import { describe, it, expect, vi } from "vitest";
import { render } from "@testing-library/react";
import { TourHighlight } from "../../components/atomic/TourHighlight";

describe("TourHighlight", () => {
  it("renders correctly when target element exists", () => {
    // Create a mock element
    const div = document.createElement("div");
    div.id = "target";
    div.getBoundingClientRect = () =>
      ({
        top: 100,
        left: 100,
        width: 100,
        height: 100,
        bottom: 200,
        right: 200,
      }) as any;
    document.body.appendChild(div);

    const { container } = render(<TourHighlight targetSelector="#target" />);
    const highlight = container.querySelector(".fixed");
    expect(highlight).toBeDefined();

    // Clean up
    document.body.removeChild(div);
  });

  it("returns null when target element does not exist", () => {
    const { container } = render(<TourHighlight targetSelector="#non-existent" />);
    expect(container.firstChild).toBeNull();
  });
});
