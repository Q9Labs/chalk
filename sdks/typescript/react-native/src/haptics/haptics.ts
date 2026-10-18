import { impactAsync, ImpactFeedbackStyle, NotificationFeedbackType, notificationAsync, selectionAsync } from "expo-haptics";

/**
 * The call's haptic moments, and only these. The mockup marks mute, hand raise and leave;
 * a sheet ticks when a drag crosses the point where letting go closes it.
 */
export const haptics = {
  mute: () => fire(impactAsync(ImpactFeedbackStyle.Light)),
  handRaise: () => fire(impactAsync(ImpactFeedbackStyle.Medium)),
  leave: () => fire(notificationAsync(NotificationFeedbackType.Warning)),
  sheetDetent: () => fire(selectionAsync()),
} as const;

export type HapticMoment = keyof typeof haptics;

// A device without a haptic engine rejects; the moment simply passes without feedback.
function fire(feedback: Promise<void>): void {
  feedback.catch(() => undefined);
}
