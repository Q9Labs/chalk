import type { SpaceClient } from "@q9labsai/chalk-client";
import { createSpaceClientForPlatform } from "@q9labsai/chalk-client/effect";
import { createCoreTestPlatform, opaqueAccessGrant } from "../../../../sdks/typescript/client/src/space-client/core.test.helpers";
import { ChalkProvider, ControlBar } from "@q9labsai/chalk-react";
import { createRoot } from "react-dom/client";

/** Mounts the real controls over an SDK client supplied by the browser test. */
class CameraEnableFixture extends HTMLElement {
  async mountPendingCamera() {
    const platform = createCoreTestPlatform();
    const tracks: MediaStreamTrack[] = [];
    let calls = 0;
    let allowCapture = () => {};
    let allowPublish = () => {};
    const captureReady = new Promise<void>((resolve) => {
      allowCapture = resolve;
    });
    const publishReady = new Promise<void>((resolve) => {
      allowPublish = resolve;
    });
    const client = createSpaceClientForPlatform(
      { space: "space-1", baseUrl: window.location.origin, getAccess: async () => opaqueAccessGrant("test") },
      {
        ...platform,
        dependencies: {
          ...platform.dependencies,
          mediaDevices: {
            ...platform.dependencies.mediaDevices,
            getUserMedia: async (constraints: MediaStreamConstraints) => {
              calls++;
              const stream = await navigator.mediaDevices.getUserMedia(constraints);
              tracks.push(...stream.getTracks());
              await captureReady;
              return stream;
            },
            enumerateDevices: () => navigator.mediaDevices.enumerateDevices(),
          },
          createSyncClient: () => ({
            ...platform.sync,
            setCameraEnabled: async () => {
              await publishReady;
              return { operationId: "enable", name: "set_camera_enabled", serverOutcome: "satisfied", mediaPlaneOutcome: "satisfied" };
            },
          }),
        },
      },
    );
    await client.join({ microphone: false, camera: false });
    const unmount = this.mount(client);
    return {
      calls: () => calls,
      tracks,
      allowCapture,
      allowPublish,
      dispose: () => {
        allowCapture();
        allowPublish();
        unmount();
        client.dispose();
      },
    };
  }

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
