import { describe, it, expect, vi } from "bun:test";
import { act, render } from "@testing-library/react";
import { ReactionBubble } from "../../components/atomic/ReactionBubble";

describe("ReactionBubble", () => {
  it("renders emoji", () => {
    const { getByText } = render(<ReactionBubble emoji="🔥" />);
    expect(getByText("🔥")).toBeDefined();
  });

  it("calls onComplete after duration", async () => {
    const onComplete = vi.fn();
    vi.useFakeTimers();

    render(<ReactionBubble emoji="🔥" onComplete={onComplete} duration={100} />);

    await act(async () => {
      vi.advanceTimersByTime(150);
    });

    expect(onComplete).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it("hides after duration", async () => {
    vi.useFakeTimers();

    const { queryByText } = render(<ReactionBubble emoji="🔥" duration={100} />);
    expect(queryByText("🔥")).toBeDefined();

    await act(async () => {
      vi.advanceTimersByTime(150);
    });

    expect(queryByText("🔥")).toBeNull();
    vi.useRealTimers();
  });
});
