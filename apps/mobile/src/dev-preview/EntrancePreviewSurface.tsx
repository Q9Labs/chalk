import { JoinFailedScreen, JoiningScreen, PreJoinScreen } from "@q9labsai/chalk-react-native";

import type { PreviewSearch, PreviewSearchPatch } from "./preview-state";
import { PREVIEW_DISPLAY_NAME, PREVIEW_SPACE_NAME } from "./sdk-preview-fixtures";

export interface EntrancePreviewSurfaceProps {
  readonly search: PreviewSearch;
  readonly onSearchChange: (patch: PreviewSearchPatch) => void;
  readonly onClose: () => void;
}

export function EntrancePreviewSurface({ search, onClose, onSearchChange }: EntrancePreviewSurfaceProps): React.JSX.Element {
  if (search.state === "joining") {
    return <JoiningScreen displayName={PREVIEW_DISPLAY_NAME} message={`Preparing to enter ${PREVIEW_SPACE_NAME}`} supportingMessages={["Checking your AccessGrant", "Starting the Episode"]} />;
  }

  if (search.state === "waiting") {
    return <JoiningScreen displayName={PREVIEW_DISPLAY_NAME} message={`Waiting for admission to ${PREVIEW_SPACE_NAME}`} supportingMessages={["Your request is with a Space collaborator"]} />;
  }

  if (search.state === "timeout" || search.state === "failure") {
    const timedOut = search.state === "timeout";
    return (
      <JoinFailedScreen
        title={timedOut ? "Entrance timed out" : "Could not enter the Space"}
        message={timedOut ? "The Entrance took too long to prepare. Try again when you’re ready." : "We could not prepare your Entrance for this Space."}
        supportCode={timedOut ? "entrance-timeout-408" : "entrance-failure-403"}
        onRetry={() => onSearchChange({ view: "entrance", state: "ready" })}
        onBack={() => onSearchChange({ view: "entrance", state: "ready" })}
      />
    );
  }

  const warning = search.state === "warning";
  return (
    <PreJoinScreen
      error={warning ? "Device access needs attention." : null}
      initialAudioEnabled={search.mic}
      initialVideoEnabled={search.camera}
      key={`${search.mic}-${search.camera}`}
      onCancel={onClose}
      onJoin={(settings) =>
        onSearchChange({
          camera: settings.cameraEnabled,
          dialog: "none",
          mic: settings.microphoneEnabled,
          panel: "none",
          state: "happy",
          view: "space",
        })
      }
      previewMode="disabled"
      roomName={PREVIEW_SPACE_NAME}
      userName={PREVIEW_DISPLAY_NAME}
    />
  );
}
