import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { Waveform } from "../../components/atomic/Waveform";

describe("Waveform", () => {
  it("renders correctly", () => {
    const { getByRole } = render(<Waveform levels={[10, 20, 30, 40, 50]} />);
    expect(getByRole("img")).toHaveAttribute("aria-label", "Audio waveform");
  }, 10_000);

  it("renders correct number of bars", () => {
    const { getByRole } = render(<Waveform levels={[10, 20, 30]} barCount={3} />);
    const container = getByRole("img");
    const bars = container.querySelectorAll("div");
    expect(bars.length).toBe(3);
  });

  it("handles empty levels", () => {
    const { getByRole } = render(<Waveform levels={[]} barCount={5} />);
    const container = getByRole("img");
    const bars = container.querySelectorAll("div");
    expect(bars.length).toBe(5);
    bars.forEach((bar) => {
      expect((bar as HTMLElement).style.height).toBe("10%");
    });
  });
});
