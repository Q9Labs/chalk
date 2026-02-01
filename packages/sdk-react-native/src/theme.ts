/**
 * Chalk UI Theme
 * Derived from @q9labs/chalk-ui CSS variables (Dark Mode)
 */

export const CHALK_THEME = {
  colors: {
    // Core backgrounds
    background: "#0A0A0C", // --chalk-bg-stage (dark)
    surface: "#141418",    // --chalk-bg-tile (dark)
    surfaceHighlight: "#27272a", // Slightly lighter surface
    
    // Semantic colors
    primary: "#2dd4bf",    // Teal-400 (approx for oklch(0.70 0.12 183))
    secondary: "#27272a",  // Zinc-800
    destructive: "#ef4444", // Red-500
    
    // Text colors
    text: {
      primary: "#ffffff",
      secondary: "rgba(255, 255, 255, 0.72)", // --chalk-pill-text (dark)
      muted: "rgba(255, 255, 255, 0.5)",
      inverse: "#0f172a",
    },

    // Status & Accents
    status: {
      speaking: "#22C55E", // --chalk-accent-speaking
      speakingGlow: "rgba(34, 197, 94, 0.4)", // --chalk-accent-speaking-glow
      error: "#ef4444",
      warning: "#f59e0b",
      success: "#22c55e",
    },

    // UI Elements (Pills, Controls)
    ui: {
      pillBg: "rgba(255, 255, 255, 0.08)", // --chalk-pill-bg (dark)
      pillBgHover: "rgba(255, 255, 255, 0.16)",
      pillBorder: "rgba(255, 255, 255, 0.12)", // --chalk-pill-border (dark)
      border: "rgba(255, 255, 255, 0.12)",
      overlay: "rgba(0, 0, 0, 0.6)",
    }
  },
  
  borderRadius: {
    sm: 4,     // --chalk-border-radius-sm
    md: 8,     // --chalk-border-radius-md
    lg: 12,    // Used in tiles
    xl: 16,    // --chalk-border-radius-xl
    full: 9999,// --chalk-border-radius-full
  },

  spacing: {
    xs: 4,
    sm: 8,
    md: 16,
    lg: 24,
    xl: 32,
  },

  typography: {
    fontFamily: "System", // Default to system font on mobile, can be customized
    sizes: {
      xs: 12,
      sm: 14,
      md: 16,
      lg: 20,
      xl: 24,
    }
  }
} as const;

export type ChalkTheme = typeof CHALK_THEME;
