import { useEffect, useRef } from "react";
import { Animated, Easing, StyleSheet, Text, View } from "react-native";
import { Theme } from "../ui/theme";
import type { NativeJoiningLoadingScreenProps } from "./NativeJoiningLoadingScreen";
import { ChalkLogoElements } from "./ChalkLogoElements";

export function NativeJoiningLoadingScreenAndroid({ message = "Preparing meeting..." }: NativeJoiningLoadingScreenProps): React.JSX.Element {
  const pulseAnim = useRef(new Animated.Value(1)).current;
  const fadeAnim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    // Subtle Pulse: Organic breathing
    Animated.loop(
      Animated.sequence([
        Animated.timing(pulseAnim, { toValue: 1.1, duration: 2500, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
        Animated.timing(pulseAnim, { toValue: 1, duration: 2500, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
      ])
    ).start();

    Animated.timing(fadeAnim, {
      toValue: 1,
      duration: 800,
      useNativeDriver: true,
    }).start();
  }, [fadeAnim, pulseAnim]);

  return (
    <View style={styles.screen}>
      <Animated.View style={[styles.content, { opacity: fadeAnim }]}>
        <View style={styles.illustrationFrame}>
          <Animated.View 
            style={[
              styles.glow, 
              { 
                transform: [{ scale: pulseAnim }],
                opacity: pulseAnim.interpolate({ inputRange: [1, 1.1], outputRange: [0.12, 0.18] })
              }
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

export { NativeJoiningLoadingScreenAndroid as NativeJoiningLoadingScreen };

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
