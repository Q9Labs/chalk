import type { ReactNode } from "react";
export function CallEventIcon({ kind, error = false }: { readonly kind: "speaker" | "microphone" | "microphone-on" | "camera" | "screen" | "recording" | "hand" | "host"; readonly error?: boolean }) {
  const paths: { readonly [K in typeof kind]: ReactNode } = {
    speaker: <path d="M11 5 6 9H3v6h3l5 4V5ZM15 8a6 6 0 0 1 0 8M18 5a10 10 0 0 1 0 14" />,
    microphone: <path d="M2 2l20 20M15 9.3V5a3 3 0 0 0-5.7-1.3M9 9v2a3 3 0 0 0 5.1 2.1M17 17a7 7 0 0 1-12-6v-1M19 10v1a7 7 0 0 1-.1 1.2M12 18v4" />,
    "microphone-on": (
      <>
        <rect x="9" y="2" width="6" height="12" rx="3" />
        <path d="M19 10v1a7 7 0 0 1-14 0v-1M12 18v4" />
      </>
    ),
    camera: <path d="M2 2l20 20M10.7 6H14a2 2 0 0 1 2 2v3.3l1 1 4-2.8v8M16 16a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h2" />,
    screen: (
      <>
        <rect x="2" y="3" width="20" height="14" rx="2" />
        <path d="M8 21h8M12 17v4M9.5 7.5l5 5M14.5 7.5l-5 5" />
      </>
    ),
    recording: (
      <>
        <circle cx="12" cy="12" r="9" />
        <circle cx="12" cy="12" r="3.5" fill="currentColor" />
      </>
    ),
    hand: (
      <>
        <path d="M18 11V6a2 2 0 0 0-4 0v5M14 10V4a2 2 0 0 0-4 0v6M10 10.5V6a2 2 0 0 0-4 0v8" />
        <path d="M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.9-6-2.3l-3.6-3.6a2 2 0 0 1 2.8-2.8L7 15" />
      </>
    ),
    host: (
      <>
        <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
        <circle cx="9" cy="7" r="4" />
        <path d="M22 21v-2a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8" />
      </>
    ),
  };
  return (
    <svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" className="shrink-0" style={{ color: error ? "var(--chalk-danger-text)" : "var(--chalk-muted-text)" }}>
      {paths[kind]}
    </svg>
  );
}
