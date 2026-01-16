/**
 * Generate consistent, vibrant colors for participants
 * Similar to Google Meet's dynamic tile colors
 */

interface ColorPalette {
  primary: string;
  secondary: string;
  border: string;
}

// Curated color palettes that work well for video tiles
const COLOR_PALETTES: ColorPalette[] = [
  // Purple
  { primary: '#3E006D', secondary: '#1a0a2e', border: 'rgba(98, 0, 177, 0.3)' },
  // Blue
  { primary: '#0D47A1', secondary: '#0a1929', border: 'rgba(13, 71, 161, 0.3)' },
  // Teal
  { primary: '#00695C', secondary: '#0a1f1c', border: 'rgba(0, 105, 92, 0.3)' },
  // Green
  { primary: '#2E7D32', secondary: '#0f1f10', border: 'rgba(46, 125, 50, 0.3)' },
  // Orange
  { primary: '#E65100', secondary: '#1f1209', border: 'rgba(230, 81, 0, 0.3)' },
  // Red
  { primary: '#C62828', secondary: '#1f0a0a', border: 'rgba(198, 40, 40, 0.3)' },
  // Pink
  { primary: '#AD1457', secondary: '#1f0a14', border: 'rgba(173, 20, 87, 0.3)' },
  // Indigo
  { primary: '#283593', secondary: '#0a0f1f', border: 'rgba(40, 53, 147, 0.3)' },
  // Cyan
  { primary: '#00838F', secondary: '#0a1a1f', border: 'rgba(0, 131, 143, 0.3)' },
  // Amber
  { primary: '#FF6F00', secondary: '#1f1609', border: 'rgba(255, 111, 0, 0.3)' },
  // Deep Purple
  { primary: '#4A148C', secondary: '#140a1f', border: 'rgba(74, 20, 140, 0.3)' },
  // Light Blue
  { primary: '#0277BD', secondary: '#0a161f', border: 'rgba(2, 119, 189, 0.3)' },
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

/**
 * Generate a gradient background string for a video tile
 */
export function getParticipantGradient(participantId?: string): string {
  const colors = getParticipantColor(participantId);
  return `linear-gradient(180deg, ${colors.primary} 0%, ${colors.secondary} 50%, #000000 100%)`;
}

/**
 * Get border color for a video tile
 */
export function getParticipantBorder(participantId?: string): string {
  const colors = getParticipantColor(participantId);
  return colors.border;
}
