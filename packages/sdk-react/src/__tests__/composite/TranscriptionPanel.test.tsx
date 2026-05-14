import { describe, it, expect, vi, beforeAll } from "vitest";
import { render } from "@testing-library/react";
import { TranscriptionPanel } from "../../components/composite/TranscriptionPanel";

describe("TranscriptionPanel", () => {
  beforeAll(() => {
    window.HTMLElement.prototype.scrollIntoView = vi.fn();
  });

  const transcripts = [{ id: "1", speaker: "Alice", speakerId: "u1", text: "Hello", timestamp: new Date() }];

  it("renders transcripts correctly", () => {
    const { getByText } = render(<TranscriptionPanel transcripts={transcripts} />);
    expect(getByText("Alice")).toBeDefined();
    expect(getByText("Hello")).toBeDefined();
  });

  it("shows empty state message", () => {
    const { getByText } = render(<TranscriptionPanel transcripts={[]} />);
    expect(getByText("No transcripts yet")).toBeDefined();
  });

  it("renders status badge when live", () => {
    const { getByText } = render(<TranscriptionPanel transcripts={[]} isLive={true} />);
    expect(getByText("Live")).toBeDefined();
  });
});
