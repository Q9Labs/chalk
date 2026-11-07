import { expect, it, vi } from "vitest";
import { track } from "../space-client/capture.test.helpers";
import { bindCameraEffectLifecycle } from "./camera-effect-lifecycle";

it("turns capture off with publication, while allowing an enabled private preview", () => {
  const source = track("video");
  const output = track("video");
  output.getSettings = () => ({ deviceId: "camera-1" });
  const dispose = bindCameraEffectLifecycle(source, output);
  output.enabled = false;
  expect(source.enabled).toBe(false);
  const preview = output.clone();
  preview.enabled = true;
  expect(source.enabled).toBe(true);
  expect(output.enabled).toBe(false);
  expect(preview.getSettings().deviceId).toBe("camera-1");
  preview.stop();
  expect(source.enabled).toBe(false);
  output.enabled = true;
  expect(source.enabled).toBe(true);
  dispose();
});

it("forwards camera interruptions and disposes cloned tracks", () => {
  const source = track("video");
  const output = track("video");
  const dispose = bindCameraEffectLifecycle(source, output);
  const preview = output.clone();
  const interrupted = vi.fn();
  output.addEventListener("mute", interrupted);
  source.dispatchEvent(new Event("mute"));
  expect(interrupted).toHaveBeenCalledOnce();
  dispose();
  expect(preview.readyState).toBe("ended");
  source.dispatchEvent(new Event("mute"));
  expect(interrupted).toHaveBeenCalledOnce();
});
