// @vitest-environment happy-dom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { ParticipantGrid } from "./ParticipantGrid";

afterEach(cleanup);

describe("ParticipantGrid", () => {
  it.each(["desktop", "mobile"] as const)("renders the empty state for the %s variant", (variant) => {
    const { container } = render(<ParticipantGrid participants={[]} variant={variant} />);

    expect(screen.getByRole("status")).toHaveTextContent("The Space is quiet");
    expect(screen.getByRole("heading", { name: "The Space is quiet" })).toBeInTheDocument();
    expect(screen.getByText("No other Participants are here yet.")).toBeInTheDocument();
    expect(container.querySelector('[data-tour="video-grid"]')).toBeInTheDocument();
  });

  it("keeps the consumer class on the empty-state grid surface", () => {
    const { container } = render(<ParticipantGrid participants={[]} className="sdk-preview-grid" />);

    expect(container.querySelector('[data-tour="video-grid"]')).toHaveClass("sdk-preview-grid");
  });

  it("renders an application-owned screen-share surface with the participant rail", () => {
    render(
      <ParticipantGrid
        variant="desktop"
        layout="presentation"
        participants={[
          { id: "nora", displayName: "Nora", isScreenSharing: true },
          { id: "hasan", displayName: "Hasan", isLocal: true },
        ]}
        screenShareContent={<div>Shared product document</div>}
      />,
    );

    expect(screen.getByText("Shared product document")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Video tile for Hasan" })).toBeInTheDocument();
  });
});
