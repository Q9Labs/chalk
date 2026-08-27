"use client";

import { useId } from "react";
import type React from "react";

export type LogoMotion = "orbit-burst" | "none";
export type LogoVariant = "mark" | "wordmark";

export type LogoProps = {
  readonly accessibilityLabel?: string | null;
  readonly color?: string;
  readonly height?: number;
  readonly motion?: LogoMotion;
  readonly variant?: LogoVariant;
};

const DEFAULT_COLOR = "#1A332B";
const DEFAULT_HEIGHT = 32;
const DEFAULT_MOTION: LogoMotion = "orbit-burst";
const DEFAULT_VARIANT: LogoVariant = "wordmark";
const WORDMARK_VIEW_BOX = "0 0 200 80";
const MARK_VIEW_BOX = "0 0 68 80";

function gradientId(prefix: string, name: string): string {
  return `${prefix}-${name}`;
}

export function Logo({ accessibilityLabel = "Chalk", color = DEFAULT_COLOR, height = DEFAULT_HEIGHT, motion = DEFAULT_MOTION, variant = DEFAULT_VARIANT }: LogoProps): React.JSX.Element {
  const generatedId = useId().replace(/[^a-zA-Z0-9_-]/gu, "");
  const idPrefix = `chalk-logo-${generatedId}`;
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
      data-chalk-logo-motion={motion}
      focusable="false"
      height={height}
      role={accessible ? "img" : undefined}
      viewBox={viewBox}
      width={width}
      xmlns="http://www.w3.org/2000/svg"
      fill="none"
    >
      <defs>
        <linearGradient id={gradientId(idPrefix, "green")} x1="0%" y1="0%" x2="100%" y2="0%">
          <stop offset="0%" stopColor="#C5E5C0" />
          <stop offset="100%" stopColor="#80B879" />
        </linearGradient>
        <linearGradient id={gradientId(idPrefix, "yellow")} x1="0%" y1="0%" x2="100%" y2="0%">
          <stop offset="0%" stopColor="#FCEAB3" />
          <stop offset="100%" stopColor="#D9B641" />
        </linearGradient>
        <linearGradient id={gradientId(idPrefix, "blue")} x1="0%" y1="0%" x2="100%" y2="0%">
          <stop offset="0%" stopColor="#B2E0F0" />
          <stop offset="100%" stopColor="#55AAC9" />
        </linearGradient>
        <linearGradient id={gradientId(idPrefix, "pink")} x1="0%" y1="0%" x2="100%" y2="0%">
          <stop offset="0%" stopColor="#F8CACA" />
          <stop offset="100%" stopColor="#D67B7B" />
        </linearGradient>
      </defs>

      <g transform="translate(2, 2) scale(0.95)">
        <g className="chalk-logo__stick chalk-logo__stick--green">
          <g transform="rotate(-15 20 60)">
            <path d="M9,20 L21,20 L22,63 A7,7 0 0 1 8,63 Z" fill={`url(#${gradientId(idPrefix, "green")})`} />
            <ellipse cx="15" cy="20" rx="6" ry="2.5" fill="#D8ECD4" />
          </g>
        </g>

        <g className="chalk-logo__stick chalk-logo__stick--yellow">
          <g transform="rotate(-8 32 55)">
            <path d="M23,15 L35,15 L36,60 A7,7 0 0 1 22,60 Z" fill={`url(#${gradientId(idPrefix, "yellow")})`} />
            <ellipse cx="29" cy="15" rx="6" ry="2.5" fill="#FEF3D1" />
          </g>
        </g>

        <g className="chalk-logo__stick chalk-logo__stick--blue">
          <g transform="rotate(12 60 30)">
            <path d="M36,8 L48,8 L49,56 A7,7 0 0 1 35,56 Z" fill={`url(#${gradientId(idPrefix, "blue")})`} />
            <ellipse cx="42" cy="8" rx="6" ry="2.5" fill="#D0EDF8" />
          </g>
        </g>

        <g className="chalk-logo__stick chalk-logo__stick--pink">
          <g transform="rotate(5 55 50)">
            <path d="M49,70 L61,70 L62,29 A7,7 0 0 0 48,29 Z" fill={`url(#${gradientId(idPrefix, "pink")})`} />
            <ellipse cx="55" cy="70" rx="6" ry="2.5" fill="#FBE4E4" />
          </g>
        </g>
      </g>

      {isWordmark ? (
        <text className="chalk-logo__wordmark" x="90" y="52" fontFamily="system-ui, -apple-system, BlinkMacSystemFont, sans-serif" fontSize="38" fontWeight="600" letterSpacing="-0.02em" fill="currentColor">
          chalk
        </text>
      ) : null}
    </svg>
  );
}
