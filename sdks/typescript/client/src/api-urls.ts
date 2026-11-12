import { trimTrailingSlashes } from "./urls";

export type ParticipantRouteSubject = {
  readonly tenantId: string;
  readonly spaceId: string;
  readonly episodeId: string;
  readonly participantId: string;
};

const segment = encodeURIComponent;

function tenantUrl(base: string, tenantId: string): string {
  return `${trimTrailingSlashes(base)}/v1/tenants/${segment(tenantId)}`;
}

function participantUrl(base: string, subject: ParticipantRouteSubject): string {
  return `${tenantUrl(base, subject.tenantId)}/spaces/${segment(subject.spaceId)}/episodes/${segment(subject.episodeId)}/participants/${segment(subject.participantId)}`;
}

/** The API routes the SDK calls by hand, because the generated client does not carry their bearer or streaming needs. */
export const mediaSignalling = (base: string, subject: ParticipantRouteSubject) => `${participantUrl(base, subject)}/media/sfu`;
export const episodeStatus = (base: string, subject: ParticipantRouteSubject) => `${participantUrl(base, subject)}/episode-status`;
export const cancelJoin = (base: string, subject: ParticipantRouteSubject) => `${participantUrl(base, subject)}/cancel-join`;
export const connectionReports = (base: string, tenantId: string) => `${tenantUrl(base, tenantId)}/connection-reports`;
export const problemReports = (base: string, tenantId: string) => `${tenantUrl(base, tenantId)}/problem-reports`;
export const problemReportAvailability = (base: string, tenantId: string) => `${tenantUrl(base, tenantId)}/problem-reports/availability`;
export const callStats = (base: string, tenantId: string) => `${tenantUrl(base, tenantId)}/call-stats`;
export const chatUploads = (base: string) => `${trimTrailingSlashes(base)}/v1/chat/attachments/uploads`;
export const chatUploadFinalize = (base: string, uploadId: string) => `${trimTrailingSlashes(base)}/v1/chat/attachments/uploads/${segment(uploadId)}/finalize`;
export const chatAttachmentDownload = (base: string, attachmentId: string) => `${trimTrailingSlashes(base)}/v1/chat/attachments/${segment(attachmentId)}/download`;
export const whiteboardFileDownload = (base: string, fileId: string) => `${trimTrailingSlashes(base)}/v1/whiteboard/files/${segment(fileId)}/download`;
