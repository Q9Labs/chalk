import type { SpaceSnapshot } from "@q9labsai/chalk-client";
import { useCallback, useMemo } from "react";
import { StyleSheet, View } from "react-native";
import { FaceAvatar } from "../avatar/FaceAvatar";
import { useSpaceClient } from "../context/space-client-context";
import { announce } from "../primitives/announce";
import { BottomSheet } from "../primitives/BottomSheet";
import { ChalkText } from "../primitives/ChalkText";
import { SheetGroup, SheetRow } from "../primitives/SheetGroup";
import { Switch } from "../primitives/Switch";
import { useToasts } from "../primitives/toast/ToastStack";
import { cameraFacing, otherCamera } from "./camera";
import { shallowEqual, useSpaceSelector } from "./space-selector";
import { useStageView } from "./stage-view";

export type TileSheetProps = {
  /** The person whose tile was tapped last; it stays set while the sheet closes, so the rows don't empty mid-slide. */
  readonly participantId: string | null;
  readonly open: boolean;
  readonly onClose: () => void;
};

type SheetModel = {
  readonly name: string;
  readonly isSelf: boolean;
  readonly cameraOn: boolean;
  readonly back: boolean;
  readonly otherCamera: string | null;
  readonly muted: boolean;
  readonly canMute: boolean;
  readonly canRemove: boolean;
};

const closed: SheetModel = { name: "", isSelf: false, cameraOn: false, back: false, otherCamera: null, muted: false, canMute: false, canRemove: false };

/**
 * The phone's tile sheet (`#tsheet` with `tileSheetHTML`): pin, your camera and mirror, and the
 * host's mute and remove for someone else. Board following waits for board editing.
 */
export function TileSheet({ participantId, open, onClose }: TileSheetProps): React.JSX.Element {
  const client = useSpaceClient();
  const toasts = useToasts();
  const view = useStageView();
  const select = useMemo(
    () =>
      (snapshot: SpaceSnapshot): SheetModel => {
        if (participantId === null) return closed;
        const person = snapshot.participants.roster.find((participant) => participant.participantId === participantId);
        const isSelf = snapshot.self.participantId === participantId;
        return {
          name: person?.displayName ?? snapshot.self.displayName ?? "",
          isSelf,
          cameraOn: isSelf && snapshot.media.local.camera.state === "enabled",
          back: cameraFacing(snapshot.media) === "back",
          otherCamera: otherCamera(snapshot.media)?.deviceId ?? null,
          muted: person?.media.microphone !== "active",
          canMute: !isSelf && snapshot.self.can("muteOthers"),
          canRemove: !isSelf && snapshot.self.can("removeParticipant"),
        };
      },
    [participantId],
  );
  const person = useSpaceSelector(select, shallowEqual);
  const id = participantId ?? "";
  const failed = useCallback((message: string) => () => toasts.show({ kind: "error", dismissible: true, message }), [toasts]);
  const run = (action: () => void) => () => {
    onClose();
    action();
  };

  return (
    <BottomSheet accessibilityLabel={`${person.name}${person.isSelf ? " (You)" : ""}`} onClose={onClose} open={open && participantId !== null} testID="sheet.tile">
      <View style={styles.header}>
        <FaceAvatar name={person.name} size={32} />
        <ChalkText numberOfLines={1} style={styles.name} variant="sheetTitle">
          {`${person.name}${person.isSelf ? " (You)" : ""}`}
        </ChalkText>
      </View>
      <SheetGroup>
        <SheetRow icon="pin" label={view.pinned === participantId ? "Unpin" : "Pin"} onPress={run(() => view.togglePin(id))} testID="tile-sheet.pin" />
        {person.cameraOn && person.otherCamera !== null ? (
          <SheetRow
            icon="flip"
            label={`Switch to the ${person.back ? "front" : "back"} camera`}
            onPress={run(() => {
              if (person.otherCamera) client.media.selectCamera(person.otherCamera).then(() => announce(`Switched to the ${person.back ? "front" : "back"} camera`), failed("Couldn't switch the camera."));
            })}
            testID="tile-sheet.flip"
          />
        ) : null}
        {person.cameraOn && !person.back ? <SheetRow end={<Switch accessibilityLabel="Mirror my video" onValueChange={view.setMirror} testID="tile-sheet.mirror" value={view.mirror} />} icon="swap" label="Mirror my video" /> : null}
        {person.canMute && !person.muted ? <SheetRow icon="micOff" label="Mute" onPress={run(() => client.participants.mute(id).catch(failed(`Couldn't mute ${person.name}.`)))} testID="tile-sheet.mute" /> : null}
        {person.canRemove ? (
          <SheetRow
            danger
            icon="x"
            label="Remove from call"
            onPress={run(() =>
              client.participants
                .remove(id)
                .then(() => announce(`${person.name} was removed`))
                .catch(failed(`Couldn't remove ${person.name}.`)),
            )}
            testID="tile-sheet.remove"
          />
        ) : null}
      </SheetGroup>
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  // `.shd`: the person's face and name over the rows.
  header: { flexDirection: "row", alignItems: "center", gap: 12, paddingTop: 4, paddingHorizontal: 8, paddingBottom: 14 },
  name: { flexShrink: 1 },
});
