import { cn } from "@q9labsai/chalk-react/utils";

const SEGMENTS = 16;
const HOT_FROM = 12;
const MAX_FROM = 15;

/** Sixteen segments that follow the microphone's loudness; the last four warm up when the visitor is loud. */
export function LevelMeter({ level, small = false }: { readonly level: number; readonly small?: boolean }) {
  const lit = Math.round((level / 100) * SEGMENTS);
  return (
    <span role="meter" aria-label="Microphone level" aria-valuemin={0} aria-valuemax={100} aria-valuenow={level} className="inline-flex flex-none items-center gap-0.5">
      {Array.from({ length: SEGMENTS }, (_, index) => (
        <i key={index} className={cn("rounded-full", small ? "h-2.5 w-[3px]" : "h-3.5 w-1", index >= lit ? "bg-[var(--chalk-line-strong)]" : index >= MAX_FROM ? "bg-[var(--chalk-danger-text)]" : index >= HOT_FROM ? "bg-[var(--chalk-warning)]" : "bg-[var(--chalk-positive)]")} />
      ))}
    </span>
  );
}
