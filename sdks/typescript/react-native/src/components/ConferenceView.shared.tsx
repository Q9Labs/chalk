import { useEffect, useRef } from "react";
import { AccessibilityInfo, Alert, Animated, Easing, Platform, SafeAreaView, StyleSheet } from "react-native";

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
import { Theme } from "../ui/theme";

export function ConferenceViewShared(props: ConferenceViewProps): React.JSX.Element {
  const controller = useConferenceViewController(props);
  const stageProgress = useRef(new Animated.Value(0)).current;
  const toggleMedia = (action: () => void) => {
    if (controller.simulatorMediaDisabled) {
      Alert.alert("Media unavailable", getIosSimulatorMediaMessage());
      return;
    }
    action();
  };

  useEffect(() => {
    let mounted = true;
    let animation: Animated.CompositeAnimation | undefined;
    void AccessibilityInfo.isReduceMotionEnabled().then((reduceMotion) => {
      if (!mounted || reduceMotion) {
        stageProgress.setValue(1);
        return;
      }
      animation = Animated.timing(stageProgress, {
        toValue: 1,
        duration: 240,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      });
      animation.start();
    });
    return () => {
      mounted = false;
      animation?.stop();
    };
  }, [stageProgress]);

  return (
    <SafeAreaView style={styles.room}>
      <MeetingTopBarAndroid formattedDuration={controller.formattedDuration} participantCount={controller.participantCount} roomName={controller.roomName} />
      <Animated.View style={[styles.stage, { opacity: stageProgress, transform: [{ translateY: stageProgress.interpolate({ inputRange: [0, 1], outputRange: [6, 0] }) }] }]}>
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
      </Animated.View>
      <MeetingBottomDockAndroid
        isCameraOff={controller.isCameraOff}
        isMuted={controller.isMuted}
        onLeave={controller.handleLeave}
        onOpenChat={controller.canChat ? () => controller.openPanel("chat") : undefined}
        onOpenParticipants={controller.canParticipants ? () => controller.openPanel("participants") : undefined}
        onOpenMore={() => controller.setActionsOpen(true)}
        onToggleAudio={() => toggleMedia(controller.toggleAudio)}
        onToggleVideo={() => toggleMedia(controller.toggleVideo)}
        simulatorMediaDisabled={controller.simulatorMediaDisabled}
        unreadChatCount={controller.chat.unreadCount}
      />
      <MeetingActionMenu controller={controller} />
      <MeetingPanel controller={controller} />
      <ReactionPicker isOpen={controller.reactionPickerOpen} onClose={() => controller.setReactionPickerOpen(false)} onSelect={(reaction) => selectReaction(controller, reaction)} />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  room: { backgroundColor: Theme.colors.background, flex: 1, paddingBottom: Platform.OS === "android" ? Theme.spacing.sm : 0, paddingTop: Platform.OS === "android" ? Theme.spacing["2xl"] : 0 },
  stage: { flex: 1, width: "100%", overflow: "hidden", justifyContent: "center", padding: Theme.spacing.md },
});
