import { Chalk } from "@q9labsai/chalk-react-native";
import { StyleSheet, View } from "react-native";

import { PreviewStatus } from "./PreviewStatus";
import type { PreviewSearch, PreviewSearchPatch } from "./preview-state";
import { PREVIEW_DISPLAY_NAME, PREVIEW_SPACE_NAME, spaceStateCopy } from "./sdk-preview-fixtures";
import { createPreviewStore } from "./sdk-preview-store";

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
        {search.state === "ended" ? (
          <PreviewStatus message="This Episode has ended." onBack={leave} onRetry={retry} title="Episode complete" />
        ) : search.state === "failure" || search.state === "timeout" ? (
          <PreviewStatus message={spaceStateCopy(search.state)} onBack={leave} onRetry={retry} title={search.state === "timeout" ? "Space timed out" : "Could not enter the Space"} />
        ) : (
          <Chalk
            client={fixture}
            defaults={{ camera: search.camera, microphone: search.mic }}
            displayName={PREVIEW_DISPLAY_NAME}
            entrance={false}
            features={{ chat: true, handRaise: true, participants: true, reactions: true, screenShare: false, whiteboard: true }}
            layout={search.layout}
            onEpisodeEnded={leave}
            onLeft={leave}
            spaceName={PREVIEW_SPACE_NAME}
          />
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  surface: { flex: 1, position: "relative" },
  productionSurface: { flex: 1 },
});
