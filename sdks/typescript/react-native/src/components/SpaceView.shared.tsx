import { Alert, StyleSheet, Text, View } from "react-native";

import { Theme } from "../ui/theme";
import { useNativeTheme } from "../ui/native-theme";
import { getIosSimulatorMediaMessage } from "../utils/ios-simulator";
import { ReactionPicker } from "./ReactionPicker";
import type { SpaceViewProps } from "./SpaceView";
import { SpaceGridAndroid } from "./native-space-view/SpaceGrid.android";
import { SpaceBottomDockAndroid } from "./native-space-view/SpaceBottomDock.android";
import { SpaceActionMenu, SpacePanel, selectSpaceReaction } from "./native-space-view/SpaceActionMenu";
import { SpaceStageAndroid } from "./native-space-view/SpaceStage.android";
import { SpaceTopBarAndroid } from "./native-space-view/SpaceTopBar.android";
import { SpaceWhiteboardSurface } from "./native-space-view/SpaceWhiteboardSurface";
import { useSpaceViewController } from "./native-space-view/useSpaceViewController";

export function SpaceViewShared(props: SpaceViewProps): React.JSX.Element {
  const controller = useSpaceViewController(props);
  const theme = useNativeTheme();
  const toggleMedia = (action: () => void) => {
    if (controller.simulatorMediaDisabled) {
      Alert.alert("Media unavailable", getIosSimulatorMediaMessage());
      return;
    }
    action();
  };

  return (
    <View style={[styles.space, { backgroundColor: theme.colors.darkCanvas }]}>
      <SpaceTopBarAndroid formattedDuration={controller.formattedDuration} logoUrl={props.logoUrl} participantCount={controller.participantCount} spaceName={controller.spaceName} />
      {props.reconnecting ? (
        <View accessibilityLiveRegion="polite" style={[styles.recovery, { backgroundColor: theme.colors.primary }]}>
          <Text style={[styles.recoveryText, { color: theme.colors.primaryForeground }]}>Reconnecting… controls will resume shortly.</Text>
        </View>
      ) : null}
      <View style={styles.stage}>
        {controller.whiteboard.isOpen ? (
          <SpaceWhiteboardSurface whiteboard={controller.whiteboard} />
        ) : controller.derived.isStageMode || controller.layout.layout !== "grid" ? (
          <SpaceStageAndroid
            activeReactions={controller.activeReactions}
            handRaised={controller.handRaised}
            isCompactViewport={controller.derived.isCompactViewport}
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
          <SpaceGridAndroid gridPages={controller.derived.gridPages} participants={controller.derived.allParticipants} />
        )}
      </View>
      <SpaceBottomDockAndroid
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
      <SpaceActionMenu controller={controller} />
      <SpacePanel controller={controller} />
      <ReactionPicker isOpen={controller.reactionPickerOpen} onClose={() => controller.setReactionPickerOpen(false)} onSelect={(reaction) => selectSpaceReaction(controller, reaction)} />
    </View>
  );
}

const styles = StyleSheet.create({
  space: { flex: 1, backgroundColor: Theme.colors.darkCanvas },
  stage: { flex: 1, width: "100%", overflow: "hidden", justifyContent: "center" },
  recovery: { alignItems: "center", paddingHorizontal: 16, paddingVertical: 8 },
  recoveryText: { fontSize: 13, fontWeight: "700" },
});
