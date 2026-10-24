"use client";

import type React from "react";

export type LogoVariant = "mark" | "wordmark";

export type LogoProps = {
  readonly accessibilityLabel?: string | null;
  readonly color?: string;
  readonly height?: number;
  readonly variant?: LogoVariant;
};

const DEFAULT_COLOR = "#16181c";
const DEFAULT_HEIGHT = 32;
const DEFAULT_VARIANT: LogoVariant = "wordmark";
const WORDMARK_VIEW_BOX = "0 0 200 80";
const MARK_VIEW_BOX = "0 0 68 80";

export function Logo({ accessibilityLabel = "Chalk", color = DEFAULT_COLOR, height = DEFAULT_HEIGHT, variant = DEFAULT_VARIANT }: LogoProps): React.JSX.Element {
  const isWordmark = variant === "wordmark";
  const viewBox = isWordmark ? WORDMARK_VIEW_BOX : MARK_VIEW_BOX;
  const width = isWordmark ? height * 2.5 : height * (68 / 80);
  const accessible = accessibilityLabel !== null;

  return (
    <svg
      aria-hidden={accessible ? undefined : true}
      aria-label={accessible ? accessibilityLabel : undefined}
      className="chalk-logo"
      color={color}
      data-chalk-logo="true"
      focusable="false"
      height={height}
      role={accessible ? "img" : undefined}
      viewBox={viewBox}
      width={width}
      xmlns="http://www.w3.org/2000/svg"
      fill="none"
    >
      <svg x="0" y="6" width="68" height="68" viewBox="0 0 48 48">
        <g transform="rotate(28 24 24)" fill="currentColor">
          <path d="M18 8h12v28a6 6 0 0 1-12 0z" />
          <path d="M18 8h12l-1.5 4.5h-9z" opacity="0.45" />
        </g>
        <circle cx="10.5" cy="41.5" r="1.7" fill="currentColor" opacity="0.55" />
        <circle cx="6.5" cy="37" r="1.2" fill="currentColor" opacity="0.4" />
        <circle cx="4" cy="43.5" r="0.85" fill="currentColor" opacity="0.28" />
      </svg>

      {isWordmark ? (
        <text className="chalk-logo__wordmark" x="90" y="52" fontFamily="system-ui, -apple-system, BlinkMacSystemFont, sans-serif" fontSize="38" fontWeight="600" letterSpacing="-0.02em" fill="currentColor">
          chalk
        </text>
      ) : null}
    </svg>
  );
}
