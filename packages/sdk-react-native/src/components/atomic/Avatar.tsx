/**
 * Avatar - Circular avatar with initials for video fallback
 */

import { useMemo } from "react";
import { View, Text, StyleSheet, type ViewStyle } from "react-native";
import { CHALK_THEME } from "../../theme";

interface AvatarProps {
  /** Display name to extract initials from */
  name: string;
  /** Avatar size in pixels (default: 64) */
  size?: number;
  /** Additional container styles */
  style?: ViewStyle;
}

/** Palette of background colors for avatars */
const AVATAR_COLORS = [
  "#6366f1", // indigo
  "#8b5cf6", // violet
  "#ec4899", // pink
  "#ef4444", // red
  "#f97316", // orange
  "#eab308", // yellow
  "#22c55e", // green
  "#14b8a6", // teal
  "#06b6d4", // cyan
  "#3b82f6", // blue
] as const;

/**
 * Simple string hash function for deterministic color selection
 */
function hashString(str: string) {
  let hash = 0;
  for (const char of str) {
    hash = (hash << 5) - hash + char.charCodeAt(0);
    hash |= 0; // Convert to 32-bit integer
  }
  return Math.abs(hash);
}

/**
 * Extract initials from a name (up to 2 characters)
 */
function getInitials(name: string) {
  return name
    .trim()
    .split(/\s+/)
    .map((part) => part[0])
    .filter(Boolean)
    .join("")
    .toUpperCase()
    .slice(0, 2);
}

export function Avatar({ name, size = 64, style }: AvatarProps) {
  const initials = useMemo(() => getInitials(name), [name]);
  const backgroundColor = useMemo(() => AVATAR_COLORS[hashString(name) % AVATAR_COLORS.length], [name]);

  const dynamicStyles = useMemo(
    () => ({
      container: {
        width: size,
        height: size,
        borderRadius: size / 2,
        backgroundColor,
      },
      text: {
        fontSize: size * 0.4,
      },
    }),
    [size, backgroundColor],
  );

  return (
    <View style={[styles.container, dynamicStyles.container, style]}>
      <Text style={[styles.text, dynamicStyles.text]}>{initials}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    justifyContent: "center",
    alignItems: "center",
  },
  text: {
    color: CHALK_THEME.colors.text.primary,
    fontWeight: "600",
  },
});
