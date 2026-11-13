// @vitest-environment jsdom
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { SpaceClientError } from "@q9labsai/chalk-client";
import { recordingFailure } from "../control-bar/command-failure";
import { mediaFailureToast } from "./call-events";

it("marks a failure with no device, such as a rejected recording start, with an alert, not a muted microphone", () => {
  const rejected = new SpaceClientError({ code: "command.rejected", recoverable: false, message: "external_operation_failed" });
  const toast = mediaFailureToast(rejected);
  expect(toast?.message).toBe("That didn’t work. Try again in a moment.");
  expect(renderToStaticMarkup(<>{toast?.icon}</>)).toContain("M12 7.5v5");
  const microphone = mediaFailureToast(new SpaceClientError({ code: "media.permission_denied", recoverable: false, message: "denied" }), "microphone");
  expect(renderToStaticMarkup(<>{microphone?.icon}</>)).toContain("M2 2l20 20");
});

it("names a failed recording start, and lets it leave on the normal timer since there is nothing to retry", () => {
  const toast = mediaFailureToast(recordingFailure(new SpaceClientError({ code: "command.rejected", recoverable: false, message: "external_operation_failed" }), "start"));
  expect(toast?.message).toBe("Couldn’t start recording. Try again in a moment.");
  expect(toast?.duration).toBe(8000);
  expect(mediaFailureToast(new SpaceClientError({ code: "media.permission_denied", recoverable: false, message: "denied" }), "camera")?.duration).toBeUndefined();
});
