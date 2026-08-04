import { ChalkProvider, ConferenceView as SpaceView, EndScreen, JoinFailedScreen } from "@q9labsai/chalk-react-native";
import { StyleSheet, View } from "react-native";

import type { PreviewSearch, PreviewSearchPatch } from "./preview-state";
import { chatCountFor, PREVIEW_SPACE_NAME, productionPalette, productionTexture, spaceStateCopy } from "./sdk-preview-fixtures";
import { createPreviewStore } from "./sdk-preview-store";

const PRODUCTION_SPACE_NAME = { roomName: PREVIEW_SPACE_NAME } as const;

export interface SpacePreviewSurfaceProps {
  readonly search: PreviewSearch;
  readonly onSearchChange: (patch: PreviewSearchPatch) => void;
  readonly onClose: () => void | Promise<void>;
}

export function SpacePreviewSurface({ search, onSearchChange, onClose }: SpacePreviewSurfaceProps): React.JSX.Element {
  const fixture = createPreviewStore(search);
  const retry = () => {
    void fixture.join();
    onSearchChange({ view: "space", state: "happy" });
  };
  const leave = () => {
    void fixture.leave();
    void onClose();
  };

  return (
    <View style={styles.surface} testID="dev-preview-space">
      <View style={styles.productionSurface}>
        <ChalkProvider session={fixture}>
          {search.state === "ended" ? (
            <EndScreen data={{ roomId: "preview-space", ...PRODUCTION_SPACE_NAME, durationSeconds: 1_080, participantCount: search.participants, chatCount: chatCountFor(search) }} onGoHome={leave} onRejoin={retry} />
          ) : search.state === "failure" || search.state === "timeout" ? (
            <JoinFailedScreen {...PRODUCTION_SPACE_NAME} message={spaceStateCopy(search.state)} onBack={leave} onRetry={retry} supportCode={`preview-${search.state}`} title={search.state === "timeout" ? "Space timed out" : "Couldn’t enter the Space"} />
          ) : (
            <SpaceView
              features={{ chat: true, handRaise: true, participants: true, reactions: true, screenShare: false, whiteboard: true }}
              initialPalette={productionPalette(search.palette)}
              initialState={{
                actionsOpen: search.dialog === "more",
                durationSeconds: 1_080,
                layout: search.layout,
                leaveConfirmationOpen: search.state === "confirmation",
                panel: search.panel === "chat" || search.panel === "participants" ? search.panel : null,
                reactionPickerOpen: search.dialog === "reactions",
                settingsOpen: search.dialog === "settings",
                whiteboardOpen: search.stage === "whiteboard",
              }}
              controlledState={{
                actionsOpen: search.dialog === "more",
                layout: search.layout,
                leaveConfirmationOpen: search.state === "confirmation",
                panel: search.panel === "chat" || search.panel === "participants" ? search.panel : null,
                reactionPickerOpen: search.dialog === "reactions",
                settingsOpen: search.dialog === "settings",
                whiteboardOpen: search.stage === "whiteboard",
              }}
              initialTexture={productionTexture(search.texture)}
              meetingLink="https://chalk.example/spaces/design-review"
              onEndForAll={() => {
                void fixture.endSession();
                void onClose();
              }}
              onLeave={leave}
              {...PRODUCTION_SPACE_NAME}
            />
          )}
        </ChalkProvider>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  surface: { flex: 1, position: "relative" },
  productionSurface: { flex: 1 },
});
