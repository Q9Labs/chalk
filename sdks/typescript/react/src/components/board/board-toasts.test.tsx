// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { ChalkProvider } from "../../bindings/context";
import { createPreviewClient } from "../../test-support/preview-client";
import { SpaceView } from "../space-view/SpaceView";

vi.mock("../stage/SpaceStage", async () => {
  const { useContext, createElement } = await import("react");
  const { BoardToastContext } = await import("../../../../../../packages/whiteboard/src/react/board/board-toasts");
  return {
    SpaceStage: () => {
      const toast = useContext(BoardToastContext);
      return createElement("button", { onClick: () => toast({ message: "Board cleared", action: { label: "Undo", onClick: () => undefined } }) }, "Clear board fixture");
    },
  };
});

it("removes the board Undo toast on close and does not restore it on reopen", async () => {
  const client = createPreviewClient();
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const render = async (isOpen: boolean) =>
    act(async () =>
      root.render(
        <ChalkProvider client={client}>
          <SpaceView spaceName="Board call" generatedAvatars={false} features={{ sounds: false }} whiteboard={{ isOpen, props: {} }} />
        </ChalkProvider>,
      ),
    );
  try {
    await render(true);
    await act(async () => [...container.querySelectorAll("button")].find((button) => button.textContent === "Clear board fixture")?.click());
    expect(container.textContent).toContain("Board cleared");
    await render(false);
    expect(container.textContent).not.toContain("Board cleared");
    await render(true);
    expect(container.textContent).not.toContain("Board cleared");
  } finally {
    await act(async () => root.unmount());
    container.remove();
    client.dispose();
  }
});
