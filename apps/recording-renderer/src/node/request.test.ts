import { describe, expect, it } from "vitest";

import { parseFrameRenderRequestV1 } from "./request.js";

const SHA256 = "a".repeat(64);

function validRequest() {
  return Object.freeze({
    schema_version: "recording-frame-render-request.v1",
    recording_id: "recording-1",
    episode_id: "episode-1",
    workspace_directory: "/private/tmp/recording-1",
    presentation_path: "/private/tmp/recording-1/presentation.json",
    presentation_sha256: SHA256,
    ui_build_sha256: SHA256,
    asset_directory: "/private/tmp/recording-1/assets",
    decoded_media_path: "/private/tmp/recording-1/media/decoded-media.json",
    decoded_media_sha256: SHA256,
    width: 1_280,
    height: 720,
    fps: 30,
    duration_ms: 3_000,
  });
}

describe("frame render request boundary", () => {
  it("accepts the canonical frozen wire request", () => {
    expect(parseFrameRenderRequestV1(validRequest())).toMatchObject({
      schemaVersion: "recording-frame-render-request.v1",
      recordingId: "recording-1",
      episodeId: "episode-1",
      width: 1_280,
      height: 720,
      fps: 30,
      durationMs: 3_000,
    });
  });

  it.each([
    ["an unknown field", { ...validRequest(), output_path: "/private/tmp/recording-1/output" }],
    ["a relative workspace", { ...validRequest(), workspace_directory: "recording-1" }],
    ["an odd frame dimension", { ...validRequest(), width: 1_279 }],
    ["an excessive frame rate", { ...validRequest(), fps: 61 }],
    ["a noncanonical digest", { ...validRequest(), presentation_sha256: SHA256.toUpperCase() }],
  ])("rejects %s", (_label, request) => {
    expect(() => parseFrameRenderRequestV1(Object.freeze(request))).toThrow(TypeError);
  });
});
