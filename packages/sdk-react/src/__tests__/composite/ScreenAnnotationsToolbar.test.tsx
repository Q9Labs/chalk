import { describe, expect, it, vi } from "bun:test";
import { fireEvent, render } from "@testing-library/react";
import { ScreenAnnotationsToolbar } from "../../components/composite/screen-annotations/ScreenAnnotationsToolbar";

const noop = () => {};

describe("ScreenAnnotationsToolbar", () => {
  it("shows the launcher during an active share even before draw permissions resolve", () => {
    const onOpen = vi.fn();
    const { getByText } = render(
      <ScreenAnnotationsToolbar
        isOpen={false}
        canDraw={false}
        canLaunch={true}
        isHost={false}
        isSessionActive={false}
        activeTool="pen"
        accessMode="all"
        canUndo={false}
        canRedo={false}
        onOpen={onOpen}
        onClose={noop}
        onToolChange={noop}
        onUndo={noop}
        onRedo={noop}
        onClear={noop}
        onAccessModeChange={noop}
      />,
    );

    fireEvent.click(getByText("Annotate"));
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it("shows connecting state while the annotation session is still syncing", () => {
    const { getByText } = render(
      <ScreenAnnotationsToolbar
        isOpen={true}
        canDraw={false}
        canLaunch={true}
        isHost={true}
        isSessionActive={false}
        activeTool="pen"
        accessMode="all"
        canUndo={false}
        canRedo={false}
        onOpen={noop}
        onClose={noop}
        onToolChange={noop}
        onUndo={noop}
        onRedo={noop}
        onClear={noop}
        onAccessModeChange={noop}
      />,
    );

    expect(getByText("Connecting annotations...")).toBeDefined();
  });
});
