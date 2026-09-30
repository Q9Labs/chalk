import { describe, expect, it } from "vitest";
import { type ComposeOutput, muxArgs, needsDenseKeyframes, overlayListFor, seekDecodeSeconds, segmentArgs, segmentFilter } from "./plan.js";
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

  it("keeps the qualified GPU encoder available for native segments", () => {
    const args = segmentArgs(
      segment,
      new Map([
        ["camera", { path: "cam.webm", startMs: 0 }],
        ["screen", { path: "screen.webm", startMs: 500 }],
      ]),
      "overlay.ffcat",
      "segment.ts",
      { ...output, encoder: "h264_nvenc" },
    );
    expect(args.join(" ")).toContain("-c:v h264_nvenc -preset p4 -profile:v high");
  });

  it("uses crop for cover and pad for contain", () => {
    const filter = segmentFilter(placements, output);
    expect(filter).toContain("force_original_aspect_ratio=increase:force_divisible_by=2,crop=320:240");
    expect(filter).toContain("force_original_aspect_ratio=decrease:force_divisible_by=2,pad=640:360:(ow-iw)/2:(oh-ih)/2:black");
    expect(filter).toContain("[base2][ui]overlay=0:0:format=yuv420:eof_action=repeat[out]");
    // An fps filter on the sparse UI stream makes overlay queue every base frame.
    expect(filter).toContain("[2:v]format=yuva420p[ui]");
  });

  it("copies video and produces padded, trimmed stereo AAC", () => {
    const args = muxArgs("segments.ffcat", "mix.wav", "export.mp4", 1800, output);
    expect(args.join(" ")).toContain("-map 0:v:0 -map 1:a:0 -filter_complex_threads 1 -threads 2 -c:v copy");
    expect(args).toContain("asetpts=PTS-STARTPTS,aresample=48000:async=1:first_pts=0,apad,atrim=end=120.000000");
    expect(args.join(" ")).toContain("-c:a aac -profile:a aac_low -b:a 128k -ar 48000 -ac 2");
    expect(args.at(-1)).toBe("export.mp4");
  });

  it("counts the video each segment seek decodes before its start", () => {
    expect(seekDecodeSeconds([0, 10, 20], [5, 12, 20, 31])).toBe(5 + 2 + 0 + 11);
    expect(seekDecodeSeconds([], [3])).toBe(3);
  });

  it("re-encodes a track only when seeks would cost more than four decodes of it", () => {
    const starts = Array.from({ length: 10 }, (_, index) => 60 + index * 60);
    expect(needsDenseKeyframes([0], starts, 600)).toBe(true);
    expect(
      needsDenseKeyframes(
        Array.from({ length: 60 }, (_, index) => index * 10),
        starts,
        600,
      ),
    ).toBe(false);
    expect(needsDenseKeyframes([0], [30], 600)).toBe(false);
  });
});
