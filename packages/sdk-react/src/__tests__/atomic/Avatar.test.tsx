import { beforeEach, describe, expect, it } from "bun:test";
import { render } from "@testing-library/react";
import { Avatar } from "../../components/atomic/Avatar";

describe("Avatar", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("renders a generated avatar when no src is provided", () => {
    const { getByRole } = render(<Avatar name="John Doe" />);
    const img = getByRole("img", { name: "John Doe" });
    expect(img).toBeDefined();
    expect(img).toHaveAttribute("src", expect.stringContaining("https://facehash.dev/api/avatar"));
    expect(img).toHaveAttribute("src", expect.stringContaining("intensity3d=dramatic"));
    expect(img).toHaveAttribute("src", expect.stringContaining("enableBlink=true"));
    expect(getByRole("img", { name: "Avatar for John Doe" })).toBeDefined();
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
