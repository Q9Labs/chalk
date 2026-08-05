import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

const appearanceState = vi.hoisted(() => ({
  theme: { colors: { ink: "#light-ink", ink2: "#light-muted", ink3: "#light-subtle", line: "#light-line", primary: "#light-primary", surfaceMuted: "#light-surface", success: "#light-success" } },
  appearance: { palette: "light", texture: "none", tokens: { stage: "#light-stage", textMuted: "#light-muted" } },
  setPalette: vi.fn(),
  setTexture: vi.fn(),
}));

vi.mock("react-native", () => ({ Pressable: "Pressable", StyleSheet: { create: <T,>(styles: T) => styles }, Text: "Text", View: "View" }));
vi.mock("@hugeicons/react-native", () => ({ HugeiconsIcon: "HugeiconsIcon" }));
vi.mock("@hugeicons/core-free-icons/dist/esm/CheckmarkCircle01Icon", () => ({ default: "CheckmarkCircle01Icon" }), { virtual: true });
vi.mock("../../ui/native-appearance-context", () => ({ useNativeAppearance: () => appearanceState }));
vi.mock("../../ui/native-theme", () => ({ useNativeTheme: () => appearanceState.theme }));

import { AppearanceSettings } from "./AppearanceSettings";

const source = readFileSync(new URL("./AppearanceSettings.tsx", import.meta.url), "utf8");

describe("AppearanceSettings", () => {
  it("exposes every palette family and texture as an accessible selection", () => {
    expect(source).toContain('(["light", "dark"] as const)');
    expect(source).toContain("THEME_PALETTES.filter");
    expect(source).toContain("THEME_TEXTURES.map");
    expect(source).toContain("accessibilityState={{ selected }}");
    expect(source).toContain("setPalette");
    expect(source).toContain("setTexture");
  });

  it("renders palette controls with the active light and dark NativeTheme", () => {
    appearanceState.theme.colors = { ...appearanceState.theme.colors, ink2: "#light-muted", line: "#light-line", surfaceMuted: "#light-surface" };
    const lightTree = AppearanceSettings();
    expect(resolveStyle(findByAccessibilityLabel(lightTree, "Use Chalk Light palette")?.style)).toEqual(expect.arrayContaining([expect.objectContaining({ backgroundColor: "#light-surface", borderColor: "#light-line" })]));

    appearanceState.theme.colors = { ...appearanceState.theme.colors, ink2: "#dark-muted", line: "#dark-line", surfaceMuted: "#dark-surface" };
    const darkTree = AppearanceSettings();
    expect(resolveStyle(findByAccessibilityLabel(darkTree, "Use Chalk Light palette")?.style)).toEqual(expect.arrayContaining([expect.objectContaining({ backgroundColor: "#dark-surface", borderColor: "#dark-line" })]));
  });
});

function resolveStyle(style: unknown): unknown {
  return typeof style === "function" ? (style as (state: { readonly pressed: boolean }) => unknown)({ pressed: false }) : style;
}

function findByAccessibilityLabel(value: unknown, label: string): { readonly style?: unknown } | undefined {
  if (Array.isArray(value)) return value.map((child) => findByAccessibilityLabel(child, label)).find(Boolean);
  if (!value || typeof value !== "object") return undefined;
  const element = value as { readonly props?: { readonly accessibilityLabel?: unknown; readonly children?: unknown; readonly style?: unknown } };
  if (typeof (element as { readonly type?: unknown }).type === "function") {
    const component = (element as { readonly type: (props: Record<string, unknown>) => unknown }).type;
    return findByAccessibilityLabel(component((element.props ?? {}) as Record<string, unknown>), label);
  }
  if (element.props?.accessibilityLabel === label) return element.props;
  return findByAccessibilityLabel(element.props?.children, label);
}
