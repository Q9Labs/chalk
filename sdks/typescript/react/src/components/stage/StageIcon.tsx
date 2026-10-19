import React, { type SVGProps } from "react";

type StageIconName = "share" | "fill" | "fit" | "zoom-in" | "zoom-out" | "pip" | "volume" | "maximize" | "pause" | "more" | "mute" | "hand" | "pin" | "pen";
const paths: Record<StageIconName, React.ReactNode> = {
  share: (
    <>
      <rect x="2" y="3" width="20" height="14" rx="2" />
      <path d="M8 21h8M12 17v4M9 10l3-3 3 3M12 7v6" />
    </>
  ),
  fill: (
    <>
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <path d="M7 12h10M7 12l2.5-2.5M7 12l2.5 2.5M17 12l-2.5-2.5M17 12l-2.5 2.5" />
    </>
  ),
  fit: (
    <>
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <rect x="7.5" y="9" width="9" height="6" rx="1" />
    </>
  ),
  "zoom-in": (
    <>
      <circle cx="11" cy="11" r="7" />
      <path d="M21 21l-4.3-4.3M8 11h6M11 8v6" />
    </>
  ),
  "zoom-out": (
    <>
      <circle cx="11" cy="11" r="7" />
      <path d="M21 21l-4.3-4.3M8 11h6" />
    </>
  ),
  pip: (
    <>
      <rect x="2" y="4" width="20" height="16" rx="2" />
      <rect x="12" y="12" width="7" height="5" rx="1" fill="currentColor" />
    </>
  ),
  volume: (
    <>
      <path d="M11 5L6 9H2v6h4l5 4z" />
      <path d="M15.5 8.5a5 5 0 0 1 0 7M19 5a10 10 0 0 1 0 14" />
    </>
  ),
  maximize: <path d="M8 3H5a2 2 0 0 0-2 2v3M21 8V5a2 2 0 0 0-2-2h-3M3 16v3a2 2 0 0 0 2 2h3M16 21h3a2 2 0 0 0 2-2v-3" />,
  pause: <path d="M9 5v14M15 5v14" strokeWidth="2.5" />,
  more: <path d="M5 12h.01M12 12h.01M19 12h.01" strokeWidth="3" />,
  mute: <path d="M2 2l20 20M15 9.3V5a3 3 0 0 0-5.7-1.3M9 9v2a3 3 0 0 0 5.1 2.1M17 17a7 7 0 0 1-12-6v-1M19 10v1a7 7 0 0 1-.1 1.2M12 18v4" />,
  hand: (
    <>
      <path d="M18 11V6a2 2 0 0 0-4 0v5M14 10V4a2 2 0 0 0-4 0v6M10 10.5V6a2 2 0 0 0-4 0v8" />
      <path d="M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.9-6-2.3l-3.6-3.6a2 2 0 0 1 2.8-2.8L7 15" />
    </>
  ),
  pin: <path d="M12 17v5M9 10.8a2 2 0 0 1-1.1 1.8l-1.8.9A2 2 0 0 0 5 15.2V17h14v-1.8a2 2 0 0 0-1.1-1.8l-1.8-.9a2 2 0 0 1-1.1-1.8V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z" />,
  pen: (
    <>
      <path d="M17 3a2.85 2.85 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5z" />
      <path d="M15 5l4 4" />
    </>
  ),
};

/** The stage's compact controls share the approved tile icon shapes. */
export function StageIcon({ name, size = 16, ...props }: SVGProps<SVGSVGElement> & { name: StageIconName; size?: number }): React.JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden={props["aria-label"] ? undefined : true} {...props}>
      {paths[name]}
    </svg>
  );
}
