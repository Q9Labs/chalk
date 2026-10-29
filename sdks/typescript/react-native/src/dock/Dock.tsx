import { useConnection, useMedia } from "../hooks/space-hooks";
import { memo, useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { StyleSheet, View } from "react-native";
import { useDevScenario } from "../frame/dev-scenario";
import type { Arrangement } from "../frame/regions";
import { useMeasuredRef } from "../frame/measurement";
import { announce } from "../primitives/announce";
import { IconButton } from "../primitives/IconButton";
import { useToasts } from "../primitives/toast/ToastStack";
import { routeIcons, routeName, useAudioOutput, type AudioOutput } from "./audio-route";
import { RoutePicker } from "./RoutePicker";

export type DockProps = {
  readonly arrangement: Arrangement;
  readonly microphoneOn: boolean;
  readonly cameraOn: boolean;
  readonly onToggleMicrophone: () => void;
  readonly onToggleCamera: () => void;
  readonly onOpenMore: () => void;
  readonly onLeave: () => void;
  readonly moreOpen: boolean;
  /** Set only when Leave opens a menu (hosts), so others hear a plain button. */
  readonly leaveOpen?: boolean;
  readonly moreRef: RefObject<View | null>;
  readonly leaveRef: RefObject<View | null>;
};

/**
 * The call controls (`.dock`): microphone, camera, audio output with its name under it (R1),
 * More and Leave. Spread across the phone in portrait, centred with 14 pt gaps in landscape.
 */
export const Dock = memo(function Dock({ arrangement, microphoneOn, cameraOn, onToggleMicrophone, onToggleCamera, onOpenMore, onLeave, moreOpen, leaveOpen, moreRef, leaveRef }: DockProps) {
  const live = useConnection().status === "live";
  const { local } = useMedia();
  const size = arrangement === "pad" ? 44 : 52;
  const dockStyle = [styles.dock, arrangement === "pad" ? styles.pad : arrangement === "landscape" ? styles.landscape : styles.portrait];
  const dockRef = useMeasuredRef<View>("frame.dock", dockStyle);
  const output = useAudioOutput();
  return (
    <View accessibilityLabel="Call controls" accessibilityRole="toolbar" pointerEvents="box-none" ref={dockRef} style={dockStyle} testID="frame.dock">
      <IconButton
        accessibilityLabel={microphoneOn ? "Mute microphone" : "Unmute microphone"}
        busy={local.microphone.state === "requesting"}
        icon={microphoneOn ? "mic" : "micOff"}
        off={!microphoneOn}
        disabled={!live && !microphoneOn}
        onCanvas
        onPress={onToggleMicrophone}
        size={size}
        testID="dock.microphone"
      />
      <IconButton accessibilityLabel={cameraOn ? "Turn off camera" : "Turn on camera"} busy={local.camera.state === "requesting"} icon={cameraOn ? "cam" : "camOff"} off={!cameraOn} disabled={!live && !cameraOn} onCanvas onPress={onToggleCamera} size={size} testID="dock.camera" />
      {output ? <AudioOutputButton captioned={arrangement === "portrait"} output={output} size={size} /> : null}
      <IconButton accessibilityLabel="More options" expanded={moreOpen} icon="more" onCanvas onPress={onOpenMore} ref={moreRef} size={size} testID="dock.more" />
      {arrangement === "pad" ? <View style={styles.gap} /> : null}
      <IconButton accessibilityLabel="Leave call" expanded={leaveOpen} icon="hang" onPress={onLeave} ref={leaveRef} size={size} testID="dock.leave" tone="danger" />
    </View>
  );
});

/**
 * With only the earpiece and the speaker, a press switches between them. Once a headset is
 * connected there are more than two places to play, so a press opens the choice.
 */
function AudioOutputButton({ output, size, captioned }: { readonly output: AudioOutput; readonly size: 44 | 52; readonly captioned: boolean }): React.JSX.Element {
  const toasts = useToasts();
  const ref = useRef<View>(null);
  const [open, setOpen] = useState(false);
  const devScenario = useDevScenario();
  // ast-grep-ignore: chalk.forbid-sdk-use-effect-tsx -- [development] Apply externally selected route-sheet scenarios after commit without continuously overriding user dismissal.
  useEffect(() => {
    if (devScenario.sheet === "route" || devScenario.menu === "route") setOpen(true);
  }, [devScenario]);

  const name = routeName(output.current);
  const choosing = output.routes.length > 2;
  const other = output.routes.find((route) => route.id !== output.selected);
  const select = useCallback(
    (id: string) => {
      setOpen(false);
      const route = output.routes.find((candidate) => candidate.id === id);
      output
        .select(id)
        .then(() => route && announce(`Audio output: ${routeName(route)}`))
        .catch(() => toasts.show({ kind: "error", dismissible: true, message: "Couldn't switch the audio output." }));
    },
    [output, toasts],
  );
  const press = useCallback(() => {
    if (choosing) setOpen((was) => !was);
    else if (other) select(other.id);
  }, [choosing, other, select]);

  const hint = choosing || !other ? "Choose output" : output.current.kind === "speaker" ? `Switch to ${routeName(other)}` : "Switch to speaker";
  return (
    <>
      <IconButton accessibilityLabel={`Audio output: ${name}. ${hint}`} caption={captioned ? name : undefined} expanded={choosing ? open : undefined} icon={routeIcons[output.current.kind]} onCanvas onPress={press} ref={ref} size={size} testID="dock.route" />
      {choosing ? <RoutePicker anchorRef={ref} onClose={() => setOpen(false)} onSelect={select} open={open} output={output} /> : null}
    </>
  );
}

const styles = StyleSheet.create({
  dock: { flex: 1, flexDirection: "row", alignItems: "center" },
  portrait: { justifyContent: "space-between", paddingHorizontal: 20 },
  landscape: { justifyContent: "center", gap: 14 },
  pad: { justifyContent: "center", gap: 8 },
  gap: { width: 8 },
});
