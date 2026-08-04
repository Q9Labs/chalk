import { useRef } from "react";
import { Animated, StyleSheet, Text, View } from "react-native";
import { Theme } from "../ui/theme";
import type { JoiningScreenProps } from "./JoiningScreen";
import { ChalkLogoElements } from "./ChalkLogoElements";
import { createNativeJoiningLoadingAnimation, type NativeJoiningLoadingAnimation } from "./native-joining-loading-animation";
import { useJoiningScreenMessage } from "./joining-screen-message";

export function JoiningScreenAndroid({ displayName, message = "Preparing Space…", supportingMessages }: JoiningScreenProps): React.JSX.Element {
  const animationRef = useRef<NativeJoiningLoadingAnimation | null>(null);
  const animation = animationRef.current ?? (animationRef.current = createNativeJoiningLoadingAnimation());
  const activeMessage = useJoiningScreenMessage(message, supportingMessages);

  return (
    <View style={styles.screen}>
      <Animated.View accessible accessibilityLabel={displayName ? `${activeMessage} for ${displayName}` : activeMessage} accessibilityLiveRegion="polite" accessibilityRole="progressbar" ref={animation.ref} style={[styles.content, { opacity: animation.fadeAnim }]}>
        <Animated.View style={[styles.illustrationFrame, { transform: [{ scale: animation.pulseAnim }] }]}>
          <ChalkLogoElements size={100} />
        </Animated.View>
        <Text style={styles.brand}>chalk</Text>
        <Text accessibilityLiveRegion="polite" style={styles.label}>
          {activeMessage}
        </Text>
      </Animated.View>
    </View>
  );
}

export { JoiningScreenAndroid as JoiningScreen };

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
    borderRadius: Theme.radius.lg,
    backgroundColor: Theme.colors.surface,
    alignItems: "center",
    justifyContent: "center",
    position: "relative",
    marginBottom: 8,
    borderWidth: 1,
    borderColor: Theme.colors.border,
    ...Theme.shadows.sm,
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
