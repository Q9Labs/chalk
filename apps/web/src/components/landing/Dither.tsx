import { useEffect, useRef } from "react";

import { IS_NIGHTLY } from "../../lib/site-head";
import { useSiteTheme } from "../site/theme";

type Color = readonly [number, number, number];
type Kind = "cta" | "speed" | "footer" | "sky";
const NAVY: Color = [10, 22, 48];
const SLATE: Color = [77, 93, 115];
const TEAL: Color = [49, 95, 114];
const clamp = (x: number) => Math.max(0, Math.min(1, x));
const linear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const channel = (c: number) => Math.round(255 * (c <= 0.0031308 ? 12.92 * clamp(c) : 1.055 * clamp(c) ** (1 / 2.4) - 0.055));

function lab([red, green, blue]: Color): Color {
  const r = linear(red / 255),
    g = linear(green / 255),
    b = linear(blue / 255);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s];
}

function rgb([L, a, b]: Color): Color {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [channel(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s), channel(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s), channel(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s)];
}

function ramp(base: Color, anchor: Color, levels: readonly number[], boost: number) {
  const [L, a, b] = lab(base),
    [zL, za, zb] = lab(anchor);
  return levels.map((t) => rgb([L + (zL - L) * t, (a + (za - a) * t) * (1 + (boost - 1) * t), (b + (zb - b) * t) * (1 + (boost - 1) * t)]));
}

function bayer(x: number, y: number): number {
  let value = 0;
  for (let size = 1; size <= 4; size *= 2) {
    const xx = Math.floor(x / size) % 2,
      yy = Math.floor(y / size) % 2;
    value = value * 4 + (yy ? (xx ? 1 : 3) : xx ? 2 : 0);
  }
  return (value + 0.5) / 64;
}

function bloom(x: number, y: number, width: number, height: number, cx: number, cy: number, radius: number) {
  const distance = Math.hypot(((x - cx * width) / height) * 0.6, (y - cy * height) / height) / radius;
  const t = clamp((distance - 0.12) / (0.95 - 0.12));
  return (1 - t * t * (3 - 2 * t)) ** 1.4;
}

/** Static ordered dither: redraw only for size or theme, never an animation loop. */
export function Dither({ kind }: { readonly kind: Kind }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const { theme } = useSiteTheme();
  useEffect(() => {
    const canvas = ref.current;
    const host = canvas?.parentElement;
    if (!canvas || !host) return;
    const context = canvas.getContext("2d");
    if (!context) return;
    const dark = theme === "dark";
    const base: Color = dark ? [11, 12, 14] : [243, 243, 245];
    const nightAnchor: Color = dark ? [39, 81, 143] : [108, 147, 209];
    const levels = dark ? [0, 0.35, 0.65, 1] : [0, 0.28, 0.55, 0.85];
    const palette =
      kind === "sky"
        ? ramp(NAVY, [24, 58, 115], [0, 1], 1)
        : kind === "footer"
          ? ramp(base, IS_NIGHTLY ? nightAnchor : SLATE, dark ? [0, 0.08, 0.16, 0.24] : [0, 0.04, 0.08, 0.12], 1)
          : ramp(IS_NIGHTLY && kind === "cta" && dark ? NAVY : base, kind === "speed" ? SLATE : IS_NIGHTLY ? nightAnchor : TEAL, levels, dark ? 1 : 1.2);
    const draw = () => {
      if (kind === "footer") host.style.setProperty("--footer-tint", `rgb(${palette[3]?.join(",")})`);
      const rect = host.getBoundingClientRect();
      const W = rect.width,
        H = kind === "footer" ? 190 : rect.height;
      const cell = kind === "sky" ? 2 : 3;
      const w = Math.ceil(W / cell),
        h = Math.ceil(H / cell);
      if (!w || !h) return;
      canvas.width = w;
      canvas.height = h;
      const masks = kind === "cta" || kind === "speed" ? Array.from(host.querySelectorAll("h2,p,.budgets,.hact")).map((el) => el.getBoundingClientRect()) : [];
      const image = context.createImageData(w, h);
      for (let y = 0; y < h; y++)
        for (let x = 0; x < w; x++) {
          const px = (x + 0.5) * cell,
            py = (y + 0.5) * cell;
          let value =
            kind === "footer" ? clamp((py / H) * 1.05 + 0.05 * Math.sin((px / W) * 9) * (1 - py / H)) : kind === "sky" ? Math.max(bloom(px, py, W, H, 0.86, 0.05, 1.2), bloom(px, py, W, H, 0.12, 0.45, 0.9) * 0.7) : bloom(px, py, W, H, 1, kind === "speed" ? 1 : 0, kind === "speed" ? 1 : 1.1);
          for (const mask of masks) {
            const dx = Math.max(mask.left - rect.left - px, 0, px - (mask.right - rect.left));
            const dy = Math.max(mask.top - rect.top - py, 0, py - (mask.bottom - rect.top));
            value *= clamp((Math.hypot(dx, dy) - 48) / 96);
          }
          const scaled = clamp(value) * (palette.length - 1),
            low = Math.floor(scaled);
          const color = palette[Math.min(palette.length - 1, low + (scaled - low > bayer(x & 7, y & 7) ? 1 : 0))] ?? base;
          image.data.set([...color, 255], (y * w + x) * 4);
        }
      if (kind === "sky") {
        let seed = 77;
        const random = () => {
          seed = (seed * 16807) % 2147483647;
          return seed / 2147483647;
        };
        for (let i = 0; i < Math.floor((W * H) / 900); i++) {
          const x = Math.floor(random() * w),
            y = Math.floor(random() * h * 0.7),
            big = random() < 0.25;
          const color = random() < 0.7 ? [234, 241, 255] : [156, 194, 255],
            alpha = Math.round(255 * (0.45 + random() * 0.5));
          for (let yy = 0; yy < (big ? 2 : 1); yy++)
            for (let xx = 0; xx < (big ? 2 : 1); xx++) {
              if (x + xx < w && y + yy < h) image.data.set([...color, alpha], ((y + yy) * w + x + xx) * 4);
            }
        }
      }
      context.putImageData(image, 0, 0);
    };
    draw();
    const observer = new ResizeObserver(draw);
    observer.observe(host);
    return () => observer.disconnect();
  }, [kind, theme]);
  return <canvas ref={ref} className="dither" aria-hidden="true" />;
}
