import { HugeiconsIcon } from "@hugeicons/react-native";
import { Pressable, StyleSheet, Text, View, type StyleProp, type ViewStyle } from "react-native";

import { getParticipantColor, getParticipantInitials } from "../../ui/participant-avatar";
import { Theme } from "../../ui/theme";

export type SpaceIcon = React.ComponentProps<typeof HugeiconsIcon>["icon"];

export function SheetGrip(): React.JSX.Element {
  return <View accessibilityElementsHidden style={styles.grip} />;
}

export function CloseButton({ label, onPress }: { readonly label: string; readonly onPress: () => void }): React.JSX.Element {
  return (
    <Pressable accessibilityLabel={label} accessibilityRole="button" hitSlop={6} onPress={onPress} style={({ pressed }) => [styles.closeButton, pressed && styles.pressed]}>
      <Text style={styles.closeGlyph}>×</Text>
    </Pressable>
  );
}

export function SurfaceHeader({ title, count, subtitle, onClose, closeLabel }: { readonly title: string; readonly count?: number; readonly subtitle?: string; readonly onClose: () => void; readonly closeLabel: string }): React.JSX.Element {
  return (
    <View style={styles.header}>
      <View style={styles.headerCopy}>
        <View style={styles.titleRow}>
          <Text style={styles.title}>{title}</Text>
          {count !== undefined ? (
            <View style={styles.countPill}>
              <Text style={styles.countText}>{count}</Text>
            </View>
          ) : null}
        </View>
        {subtitle ? <Text style={styles.subtitle}>{subtitle}</Text> : null}
      </View>
      <CloseButton label={closeLabel} onPress={onClose} />
    </View>
  );
}

export function InitialsAvatar({ name, size = 52, style }: { readonly name: string; readonly size?: number; readonly style?: StyleProp<ViewStyle> }): React.JSX.Element {
  const color = getParticipantColor(name);
  return (
    <View style={[styles.avatar, { backgroundColor: color.primary, borderRadius: size / 2, height: size, width: size }, style]}>
      <Text allowFontScaling={false} style={[styles.avatarText, { fontSize: Math.max(16, Math.round(size * 0.34)) }]}>
        {getParticipantInitials(name)}
      </Text>
    </View>
  );
}

export function IconTile({ icon, symbol, color = Theme.colors.ink, wash = Theme.colors.surface }: { readonly icon?: SpaceIcon; readonly symbol?: string; readonly color?: string; readonly wash?: string }): React.JSX.Element {
  return <View style={[styles.iconTile, { backgroundColor: wash }]}>{icon ? <HugeiconsIcon color={color} icon={icon} size={22} /> : <Text style={[styles.symbol, { color }]}>{symbol}</Text>}</View>;
}

export function PressedStyle({ pressed }: { readonly pressed: boolean }): StyleProp<ViewStyle> {
  return pressed ? styles.pressed : undefined;
}

const styles = StyleSheet.create({
  grip: { alignSelf: "center", backgroundColor: Theme.colors.lineStrong, borderRadius: Theme.radius.full, height: 5, marginTop: Theme.spacing.sm, width: 48 },
  closeButton: { alignItems: "center", borderColor: Theme.colors.line, borderRadius: Theme.radius.full, borderWidth: 1, height: 46, justifyContent: "center", width: 46 },
  closeGlyph: { color: Theme.colors.ink, fontSize: 28, fontWeight: "400", lineHeight: 30 },
  header: { alignItems: "center", borderBottomColor: Theme.colors.line, borderBottomWidth: 1, flexDirection: "row", justifyContent: "space-between", minHeight: 88, paddingHorizontal: Theme.spacing.lg, paddingVertical: Theme.spacing.md },
  headerCopy: { flex: 1, minWidth: 0, paddingRight: Theme.spacing.md },
  titleRow: { alignItems: "center", flexDirection: "row", gap: Theme.spacing.sm },
  title: { ...Theme.typography.heading, color: Theme.colors.ink },
  subtitle: { ...Theme.typography.meta, color: Theme.colors.ink2, marginTop: 2 },
  countPill: { alignItems: "center", backgroundColor: Theme.colors.paper2, borderRadius: Theme.radius.sm, justifyContent: "center", minHeight: 32, minWidth: 36, paddingHorizontal: Theme.spacing.sm },
  countText: { ...Theme.typography.label, color: Theme.colors.ink },
  avatar: { alignItems: "center", justifyContent: "center", overflow: "hidden" },
  avatarText: { color: Theme.colors.surface, fontWeight: "500", includeFontPadding: false, textAlign: "center" },
  iconTile: { alignItems: "center", borderColor: Theme.colors.line, borderRadius: Theme.radius.md, borderWidth: 1, height: 44, justifyContent: "center", width: 44 },
  symbol: { fontSize: 24, fontWeight: "500", includeFontPadding: false },
  pressed: { opacity: 0.72, transform: [{ scale: 0.98 }] },
});
