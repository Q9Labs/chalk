import { forwardRef, type CSSProperties, type InputHTMLAttributes, type ReactNode } from "react";

import { cn } from "../../utils/cn";
import { ChalkChrome } from "./ChalkChrome";
import { TONE_FILLS, TONE_STROKES, type ChalkSeed, type ChalkTone } from "./common";

export interface ChalkSliderProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "type"> {
  readonly tone?: ChalkTone;
  readonly seed?: ChalkSeed;
  readonly roughness?: number;
  readonly label?: ReactNode;
  readonly wrapperClassName?: string;
  readonly orientation?: "horizontal" | "vertical";
}

function toNumber(value: string | number | readonly string[] | undefined): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function sliderPercent(value: string | number | readonly string[] | undefined, defaultValue: string | number | readonly string[] | undefined, min: string | number | undefined, max: string | number | undefined): number {
  const minimum = toNumber(min) ?? 0;
  const maximum = toNumber(max) ?? 100;
  const current = toNumber(value) ?? toNumber(defaultValue) ?? minimum;
  if (maximum <= minimum) return 0;
  return Math.min(100, Math.max(0, ((current - minimum) / (maximum - minimum)) * 100));
}

export const ChalkSlider = forwardRef<HTMLInputElement, ChalkSliderProps>(function ChalkSlider({ className, defaultValue, label, min, max, orientation = "horizontal", seed, roughness, tone = "accent", value, wrapperClassName, style, ...props }, ref) {
  const stroke = TONE_STROKES[tone];
  const percent = sliderPercent(value, defaultValue, min, max);
  const knobStyle: CSSProperties = orientation === "vertical" ? { bottom: `${percent}%` } : { left: `${percent}%` };
  const control = (
    <span className={cn("group relative block", orientation === "vertical" ? "h-32 w-6" : "h-6 w-full", wrapperClassName)}>
      <ChalkChrome
        className={cn("absolute", orientation === "vertical" ? "left-1/2 top-1/2 h-full w-full -translate-x-1/2 -translate-y-1/2 rotate-90" : "inset-x-0 top-1/2 h-full w-full -translate-y-1/2")}
        focusStroke={stroke}
        height={12}
        shape="line"
        roughness={roughness}
        seed={seed}
        stroke={stroke}
        width={120}
      />
      <span aria-hidden="true" className={cn("pointer-events-none absolute z-[1] size-5 -translate-x-1/2 -translate-y-1/2", orientation === "vertical" ? "left-1/2" : "top-1/2")} style={knobStyle}>
        <ChalkChrome className="absolute inset-0 h-full w-full" filled fill={TONE_FILLS[tone]} focusStroke={stroke} part="knob" shape="circle" roughness={roughness} seed={seed === undefined ? undefined : `${String(seed)}-knob`} stroke={stroke} />
      </span>
      <input ref={ref} type="range" min={min} max={max} value={value} defaultValue={defaultValue} aria-orientation={orientation} className={cn("peer relative z-[2] block size-full cursor-pointer appearance-none bg-transparent opacity-0", className)} style={style} {...props} />
    </span>
  );
  return label ? (
    <label className="block text-sm text-[var(--chalk-app-text)]">
      <span className="mb-1 block">{label}</span>
      {control}
    </label>
  ) : (
    control
  );
});

ChalkSlider.displayName = "ChalkSlider";
