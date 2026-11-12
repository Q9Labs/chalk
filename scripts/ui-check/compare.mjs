// Pixel comparison of the branch's frames against master's. Reports the changed regions of each frame and writes a
// before | after strip with the regions boxed in red. Runs in a headless page so it needs no image library.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { chromium } from "playwright";

/** A pixel counts as changed when any color channel moves by more than this (of 255); it absorbs font antialiasing. */
const CHANNEL_TOLERANCE = 24;
const TILE = 20;
const MAX_REGIONS = 6;
const REVIEW_WIDTH = 1600;

async function compareInPage({ pairs, tolerance, tile, maxRegions, reviewWidth }) {
  const load = (b64) =>
    new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = reject;
      image.src = `data:image/png;base64,${b64}`;
    });
  const results = [];
  for (const pair of pairs) {
    const before = await load(pair.before);
    const after = await load(pair.after);
    const width = Math.max(before.width, after.width);
    const height = Math.max(before.height, after.height);
    const read = (image) => {
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext("2d", { willReadFrequently: true });
      context.fillStyle = "#ff00ff";
      context.fillRect(0, 0, width, height);
      context.drawImage(image, 0, 0);
      return context.getImageData(0, 0, width, height).data;
    };
    const a = read(before);
    const b = read(after);
    const cols = Math.ceil(width / tile);
    const rows = Math.ceil(height / tile);
    const tiles = new Uint32Array(cols * rows);
    let changed = 0;
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const i = (y * width + x) * 4;
        if (Math.abs(a[i] - b[i]) > tolerance || Math.abs(a[i + 1] - b[i + 1]) > tolerance || Math.abs(a[i + 2] - b[i + 2]) > tolerance) {
          changed += 1;
          tiles[Math.floor(y / tile) * cols + Math.floor(x / tile)] += 1;
        }
      }
    }
    // Neighboring changed tiles form one region.
    const seen = new Uint8Array(cols * rows);
    const regions = [];
    for (let start = 0; start < tiles.length; start += 1) {
      if (tiles[start] === 0 || seen[start]) continue;
      const stack = [start];
      seen[start] = 1;
      let minC = cols;
      let maxC = 0;
      let minR = rows;
      let maxR = 0;
      let pixels = 0;
      while (stack.length > 0) {
        const at = stack.pop();
        const c = at % cols;
        const r = Math.floor(at / cols);
        minC = Math.min(minC, c);
        maxC = Math.max(maxC, c);
        minR = Math.min(minR, r);
        maxR = Math.max(maxR, r);
        pixels += tiles[at];
        for (const [dc, dr] of [
          [1, 0],
          [-1, 0],
          [0, 1],
          [0, -1],
          [1, 1],
          [-1, -1],
          [1, -1],
          [-1, 1],
        ]) {
          const nc = c + dc;
          const nr = r + dr;
          if (nc < 0 || nr < 0 || nc >= cols || nr >= rows) continue;
          const next = nr * cols + nc;
          if (tiles[next] !== 0 && !seen[next]) {
            seen[next] = 1;
            stack.push(next);
          }
        }
      }
      regions.push({ x: minC * tile, y: minR * tile, w: Math.min(width, (maxC + 1) * tile) - minC * tile, h: Math.min(height, (maxR + 1) * tile) - minR * tile, pixels });
    }
    regions.sort((x, y) => y.pixels - x.pixels);
    const top = regions.slice(0, maxRegions);
    let strip = null;
    let review = null;
    if (changed > 0) {
      const canvas = document.createElement("canvas");
      canvas.width = before.width + after.width + 16;
      canvas.height = Math.max(before.height, after.height);
      const context = canvas.getContext("2d");
      context.fillStyle = "#777";
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.drawImage(before, 0, 0);
      context.drawImage(after, before.width + 16, 0);
      context.strokeStyle = "#ff1744";
      context.lineWidth = 3;
      for (const region of top) {
        context.strokeRect(region.x + 1.5, region.y + 1.5, region.w - 3, region.h - 3);
        context.strokeRect(before.width + 16 + region.x + 1.5, region.y + 1.5, region.w - 3, region.h - 3);
      }
      strip = canvas.toDataURL("image/png").split(",")[1];
      // A smaller copy for the vision review keeps its image tokens low.
      const scale = Math.min(1, reviewWidth / canvas.width);
      const small = document.createElement("canvas");
      small.width = Math.round(canvas.width * scale);
      small.height = Math.round(canvas.height * scale);
      small.getContext("2d").drawImage(canvas, 0, 0, small.width, small.height);
      review = small.toDataURL("image/jpeg", 0.82).split(",")[1];
    }
    results.push({ frame: pair.frame, changed, total: width * height, fraction: changed / (width * height), sizeChanged: before.width !== after.width || before.height !== after.height, regions: top, strip, review, afterWidth: after.width, afterHeight: after.height });
  }
  return results;
}

/**
 * @param {{ headDir: string, baseDir: string, out: string, headFrames: { frame: string, shot: string | null }[], baseFrames: { frame: string, shot: string | null }[] }} input
 */
export async function compareFrames({ headDir, baseDir, out, headFrames, baseFrames }) {
  await mkdir(out, { recursive: true });
  const baseShots = new Map(baseFrames.filter((frame) => frame.shot).map((frame) => [frame.frame, frame.shot]));
  const pairs = [];
  for (const frame of headFrames) {
    const baseShot = baseShots.get(frame.frame);
    if (!frame.shot || !baseShot) continue;
    pairs.push({ frame: frame.frame, before: (await readFile(join(baseDir, baseShot))).toString("base64"), after: (await readFile(join(headDir, frame.shot))).toString("base64") });
  }
  const browser = await chromium.launch();
  const results = [];
  try {
    const page = await browser.newPage();
    for (let start = 0; start < pairs.length; start += 8) results.push(...(await page.evaluate(compareInPage, { pairs: pairs.slice(start, start + 8), tolerance: CHANNEL_TOLERANCE, tile: TILE, maxRegions: MAX_REGIONS, reviewWidth: REVIEW_WIDTH })));
  } finally {
    await browser.close();
  }
  for (const result of results) {
    if (result.strip) await writeFile(join(out, `${result.frame}.png`), Buffer.from(result.strip, "base64"));
    if (result.review) await writeFile(join(out, `${result.frame}.review.jpg`), Buffer.from(result.review, "base64"));
    delete result.strip;
    delete result.review;
  }
  return results;
}
