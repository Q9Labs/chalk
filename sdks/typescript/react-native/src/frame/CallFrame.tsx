import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Pressable, StatusBar, StyleSheet, View } from "react-native";
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from "react-native-reanimated";
import { useSpaceClient } from "../context/space-client-context";
import { Dock } from "../dock/Dock";
import { LeaveMenu } from "../dock/LeaveMenu";
import { MoreSheet } from "../dock/MoreSheet";
import { haptics } from "../haptics/haptics";
import { CallDetailsSheet } from "../header/CallDetailsSheet";
import { Header } from "../header/Header";
import { useCan, useConnection, useMedia } from "../hooks/space-hooks";
import { timings } from "../motion/motion";
import { ToastStack, useToasts } from "../primitives/toast/ToastStack";
import { ChatNotices } from "../sheets/people-chat/ChatNotices";
import { PeopleChatSheet } from "../sheets/people-chat/PeopleChatSheet";
import { playSound } from "../sounds/sounds";
import { Stage } from "../stage/Stage";
import { CallOverlays } from "../status/CallOverlays";
import { ArrivalScreen } from "../status/ChalkArrival";
import { callScreen } from "../status/call-screen";
import { useTheme } from "../theme/theme";
import { durations } from "../theme/tokens";
import { useCallEventToasts, type Permission } from "../toasts/CallEventToasts";
import { useDevScenario } from "./dev-scenario";
import { useDeviceLayout } from "./device-layout";
import { PortalHost, usePortalCount } from "./portal";
import { useMeasuredRef } from "./measurement";
import { usePreferences } from "./preferences";
import { frameRegions } from "./regions";

export type CallFrameProps = {
  readonly displayName?: string;
  readonly callName?: string;
  readonly inviteLink?: string;
  readonly onLeave?: () => void;
  readonly onOpenSettings?: (permission: Permission) => void;
  readonly resumedAfterSettings?: Permission;
};

type OpenSheet = "more" | "people" | "chat" | "details" | null;

/**
 * The call's frame: header, stage and dock regions, then the sheets layer, the limbo and status
 * overlays, the menus layer and the toasts layer, each inside the safe area for the current
 * arrangement. Each region lives in its own folder so the part lanes can work in parallel.
 */
export function CallFrame({ displayName, callName = "Call", inviteLink, onLeave, onOpenSettings, resumedAfterSettings }: CallFrameProps): React.JSX.Element {
  const client = useSpaceClient();
  const connection = useConnection();
  const media = useMedia();
  const { colors, scheme } = useTheme();
  const layout = useDeviceLayout();
  const { soundsEnabled } = usePreferences();
  const toasts = useToasts();
  const callEvents = useCallEventToasts({ onOpenSettings, resumedAfterSettings });
  const [leftByChoice, setLeftByChoice] = useState(false);
  const [sheet, setSheet] = useState<OpenSheet>(null);
  const moreRef = useRef<View>(null);
  const leaveRef = useRef<View>(null);
  const nameRef = useRef<View>(null);
  const canEnd = useCan("endEpisode");
  const [leaveMenuOpen, setLeaveMenuOpen] = useState(false);
  const sheetCount = usePortalCount("sheets");
  const menuCount = usePortalCount("menus");
  const layered = sheetCount > 0 || menuCount > 0;
  const regions = useMemo(() => frameRegions(layout.arrangement, layout.width, layout.height, layout.insets), [layout]);
  const screenStyle = [styles.root, { backgroundColor: colors.canvas }];
  const screenRef = useMeasuredRef<View>("frame.screen", screenStyle);

  const join = useCallback(() => {
    // A failed join shows up as `connection.status === "failed"` with `lastError`, which the status page reads.
    setLeftByChoice(false);
    client.join({ displayName, microphone: false, camera: false }).catch(() => undefined);
  }, [client, displayName]);
  useEffect(() => {
    if (client.getSnapshot().connection.status === "idle") join();
  }, [client, join]);

  const microphoneOn = media.local.microphone.state === "enabled";
  const cameraOn = media.local.camera.state === "enabled";
  const { noteOwnMicrophoneChange, reportMediaFailure } = callEvents;
  const toggleMicrophone = useCallback(() => {
    haptics.mute();
    playSound(microphoneOn ? "mute" : "unmute", soundsEnabled);
    if (microphoneOn) noteOwnMicrophoneChange();
    const turnOn = () => client.media.setMicrophoneEnabled(true).catch((cause: unknown) => reportMediaFailure("microphone", cause, turnOn));
    if (microphoneOn) client.media.setMicrophoneEnabled(false).catch(() => toasts.show({ kind: "error", dismissible: true, message: "Couldn’t mute your microphone." }));
    else void turnOn();
  }, [client, microphoneOn, noteOwnMicrophoneChange, reportMediaFailure, soundsEnabled, toasts]);
  const toggleCamera = useCallback(() => {
    const turnOn = () => client.media.setCameraEnabled(true).catch((cause: unknown) => reportMediaFailure("camera", cause, turnOn));
    if (cameraOn) client.media.setCameraEnabled(false).catch(() => toasts.show({ kind: "error", dismissible: true, message: "Couldn’t turn off your camera." }));
    else void turnOn();
  }, [cameraOn, client, reportMediaFailure, toasts]);
  const exit = useCallback(
    (how: "leave" | "end") => {
      setSheet(null);
      setLeaveMenuOpen(false);
      setLeftByChoice(true);
      // The status page (A3, A4) follows; its Home button calls `onLeave`.
      (how === "end" ? client.endEpisode() : client.leave()).catch(() => {
        setLeftByChoice(false);
        toasts.show({ kind: "error", dismissible: true, message: how === "end" ? "Couldn’t end the call." : "Couldn’t leave the call." });
      });
    },
    [client, toasts],
  );
  const pressLeave = useCallback(() => {
    haptics.leave();
    if (canEnd) setLeaveMenuOpen((open) => !open);
    else exit("leave");
  }, [canEnd, exit]);

  const devScenario = useDevScenario();
  useEffect(() => {
    if (devScenario.sheet && devScenario.sheet !== "route") setSheet(devScenario.sheet);
    if (devScenario.menu === "leave") setLeaveMenuOpen(true);
  }, [devScenario]);

  const chrome = useLandscapeChrome(layout.arrangement === "landscape" && sheet === null && !layered);
  const forced = devScenario.callState;
  const screen = forced === "hold" ? { kind: "call" as const } : forced === "left" || forced === "ended" || forced === "failed" || forced === "removed" ? { kind: "status" as const, outcome: forced } : callScreen(connection, leftByChoice);

  return (
    <View ref={screenRef} style={screenStyle} testID="frame.screen">
      <StatusBar barStyle={scheme === "dark" ? "light-content" : "dark-content"} />
      <View accessibilityElementsHidden={layered} importantForAccessibility={layered ? "no-hide-descendants" : "auto"} style={StyleSheet.absoluteFill}>
        <Stage frame={regions.stage} onOpenPeople={() => setSheet("people")} />
        {chrome.hidden ? <Pressable accessibilityLabel="Show call controls" onPress={chrome.show} style={StyleSheet.absoluteFill} testID="frame.show-controls" /> : null}
        <Animated.View pointerEvents={chrome.hidden ? "none" : "box-none"} style={[styles.region, frameStyle(regions.header), chrome.style]}>
          <Header arrangement={layout.arrangement} callName={callName} detailsOpen={sheet === "details"} onOpenDetails={() => setSheet("details")} ref={nameRef} />
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
        {/* Focus goes back to More only once no sheet is open, so switching to People keeps it there. */}
        <MoreSheet inviteLink={inviteLink} onClose={() => setSheet(null)} onOpenChat={() => setSheet("chat")} onOpenPeople={() => setSheet("people")} open={sheet === "more"} returnFocusRef={sheet === null ? moreRef : undefined} />
        <CallDetailsSheet callName={callName} inviteLink={inviteLink} onClose={() => setSheet(null)} open={sheet === "details"} returnFocusRef={nameRef} />
        <PeopleChatSheet onClose={() => setSheet(null)} onTabChange={setSheet} open={sheet === "people" || sheet === "chat"} returnFocusRef={sheet === null ? moreRef : undefined} tab={sheet === "chat" ? "chat" : "people"} />
        <PortalHost layer="sheets" />
      </View>
      <View pointerEvents="box-none" style={StyleSheet.absoluteFill} testID="frame.overlays">
        {forced === "knocking" || forced === "refused" || forced === "full" ? (
          <ArrivalScreen callName={callName} onCancel={() => onLeave?.()} onRetry={join} state={forced} />
        ) : (
          <CallOverlays callName={callName} onHold={forced === "hold"} onHome={() => onLeave?.()} onRejoin={join} rejoining={resumedAfterSettings !== undefined} screen={screen} />
        )}
      </View>
      <View pointerEvents="box-none" style={StyleSheet.absoluteFill} testID="frame.menus">
        <LeaveMenu anchorRef={leaveRef} onClose={() => setLeaveMenuOpen(false)} onEnd={() => exit("end")} onLeave={() => exit("leave")} open={leaveMenuOpen} />
        <PortalHost layer="menus" />
      </View>
      <ToastStack />
      <ChatNotices chatVisible={sheet === "chat"} onOpenChat={() => setSheet("chat")} sheetOpen={sheet === "people" || sheet === "chat"} />
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
