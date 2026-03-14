/**
 * Chalk Mobile Design System Tokens
 * Derived from @docs/design-system/chalk-design-system.md
 */

export const Theme = {
  colors: {
    // Core Semantic Colors (Dark Mode Default for Mobile)
    background: "#0a0a0b",
    foreground: "#fbffff",
    card: "#141418",
    cardForeground: "#fbffff",
    popover: "#141418",
    popoverForeground: "#fbffff",
    primary: "#1bb6a6",
    primaryForeground: "#ffffff",
    secondary: "#18181b",
    secondaryForeground: "#fbffff",
    muted: "#18181b",
    mutedForeground: "#71717a",
    accent: "#18181b",
    accentForeground: "#fbffff",
    destructive: "#7f1d1d",
    destructiveForeground: "#fca5a5",
    border: "#1c1c1f",
    input: "#1c1c1f",
    ring: "#1bb6a6",
    success: "#22c55e",
    warning: "#f59e0b",
    error: "#ef4444",

    // Brand specific
    brandTeal: "#1bb6a6",
    brandCyan: "#06b6d4",

    // Meeting specific from SDK
    stageBackground: "#0a0a0c",
    tileBackground: "#141418",
    controlsBackground: "rgba(26, 26, 26, 0.92)",
    speakingAccent: "#22c55e",
    glassSurface: "rgba(18, 18, 26, 0.72)",
    
    // Legacy mapping (to be phased out)
    eyebrow: "#1bb6a6",
    placeholder: "#3f3f46",
  },
  radius: {
    xs: 4,
    sm: 8,
    md: 10, // var(--radius) is 0.625rem = 10px
    lg: 12,
    xl: 16,
    "2xl": 24,
    full: 9999,
  },
  spacing: {
    xs: 4,
    sm: 8,
    md: 12,
    lg: 16,
    xl: 20,
    "2xl": 24,
    "3xl": 32,
    "4xl": 40,
    "5xl": 48,
    "6xl": 64,
  },
  shadows: {
    sm: {
      shadowColor: "#000",
      shadowOffset: { width: 0, height: 1 },
      shadowOpacity: 0.1,
      shadowRadius: 2,
      elevation: 2,
    },
    md: {
      shadowColor: "#000",
      shadowOffset: { width: 0, height: 4 },
      shadowOpacity: 0.2,
      shadowRadius: 8,
      elevation: 4,
    },
    lg: {
      shadowColor: "#000",
      shadowOffset: { width: 0, height: 12 },
      shadowOpacity: 0.3,
      shadowRadius: 24,
      elevation: 8,
    },
  },
  typography: {
    eyebrow: {
      fontSize: 12,
      fontWeight: "700" as const,
      textTransform: "uppercase" as const,
      letterSpacing: 1.2,
    },
    title: {
      fontSize: 32,
      fontWeight: "800" as const,
      lineHeight: 40,
    },
    heading: {
      fontSize: 22,
      fontWeight: "700" as const,
      lineHeight: 28,
    },
    subheading: {
      fontSize: 18,
      fontWeight: "700" as const,
      lineHeight: 24,
    },
    body: {
      fontSize: 15,
      lineHeight: 22,
    },
    label: {
      fontSize: 14,
      fontWeight: "600" as const,
    },
    meta: {
      fontSize: 13,
      lineHeight: 18,
    },
  },
};
