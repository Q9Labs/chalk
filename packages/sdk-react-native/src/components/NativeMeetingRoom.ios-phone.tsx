import { Alert, StyleSheet, View } from "react-native";
import { getIosSimulatorMediaMessage } from "../utils/ios-simulator";
import { NativeMeetingActionsSheet } from "./NativeMeetingActionsSheet";
import { NativeMeetingPanel } from "./NativeMeetingPanel";
import { NativeReactionPicker } from "./NativeReactionPicker";
import type { NativeMeetingRoomProps } from "./NativeMeetingRoom";
import { NativeMeetingGrid } from "./native-meeting-room/NativeMeetingGrid";
import { NativeMeetingBottomDock } from "./native-meeting-room/NativeMeetingBottomDock";
import { NativeMeetingStage } from "./native-meeting-room/NativeMeetingStage";
import { NativeMeetingTopBar } from "./native-meeting-room/NativeMeetingTopBar";
import { useNativeMeetingRoomController } from "./native-meeting-room/useNativeMeetingRoomController";

export function NativeMeetingRoomIosPhone(props: NativeMeetingRoomProps): React.JSX.Element {
  const controller = useNativeMeetingRoomController(props);

  return (
    <View style={styles.roomScreen}>
      <NativeMeetingTopBar formattedDuration={controller.formattedDuration} participantCount={controller.participantCount} roomName={controller.roomName} />

      <View style={styles.stageFrame}>
        {controller.derived.isStageMode ? (
          <NativeMeetingStage
            activeReactions={controller.activeReactions}
            handRaised={controller.handRaised}
            isCompactViewport={controller.derived.isCompactViewport}
            isHost={controller.isHost}
            isMuted={controller.isMuted}
            isRecording={controller.recording.isRecording}
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
          <NativeMeetingGrid gridPages={controller.derived.gridPages} participants={controller.derived.allParticipants} />
        )}
      </View>

      <NativeMeetingBottomDock
        isCameraOff={controller.isCameraOff}
        isMuted={controller.isMuted}
        simulatorMediaDisabled={controller.simulatorMediaDisabled}
        unreadChatCount={controller.chat.unreadCount}
        onLeave={controller.handleLeave}
        onOpenChat={() => controller.openPanel("chat")}
        onOpenMore={() => controller.setActionsOpen(true)}
        onToggleAudio={() => {
          if (controller.simulatorMediaDisabled) {
            Alert.alert("Media unavailable", getIosSimulatorMediaMessage());
            return;
          }
          controller.toggleAudio();
        }}
        onToggleVideo={() => {
          if (controller.simulatorMediaDisabled) {
            Alert.alert("Media unavailable", getIosSimulatorMediaMessage());
            return;
          }
          controller.toggleVideo();
        }}
      />

      <NativeMeetingActionsSheet
        chatEnabled={controller.canChat}
        chatUnreadCount={controller.chat.unreadCount}
        isHandRaised={controller.handRaised}
        isScreenSharing={controller.screenShare.isLocalSharing}
        onClose={() => controller.setActionsOpen(false)}
        onInviteParticipants={controller.handleInviteParticipants}
        onLeaveMeeting={() => {
          controller.setActionsOpen(false);
          controller.handleLeave();
        }}
        onOpenChat={() => controller.openPanel("chat")}
        onOpenParticipants={() => controller.openPanel("participants")}
        onOpenReactions={() => {
          controller.setActionsOpen(false);
          controller.setReactionPickerOpen(true);
        }}
        onOpenSettings={() => controller.openPanel("settings")}
        onOpenTranscripts={() => controller.openPanel("transcripts")}
        onOpenWhiteboard={() => controller.openPanel("whiteboard")}
        onToggleHand={() => {
          controller.setActionsOpen(false);
          controller.toggleHand();
        }}
        onToggleScreenShare={controller.toggleScreenShare}
        participantCount={controller.participantCount}
        peopleEnabled={controller.canParticipants}
        raisedHandCount={controller.raisedHandCount}
        settingsEnabled={controller.canSettings}
        screenShareEnabled={controller.canScreenShare}
        transcriptsEnabled={controller.canTranscripts}
        visible={controller.actionsOpen}
        whiteboardEnabled={controller.canWhiteboard}
      />

      <NativeReactionPicker isOpen={controller.reactionPickerOpen} onClose={() => controller.setReactionPickerOpen(false)} onSelect={controller.sendReaction} />

      <NativeMeetingPanel
        cameras={controller.devices.cameras}
        chatDraft={controller.chatDraft}
        isHost={controller.isHost}
        isRefreshingDevices={controller.devices.isLoading}
        localParticipantId={controller.participants.localParticipant?.id ?? null}
        messages={controller.chat.messages}
        microphones={controller.devices.microphones}
        onChatDraftChange={controller.setChatDraft}
        onClearWhiteboard={controller.whiteboard.clear}
        onClose={controller.closePanel}
        onMuteParticipant={controller.muteParticipant}
        onRefreshDevices={controller.refreshDevices}
        onRemoveParticipant={controller.removeParticipant}
        onRequestWhiteboardSync={controller.whiteboard.requestSync}
        onSelectCamera={controller.selectCamera}
        onSelectMicrophone={controller.selectMicrophone}
        onSelectSpeaker={controller.selectSpeaker}
        onSendMessage={controller.sendChatMessage}
        onToggleWhiteboard={controller.whiteboard.toggle}
        onUnmuteParticipant={controller.unmuteParticipant}
        panel={controller.panel}
        participants={controller.participants.participants}
        selectedCamera={controller.devices.selectedCamera}
        selectedMicrophone={controller.devices.selectedMicrophone}
        selectedSpeaker={controller.devices.selectedSpeaker}
        speakers={controller.devices.speakers}
        transcripts={controller.transcripts.transcripts}
        whiteboardCanDraw={controller.whiteboard.canDraw}
        whiteboardElementCount={controller.whiteboard.elements.length}
        whiteboardOpen={controller.whiteboard.isOpen}
        whiteboardParticipantCount={controller.whiteboard.openParticipants.length}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  roomScreen: {
    flex: 1,
    backgroundColor: "#000000",
    paddingHorizontal: 0,
  },
  stageFrame: {
    flex: 1,
    backgroundColor: "#000000",
    width: "100%",
    borderRadius: 24,
    overflow: "hidden",
    justifyContent: "center",
  },
});
