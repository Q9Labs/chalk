import { Alert, StyleSheet, View } from "react-native";

import { getIosSimulatorMediaMessage } from "../utils/ios-simulator";
import { ReactionPicker } from "./ReactionPicker";
import type { ConferenceViewProps } from "./ConferenceView";
import { MeetingGridAndroid } from "./native-meeting-room/MeetingGrid.android";
import { MeetingBottomDockAndroid } from "./native-meeting-room/MeetingBottomDock.android";
import { MeetingActionMenu, MeetingPanel, selectReaction } from "./native-meeting-room/MeetingActionMenu";
import { MeetingStageAndroid } from "./native-meeting-room/MeetingStage.android";
import { MeetingTopBarAndroid } from "./native-meeting-room/MeetingTopBar.android";
import { MeetingWhiteboardSurface } from "./native-meeting-room/MeetingWhiteboardSurface";
import { useConferenceViewController } from "./native-meeting-room/useConferenceViewController";

export function ConferenceViewShared(props: ConferenceViewProps): React.JSX.Element {
  const controller = useConferenceViewController(props);
  const toggleMedia = (action: () => void) => {
    if (controller.simulatorMediaDisabled) {
      Alert.alert("Media unavailable", getIosSimulatorMediaMessage());
      return;
    }
    action();
  };

  return (
    <View style={styles.room}>
      <MeetingTopBarAndroid formattedDuration={controller.formattedDuration} participantCount={controller.participantCount} roomName={controller.roomName} />
      <View style={styles.stage}>
        {controller.whiteboard.isOpen ? (
          <MeetingWhiteboardSurface whiteboard={controller.whiteboard} />
        ) : controller.derived.isStageMode ? (
          <MeetingStageAndroid
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
          <MeetingGridAndroid gridPages={controller.derived.gridPages} participants={controller.derived.allParticipants} />
        )}
      </View>
      <MeetingBottomDockAndroid
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
      <MeetingActionMenu controller={controller} />
      <MeetingPanel controller={controller} />
      <ReactionPicker isOpen={controller.reactionPickerOpen} onClose={() => controller.setReactionPickerOpen(false)} onSelect={(reaction) => selectReaction(controller, reaction)} />
    </View>
  );
}

const styles = StyleSheet.create({
  room: { flex: 1, backgroundColor: "#000000" },
  stage: { flex: 1, width: "100%", overflow: "hidden", justifyContent: "center" },
});
