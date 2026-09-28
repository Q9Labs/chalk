import { describe, expect, it } from "vitest";
import { muxArgs, overlayListFor, segmentArgs, segmentFilter, type ComposeOutput } from "./plan.js";
import type { SceneSpan, VideoSegment } from "./scene.js";

const output: ComposeOutput = { width: 1280, height: 720, fps: 15, encoder: "libx264", threads: 2 };
const scene = { spaceName: "Test", colorScheme: "light", generatedAvatars: true, tiles: [], reactions: [] } as const;
const spans: readonly SceneSpan[] = [
  { startFrame: 15, endFrame: 30, sceneKey: "one", scene },
  { startFrame: 30, endFrame: 45, sceneKey: "two", scene },
];
const placements = [
  { sourceId: "camera", rect: { x: 16, y: 48, width: 320, height: 240 }, fit: "cover" },
  { sourceId: "screen", rect: { x: 352, y: 48, width: 640, height: 360 }, fit: "contain" },
] as const;
const segment: VideoSegment = { startFrame: 15, endFrame: 45, placements, spans };

describe("FFmpeg plan", () => {
  it("writes each overlay duration and repeats the last file", () => {
    expect(overlayListFor(segment, (key) => `/tmp/${key}.png`, 15)).toBe("ffconcat version 1.0\nfile '/tmp/one.png'\nduration 1.000000\nfile '/tmp/two.png'\nduration 1.000000\nfile '/tmp/two.png'\n");
  });

  it("seeks each input relative to its source and caps decoding and encoding", () => {
    const args = segmentArgs(
      segment,
      new Map([
        ["camera", { path: "cam.webm", startMs: 0 }],
        ["screen", { path: "screen.webm", startMs: 500 }],
      ]),
      "overlay.ffcat",
      "segment.ts",
      output,
    );
    expect(args.join(" ")).toContain("-threads 1 -ss 1.000000 -t 2.066667 -i cam.webm -threads 1 -ss 0.500000 -t 2.066667 -i screen.webm");
    expect(args).toContain("-filter_complex_threads");
    expect(args.slice(args.indexOf("-frames:v"), args.indexOf("-frames:v") + 4)).toEqual(["-frames:v", "30", "-r", "15"]);
    expect(args.slice(-3)).toEqual(["-f", "mpegts", "segment.ts"]);
  });

  it("uses crop for cover and pad for contain", () => {
    const filter = segmentFilter(placements, output);
    expect(filter).toContain("force_original_aspect_ratio=increase:force_divisible_by=2,crop=320:240");
    expect(filter).toContain("force_original_aspect_ratio=decrease:force_divisible_by=2,pad=640:360:(ow-iw)/2:(oh-ih)/2:black");
    expect(filter).toContain("[base2][ui]overlay=0:0:format=yuv420:eof_action=repeat[out]");
  });

  it("copies video and produces padded, trimmed stereo AAC", () => {
    const args = muxArgs("segments.ffcat", "mix.wav", "export.mp4", 1800, output);
    expect(args.join(" ")).toContain("-map 0:v:0 -map 1:a:0 -filter_complex_threads 1 -threads 2 -c:v copy");
    expect(args).toContain("asetpts=PTS-STARTPTS,aresample=48000:async=1:first_pts=0,apad,atrim=end=120.000000");
    expect(args.join(" ")).toContain("-c:a aac -profile:a aac_low -b:a 128k -ar 48000 -ac 2");
    expect(args.at(-1)).toBe("export.mp4");
  });
});
