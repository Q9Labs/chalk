import { withTiming, type EntryExitAnimationFunction } from "react-native-reanimated";
import { timings } from "./motion";

/** A new tile fades in from 97 % scale over 220 ms. Pass as `entering` on an Animated.View. */
export const tileEntering: EntryExitAnimationFunction = () => {
  "worklet";
  return {
    initialValues: { opacity: 0, transform: [{ scale: 0.97 }] },
    animations: { opacity: withTiming(1, timings.enter), transform: [{ scale: withTiming(1, timings.enter) }] },
  };
};

/** A leaving tile fades out over 160 ms. Pass as `exiting` on an Animated.View. */
export const tileLeaving: EntryExitAnimationFunction = () => {
  "worklet";
  return {
    initialValues: { opacity: 1 },
    animations: { opacity: withTiming(0, timings.leave) },
  };
};
