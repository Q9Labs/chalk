// React- and DOM-free helpers for renderers that draw a Recording without a
// browser, so they place tiles exactly where the live Stage does.
export { DEFAULT_GRID_OPTIONS, DEFAULT_SPOTLIGHT_OPTIONS, fitGrid, fitSpotlight } from "./components/stage/stage-layout";
export type { StageBox, StageFrame, StageGeometry, StageRole } from "./components/stage/stage-layout";
export { choosePrimary, gridOrder, screenShareItemId, WHITEBOARD_ITEM_ID } from "./components/stage/stage-items";
export type { StageItem, StageLayout } from "./components/stage/stage-items";
export type { Participant } from "./components/participant-grid/ParticipantGrid";
export { loadRecordingWhiteboardFiles, parseRecordingWhiteboardStateV1, recordingWhiteboardSceneAppState } from "./components/whiteboard-view/recording-whiteboard-state";
export type { RecordingWhiteboardStateV1 } from "./components/whiteboard-view/recording-whiteboard-state";
