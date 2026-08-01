// @vitest-environment happy-dom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { VideoGrid } from "./VideoGrid";

afterEach(cleanup);

describe("VideoGrid", () => {
  it("renders an application-owned screen-share surface with the participant rail", () => {
    render(
      <VideoGrid
        variant="desktop"
        layout="screen-share"
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
