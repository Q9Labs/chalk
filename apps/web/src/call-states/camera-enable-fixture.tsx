import type { SpaceClient } from "@q9labsai/chalk-client";
import { ChalkProvider, ControlBar } from "@q9labsai/chalk-react";
import { createRoot } from "react-dom/client";

/** Mounts the real controls over an SDK client supplied by the browser test. */
class CameraEnableFixture extends HTMLElement {
  mount(client: SpaceClient): () => void {
    const element = this;
    element.dataset.chalk = "";
    element.className = "chalk-root";
    element.style.padding = "80px";
    element.style.display = "block";
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
}
customElements.define("chalk-camera-enable-fixture", CameraEnableFixture);
declare global {
  interface HTMLElementTagNameMap {
    "chalk-camera-enable-fixture": CameraEnableFixture;
  }
}
