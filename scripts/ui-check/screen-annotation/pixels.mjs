import { execFileSync } from "node:child_process";

export const TARGETS = [
  { x: 0.055, y: 0.13 },
  { x: 0.29, y: 0.85 },
  { x: 0.47, y: 0.44 },
  { x: 0.76, y: 0.26 },
  { x: 0.92, y: 0.76 },
];

export const targetPixel = (r, g, b) => r > 140 && g > 75 && g < r - 25 && b < 100 && g > b + 30;
export const inkPixel = (r, g, b) => r > g + 55 && b > g + 55 && r > 120 && b > 120;

export function decodeRgb(file, frame = 0) {
  const raw = execFileSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0", file], { encoding: "utf8" });
  const [width, height] = raw.trim().split(",").map(Number);
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 || width * height > 20_000_000) throw new Error("invalid evidence dimensions");
  const bytes = execFileSync("ffmpeg", ["-v", "error", "-nostdin", "-i", file, "-vf", `select=eq(n\\,${frame})`, "-frames:v", "1", "-pix_fmt", "rgb24", "-f", "rawvideo", "-"], { maxBuffer: width * height * 3 + 65_536 });
  if (bytes.length !== width * height * 3) throw new Error(`no decoded evidence frame ${frame}`);
  return { width, height, bytes };
}

export function centroid(image, region, test) {
  const { x, y, width, height } = region;
  if (![x, y, width, height].every(Number.isSafeInteger) || x < 0 || y < 0 || width <= 0 || height <= 0 || x + width > image.width || y + height > image.height) throw new Error("evidence region is outside its image");
  let count = 0;
  let sumX = 0;
  let sumY = 0;
  for (let row = y; row < y + height; row++) {
    for (let col = x; col < x + width; col++) {
      const offset = (row * image.width + col) * 3;
      if (!test(image.bytes[offset], image.bytes[offset + 1], image.bytes[offset + 2])) continue;
      count++;
      sumX += col + 0.5;
      sumY += row + 0.5;
    }
  }
  return count === 0 ? null : { x: sumX / count, y: sumY / count, count };
}

export function regionAround(center, radius, image) {
  const x = Math.max(0, Math.floor(center.x - radius));
  const y = Math.max(0, Math.floor(center.y - radius));
  return {
    x,
    y,
    width: Math.min(image.width, Math.ceil(center.x + radius)) - x,
    height: Math.min(image.height, Math.ceil(center.y + radius)) - y,
  };
}

export function fiducialPpm(width, height) {
  const pixels = Buffer.alloc(width * height * 3, 34);
  for (const target of TARGETS) {
    const cx = Math.floor(target.x * width);
    const cy = Math.floor(target.y * height);
    for (let y = cy - 12; y <= cy + 12; y++) {
      for (let x = cx - 12; x <= cx + 12; x++) {
        if (Math.abs(x - cx) > 2 && Math.abs(y - cy) > 2) continue;
        const offset = (y * width + x) * 3;
        pixels.set([255, 158, 42], offset);
      }
    }
  }
  return Buffer.concat([Buffer.from(`P6\n${width} ${height}\n255\n`), pixels]);
}
