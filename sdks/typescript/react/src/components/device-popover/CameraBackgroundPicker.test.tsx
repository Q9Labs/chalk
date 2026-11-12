// @vitest-environment jsdom
import { act, Suspense, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import type { loadCameraBackgroundControls } from "@q9labsai/chalk-client";
import { CameraBackgroundPicker, type CameraBackgroundMenu } from "./CameraBackgroundPicker";

const menu: CameraBackgroundMenu = {
  Label: ({ children }: { readonly children: ReactNode }) => <span>{children}</span>,
  Item: ({ children, onClick }) => <button onClick={onClick}>{children}</button>,
};

it("keeps a failed controls download local and retries when the picker reopens", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  let downloads = 0;
  const loadControls = (async () => {
    downloads += 1;
    if (downloads === 1) throw new Error("controls download failed");
    return {
      getCameraBackground: () => "none",
      cameraBackgroundAvailable: () => true,
      CAMERA_BACKGROUND_OPTIONS: [{ id: "none", label: "None" }],
    };
  }) as unknown as typeof loadCameraBackgroundControls;
  const element = document.createElement("div");
  document.body.append(element);
  const root = createRoot(element);
  const render = () =>
    root.render(
      <Suspense fallback={null}>
        <CameraBackgroundPicker deviceId="camera" menu={menu} load={loadControls} />
      </Suspense>,
    );
  try {
    await act(async () => render());
    expect(element.querySelector('[role="alert"]')?.textContent).toBe("Backgrounds didn’t load. Reopen to try again.");
    await act(async () => root.render(null));
    await act(async () => render());
    expect(downloads).toBe(2);
    expect(element.querySelector('[role="alert"]')).toBeNull();
    expect(element.querySelector("button")?.textContent).toBe("None");
  } finally {
    await act(async () => root.unmount());
    element.remove();
    vi.unstubAllGlobals();
  }
});
