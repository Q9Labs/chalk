import { describe, it, expect } from "bun:test";
import { render } from "@testing-library/react";
import { MessageBubble } from "../../components/composite/MessageBubble";

describe("MessageBubble", () => {
  const timestamp = new Date("2025-01-01T12:00:00");

  it("renders content correctly", () => {
    const { getByText, getByLabelText } = render(<MessageBubble content="Hello" senderName="Alice" timestamp={timestamp} />);
    expect(getByText("Hello")).toBeDefined();
    expect(getByLabelText("Avatar for Alice")).toBeDefined();
  });

  it("renders links as anchor tags", () => {
    const { getByRole } = render(<MessageBubble content="Check https://example.com" senderName="Alice" timestamp={timestamp} />);
    const link = getByRole("link");
    expect(link).toHaveAttribute("href", "https://example.com");
  });

  it("renders system message correctly", () => {
    const { getByText } = render(<MessageBubble content="Alice joined" senderName="System" timestamp={timestamp} isSystem />);
    expect(getByText("Alice joined")).toBeDefined();
  });

  it("applies local message styles", () => {
    const { container } = render(<MessageBubble content="My message" senderName="Me" timestamp={timestamp} isLocal />);
    const bubble = container.querySelector(".bg-primary");
    expect(bubble).toBeDefined();
  });
});
