import type { components, operations } from "../generated/openapi-types.js";
import type { ChalkIdempotencyOptions } from "./types.js";

export type ServerSchemas = components["schemas"];
export type PageInput = {
  readonly cursor?: string;
  readonly pageSize?: number;
};

export type Transcript = ServerSchemas["Transcript"];
export type TranscriptList = ServerSchemas["TranscriptList"];
export type TranscriptDocument = ServerSchemas["TranscriptDocument"];
export type TranscriptText = ServerSchemas["TranscriptText"];
export type TranscriptDownloadURL = ServerSchemas["TranscriptDownloadURL"];
export type TranscriptRequestAcceptedResponse = ServerSchemas["TranscriptRequestAcceptedResponse"];
export type ListTranscriptsInput = PageInput & {
  readonly recordingId?: NonNullable<operations["listTranscripts"]["parameters"]["query"]>["recording_id"];
};
export type CreateTranscriptDownloadURLInput = {
  readonly expiresInSeconds: ServerSchemas["CreateTranscriptDownloadURLRequest"]["expires_in_seconds"];
};
export type RequestTranscriptInput = {
  readonly idempotencyKey: ServerSchemas["RequestTranscriptRequest"]["idempotency_key"];
  readonly language?: ServerSchemas["RequestTranscriptRequest"]["language"];
  readonly languages?: Readonly<NonNullable<ServerSchemas["RequestTranscriptRequest"]["languages"]>>;
};

export type ScheduledEpisode = ServerSchemas["ScheduledEpisode"];
type ScheduledEpisodeRequest = ServerSchemas["PutScheduledEpisodeRequest"];
type ExpectedParticipant = NonNullable<ScheduledEpisodeRequest["expected_participants"]>[number];
export type ScheduledEpisodeExpectedParticipant = {
  readonly identityExternalId?: ExpectedParticipant["identity_external_id"];
  readonly name: ExpectedParticipant["name"];
  readonly role?: ExpectedParticipant["role"];
};
export type PutScheduledEpisodeInput = {
  readonly startsAt: ScheduledEpisodeRequest["starts_at"];
  readonly expectedEndsAt: ScheduledEpisodeRequest["expected_ends_at"];
  readonly expectedParticipants?: readonly ScheduledEpisodeExpectedParticipant[];
  readonly metadata?: ScheduledEpisodeRequest["metadata"];
};

export type WebhookEndpoint = ServerSchemas["WebhookEndpoint"];
export type WebhookEndpointWithSecret = ServerSchemas["WebhookEndpointWithSecret"];
export type WebhookEndpointList = ServerSchemas["WebhookEndpointList"];
export type RotateWebhookSecretResponse = ServerSchemas["RotateWebhookSecretResponse"];
export type WebhookDeliveryList = ServerSchemas["WebhookDeliveryList"];
export type WebhookDeliveryCreated = ServerSchemas["WebhookDeliveryCreated"];
type CreateWebhookRequest = ServerSchemas["CreateWebhookEndpointRequest"];
type UpdateWebhookRequest = ServerSchemas["UpdateWebhookEndpointRequest"];
type WebhookDeliveryQuery = NonNullable<operations["listWebhookDeliveries"]["parameters"]["query"]>;
export type CreateWebhookEndpointInput = {
  readonly apiVersion: CreateWebhookRequest["api_version"];
  readonly enabled: CreateWebhookRequest["enabled"];
  readonly eventTypes: Readonly<CreateWebhookRequest["event_types"]>;
  readonly name: CreateWebhookRequest["name"];
  readonly url: CreateWebhookRequest["url"];
};
export type UpdateWebhookEndpointInput = {
  readonly revision: WebhookEndpoint["revision"];
  readonly apiVersion?: UpdateWebhookRequest["api_version"];
  readonly enabled?: UpdateWebhookRequest["enabled"];
  readonly eventTypes?: Readonly<NonNullable<UpdateWebhookRequest["event_types"]>>;
  readonly name?: UpdateWebhookRequest["name"];
  readonly url?: UpdateWebhookRequest["url"];
};
export type RotateWebhookSecretInput = {
  readonly revokePreviousImmediately: ServerSchemas["RotateWebhookSecretRequest"]["revoke_previous_immediately"];
};
export type ListWebhookEndpointsInput = PageInput;
export type ListWebhookDeliveriesInput = PageInput & {
  readonly states?: Readonly<NonNullable<WebhookDeliveryQuery["state"]>>;
  readonly eventTypes?: Readonly<NonNullable<WebhookDeliveryQuery["event_type"]>>;
};

export type ServerResourceMethods = {
  readonly scheduledEpisodes: {
    put(spaceId: string, scheduledEpisodeId: string, input: PutScheduledEpisodeInput): Promise<ScheduledEpisode>;
    get(spaceId: string, scheduledEpisodeId: string): Promise<ScheduledEpisode>;
    delete(spaceId: string, scheduledEpisodeId: string): Promise<void>;
  };
  readonly transcripts: {
    list(input?: ListTranscriptsInput): Promise<TranscriptList>;
    get(transcriptId: string): Promise<Transcript>;
    getDocument(transcriptId: string): Promise<TranscriptDocument>;
    getText(transcriptId: string): Promise<TranscriptText>;
    createDownloadURL(transcriptId: string, input: CreateTranscriptDownloadURLInput): Promise<TranscriptDownloadURL>;
    request(recordingId: string, input: RequestTranscriptInput): Promise<TranscriptRequestAcceptedResponse>;
    delete(transcriptId: string): Promise<void>;
  };
  readonly webhookEndpoints: {
    create(input: CreateWebhookEndpointInput, options?: ChalkIdempotencyOptions): Promise<WebhookEndpointWithSecret>;
    list(input?: ListWebhookEndpointsInput): Promise<WebhookEndpointList>;
    get(endpointId: string): Promise<WebhookEndpoint>;
    update(endpointId: string, input: UpdateWebhookEndpointInput, options?: ChalkIdempotencyOptions): Promise<WebhookEndpoint>;
    rotateSecret(endpointId: string, input: RotateWebhookSecretInput, options?: ChalkIdempotencyOptions): Promise<RotateWebhookSecretResponse>;
    delete(endpointId: string, revision: number, options?: ChalkIdempotencyOptions): Promise<void>;
    listDeliveries(endpointId: string, input?: ListWebhookDeliveriesInput): Promise<WebhookDeliveryList>;
    redeliver(endpointId: string, deliveryId: string, options?: ChalkIdempotencyOptions): Promise<WebhookDeliveryCreated>;
  };
};
