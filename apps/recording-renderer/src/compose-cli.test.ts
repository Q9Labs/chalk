import { describe, expect, it } from "vitest";
import { parseArguments } from "./compose-cli.js";

describe("compose CLI arguments", () => {
  it("accepts absolute paths and bounded threads", () => {
    expect(parseArguments(["--request", "/tmp/request.json", "--result", "/tmp/result.json", "--output", "/tmp/export.mp4", "--threads", "2"])).toEqual({
      requestPath: "/tmp/request.json",
      resultPath: "/tmp/result.json",
      outputPath: "/tmp/export.mp4",
      ffmpegPath: "ffmpeg",
      encoder: "libx264",
      threads: 2,
    });
  });

  it("accepts the qualified GPU encoder", () => {
    const parsed = parseArguments(["--request", "/tmp/request.json", "--result", "/tmp/result.json", "--output", "/tmp/export.mp4", "--encoder", "h264_nvenc"]);
    expect(parsed.encoder).toBe("h264_nvenc");
  });

  it("rejects malformed and unknown options", () => {
    const required = ["--request", "/tmp/request.json", "--result", "/tmp/result.json", "--output", "/tmp/export.mp4"];
    expect(() => parseArguments([...required, "--threads", "0"])).toThrow("--threads must be between 1 and 64");
    expect(() => parseArguments([...required, "--unknown", "value"])).toThrow("unknown compose option");
    expect(() => parseArguments(["--request", "relative.json", "--result", "/tmp/result.json", "--output", "/tmp/export.mp4"])).toThrow("--request must be an absolute path");
  });
});
