import React from "react";
import { render } from "@testing-library/react";
import { describe, it, expect } from "bun:test";
import { LoadingScreen } from "../../components/full/LoadingScreen";

describe("LoadingScreen", () => {
  it("renders correctly with default message", () => {
    const { getByText } = render(<LoadingScreen />);
    expect(getByText("Loading...")).toBeDefined();
  });

  it("renders with custom message", () => {
    const customMessage = "Joining the Matrix...";
    const { getByText } = render(<LoadingScreen message={customMessage} />);
    expect(getByText(customMessage)).toBeDefined();
  });

  it("has appropriate accessibility attributes (though purely visual)", () => {
    const { container } = render(<LoadingScreen />);
    // Check if the main container is present
    expect(container.firstChild).toBeDefined();
    // Check for the animation elements by class presence
    expect(container.querySelector(".chalk-animate-ripple")).toBeDefined();
    expect(container.querySelector(".chalk-animate-spin-slow")).toBeDefined();
  });
});
