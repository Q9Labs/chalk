import CheckmarkCircle01Icon from "@hugeicons/core-free-icons/dist/esm/CheckmarkCircle01Icon";
import { HugeiconsIcon } from "@hugeicons/react-native";
import { Pressable, StyleSheet, Text, View } from "react-native";

import { THEME_PALETTES, THEME_TEXTURES, type ThemeMode } from "../../ui/appearance";
import { useNativeAppearance } from "../../ui/native-appearance-context";
import { useNativeTheme } from "../../ui/native-theme";
import { Theme } from "../../ui/theme";

export function AppearanceSettings(): React.JSX.Element {
  const { appearance, setPalette, setTexture } = useNativeAppearance();
  const theme = useNativeTheme();
  return (
    <View style={styles.section}>
      <Text style={[styles.intro, { color: theme.colors.ink2 }]}>Choose a complete color family, then layer in a material texture. Every combination is available on mobile.</Text>
      {(["light", "dark"] as const).map((mode) => (
        <PaletteGroup key={mode} mode={mode} selectedPalette={appearance.palette} theme={theme} onSelect={setPalette} />
      ))}
      <View style={styles.textureSection}>
        <Text style={styles.groupLabel}>Texture</Text>
        <View style={styles.textureGrid}>
          {THEME_TEXTURES.map((texture) => {
            const selected = texture.value === appearance.texture;
            return (
              <Pressable
                accessibilityLabel={`Use ${texture.label} texture`}
                accessibilityRole="button"
                accessibilityState={{ selected }}
                key={texture.value}
                onPress={() => setTexture(texture.value)}
                style={({ pressed }) => [styles.texture, { backgroundColor: theme.colors.surfaceMuted, borderColor: theme.colors.line }, selected && [styles.selected, { borderColor: theme.colors.primary }], pressed && styles.pressed]}
              >
                <TexturePreview kind={texture.value} background={appearance.tokens.stage} foreground={appearance.tokens.textMuted} />
                <Text numberOfLines={1} style={[styles.textureLabel, { color: theme.colors.ink }]}>
                  {texture.label}
                </Text>
              </Pressable>
            );
          })}
        </View>
      </View>
    </View>
  );
}

function PaletteGroup({ mode, selectedPalette, theme, onSelect }: { readonly mode: ThemeMode; readonly selectedPalette: string; readonly theme: ReturnType<typeof useNativeTheme>; readonly onSelect: (palette: (typeof THEME_PALETTES)[number]["value"]) => void }): React.JSX.Element {
  return (
    <View style={styles.group}>
      <Text style={styles.groupLabel}>{mode === "light" ? "Light palettes" : "Dark palettes"}</Text>
      <View style={styles.paletteGrid}>
        {THEME_PALETTES.filter((palette) => palette.mode === mode).map((palette) => {
          const selected = palette.value === selectedPalette;
          return (
            <Pressable
              accessibilityLabel={`Use ${palette.label} palette`}
              accessibilityRole="button"
              accessibilityState={{ selected }}
              key={palette.value}
              onPress={() => onSelect(palette.value)}
              style={({ pressed }) => [styles.palette, { backgroundColor: theme.colors.surfaceMuted, borderColor: theme.colors.line }, selected && [styles.selected, { borderColor: theme.colors.primary }], pressed && styles.pressed]}
            >
              <View style={styles.swatches}>
                {palette.swatch.map((color) => (
                  <View key={color} style={[styles.swatch, { backgroundColor: color }]} />
                ))}
              </View>
              <View style={styles.paletteCopy}>
                <Text numberOfLines={1} style={[styles.paletteLabel, { color: theme.colors.ink }]}>
                  {palette.label}
                </Text>
                <Text numberOfLines={1} style={[styles.family, { color: theme.colors.ink3 }]}>
                  {palette.family}
                </Text>
              </View>
              {selected ? <HugeiconsIcon color={theme.colors.success} icon={CheckmarkCircle01Icon} size={18} /> : null}
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

function TexturePreview({ background, foreground, kind }: { readonly background: string; readonly foreground: string; readonly kind: "none" | "paper" | "slate" }): React.JSX.Element {
  return (
    <View style={[styles.texturePreview, { backgroundColor: background }]}>
      {kind === "paper" ? Array.from({ length: 11 }, (_, index) => <View key={index} style={[styles.grain, { backgroundColor: foreground, left: `${(index * 29) % 91}%`, top: `${(index * 43) % 88}%` }]} />) : null}
      {kind === "slate" ? Array.from({ length: 5 }, (_, index) => <View key={index} style={[styles.slateLine, { backgroundColor: foreground, top: 4 + index * 8 }]} />) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  section: { gap: Theme.spacing.xl },
  intro: { color: Theme.colors.ink2, fontSize: 14, lineHeight: 20 },
  group: { gap: Theme.spacing.sm },
  groupLabel: { color: Theme.colors.ink3, fontSize: 11, fontWeight: "800", letterSpacing: 1, textTransform: "uppercase" },
  paletteGrid: { flexDirection: "row", flexWrap: "wrap", gap: Theme.spacing.sm },
  palette: { alignItems: "center", backgroundColor: Theme.colors.surfaceMuted, borderColor: Theme.colors.line, borderRadius: Theme.radius.md, borderWidth: 1, flexDirection: "row", gap: 9, minHeight: 66, padding: 9, width: "48.6%" },
  selected: { borderColor: Theme.colors.chalkBlue, borderWidth: 2, padding: 8 },
  swatches: { borderColor: Theme.colors.line, borderRadius: 7, borderWidth: 1, height: 42, overflow: "hidden", width: 42 },
  swatch: { flex: 1 },
  paletteCopy: { flex: 1, minWidth: 0 },
  paletteLabel: { color: Theme.colors.ink, fontSize: 13, fontWeight: "700" },
  family: { color: Theme.colors.ink3, fontSize: 11, marginTop: 2 },
  textureSection: { gap: Theme.spacing.sm },
  textureGrid: { flexDirection: "row", gap: Theme.spacing.sm },
  texture: { backgroundColor: Theme.colors.surfaceMuted, borderColor: Theme.colors.line, borderRadius: Theme.radius.md, borderWidth: 1, flex: 1, overflow: "hidden", padding: 9 },
  texturePreview: { borderColor: Theme.colors.line, borderRadius: Theme.radius.sm, borderWidth: 1, height: 44, overflow: "hidden", position: "relative" },
  textureLabel: { color: Theme.colors.ink, fontSize: 12, fontWeight: "700", marginTop: 7, textAlign: "center" },
  grain: { borderRadius: 1, height: 2, opacity: 0.18, position: "absolute", width: 2 },
  slateLine: { height: 1, left: -5, opacity: 0.15, position: "absolute", transform: [{ rotate: "7deg" }], width: "120%" },
  pressed: { opacity: 0.7, transform: [{ scale: 0.98 }] },
});
