/**
 * Generate consistent, vibrant colors for participants
 * Similar to Google Meet's dynamic tile colors
 */

interface ColorPalette {
  primary: string;
  secondary: string;
  gradientEnd: string;
  border: string;
}

// Curated color palettes that work well for video tiles
const COLOR_PALETTES: ColorPalette[] = [
  // Brand Teal
  { primary: '#1bb6a6', secondary: '#0a1f1c', gradientEnd: '#0d9488', border: 'rgba(27, 182, 166, 0.3)' },
  // Teal 600
  { primary: '#0d9488', secondary: '#0a1917', gradientEnd: '#115e59', border: 'rgba(13, 148, 136, 0.3)' },
  // Cyan
  { primary: '#06b6d4', secondary: '#0a1a1f', gradientEnd: '#0891b2', border: 'rgba(6, 182, 212, 0.3)' },
  // Emerald
  { primary: '#10b981', secondary: '#0a1f16', gradientEnd: '#059669', border: 'rgba(16, 185, 129, 0.3)' },
  // Sky
  { primary: '#0ea5e9', secondary: '#0a161f', gradientEnd: '#0284c7', border: 'rgba(14, 165, 233, 0.3)' },
  // Blue
  { primary: '#3b82f6', secondary: '#0a1429', gradientEnd: '#2563eb', border: 'rgba(59, 130, 246, 0.3)' },
  // Indigo
  { primary: '#6366f1', secondary: '#0f0a29', gradientEnd: '#4f46e5', border: 'rgba(99, 102, 241, 0.3)' },
  // Violet
  { primary: '#8b5cf6', secondary: '#140a29', gradientEnd: '#7c3aed', border: 'rgba(139, 92, 246, 0.3)' },
  // Teal Light
  { primary: '#2dd4bf', secondary: '#0a1f1c', gradientEnd: '#14b8a6', border: 'rgba(45, 212, 191, 0.3)' },
  // Green
  { primary: '#22c55e', secondary: '#0f1f10', gradientEnd: '#16a34a', border: 'rgba(34, 197, 94, 0.3)' },
];

/**
 * Hash a string to a number (simple hash function)
 */
function hashString(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32-bit integer
  }
  return Math.abs(hash);
}

/**
 * Get a consistent color palette for a participant based on their ID
 * Same ID will always return the same color
 */
export function getParticipantColor(participantId?: string): ColorPalette {
  if (!participantId) {
    return COLOR_PALETTES[0] as ColorPalette;
  }
  const hash = hashString(participantId);
  const index = hash % COLOR_PALETTES.length;
  return COLOR_PALETTES[index] as ColorPalette;
}

function getReadableTextColor(hexColor: string): string {
  const normalized = hexColor.replace('#', '');
  const hex = normalized.length === 3
    ? normalized.split('').map((char) => `${char}${char}`).join('')
    : normalized;

  const r = Number.parseInt(hex.slice(0, 2), 16) / 255;
  const g = Number.parseInt(hex.slice(2, 4), 16) / 255;
  const b = Number.parseInt(hex.slice(4, 6), 16) / 255;

  const linearize = (channel: number) =>
    channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;

  const luminance = (0.2126 * linearize(r)) + (0.7152 * linearize(g)) + (0.0722 * linearize(b));

  return luminance > 0.5 ? '#0f172a' : '#f8fafc';
}

export function getParticipantThemeVariables(participantId?: string) {
  const colors = getParticipantColor(participantId);

  return {
    '--primary': colors.primary,
    '--primary-foreground': getReadableTextColor(colors.primary),
    '--ring': colors.primary,
  };
}

/**
 * Generate a rich, fully-saturated gradient string for Avatars and small badges.
 */
export function getParticipantAvatarGradient(participantId?: string): string {
  const colors = getParticipantColor(participantId);
  return `linear-gradient(135deg, ${colors.primary} 0%, ${colors.gradientEnd} 100%)`;
}

/**
 * Generate a gradient background string for a video tile.
 * Returns a consistent, rich 2-stop gradient that works beautifully in both light and dark modes.
 */
export function getParticipantGradient(participantId?: string): string {
  const colors = getParticipantColor(participantId);
  return `linear-gradient(180deg, ${colors.primary} 0%, ${colors.gradientEnd} 100%)`;
}

/**
 * Get border color for a video tile
 */
export function getParticipantBorder(participantId?: string): string {
  const colors = getParticipantColor(participantId);
  return colors.border;
}
