import { useId } from "react";
import { View } from "react-native";
import Svg, { Defs, Ellipse, G, LinearGradient, Path, Stop, Text as SvgText } from "react-native-svg";

export type LogoVariant = "mark" | "wordmark";

export interface LogoProps {
  readonly accessibilityLabel?: string | null;
  readonly color?: string;
  readonly height?: number;
  readonly variant?: LogoVariant;
}

const DEFAULT_COLOR = "#1A332B";
const DEFAULT_HEIGHT = 32;
const DEFAULT_VARIANT: LogoVariant = "wordmark";
const WORDMARK_VIEW_BOX = "0 0 200 80";
const MARK_VIEW_BOX = "0 0 68 80";

export function Logo({ accessibilityLabel = "Chalk", color = DEFAULT_COLOR, height = DEFAULT_HEIGHT, variant = DEFAULT_VARIANT }: LogoProps): React.JSX.Element {
  const idPrefix = `chalk-logo-${useId().replace(/[^a-zA-Z0-9_-]/gu, "")}`;
  const width = variant === "wordmark" ? height * 2.5 : height * (68 / 80);
  const viewBox = variant === "wordmark" ? WORDMARK_VIEW_BOX : MARK_VIEW_BOX;
  const accessible = accessibilityLabel !== null;

  return (
    <View accessible={false}>
      <Svg accessibilityLabel={accessible ? (accessibilityLabel ?? undefined) : undefined} accessible={accessible} color={color} fill="none" focusable={false} height={height} viewBox={viewBox} width={width}>
        <Defs>
          <LinearGradient id={`${idPrefix}-green`} x1="0%" x2="100%" y1="0%" y2="0%">
            <Stop offset="0%" stopColor="#C5E5C0" />
            <Stop offset="100%" stopColor="#80B879" />
          </LinearGradient>
          <LinearGradient id={`${idPrefix}-yellow`} x1="0%" x2="100%" y1="0%" y2="0%">
            <Stop offset="0%" stopColor="#FCEAB3" />
            <Stop offset="100%" stopColor="#D9B641" />
          </LinearGradient>
          <LinearGradient id={`${idPrefix}-blue`} x1="0%" x2="100%" y1="0%" y2="0%">
            <Stop offset="0%" stopColor="#B2E0F0" />
            <Stop offset="100%" stopColor="#55AAC9" />
          </LinearGradient>
          <LinearGradient id={`${idPrefix}-pink`} x1="0%" x2="100%" y1="0%" y2="0%">
            <Stop offset="0%" stopColor="#F8CACA" />
            <Stop offset="100%" stopColor="#D67B7B" />
          </LinearGradient>
        </Defs>

        <G transform="translate(2, 2) scale(0.95)">
          <G transform="rotate(-15 20 60)">
            <Path d="M9,20 L21,20 L22,63 A7,7 0 0 1 8,63 Z" fill={`url(#${idPrefix}-green)`} />
            <Ellipse cx="15" cy="20" fill="#D8ECD4" rx="6" ry="2.5" />
          </G>

          <G transform="rotate(-8 32 55)">
            <Path d="M23,15 L35,15 L36,60 A7,7 0 0 1 22,60 Z" fill={`url(#${idPrefix}-yellow)`} />
            <Ellipse cx="29" cy="15" fill="#FEF3D1" rx="6" ry="2.5" />
          </G>

          <G transform="rotate(12 60 30)">
            <Path d="M36,8 L48,8 L49,56 A7,7 0 0 1 35,56 Z" fill={`url(#${idPrefix}-blue)`} />
            <Ellipse cx="42" cy="8" fill="#D0EDF8" rx="6" ry="2.5" />
          </G>

          <G transform="rotate(5 55 50)">
            <Path d="M49,70 L61,70 L62,29 A7,7 0 0 0 48,29 Z" fill={`url(#${idPrefix}-pink)`} />
            <Ellipse cx="55" cy="70" fill="#FBE4E4" rx="6" ry="2.5" />
          </G>
        </G>

        {variant === "wordmark" ? (
          <SvgText fill="currentColor" fontFamily="system-ui, -apple-system, BlinkMacSystemFont, sans-serif" fontSize="38" fontWeight="600" letterSpacing="-0.02em" x="90" y="52">
            chalk
          </SvgText>
        ) : null}
      </Svg>
    </View>
  );
}
