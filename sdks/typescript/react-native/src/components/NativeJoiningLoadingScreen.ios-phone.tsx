import { useRef } from "react";
import { Animated, StyleSheet, Text, View } from "react-native";
import { Theme } from "../ui/theme";
import type { NativeJoiningLoadingScreenProps } from "./NativeJoiningLoadingScreen";
import { ChalkLogoElements } from "./ChalkLogoElements";
import { createNativeJoiningLoadingAnimation, type NativeJoiningLoadingAnimation } from "./native-joining-loading-animation";

export function NativeJoiningLoadingScreenIosPhone({ message = "Preparing meeting..." }: NativeJoiningLoadingScreenProps): React.JSX.Element {
  const animationRef = useRef<NativeJoiningLoadingAnimation | null>(null);
  const animation = animationRef.current ?? (animationRef.current = createNativeJoiningLoadingAnimation());

  return (
    <View style={styles.screen}>
      <Animated.View ref={animation.ref} style={[styles.content, { opacity: animation.fadeAnim }]}>
        <View style={styles.illustrationFrame}>
          <Animated.View
            style={[
              styles.glow,
              {
                transform: [{ scale: animation.pulseAnim }],
                opacity: animation.pulseAnim.interpolate({ inputRange: [1, 1.1], outputRange: [0.12, 0.18] }),
              },
            ]}
          />
          <ChalkLogoElements size={100} />
        </View>
        <Text style={styles.brand}>chalk</Text>
        <Text style={styles.label}>{message}</Text>
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: Theme.colors.background,
    alignItems: "center",
    justifyContent: "center",
  },
  content: {
    alignItems: "center",
    justifyContent: "center",
    gap: 16,
  },
  illustrationFrame: {
    width: 180,
    height: 180,
    borderRadius: 90,
    backgroundColor: "rgba(27, 182, 166, 0.04)",
    alignItems: "center",
    justifyContent: "center",
    position: "relative",
    marginBottom: 8,
    borderWidth: 1,
    borderColor: "rgba(27, 182, 166, 0.08)",
  },
  glow: {
    position: "absolute",
    width: 120,
    height: 120,
    borderRadius: 60,
    backgroundColor: Theme.colors.primary,
  },
  brand: {
    fontSize: 32,
    fontWeight: "800",
    color: Theme.colors.foreground,
    letterSpacing: -1,
  },
  label: {
    fontSize: 17,
    lineHeight: 24,
    color: Theme.colors.mutedForeground,
    textAlign: "center",
    maxWidth: 300,
  },
});
