import { createContext, useCallback, useContext, useEffect, useMemo, useState, type PropsWithChildren } from "react";
import { StyleSheet, View } from "react-native";

import { resolveNativeAppearance, type NativeAppearance, type ThemeAppearance, type ThemePalette, type ThemeTexture } from "./appearance";

interface NativeAppearanceContextValue {
  readonly appearance: NativeAppearance;
  readonly setPalette: (palette: ThemePalette) => void;
  readonly setTexture: (texture: ThemeTexture) => void;
}

const NativeAppearanceContext = createContext<NativeAppearanceContextValue | null>(null);

interface NativeAppearanceProviderProps extends PropsWithChildren {
  readonly initialAppearance?: Partial<ThemeAppearance>;
}

export function NativeAppearanceProvider({ children, initialAppearance }: NativeAppearanceProviderProps): React.JSX.Element {
  const [selection, setSelection] = useState<ThemeAppearance>({ palette: initialAppearance?.palette ?? "light", texture: initialAppearance?.texture ?? "none" });
  useEffect(() => {
    if (initialAppearance?.palette === undefined && initialAppearance?.texture === undefined) return;
    setSelection((current) => {
      const next = {
        palette: initialAppearance?.palette ?? current.palette,
        texture: initialAppearance?.texture ?? current.texture,
      } satisfies ThemeAppearance;
      return next.palette === current.palette && next.texture === current.texture ? current : next;
    });
  }, [initialAppearance?.palette, initialAppearance?.texture]);
  const appearance = useMemo(() => resolveNativeAppearance(selection), [selection]);

  const updateSelection = useCallback((next: ThemeAppearance) => {
    setSelection(next);
  }, []);

  const value = useMemo<NativeAppearanceContextValue>(
    () => ({
      appearance,
      setPalette: (palette) => updateSelection({ ...selection, palette }),
      setTexture: (texture) => updateSelection({ ...selection, texture }),
    }),
    [appearance, selection, updateSelection],
  );

  return <NativeAppearanceContext.Provider value={value}>{children}</NativeAppearanceContext.Provider>;
}

export function useNativeAppearance(): NativeAppearanceContextValue {
  const value = useContext(NativeAppearanceContext);
  if (!value) throw new Error("useNativeAppearance must be used inside NativeAppearanceProvider");
  return value;
}

export function NativeTextureOverlay(): React.JSX.Element | null {
  const { appearance } = useNativeAppearance();
  const descriptor = appearance.textureDescriptor;
  if (descriptor.kind === "none") return null;

  const marks = descriptor.kind === "paper-grain" ? 44 : 26;
  return (
    <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants" pointerEvents="none" style={[StyleSheet.absoluteFill, styles.overlay, { opacity: descriptor.opacity }]}>
      {Array.from({ length: marks }, (_, index) => {
        const size = descriptor.kind === "paper-grain" ? 1 + (index % 2) : 1;
        return <View key={index} style={[styles.mark, descriptor.kind === "slate" && styles.slateMark, { backgroundColor: appearance.tokens.text, height: size, left: `${(index * 37) % 97}%`, top: `${(index * 53) % 96}%`, width: descriptor.kind === "slate" ? 38 : size }]} />;
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  overlay: { overflow: "hidden" },
  mark: { borderRadius: 2, position: "absolute" },
  slateMark: { opacity: 0.48, transform: [{ rotate: "7deg" }] },
});
