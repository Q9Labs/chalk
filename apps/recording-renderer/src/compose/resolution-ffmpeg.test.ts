import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { segmentArgs } from "./plan.js";
import type { VideoSegment } from "./scene.js";

function ffmpeg(args: readonly string[]): Buffer {
  const result = spawnSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args], { maxBuffer: 128 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`ffmpeg: ${result.error?.message ?? result.status}: ${result.stderr.toString()}`);
  return result.stdout;
}

const available = spawnSync("ffmpeg", ["-version"]).status === 0;
describe.skipIf(!available)("changing-resolution native composition", () => {
  it("keeps high-layer detail, orientation and every frame across several switches", () => {
    const root = mkdtempSync(join(tmpdir(), "chalk-resolution-"));
    try {
      const sizes = [
        [240, 135],
        [1280, 720],
        [135, 241],
        [320, 180],
        [3, 3],
      ];
      const colors = ["red", "white", "green", "blue", "yellow"];
      const packets: Buffer[] = [];
      let header = Buffer.alloc(0);
      for (const [index, size] of sizes.entries()) {
        const path = join(root, `${index}.ivf`);
        const pattern = index === 1 ? "geq=r='255*lt(mod(X,4),2)':g='255*lt(mod(X,4),2)':b='255*lt(mod(X,4),2)'" : index === 2 ? "drawbox=color=green:t=fill,drawbox=y=0:h=ih/4:color=white:t=fill,drawbox=y=3*ih/4:h=ih/4:color=blue:t=fill" : `drawbox=color=${colors[index]}:t=fill`;
        ffmpeg(["-f", "lavfi", "-i", `testsrc=size=${size[0]}x${size[1]}:rate=10:duration=1`, "-vf", pattern, "-c:v", "libvpx", "-deadline", "realtime", "-threads", "1", "-pix_fmt", "yuv420p", "-f", "ivf", path]);
        const data = readFileSync(path);
        if (index === 0) header = data.subarray(0, 32);
        for (let cursor = 32; cursor < data.length; ) {
          const length = data.readUInt32LE(cursor);
          const packet = Buffer.from(data.subarray(cursor, cursor + 12 + length));
          packet.writeBigUInt64LE(packet.readBigUInt64LE(4) + BigInt(index * 10 + (index >= 2 ? 20 : 0)), 4);
          packets.push(packet);
          cursor += 12 + length;
        }
      }
      header.writeUInt32LE(packets.length, 24);
      writeFileSync(join(root, "source.ivf"), Buffer.concat([header, ...packets]));
      const source = join(root, "source.webm");
      ffmpeg(["-i", join(root, "source.ivf"), "-c:v", "copy", source]);
      const overlay = join(root, "overlay.png");
      ffmpeg(["-f", "lavfi", "-i", "color=black@0:size=1280x720,format=rgba", "-frames:v", "1", overlay]);
      const list = join(root, "overlay.ffcat");
      writeFileSync(list, `ffconcat version 1.0\nfile '${overlay}'\nduration 7\nfile '${overlay}'\n`);
      const segment: VideoSegment = { startFrame: 0, endFrame: 70, placements: [{ sourceId: "camera", rect: { x: 0, y: 0, width: 1280, height: 720 }, fit: "contain" }], spans: [] };
      const output = { width: 1280, height: 720, fps: 10, encoder: "libx264", threads: 1 } as const;
      const path = join(root, "segment.ts");
      ffmpeg(segmentArgs(segment, new Map([["camera", { path: source, startMs: 0 }]]), list, path, output));
      const raw = ffmpeg(["-i", path, "-pix_fmt", "gray", "-f", "rawvideo", "-"]);
      const pixels = 1280 * 720;
      expect(raw.length / pixels).toBe(70);
      const pixel = (frame: number, x: number, y: number): number => raw[frame * pixels + y * 1280 + x]!;
      // Two-pixel stripes would be destroyed by first-layer normalization.
      let contrast = 0;
      for (let x = 100; x < 300; x++) contrast += Math.abs(pixel(15, x, 300) - pixel(15, x + 2, 300));
      expect(contrast / 200).toBeGreaterThan(100);
      expect(pixel(45, 0, 300)).toBeLessThan(5); // portrait letterbox
      expect(pixel(45, 640, 300)).toBeGreaterThan(40);
      expect(pixel(55, 640, 300)).toBeLessThan(45); // blue after rotation
      expect(pixel(65, 640, 300)).toBeGreaterThan(180); // tiny final layer
      const coverPath = join(root, "cover.ts");
      ffmpeg(segmentArgs({ ...segment, placements: segment.placements.map((placement) => ({ ...placement, fit: "cover" as const })) }, new Map([["camera", { path: source, startMs: 0, changingSize: true }]]), list, coverPath, output));
      const cover = ffmpeg(["-i", coverPath, "-vf", "select=eq(n\\,45)", "-frames:v", "1", "-pix_fmt", "gray", "-f", "rawvideo", "-"]);
      // Rotation must crop the green center, not the white top of the portrait.
      expect(cover[300 * 1280 + 640]).toBeGreaterThan(40);
      expect(cover[300 * 1280 + 640]).toBeLessThan(150);
      expect(cover[300 * 1280 + 10]).toBeGreaterThan(40);
      // A seek inside the 2–4 second gap must not jump to the portrait keyframe.
      const gapPath = join(root, "gap.ts");
      ffmpeg(segmentArgs({ ...segment, startFrame: 25, endFrame: 35 }, new Map([["camera", { path: source, startMs: 0, decodeFromStartSeconds: 9 }]]), list, gapPath, output));
      const gap = ffmpeg(["-i", gapPath, "-pix_fmt", "gray", "-f", "rawvideo", "-"]);
      expect(gap.length / pixels).toBe(10);
      expect(Math.abs(gap[300 * 1280 + 100]! - gap[300 * 1280 + 102]!)).toBeGreaterThan(100);
      // The final image must also survive a seek beyond source EOF.
      const heldPath = join(root, "held.ts");
      ffmpeg(segmentArgs({ ...segment, startFrame: 80, endFrame: 90 }, new Map([["camera", { path: source, startMs: 0, decodeFromStartSeconds: 9 }]]), list, heldPath, output));
      const held = ffmpeg(["-i", heldPath, "-pix_fmt", "gray", "-f", "rawvideo", "-"]);
      expect(held.length / pixels).toBe(10);
      expect(held[300 * 1280 + 640]).toBeGreaterThan(180);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);
});
