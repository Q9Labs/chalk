import { EntrancePreviewFixture } from "./EntrancePreviewFixture";
import { PreviewStatus } from "./PreviewStatus";
import type { PreviewSearch, PreviewSearchPatch } from "./preview-state";
import { PREVIEW_DISPLAY_NAME, PREVIEW_SPACE_NAME } from "./sdk-preview-fixtures";

export interface EntrancePreviewSurfaceProps {
  readonly search: PreviewSearch;
  readonly onSearchChange: (patch: PreviewSearchPatch) => void;
  readonly onClose: () => void;
}

export function EntrancePreviewSurface({ search, onClose, onSearchChange }: EntrancePreviewSurfaceProps): React.JSX.Element {
  if (search.state === "joining") {
    return <PreviewStatus message={`Preparing to enter ${PREVIEW_SPACE_NAME}`} onBack={onClose} title="Entering Space" />;
  }

  if (search.state === "waiting") {
    return <PreviewStatus message={`Waiting for admission to ${PREVIEW_SPACE_NAME}`} onBack={onClose} title="Waiting for admission" />;
  }

  if (search.state === "timeout" || search.state === "failure") {
    const timedOut = search.state === "timeout";
    return (
      <PreviewStatus
        message={timedOut ? "The Entrance took too long to prepare. Try again when you’re ready." : "We could not prepare your Entrance for this Space."}
        onBack={() => onSearchChange({ view: "entrance", state: "ready" })}
        onRetry={() => onSearchChange({ view: "entrance", state: "ready" })}
        title={timedOut ? "Entrance timed out" : "Could not enter the Space"}
      />
    );
  }

  const warning = search.state === "warning";
  return (
    <EntrancePreviewFixture
      defaultDisplayName={PREVIEW_DISPLAY_NAME}
      defaults={{ camera: search.camera, microphone: search.mic }}
      error={warning ? "Device access needs attention." : undefined}
      onCancel={onClose}
      onJoin={(settings) =>
        onSearchChange({
          camera: settings.camera,
          mic: settings.microphone,
          state: "happy",
          view: "space",
        })
      }
      spaceName={PREVIEW_SPACE_NAME}
    />
  );
}
