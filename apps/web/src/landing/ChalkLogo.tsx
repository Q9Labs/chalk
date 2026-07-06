import { useId } from "react";

type ChalkLogoProps = {
  /** Height of the chalk-stick mark in px. */
  size?: number;
  /** Show the "chalk" wordmark next to the mark. */
  wordmark?: boolean;
  className?: string;
};

/**
 * The Chalk brand mark: four tilted chalk sticks, optionally followed by the
 * wordmark. Rendered inline so the wordmark inherits `currentColor` and the
 * gradient ids stay unique per instance.
 */
export function ChalkLogo({ size = 30, wordmark = true, className }: ChalkLogoProps) {
  const uid = useId().replace(/[^a-z0-9]/gi, "");
  const g = (name: string) => `${name}-${uid}`;

  return (
    <span
      className={className}
      style={{ display: "inline-flex", alignItems: "center", gap: size * 0.36 }}
    >
      <svg
        width={size}
        height={size}
        viewBox="0 0 64 64"
        fill="none"
        role="img"
        aria-label="Chalk"
        style={{ flex: "none" }}
      >
        <defs>
          <linearGradient id={g("grn")} x1="0%" y1="0%" x2="100%" y2="0%">
            <stop offset="0%" stopColor="#C5E5C0" />
            <stop offset="100%" stopColor="#80B879" />
          </linearGradient>
          <linearGradient id={g("yel")} x1="0%" y1="0%" x2="100%" y2="0%">
            <stop offset="0%" stopColor="#FCEAB3" />
            <stop offset="100%" stopColor="#D9B641" />
          </linearGradient>
          <linearGradient id={g("blu")} x1="0%" y1="0%" x2="100%" y2="0%">
            <stop offset="0%" stopColor="#B2E0F0" />
            <stop offset="100%" stopColor="#55AAC9" />
          </linearGradient>
          <linearGradient id={g("pnk")} x1="0%" y1="0%" x2="100%" y2="0%">
            <stop offset="0%" stopColor="#F8CACA" />
            <stop offset="100%" stopColor="#D67B7B" />
          </linearGradient>
        </defs>
        <g transform="translate(5, 5) scale(0.85)">
          <g transform="rotate(-20 16 48)">
            <path d="M9,16 L19,16 L20,50 A6,6 0 0 1 8,50 Z" fill={`url(#${g("grn")})`} />
            <ellipse cx="14" cy="16" rx="5" ry="2" fill="#D8ECD4" />
          </g>
          <g transform="rotate(-5 24 44)">
            <path d="M19,12 L29,12 L30,50 A6,6 0 0 1 18,50 Z" fill={`url(#${g("yel")})`} />
            <ellipse cx="24" cy="12" rx="5" ry="2" fill="#FEF3D1" />
          </g>
          <g transform="rotate(25 44 20)">
            <path d="M29,4 L39,4 L40,40 A6,6 0 0 1 28,40 Z" fill={`url(#${g("blu")})`} />
            <ellipse cx="34" cy="4" rx="5" ry="2" fill="#D0EDF8" />
          </g>
          <g transform="rotate(10 44 40)">
            <path d="M39,56 L49,56 L50,24 A6,6 0 0 0 38,24 Z" fill={`url(#${g("pnk")})`} />
            <ellipse cx="44" cy="56" rx="5" ry="2" fill="#FBE4E4" />
          </g>
        </g>
      </svg>
      {wordmark && (
        <span
          style={{
            fontFamily: '"Space Grotesk", Inter, system-ui, sans-serif',
            fontWeight: 600,
            fontSize: size * 0.62,
            letterSpacing: "-0.03em",
          }}
        >
          chalk
        </span>
      )}
    </span>
  );
}
