// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ReconnectingOverlay } from "./ReconnectingOverlay";

afterEach(cleanup);

describe("ReconnectingOverlay", () => {
  it("keeps the overlay hidden until requested", () => {
    const { container } = render(<ReconnectingOverlay isVisible={false} status="reconnecting" />);

    expect(container).toBeEmptyDOMElement();
  });

  it("renders chalk recovery chrome and preserves retry and leave actions", () => {
    const onRetry = vi.fn();
    const onLeft = vi.fn();
    const { container } = render(<ReconnectingOverlay isVisible status="failed" supportCode="retry-42" onRetry={onRetry} onLeft={onLeft} />);

    expect(screen.getByRole("alertdialog")).toHaveTextContent("Unable to connect to the server.");
    expect(screen.getByText("retry-42")).toBeInTheDocument();
    expect(container.querySelectorAll("svg[data-chalk-chrome='true']").length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole("button", { name: "Try Again" }));
    fireEvent.click(screen.getByRole("button", { name: "Leave Space" }));

    expect(onRetry).toHaveBeenCalledOnce();
    expect(onLeft).toHaveBeenCalledOnce();
  });
});
