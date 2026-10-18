import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Pressable, StatusBar, StyleSheet, View } from "react-native";
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from "react-native-reanimated";
import { useSpaceClient } from "../context/space-client-context";
import { Dock } from "../dock/Dock";
import { LeaveMenu } from "../dock/LeaveMenu";
import { MoreSheet } from "../dock/MoreSheet";
import { haptics } from "../haptics/haptics";
import { Header } from "../header/Header";
import { useCan, useConnection, useMedia } from "../hooks/space-hooks";
import { Limbo } from "../limbo/Limbo";
import { timings } from "../motion/motion";
import { ToastStack, useToasts } from "../primitives/toast/ToastStack";
import { PeopleSheet } from "../sheets/people-chat/PeopleSheet";
import { playSound } from "../sounds/sounds";
import { Stage } from "../stage/Stage";
import { StatusPage } from "../status/StatusPage";
import { useTheme } from "../theme/theme";
import { durations } from "../theme/tokens";
import { CallEventToasts } from "../toasts/CallEventToasts";
import { useDeviceLayout } from "./device-layout";
import { PortalHost, usePortalEntries } from "./portal";
import { useMeasuredRef } from "./measurement";
import { usePreferences } from "./preferences";
import { frameRegions } from "./regions";

export type CallFrameProps = {
  readonly displayName?: string;
  readonly callName?: string;
  readonly onLeave?: () => void;
};

type OpenSheet = "more" | "people" | null;

/**
 * The call's frame: header, stage and dock regions, then the sheets layer, the limbo and status
 * overlays, the menus layer and the toasts layer, each inside the safe area for the current
 * arrangement. Each region lives in its own folder so the part lanes can work in parallel.
 */
export function CallFrame({ displayName, callName = "Call", onLeave }: CallFrameProps): React.JSX.Element {
  const client = useSpaceClient();
  const connection = useConnection();
  const media = useMedia();
  const { colors, scheme } = useTheme();
  const layout = useDeviceLayout();
  const { soundsEnabled } = usePreferences();
  const toasts = useToasts();
  const [sheet, setSheet] = useState<OpenSheet>(null);
  const moreRef = useRef<View>(null);
  const leaveRef = useRef<View>(null);
  const canEnd = useCan("endEpisode");
  const [leaveMenuOpen, setLeaveMenuOpen] = useState(false);
  const sheetEntries = usePortalEntries("sheets");
  const menuEntries = usePortalEntries("menus");
  const layered = sheetEntries.length > 0 || menuEntries.length > 0;
  const regions = useMemo(() => frameRegions(layout.arrangement, layout.width, layout.height, layout.insets), [layout]);
  const screenStyle = [styles.root, { backgroundColor: colors.canvas }];
  const screenRef = useMeasuredRef<View>("frame.screen", screenStyle);

  const join = useCallback(() => {
    // A failed join shows up as `connection.status === "failed"` with `lastError`, which the status page reads.
    client.join({ displayName, microphone: false, camera: false }).catch(() => undefined);
  }, [client, displayName]);
  useEffect(() => {
    if (client.getSnapshot().connection.status === "idle") join();
  }, [client, join]);

  const microphoneOn = media.local.microphone.state === "enabled";
  const cameraOn = media.local.camera.state === "enabled";
  const reportMediaFailure = useCallback(
    (what: string) => (cause: unknown) => {
      toasts.show({ kind: "error", dismissible: true, message: cause instanceof Error ? `Couldn't change your ${what}. ${cause.message}` : `Couldn't change your ${what}.` });
    },
    [toasts],
  );
  const toggleMicrophone = useCallback(() => {
    haptics.mute();
    playSound(microphoneOn ? "mute" : "unmute", soundsEnabled);
    client.media.setMicrophoneEnabled(!microphoneOn).catch(reportMediaFailure("microphone"));
  }, [client, microphoneOn, reportMediaFailure, soundsEnabled]);
  const toggleCamera = useCallback(() => {
    client.media.setCameraEnabled(!cameraOn).catch(reportMediaFailure("camera"));
  }, [cameraOn, client, reportMediaFailure]);
  const exit = useCallback(
    (how: "leave" | "end") => {
      setSheet(null);
      setLeaveMenuOpen(false);
      (how === "end" ? client.endEpisode() : client.leave()).then(() => onLeave?.()).catch(() => toasts.show({ kind: "error", dismissible: true, message: how === "end" ? "Couldn't end the call." : "Couldn't leave the call." }));
    },
    [client, onLeave, toasts],
  );
  const pressLeave = useCallback(() => {
    haptics.leave();
    if (canEnd) setLeaveMenuOpen((open) => !open);
    else exit("leave");
  }, [canEnd, exit]);

  const chrome = useLandscapeChrome(layout.arrangement === "landscape" && sheet === null && !layered);
  const status = connection.status;

  return (
    <View ref={screenRef} style={screenStyle} testID="frame.screen">
      <StatusBar barStyle={scheme === "dark" ? "light-content" : "dark-content"} />
      <View accessibilityElementsHidden={layered} importantForAccessibility={layered ? "no-hide-descendants" : "auto"} style={StyleSheet.absoluteFill}>
        <Stage frame={regions.stage} />
        {chrome.hidden ? <Pressable accessibilityLabel="Show call controls" onPress={chrome.show} style={StyleSheet.absoluteFill} testID="frame.show-controls" /> : null}
        <Animated.View pointerEvents={chrome.hidden ? "none" : "box-none"} style={[styles.region, frameStyle(regions.header), chrome.style]}>
          <Header arrangement={layout.arrangement} callName={callName} onOpenDetails={() => setSheet("more")} />
        </Animated.View>
        <Animated.View pointerEvents={chrome.hidden ? "none" : "box-none"} style={[styles.region, frameStyle(regions.dock), chrome.style]}>
          <Dock
            arrangement={layout.arrangement}
            cameraOn={cameraOn}
            microphoneOn={microphoneOn}
            leaveOpen={canEnd ? leaveMenuOpen : undefined}
            leaveRef={leaveRef}
            moreOpen={sheet === "more"}
            moreRef={moreRef}
            onLeave={pressLeave}
            onOpenMore={() => setSheet("more")}
            onToggleCamera={toggleCamera}
            onToggleMicrophone={toggleMicrophone}
          />
        </Animated.View>
      </View>
      <View pointerEvents="box-none" style={StyleSheet.absoluteFill} testID="frame.sheets">
        <MoreSheet onClose={() => setSheet(null)} onOpenPeople={() => setSheet("people")} open={sheet === "more"} returnFocusRef={moreRef} />
        <PeopleSheet onClose={() => setSheet(null)} open={sheet === "people"} />
        <PortalHost layer="sheets" />
      </View>
      <View pointerEvents="box-none" style={StyleSheet.absoluteFill} testID="frame.overlays">
        {status === "joining" || status === "idle" ? <Limbo message="Joining" /> : null}
        {status === "reconnecting" ? <Limbo message="Reconnecting" /> : null}
        {status === "left" ? <StatusPage action={{ label: "Rejoin", onPress: join }} title="You left the call" /> : null}
        {status === "failed" ? <StatusPage action={{ label: "Try again", onPress: join }} detail={connection.lastError?.message} title="Couldn't join the call" /> : null}
      </View>
      <View pointerEvents="box-none" style={StyleSheet.absoluteFill} testID="frame.menus">
        <LeaveMenu anchorRef={leaveRef} onClose={() => setLeaveMenuOpen(false)} onEnd={() => exit("end")} onLeave={() => exit("leave")} open={leaveMenuOpen} />
        <PortalHost layer="menus" />
      </View>
      <ToastStack />
      <CallEventToasts />
    </View>
  );
}

/** Phone landscape (L1): the controls fade after 4 s and come back on a tap. */
function useLandscapeChrome(fades: boolean): { readonly hidden: boolean; readonly show: () => void; readonly style: ReturnType<typeof useAnimatedStyle> } {
  const [hidden, setHidden] = useState(false);
  const [shownAt, setShownAt] = useState(0);
  const opacity = useSharedValue(1);
  useEffect(() => {
    opacity.value = withTiming(hidden ? 0 : 1, timings.fade);
  }, [hidden, opacity]);
  useEffect(() => {
    if (!fades) {
      setHidden(false);
      return;
    }
    const timer = setTimeout(() => setHidden(true), durations.landscapeHide);
    return () => clearTimeout(timer);
  }, [fades, shownAt]);
  const show = useCallback(() => {
    setHidden(false);
    setShownAt(Date.now());
  }, []);
  const style = useAnimatedStyle(() => {
    "worklet";
    return { opacity: opacity.value };
  });
  return { hidden, show, style };
}

function frameStyle(frame: { readonly x: number; readonly y: number; readonly width: number; readonly height: number }) {
  return { left: frame.x, top: frame.y, width: frame.width, height: frame.height };
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  region: { position: "absolute" },
});
