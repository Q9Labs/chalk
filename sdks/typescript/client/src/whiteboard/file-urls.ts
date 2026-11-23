import { route } from "../api-urls";

export const whiteboardFileAvailability = (base: string) => route(base, "whiteboard", "files", "availability");
export const whiteboardFileDownload = (base: string, fileId: string) => route(base, "whiteboard", "files", fileId, "download");
export const whiteboardFileUpload = (base: string, sceneId: string, fileId: string) => route(base, "whiteboard", "scenes", sceneId, "files", fileId, "upload");
export const whiteboardFileFinalize = (base: string, sceneId: string, fileId: string) => route(base, "whiteboard", "scenes", sceneId, "files", fileId, "finalize");
