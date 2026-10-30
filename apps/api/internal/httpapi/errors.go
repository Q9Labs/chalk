package httpapi

import (
	"net/http"

	"github.com/q9labs/chalk/platform/httpcontract"
)

var (
	apiErrorUnauthenticated    = httpcontract.APIError{Status: http.StatusUnauthorized, Code: "access.unauthenticated", Message: "Authentication required"}
	apiErrorForbidden          = httpcontract.APIError{Status: http.StatusForbidden, Code: "access.forbidden", Message: "Access denied"}
	apiErrorServiceUnavailable = httpcontract.APIError{Status: http.StatusServiceUnavailable, Code: "service.unavailable", Message: "Service is not ready"}
	apiErrorInvalidRequest     = httpcontract.APIError{Status: http.StatusBadRequest, Code: "request.invalid", Message: "Invalid request body"}
	apiErrorInvalidPageSize    = httpcontract.APIError{Status: http.StatusBadRequest, Code: "pagination.invalid_page_size", Message: "Invalid page size"}
	apiErrorInvalidCursor      = httpcontract.APIError{Status: http.StatusBadRequest, Code: "pagination.invalid_cursor", Message: "Invalid cursor"}
	apiErrorInvalidTenantID    = httpcontract.APIError{Status: http.StatusBadRequest, Code: "tenant.invalid_id", Message: "Invalid tenant id"}
	apiErrorInvalidTenantName  = httpcontract.APIError{Status: http.StatusBadRequest, Code: "tenant.invalid_name", Message: "Invalid tenant name"}

	apiErrorInvalidTenantField      = httpcontract.APIError{Status: http.StatusBadRequest, Code: "tenant.invalid_field", Message: "Invalid tenant field"}
	apiErrorInvalidTenantCORSOrigin = httpcontract.APIError{Status: http.StatusBadRequest, Code: "tenant.invalid_cors_origin", Message: "Use up to 32 exact HTTPS origins; HTTP is allowed only for localhost or loopback addresses"}
	apiErrorTenantNotFound          = httpcontract.APIError{Status: http.StatusNotFound, Code: "tenant.not_found", Message: "Tenant not found"}
	apiErrorRateLimited             = httpcontract.APIError{Status: http.StatusTooManyRequests, Code: "request.rate_limited", Message: "Too many requests"}
	apiErrorPayloadTooLarge         = httpcontract.APIError{Status: http.StatusRequestEntityTooLarge, Code: "request.payload_too_large", Message: "Request body is too large"}
	apiErrorInternal                = httpcontract.APIError{Status: http.StatusInternalServerError, Code: "service.internal_error", Message: "Internal server error"}
	apiErrorInvalidUserID           = httpcontract.APIError{Status: http.StatusBadRequest, Code: "user.invalid_id", Message: "Invalid user id"}

	apiErrorInvalidMembershipID   = httpcontract.APIError{Status: http.StatusBadRequest, Code: "membership.invalid_id", Message: "Invalid membership id"}
	apiErrorInvalidMembershipRole = httpcontract.APIError{Status: http.StatusBadRequest, Code: "membership.invalid_role", Message: "Invalid membership role"}
	apiErrorMembershipNotFound    = httpcontract.APIError{Status: http.StatusNotFound, Code: "membership.not_found", Message: "Membership not found"}

	apiErrorInvalidSpaceID                = httpcontract.APIError{Status: http.StatusBadRequest, Code: "space.invalid_id", Message: "Invalid Space id"}
	apiErrorInvalidEpisodeID              = httpcontract.APIError{Status: http.StatusBadRequest, Code: "episode.invalid_id", Message: "Invalid Episode id"}
	apiErrorInvalidSpaceName              = httpcontract.APIError{Status: http.StatusBadRequest, Code: "space.invalid_name", Message: "Invalid Space name"}
	apiErrorInvalidSpaceSlug              = httpcontract.APIError{Status: http.StatusBadRequest, Code: "space.invalid_slug", Message: "Invalid Space slug"}
	apiErrorInvalidMediaPlane             = httpcontract.APIError{Status: http.StatusBadRequest, Code: "space.invalid_media_plane", Message: "Invalid media plane"}
	apiErrorInvalidSpaceField             = httpcontract.APIError{Status: http.StatusBadRequest, Code: "space.invalid_field", Message: "Invalid Space field"}
	apiErrorSpaceSlugAlreadyUsed          = httpcontract.APIError{Status: http.StatusConflict, Code: "space.slug_conflict", Message: "Space slug already used"}
	apiErrorSpaceNotFound                 = httpcontract.APIError{Status: http.StatusNotFound, Code: "space.not_found", Message: "Space not found"}
	apiErrorInvalidSpaceArchiveFilter     = httpcontract.APIError{Status: http.StatusBadRequest, Code: "space.invalid_archive_filter", Message: "Invalid archived filter"}
	apiErrorEpisodeNotFound               = httpcontract.APIError{Status: http.StatusNotFound, Code: "episode.not_found", Message: "Episode not found"}
	apiErrorInvalidParticipantID          = httpcontract.APIError{Status: http.StatusBadRequest, Code: "participant.invalid_id", Message: "Invalid Participant id"}
	apiErrorInvalidRequestKey             = httpcontract.APIError{Status: http.StatusBadRequest, Code: "request.invalid_idempotency_key", Message: "Idempotency-Key must contain 16 to 128 ASCII letters, digits, underscores, or hyphens"}
	apiErrorEpisodeNotActive              = httpcontract.APIError{Status: http.StatusConflict, Code: "episode.not_active", Message: "Episode is not active"}
	apiErrorEpisodeControlBusy            = httpcontract.APIError{Status: http.StatusConflict, Code: "episode.control_busy", Message: "Another Episode control operation is still being applied"}
	apiErrorParticipantNotFound           = httpcontract.APIError{Status: http.StatusNotFound, Code: "participant.not_found", Message: "Participant not found"}
	apiErrorParticipantNotActive          = httpcontract.APIError{Status: http.StatusConflict, Code: "participant.not_active", Message: "Participant is not active"}
	apiErrorParticipantGenerationMismatch = httpcontract.APIError{Status: http.StatusConflict, Code: "participant.generation_mismatch", Message: "Participant generation does not match"}
	apiErrorIdempotencyConflict           = httpcontract.APIError{Status: http.StatusConflict, Code: "request.idempotency_conflict", Message: "Idempotency key was already used for another request"}
	apiErrorEpisodeCapacityExceeded       = httpcontract.APIError{Status: http.StatusConflict, Code: "episode.capacity_exceeded", Message: "Episode capacity is exhausted"}
	apiErrorMediaPlaneUnavailable         = httpcontract.APIError{Status: http.StatusServiceUnavailable, Code: "media.unavailable", Message: "Media plane is unavailable"}
	apiErrorMediaConnectionNotFound       = httpcontract.APIError{Status: http.StatusNotFound, Code: "media.connection_not_found", Message: "Media connection not found"}

	apiErrorInvalidRecordingID        = httpcontract.APIError{Status: http.StatusBadRequest, Code: "recording.invalid_id", Message: "Invalid recording id"}
	apiErrorInvalidRecordingStatus    = httpcontract.APIError{Status: http.StatusBadRequest, Code: "recording.invalid_status", Message: "Invalid recording status"}
	apiErrorInvalidStorageProvider    = httpcontract.APIError{Status: http.StatusBadRequest, Code: "storage.invalid_provider", Message: "Invalid storage provider"}
	apiErrorInvalidStorageKey         = httpcontract.APIError{Status: http.StatusBadRequest, Code: "storage.invalid_key", Message: "Invalid storage key"}
	apiErrorInvalidRecordingField     = httpcontract.APIError{Status: http.StatusBadRequest, Code: "recording.invalid_field", Message: "Invalid recording field"}
	apiErrorInvalidURLExpiration      = httpcontract.APIError{Status: http.StatusBadRequest, Code: "url.invalid_expiration", Message: "Invalid url expiration"}
	apiErrorRecordingNotReady         = httpcontract.APIError{Status: http.StatusBadRequest, Code: "recording.not_ready", Message: "Recording is not ready"}
	apiErrorRecordingNotFound         = httpcontract.APIError{Status: http.StatusNotFound, Code: "recording.not_found", Message: "Recording not found"}
	apiErrorRecordingExportRetryLimit = httpcontract.APIError{Status: http.StatusConflict, Code: "recording.export_retry_limit_reached", Message: "Recording Export retry limit reached"}
	apiErrorRecordingArtifactNotFound = httpcontract.APIError{Status: http.StatusNotFound, Code: "recording_artifact.not_found", Message: "Recording artifact not found"}

	apiErrorInvalidTranscriptID     = httpcontract.APIError{Status: http.StatusBadRequest, Code: "transcript.invalid_id", Message: "Invalid transcript id"}
	apiErrorTranscriptionDisabled   = httpcontract.APIError{Status: http.StatusConflict, Code: "transcript.disabled", Message: "Transcription is disabled for this Episode"}
	apiErrorTranscriptSourceExpired = httpcontract.APIError{Status: http.StatusConflict, Code: "transcript.source_expired", Message: "The temporary transcription source has expired"}
	apiErrorTranscriptAlreadyExists = httpcontract.APIError{Status: http.StatusConflict, Code: "transcript.already_exists", Message: "A Transcript already exists for this Recording"}
	apiErrorTranscriptNotFound      = httpcontract.APIError{Status: http.StatusNotFound, Code: "transcript.not_found", Message: "Transcript not found"}
	apiErrorTranscriptNotReady      = httpcontract.APIError{Status: http.StatusConflict, Code: "transcript.not_ready", Message: "Transcript artifact is not ready"}

	apiErrorInvalidWebhookEndpointID        = httpcontract.APIError{Status: http.StatusBadRequest, Code: "webhook.invalid_endpoint_id", Message: "Invalid webhook endpoint id"}
	apiErrorInvalidWebhookDeliveryID        = httpcontract.APIError{Status: http.StatusBadRequest, Code: "webhook.invalid_delivery_id", Message: "Invalid webhook delivery id"}
	apiErrorInvalidWebhookURL               = httpcontract.APIError{Status: http.StatusBadRequest, Code: "webhook.invalid_url", Message: "Invalid webhook URL"}
	apiErrorUnsafeWebhookURL                = httpcontract.APIError{Status: http.StatusBadRequest, Code: "webhook.unsafe_url", Message: "Webhook URL is not a safe public HTTPS destination"}
	apiErrorInvalidWebhookEventType         = httpcontract.APIError{Status: http.StatusBadRequest, Code: "webhook.invalid_event_type", Message: "Invalid webhook event type"}
	apiErrorWebhookEventTypeUnavailable     = httpcontract.APIError{Status: http.StatusConflict, Code: "webhook.event_type_unavailable", Message: "Webhook event type is not available"}
	apiErrorInvalidWebhookAPIVersion        = httpcontract.APIError{Status: http.StatusBadRequest, Code: "webhook.invalid_api_version", Message: "Invalid webhook API version"}
	apiErrorWebhookEndpointLimit            = httpcontract.APIError{Status: http.StatusConflict, Code: "webhook.endpoint_limit_reached", Message: "Webhook endpoint limit reached"}
	apiErrorWebhookEndpointNotFound         = httpcontract.APIError{Status: http.StatusNotFound, Code: "webhook.endpoint_not_found", Message: "Webhook endpoint not found"}
	apiErrorWebhookDeliveryNotFound         = httpcontract.APIError{Status: http.StatusNotFound, Code: "webhook.delivery_not_found", Message: "Webhook delivery not found"}
	apiErrorWebhookDeliveryNotRedeliverable = httpcontract.APIError{Status: http.StatusConflict, Code: "webhook.delivery_not_redeliverable", Message: "Webhook delivery cannot be redelivered"}
	apiErrorWebhookEventErased              = httpcontract.APIError{Status: http.StatusGone, Code: "webhook.event_erased", Message: "Webhook event body was erased"}
	apiErrorWebhookRevisionConflict         = httpcontract.APIError{Status: http.StatusPreconditionFailed, Code: "webhook.endpoint_revision_conflict", Message: "Webhook endpoint revision does not match"}
	apiErrorWebhookIdempotencyRequired      = httpcontract.APIError{Status: http.StatusBadRequest, Code: "webhook.idempotency_key_required", Message: "Idempotency-Key is required"}
	apiErrorWebhookIdempotencyConflict      = httpcontract.APIError{Status: http.StatusConflict, Code: "webhook.idempotency_conflict", Message: "Idempotency key was used for another request"}
	apiErrorWebhookIdempotencyExpired       = httpcontract.APIError{Status: http.StatusConflict, Code: "webhook.idempotency_expired", Message: "Idempotency key has expired"}
)

func writeAPIError(w http.ResponseWriter, err httpcontract.APIError) {
	writeError(w, err.Status, err.Code, err.Message)
}
