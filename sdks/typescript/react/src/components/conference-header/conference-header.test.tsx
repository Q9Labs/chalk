// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ConferenceHeader } from "./ConferenceHeader";

afterEach(cleanup);

describe("ConferenceHeader", () => {
  it("opens meeting information and keeps layout selection explicit", () => {
    const onInfo = vi.fn();
    const onLayoutChange = vi.fn();
    render(<ConferenceHeader roomName="Design review" duration={1122} layout="focus" onInfo={onInfo} onLayoutChange={onLayoutChange} />);

    fireEvent.click(screen.getByRole("button", { name: "Meeting information" }));
    fireEvent.click(screen.getByRole("button", { name: "Grid layout" }));
    fireEvent.click(screen.getByRole("button", { name: "Presentation layout" }));

    expect(onInfo).toHaveBeenCalledOnce();
    expect(onLayoutChange).toHaveBeenNthCalledWith(1, "grid");
    expect(onLayoutChange).toHaveBeenNthCalledWith(2, "presentation");
    expect(screen.getByRole("button", { name: "Spotlight layout" })).toHaveAttribute("aria-pressed", "true");
  });
});
