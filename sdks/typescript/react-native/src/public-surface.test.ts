import type { ClientEventMap } from "@q9labsai/chalk-client";
import type { ThemeAppearance as ReactThemeAppearance, ThemePalette as ReactThemePalette, ThemeTexture as ReactThemeTexture } from "../../react/src/components/theme";
import type { ChalkProps, ChalkThemeTokens, SpaceLayout } from "./components/Chalk";
import type { EntranceProps, EntranceSettings } from "./components/Entrance";
import type { ThemeAppearance, ThemePalette, ThemeTexture } from "./ui/appearance";
import { expectTypeOf, test } from "vitest";

test("the turnkey and entrance props use the ratified names", () => {
  expectTypeOf<ChalkProps>().toMatchTypeOf<{
    readonly entrance?: boolean;
    readonly defaults?: { readonly microphone?: boolean; readonly camera?: boolean };
    readonly features?: object;
    readonly layout?: SpaceLayout;
  }>();
  expectTypeOf<EntranceProps>().toMatchTypeOf<{
    readonly defaults?: { readonly microphone?: boolean; readonly camera?: boolean };
    readonly onCancel?: () => void;
  }>();
  expectTypeOf<EntranceSettings>().toEqualTypeOf<{ readonly displayName: string; readonly microphone: boolean; readonly camera: boolean }>();
  expectTypeOf<NonNullable<ChalkProps["onError"]>>().toEqualTypeOf<(event: ClientEventMap["error"]) => void>();
  expectTypeOf<keyof ChalkThemeTokens>().toEqualTypeOf<"canvas" | "chrome" | "surface" | "stage" | "text" | "mutedText" | "line" | "accent" | "accentText" | "positive" | "danger" | "dangerSurface" | "focus" | "shadow">();
  expectTypeOf<ThemePalette>().toEqualTypeOf<ReactThemePalette>();
  expectTypeOf<ThemeTexture>().toEqualTypeOf<ReactThemeTexture>();
  expectTypeOf<ThemeAppearance>().toEqualTypeOf<ReactThemeAppearance>();
});
