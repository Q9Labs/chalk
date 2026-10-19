import { AccessibilityInfo, Platform } from "react-native";

/** Speaks a message through VoiceOver or TalkBack, like the mockup's polite live region. Queued on iOS so it doesn't cut off the current utterance. */
export function announce(message: string): void {
  if (Platform.OS === "ios") AccessibilityInfo.announceForAccessibilityWithOptions(message, { queue: true });
  else AccessibilityInfo.announceForAccessibility(message);
}
