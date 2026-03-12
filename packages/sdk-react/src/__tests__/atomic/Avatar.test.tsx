import { beforeEach, describe, expect, it } from "bun:test";
import { render } from "@testing-library/react";
import { Avatar } from "../../components/atomic/Avatar";

describe("Avatar", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("renders a generated avatar when no src is provided", () => {
    const { container, getByRole } = render(<Avatar name="John Doe" />);
    const avatar = getByRole("img", { name: "Avatar for John Doe" });
    expect(avatar).toBeDefined();
    expect(container.querySelector("[data-facehash]")).toBeDefined();
    expect(container.querySelector("svg")).toBeDefined();
  });

  it("renders initials when generated avatars are disabled", () => {
    localStorage.setItem(
      "chalk-meeting-settings",
      JSON.stringify({
        version: 6,
        appearance: {
          generatedAvatars: false,
        },
      }),
    );

    const { getByText, queryByRole } = render(<Avatar name="John Doe" />);
    expect(getByText("JD")).toBeDefined();
    expect(queryByRole("img", { name: "John Doe" })).toBeNull();
  });

  it("renders an image when src is provided", () => {
    const { getByRole } = render(<Avatar name="John Doe" src="https://example.com/avatar.jpg" />);
    const img = getByRole("img", { name: "John Doe" });
    expect(img).toBeDefined();
    expect(img).toHaveAttribute("src", "https://example.com/avatar.jpg");
  });

  it("falls back to a generated avatar when the image fails and fun avatars stay enabled", () => {
    const { container, getByRole } = render(<Avatar name="John Doe" src="https://example.com/avatar.jpg" />);
    const img = getByRole("img", { name: "John Doe" });
    img.dispatchEvent(new Event("error"));

    expect(getByRole("img", { name: "Avatar for John Doe" })).toBeDefined();
    expect(container.querySelector("svg")).toBeDefined();
  });

  it("renders status indicator when status is provided", () => {
    const { container } = render(<Avatar name="John Doe" status="online" />);
    const statusIndicator = container.querySelector("span");
    expect(statusIndicator).toBeDefined();
  });

  it("applies custom size styles", () => {
    const { container } = render(<Avatar name="John Doe" size="lg" />);
    const avatar = container.firstChild as HTMLElement;
    expect(avatar.style.width).toBe("64px");
    expect(avatar.style.height).toBe("64px");
  });

  it("applies custom className", () => {
    const { container } = render(<Avatar name="John Doe" className="custom-avatar" />);
    expect(container.firstChild).toHaveClass("custom-avatar");
  });
});
