import { describe, it, expect, vi } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import { Thumbnail } from "../../components/atomic/Thumbnail";

// Mock MediaStream since JSDOM/HappyDOM doesn't have it
global.MediaStream = vi.fn().mockImplementation(() => ({
  getTracks: () => [],
})) as any;

describe("Thumbnail", () => {
  it("renders video element", () => {
    const { container } = render(<Thumbnail />);
    expect(container.querySelector("video")).toBeDefined();
  });

  it("handles click events", () => {
    const onClick = vi.fn();
    const { getByRole } = render(<Thumbnail onClick={onClick} />);
    fireEvent.click(getByRole("button"));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("shows muted icon when muted is true", () => {
    const { container } = render(<Thumbnail muted />);
    expect(container.querySelector("svg")).toBeDefined();
  });

  it("applies active ring when active is true", () => {
    const { getByRole } = render(<Thumbnail active />);
    expect(getByRole("button")).toHaveClass("ring-2");
  });
});
