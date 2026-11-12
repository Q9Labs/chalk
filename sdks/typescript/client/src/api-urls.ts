import { trimTrailingSlashes } from "./urls";

export type ParticipantRouteSubject = {
  readonly tenantId: string;
  readonly spaceId: string;
  readonly episodeId: string;
  readonly participantId: string;
};

/** `base` and `/v1/` followed by the parts, each encoded as one path segment. */
const route = (base: string, ...parts: string[]): string => `${trimTrailingSlashes(base)}/v1/${parts.map(encodeURIComponent).join("/")}`;
const tenantRoute = (base: string, tenantId: string, ...parts: string[]) => route(base, "tenants", tenantId, ...parts);
const participantRoute = (base: string, subject: ParticipantRouteSubject, ...leaf: string[]) => route(base, "tenants", subject.tenantId, "spaces", subject.spaceId, "episodes", subject.episodeId, "participants", subject.participantId, ...leaf);

/** The API routes the SDK calls by hand, because the generated client does not carry their bearer or streaming needs. */
export const mediaSignalling = (base: string, subject: ParticipantRouteSubject) => participantRoute(base, subject, "media", "sfu");
export const episodeStatus = (base: string, subject: ParticipantRouteSubject) => participantRoute(base, subject, "episode-status");
export const cancelJoin = (base: string, subject: ParticipantRouteSubject) => participantRoute(base, subject, "cancel-join");
export const connectionReports = (base: string, tenantId: string) => tenantRoute(base, tenantId, "connection-reports");
export const problemReports = (base: string, tenantId: string) => tenantRoute(base, tenantId, "problem-reports");
export const problemReportAvailability = (base: string, tenantId: string) => tenantRoute(base, tenantId, "problem-reports", "availability");
export const callStats = (base: string, tenantId: string) => tenantRoute(base, tenantId, "call-stats");
export const chatUploads = (base: string) => route(base, "chat", "attachments", "uploads");
export const chatUploadFinalize = (base: string, uploadId: string) => route(base, "chat", "attachments", "uploads", uploadId, "finalize");
export const chatAttachmentDownload = (base: string, attachmentId: string) => route(base, "chat", "attachments", attachmentId, "download");
export const whiteboardFileDownload = (base: string, fileId: string) => route(base, "whiteboard", "files", fileId, "download");
