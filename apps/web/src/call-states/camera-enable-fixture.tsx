import type { SpaceClient } from "@q9labsai/chalk-client";
import { ChalkProvider, ControlBar } from "@q9labsai/chalk-react";
import { createRoot } from "react-dom/client";

/** Mounts the real controls over an SDK client supplied by the browser test. */
export function mountCameraEnableMenu(client: SpaceClient): () => void {
  const element = document.createElement("div");
  element.dataset.chalk = "";
  element.className = "chalk-root";
  element.style.padding = "80px";
  document.body.replaceChildren(element);
  const root = createRoot(element);
  root.render(
    <ChalkProvider client={client}>
      <ControlBar buttons={["video"]} />
    </ChalkProvider>,
  );
  return () => {
    root.unmount();
    element.remove();
  };
}
