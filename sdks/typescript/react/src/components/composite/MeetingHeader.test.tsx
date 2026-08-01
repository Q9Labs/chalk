// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { MeetingHeader } from "./MeetingHeader";

afterEach(cleanup);

describe("MeetingHeader", () => {
  it("opens meeting information and keeps layout selection explicit", () => {
    const onInfo = vi.fn();
    const onLayoutChange = vi.fn();
    render(<MeetingHeader roomName="Design review" duration={1122} layout="spotlight" onInfo={onInfo} onLayoutChange={onLayoutChange} />);

    fireEvent.click(screen.getByRole("button", { name: "Meeting information" }));
    fireEvent.click(screen.getByRole("button", { name: "Grid layout" }));

    expect(onInfo).toHaveBeenCalledOnce();
    expect(onLayoutChange).toHaveBeenCalledWith("grid");
    expect(screen.getByRole("button", { name: "Spotlight layout" })).toHaveAttribute("aria-pressed", "true");
  });
});
