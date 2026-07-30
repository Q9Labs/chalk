import { Alert, StyleSheet, View } from "react-native";

import { getIosSimulatorMediaMessage } from "../utils/ios-simulator";
import { NativeReactionPicker } from "./NativeReactionPicker";
import type { NativeMeetingRoomProps } from "./NativeMeetingRoom";
import { NativeMeetingGridAndroid } from "./native-meeting-room/NativeMeetingGrid.android";
import { NativeMeetingBottomDockAndroid } from "./native-meeting-room/NativeMeetingBottomDock.android";
import { NativeMeetingActionMenu, NativeMeetingPanel, selectReaction } from "./native-meeting-room/NativeMeetingOverlays";
import { NativeMeetingStageAndroid } from "./native-meeting-room/NativeMeetingStage.android";
import { NativeMeetingTopBarAndroid } from "./native-meeting-room/NativeMeetingTopBar.android";
import { NativeMeetingWhiteboardSurface } from "./native-meeting-room/NativeMeetingWhiteboardSurface";
import { useNativeMeetingRoomController } from "./native-meeting-room/useNativeMeetingRoomController";

export function NativeMeetingRoomShared(props: NativeMeetingRoomProps): React.JSX.Element {
  const controller = useNativeMeetingRoomController(props);
  const toggleMedia = (action: () => void) => {
    if (controller.simulatorMediaDisabled) {
      Alert.alert("Media unavailable", getIosSimulatorMediaMessage());
      return;
    }
    action();
  };

  return (
    <View style={styles.room}>
      <NativeMeetingTopBarAndroid formattedDuration={controller.formattedDuration} participantCount={controller.participantCount} roomName={controller.roomName} />
      <View style={styles.stage}>
        {controller.whiteboard.isOpen ? (
          <NativeMeetingWhiteboardSurface whiteboard={controller.whiteboard} />
        ) : controller.derived.isStageMode ? (
          <NativeMeetingStageAndroid
            activeReactions={controller.activeReactions}
            handRaised={controller.handRaised}
            isCompactViewport={controller.derived.isCompactViewport}
            isHost={controller.isHost}
            isMuted={controller.isMuted}
            layoutMode={controller.layout.layout}
            primaryContent={controller.derived.primaryContent}
            raisedHandCount={controller.raisedHandCount}
            screenShareTrack={controller.derived.screenShareTrack}
            screenSharer={controller.derived.screenSharer}
            selfName={controller.selfName}
            stripParticipants={controller.derived.allParticipants}
            whiteboard={{
              isOpen: controller.whiteboard.isOpen,
              canDraw: controller.whiteboard.canDraw,
              elementCount: controller.whiteboard.elements.length,
              participantCount: controller.whiteboard.openParticipants.length,
            }}
          />
        ) : (
          <NativeMeetingGridAndroid gridPages={controller.derived.gridPages} participants={controller.derived.allParticipants} />
        )}
      </View>
      <NativeMeetingBottomDockAndroid
        isCameraOff={controller.isCameraOff}
        isMuted={controller.isMuted}
        onLeave={controller.handleLeave}
        onOpenChat={controller.canChat ? () => controller.openPanel("chat") : undefined}
        onOpenMore={() => controller.setActionsOpen(true)}
        onToggleAudio={() => toggleMedia(controller.toggleAudio)}
        onToggleVideo={() => toggleMedia(controller.toggleVideo)}
        simulatorMediaDisabled={controller.simulatorMediaDisabled}
        unreadChatCount={controller.chat.unreadCount}
      />
      <NativeMeetingActionMenu controller={controller} />
      <NativeMeetingPanel controller={controller} />
      <NativeReactionPicker isOpen={controller.reactionPickerOpen} onClose={() => controller.setReactionPickerOpen(false)} onSelect={(reaction) => selectReaction(controller, reaction)} />
    </View>
  );
}

const styles = StyleSheet.create({
  room: { flex: 1, backgroundColor: "#000000" },
  stage: { flex: 1, width: "100%", overflow: "hidden", justifyContent: "center" },
});
