import type { ActiveReaction } from "@q9labsai/chalk-client";
import { memo, useEffect } from "react";
import { StyleSheet, Text, View } from "react-native";
import Animated, { useAnimatedStyle, useReducedMotion, useSharedValue, withTiming } from "react-native-reanimated";
import { useReactions } from "../hooks/space-hooks";
import { easings } from "../theme/tokens";

/** The mockup's `@keyframes rx`: 2 s ease-out, fading in over the first 15 % while rising 82 pt. */
const DURATION = 2000;
const FADE_IN = 0.15;

/**
 * Reactions a person sends (F12), floating up from the lower middle of their tile. Mount it inside
 * the tile; it draws nothing while that person has no reaction showing.
 */
export const ReactionBurst = memo(function ReactionBurst({ participantId }: { readonly participantId: string }): React.JSX.Element | null {
  const active = useReactions().active.filter((reaction) => reaction.participantId === participantId);
  if (active.length === 0) return null;
  return (
    <View pointerEvents="none" style={styles.layer}>
      {active.map((reaction) => (
        <FloatingEmoji key={reaction.eventId} reaction={reaction} />
      ))}
    </View>
  );
});

function FloatingEmoji({ reaction }: { readonly reaction: ActiveReaction }): React.JSX.Element {
  const reduceMotion = useReducedMotion();
  const progress = useSharedValue(0);
  // nosemgrep: chalk.forbid-sdk-use-effect -- Keep existing cancellable native reaction animation.
  useEffect(() => {
    progress.value = withTiming(1, { duration: DURATION, easing: easings.easeOut });
  }, [progress]);
  const style = useAnimatedStyle(() => {
    "worklet";
    const t = progress.value;
    const opacity = t < FADE_IN ? t / FADE_IN : 1 - (t - FADE_IN) / (1 - FADE_IN);
    // Reduced motion keeps the fade (`@keyframes rxf`) and drops the rise.
    return { opacity, transform: [{ translateY: reduceMotion ? 0 : 12 - 82 * t }] };
  });
  return (
    <Animated.View style={[styles.emoji, style]}>
      <Text allowFontScaling={false} style={styles.text}>
        {reaction.reaction}
      </Text>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  layer: { ...StyleSheet.absoluteFillObject, zIndex: 6 },
  // `.rx`: centred, its bottom 28 % up the tile.
  emoji: { position: "absolute", left: 0, right: 0, bottom: "28%", alignItems: "center" },
  text: { fontSize: 44 },
});
