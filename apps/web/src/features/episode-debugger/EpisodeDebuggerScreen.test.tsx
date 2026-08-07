// @vitest-environment happy-dom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { EpisodeDebuggerScreen } from "./EpisodeDebuggerScreen";
import { TEST_REFERENCE } from "./test-fixtures";

afterEach(cleanup);

describe("EpisodeDebuggerScreen", () => {
  it("refuses a disabled diagnostics build before constructing the API client", () => {
    render(<EpisodeDebuggerScreen reference={TEST_REFERENCE} mode="off" />);

    expect(screen.getByRole("heading", { name: "Episode Diagnostics are off" })).toBeTruthy();
    expect(screen.getByText("This build does not register the debugger route when diagnostics mode is off.")).toBeTruthy();
  });
});
