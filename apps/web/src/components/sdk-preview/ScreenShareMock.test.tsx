// @vitest-environment happy-dom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { ScreenShareMock } from "./ScreenShareMock";

afterEach(cleanup);

describe("ScreenShareMock", () => {
  it("renders the realistic shared product document", () => {
    render(<ScreenShareMock />);

    expect(screen.getByRole("heading", { name: "Design review" })).toBeTruthy();
    expect(screen.getByText("Today’s decisions")).toBeTruthy();
    expect(screen.getByText("42 ms")).toBeTruthy();
  });
});
