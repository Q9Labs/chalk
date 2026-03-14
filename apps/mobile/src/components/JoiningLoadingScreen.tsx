import { useEffect, useMemo, useRef, useState } from "react";
import { Animated, Easing, StyleSheet, Text, View } from "react-native";
import { Theme } from "../lib/theme";

export interface JoiningLoadingScreenProps {
  message?: string;
  displayName?: string;
  supportingMessages?: readonly string[];
}

const EMPTY_SUPPORTING_MESSAGES: readonly string[] = [];

function hashString(value: string): number {
  let hash = 0;

  for (let index = 0; index < value.length; index += 1) {
    hash = (hash << 5) - hash + value.charCodeAt(index);
    hash |= 0;
  }

  return Math.abs(hash);
}

function colorForDisplayName(displayName: string): string {
  const palette = ["#1bb6a6", "#22c55e", "#06b6d4", "#3b82f6", "#f59e0b", "#d946ef"];
  return palette[hashString(displayName) % palette.length] ?? Theme.colors.primary;
}

export function JoiningLoadingScreen({
  message = "Joining room...",
  displayName = "Chalk User",
  supportingMessages = EMPTY_SUPPORTING_MESSAGES,
}: JoiningLoadingScreenProps): React.JSX.Element {
  const messages = useMemo(() => [message, ...supportingMessages], [message, supportingMessages]);
  const [messageIndex, setMessageIndex] = useState(0);
  const auraScale = useRef(new Animated.Value(0.92)).current;
  const auraOpacity = useRef(new Animated.Value(0.28)).current;
  const contentOpacity = useRef(new Animated.Value(0)).current;
  const contentScale = useRef(new Animated.Value(0.95)).current;
  const dot1 = useRef(new Animated.Value(0)).current;
  const dot2 = useRef(new Animated.Value(0)).current;
  const dot3 = useRef(new Animated.Value(0)).current;
  const primaryColor = useMemo(() => colorForDisplayName(displayName), [displayName]);

  useEffect(() => {
    setMessageIndex(0);
  }, [messages]);

  useEffect(() => {
    if (messages.length <= 1) {
      return;
    }

    const interval = setInterval(() => {
      setMessageIndex((current) => (current + 1) % messages.length);
    }, 1800);

    return () => {
      clearInterval(interval);
    };
  }, [messages]);

  useEffect(() => {
    Animated.parallel([
      Animated.timing(contentOpacity, {
        toValue: 1,
        duration: 900,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }),
      Animated.timing(contentScale, {
        toValue: 1,
        duration: 900,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }),
      Animated.loop(
        Animated.sequence([
          Animated.parallel([
            Animated.timing(auraScale, {
              toValue: 1.06,
              duration: 4000,
              easing: Easing.inOut(Easing.ease),
              useNativeDriver: true,
            }),
            Animated.timing(auraOpacity, {
              toValue: 0.4,
              duration: 4000,
              easing: Easing.inOut(Easing.ease),
              useNativeDriver: true,
            }),
          ]),
          Animated.parallel([
            Animated.timing(auraScale, {
              toValue: 0.92,
              duration: 4000,
              easing: Easing.inOut(Easing.ease),
              useNativeDriver: true,
            }),
            Animated.timing(auraOpacity, {
              toValue: 0.24,
              duration: 4000,
              easing: Easing.inOut(Easing.ease),
              useNativeDriver: true,
            }),
          ]),
        ]),
      ),
      Animated.loop(createDotAnimation(dot1, 0)),
      Animated.loop(createDotAnimation(dot2, 150)),
      Animated.loop(createDotAnimation(dot3, 300)),
    ]).start();
  }, [auraOpacity, auraScale, contentOpacity, contentScale, dot1, dot2, dot3]);

  const activeMessage = messages[messageIndex] ?? message;

  return (
    <View style={styles.screen}>
      <Animated.View
        style={[
          styles.aura,
          {
            backgroundColor: primaryColor,
            opacity: auraOpacity,
            transform: [{ scale: auraScale }],
          },
        ]}
      />
      <View
        style={[
          styles.backgroundGlow,
          {
            backgroundColor: primaryColor,
          },
        ]}
      />

      <Animated.View
        style={[
          styles.content,
          {
            opacity: contentOpacity,
            transform: [{ scale: contentScale }],
          },
        ]}
      >
        <View style={styles.messageBlock}>
          <Text style={styles.message}>{activeMessage}</Text>
          <View style={styles.dotsRow}>
            <Animated.View style={[styles.dot, getDotStyle(dot1)]} />
            <Animated.View style={[styles.dot, getDotStyle(dot2)]} />
            <Animated.View style={[styles.dot, getDotStyle(dot3)]} />
          </View>
        </View>
      </Animated.View>
    </View>
  );
}

function createDotAnimation(value: Animated.Value, delayMs: number): Animated.CompositeAnimation {
  return Animated.sequence([
    Animated.delay(delayMs),
    Animated.timing(value, {
      toValue: -8,
      duration: 320,
      easing: Easing.out(Easing.quad),
      useNativeDriver: true,
    }),
    Animated.timing(value, {
      toValue: 0,
      duration: 320,
      easing: Easing.in(Easing.quad),
      useNativeDriver: true,
    }),
    Animated.delay(Math.max(0, 900 - delayMs)),
  ]);
}

function getDotStyle(value: Animated.Value) {
  return {
    transform: [{ translateY: value }],
  };
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: Theme.colors.background,
    overflow: "hidden",
  },
  aura: {
    position: "absolute",
    width: 560,
    height: 560,
    borderRadius: 280,
    opacity: 0.3,
  },
  backgroundGlow: {
    position: "absolute",
    width: "100%",
    height: "100%",
    opacity: 0.08,
  },
  content: {
    alignItems: "center",
    gap: 32,
    paddingHorizontal: 24,
  },
  messageBlock: {
    alignItems: "center",
    gap: 18,
  },
  message: {
    color: Theme.colors.foreground,
    fontSize: 34,
    fontWeight: "800",
    textAlign: "center",
    letterSpacing: -0.7,
  },
  dotsRow: {
    flexDirection: "row",
    gap: 10,
    marginTop: 2,
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: 999,
    backgroundColor: "rgba(251, 255, 255, 0.4)",
  },
});
