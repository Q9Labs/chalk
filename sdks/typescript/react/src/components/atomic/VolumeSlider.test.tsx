// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { VolumeSlider } from "./VolumeSlider";

afterEach(cleanup);

describe("VolumeSlider", () => {
  it("renders chalk slider chrome and forwards native range changes", () => {
    const onChange = vi.fn();
    render(<VolumeSlider value={50} onChange={onChange} showValue />);

    const slider = screen.getByRole("slider", { name: "Volume" });
    expect(slider).toBeInTheDocument();
    expect(slider.closest("span")?.querySelector("[data-chalk-chrome]")).toBeInTheDocument();
    expect(screen.getByText("50%")).toBeInTheDocument();

    fireEvent.change(slider, { target: { value: "75" } });
    expect(onChange).toHaveBeenCalledWith(75);
  });
});
