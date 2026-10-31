// @vitest-environment happy-dom
import { act, Suspense, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { CameraBackgroundPicker, type CameraBackgroundMenu } from "./CameraBackgroundPicker";

const loadControls = vi.hoisted(() => vi.fn());
vi.mock("@q9labsai/chalk-client", () => ({
  loadCameraBackgroundControls: loadControls,
  subscribeCameraBackground: () => () => {},
  setCameraBackground: vi.fn(),
}));

const menu: CameraBackgroundMenu = {
  Label: ({ children }: { readonly children: ReactNode }) => <span>{children}</span>,
  Item: ({ children, onClick }) => <button onClick={onClick}>{children}</button>,
};

it("keeps a failed controls download local and retries when the picker reopens", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  loadControls.mockReset();
  loadControls.mockRejectedValueOnce(new Error("controls download failed")).mockResolvedValue({
    getCameraBackground: () => "none",
    cameraBackgroundAvailable: () => true,
    CAMERA_BACKGROUND_OPTIONS: [{ id: "none", label: "None" }],
  });
  const element = document.createElement("div");
  document.body.append(element);
  const root = createRoot(element);
  const render = () =>
    root.render(
      <Suspense fallback={null}>
        <CameraBackgroundPicker deviceId="camera" menu={menu} />
      </Suspense>,
    );
  try {
    await act(async () => render());
    expect(element.querySelector('[role="alert"]')?.textContent).toBe("Backgrounds didn’t load. Reopen to try again.");
    await act(async () => root.render(null));
    await act(async () => render());
    expect(loadControls).toHaveBeenCalledTimes(2);
    expect(element.querySelector('[role="alert"]')).toBeNull();
    expect(element.querySelector("button")?.textContent).toBe("None");
  } finally {
    await act(async () => root.unmount());
    element.remove();
    vi.unstubAllGlobals();
  }
});
