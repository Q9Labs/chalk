package httpapi

import "net/http"

type APIError struct {
	Status  int
	Code    string
	Message string
}

func (err APIError) Error() string {
	return err.Code
}

var (
	apiErrorUnauthenticated     = APIError{Status: http.StatusUnauthorized, Code: "access.unauthenticated", Message: "Authentication required"}
	apiErrorForbidden           = APIError{Status: http.StatusForbidden, Code: "access.forbidden", Message: "Access denied"}
	apiErrorServiceUnavailable  = APIError{Status: http.StatusServiceUnavailable, Code: "service.unavailable", Message: "Service is not ready"}
	apiErrorInvalidRequest      = APIError{Status: http.StatusBadRequest, Code: "request.invalid", Message: "Invalid request body"}
	apiErrorInvalidPageSize     = APIError{Status: http.StatusBadRequest, Code: "pagination.invalid_page_size", Message: "Invalid page size"}
	apiErrorInvalidCursor       = APIError{Status: http.StatusBadRequest, Code: "pagination.invalid_cursor", Message: "Invalid cursor"}
	apiErrorInvalidTenantID     = APIError{Status: http.StatusBadRequest, Code: "tenant.invalid_id", Message: "Invalid tenant id"}
	apiErrorInvalidTenantName   = APIError{Status: http.StatusBadRequest, Code: "tenant.invalid_name", Message: "Invalid tenant name"}
	apiErrorInvalidTenantRegion = APIError{Status: http.StatusBadRequest, Code: "tenant.invalid_region", Message: "Invalid tenant region"}
	apiErrorInvalidTenantField  = APIError{Status: http.StatusBadRequest, Code: "tenant.invalid_field", Message: "Invalid tenant field"}
	apiErrorTenantNotFound      = APIError{Status: http.StatusNotFound, Code: "tenant.not_found", Message: "Tenant not found"}
	apiErrorRateLimited         = APIError{Status: http.StatusTooManyRequests, Code: "request.rate_limited", Message: "Too many requests"}
	apiErrorPayloadTooLarge     = APIError{Status: http.StatusRequestEntityTooLarge, Code: "request.payload_too_large", Message: "Request body is too large"}
	apiErrorInternal            = APIError{Status: http.StatusInternalServerError, Code: "service.internal_error", Message: "Internal server error"}

	apiErrorInvalidEmail              = APIError{Status: http.StatusBadRequest, Code: "identity.invalid_email", Message: "Invalid email"}
	apiErrorInvalidPassword           = APIError{Status: http.StatusBadRequest, Code: "access.invalid_password", Message: "Invalid password"}
	apiErrorInvalidUserID             = APIError{Status: http.StatusBadRequest, Code: "user.invalid_id", Message: "Invalid user id"}
	apiErrorInvalidUserName           = APIError{Status: http.StatusBadRequest, Code: "user.invalid_name", Message: "Invalid user name"}
	apiErrorInvalidUserEmail          = APIError{Status: http.StatusBadRequest, Code: "user.invalid_email", Message: "Invalid user email"}
	apiErrorEmailAlreadyRegistered    = APIError{Status: http.StatusConflict, Code: "identity.email_registered", Message: "Email already registered"}
	apiErrorEmailVerificationRequired = APIError{Status: http.StatusForbidden, Code: "identity.email_verification_required", Message: "Email verification is required"}
	apiErrorInvalidCredentials        = APIError{Status: http.StatusUnauthorized, Code: "access.invalid_credentials", Message: "Invalid email or password"}
	apiErrorOAuthNotConfigured        = APIError{Status: http.StatusServiceUnavailable, Code: "oauth.not_configured", Message: "OAuth is not configured"}
	apiErrorInvalidOAuthState         = APIError{Status: http.StatusBadRequest, Code: "oauth.invalid_state", Message: "Invalid OAuth state"}
	apiErrorOAuthEmailConflict        = APIError{Status: http.StatusConflict, Code: "oauth.email_conflict", Message: "Email is already registered with another sign-in method"}
	apiErrorOAuthEmailNotVerified     = APIError{Status: http.StatusUnauthorized, Code: "oauth.email_not_verified", Message: "Google email is not verified"}
	apiErrorUserNotFound              = APIError{Status: http.StatusNotFound, Code: "user.not_found", Message: "User not found"}

	apiErrorInvalidMembershipID   = APIError{Status: http.StatusBadRequest, Code: "membership.invalid_id", Message: "Invalid membership id"}
	apiErrorInvalidMembershipRole = APIError{Status: http.StatusBadRequest, Code: "membership.invalid_role", Message: "Invalid membership role"}
	apiErrorMembershipNotFound    = APIError{Status: http.StatusNotFound, Code: "membership.not_found", Message: "Membership not found"}

	apiErrorInvalidSpaceID                = APIError{Status: http.StatusBadRequest, Code: "space.invalid_id", Message: "Invalid Space id"}
	apiErrorInvalidEpisodeID              = APIError{Status: http.StatusBadRequest, Code: "episode.invalid_id", Message: "Invalid Episode id"}
	apiErrorInvalidSpaceName              = APIError{Status: http.StatusBadRequest, Code: "space.invalid_name", Message: "Invalid Space name"}
	apiErrorInvalidSpaceSlug              = APIError{Status: http.StatusBadRequest, Code: "space.invalid_slug", Message: "Invalid Space slug"}
	apiErrorInvalidMediaPlane             = APIError{Status: http.StatusBadRequest, Code: "space.invalid_media_plane", Message: "Invalid media plane"}
	apiErrorInvalidSpaceField             = APIError{Status: http.StatusBadRequest, Code: "space.invalid_field", Message: "Invalid Space field"}
	apiErrorSpaceSlugAlreadyUsed          = APIError{Status: http.StatusConflict, Code: "space.slug_conflict", Message: "Space slug already used"}
	apiErrorSpaceNotFound                 = APIError{Status: http.StatusNotFound, Code: "space.not_found", Message: "Space not found"}
	apiErrorInvalidSpaceArchiveFilter     = APIError{Status: http.StatusBadRequest, Code: "space.invalid_archive_filter", Message: "Invalid archived filter"}
	apiErrorEpisodeNotFound               = APIError{Status: http.StatusNotFound, Code: "episode.not_found", Message: "Episode not found"}
	apiErrorInvalidParticipantID          = APIError{Status: http.StatusBadRequest, Code: "participant.invalid_id", Message: "Invalid Participant id"}
	apiErrorInvalidRequestKey             = APIError{Status: http.StatusBadRequest, Code: "request.invalid_idempotency_key", Message: "Idempotency-Key must contain 16 to 128 ASCII letters, digits, underscores, or hyphens"}
	apiErrorEpisodeNotActive              = APIError{Status: http.StatusConflict, Code: "episode.not_active", Message: "Episode is not active"}
	apiErrorParticipantNotFound           = APIError{Status: http.StatusNotFound, Code: "participant.not_found", Message: "Participant not found"}
	apiErrorParticipantNotActive          = APIError{Status: http.StatusConflict, Code: "participant.not_active", Message: "Participant is not active"}
	apiErrorParticipantGenerationMismatch = APIError{Status: http.StatusConflict, Code: "participant.generation_mismatch", Message: "Participant generation does not match"}
	apiErrorIdempotencyConflict           = APIError{Status: http.StatusConflict, Code: "request.idempotency_conflict", Message: "Idempotency key was already used for another request"}
	apiErrorEpisodeCapacityExceeded       = APIError{Status: http.StatusConflict, Code: "episode.capacity_exceeded", Message: "Episode capacity is exhausted"}
	apiErrorMediaPlaneUnavailable         = APIError{Status: http.StatusServiceUnavailable, Code: "media.unavailable", Message: "Media plane is unavailable"}

	apiErrorInvalidRecordingID               = APIError{Status: http.StatusBadRequest, Code: "recording.invalid_id", Message: "Invalid recording id"}
	apiErrorInvalidRecordingStatus           = APIError{Status: http.StatusBadRequest, Code: "recording.invalid_status", Message: "Invalid recording status"}
	apiErrorInvalidStorageProvider           = APIError{Status: http.StatusBadRequest, Code: "storage.invalid_provider", Message: "Invalid storage provider"}
	apiErrorInvalidStorageKey                = APIError{Status: http.StatusBadRequest, Code: "storage.invalid_key", Message: "Invalid storage key"}
	apiErrorInvalidRecordingField            = APIError{Status: http.StatusBadRequest, Code: "recording.invalid_field", Message: "Invalid recording field"}
	apiErrorInvalidURLExpiration             = APIError{Status: http.StatusBadRequest, Code: "url.invalid_expiration", Message: "Invalid url expiration"}
	apiErrorRecordingNotReady                = APIError{Status: http.StatusBadRequest, Code: "recording.not_ready", Message: "Recording is not ready"}
	apiErrorInvalidRecordingReservationID    = APIError{Status: http.StatusBadRequest, Code: "recording_reservation.invalid_id", Message: "Invalid recording reservation id"}
	apiErrorInvalidRecordingParticipantCount = APIError{Status: http.StatusBadRequest, Code: "recording.invalid_participant_count", Message: "Recording participant count must be between one and ten"}
	apiErrorInvalidRecordingDuration         = APIError{Status: http.StatusBadRequest, Code: "recording.invalid_duration", Message: "Recording duration must be between one and 120 minutes"}
	apiErrorInvalidRecordingBitrate          = APIError{Status: http.StatusBadRequest, Code: "recording.invalid_bitrate", Message: "Recording bitrate exceeds the qualified limit"}
	apiErrorRecordingCapacityUnavailable     = APIError{Status: http.StatusServiceUnavailable, Code: "recording.capacity_unavailable", Message: "Recording capacity is unavailable"}
	apiErrorRecordingReservationNotFound     = APIError{Status: http.StatusNotFound, Code: "recording_reservation.not_found", Message: "Recording reservation not found"}
	apiErrorRecordingNotFound                = APIError{Status: http.StatusNotFound, Code: "recording.not_found", Message: "Recording not found"}
	apiErrorRecordingArtifactNotFound        = APIError{Status: http.StatusNotFound, Code: "recording_artifact.not_found", Message: "Recording artifact not found"}

	apiErrorInvalidTranscriptID        = APIError{Status: http.StatusBadRequest, Code: "transcript.invalid_id", Message: "Invalid transcript id"}
	apiErrorInvalidTranscriptStatus    = APIError{Status: http.StatusBadRequest, Code: "transcript.invalid_status", Message: "Invalid transcript status"}
	apiErrorInvalidTranscriptProvider  = APIError{Status: http.StatusBadRequest, Code: "transcript.invalid_provider", Message: "Invalid transcript provider"}
	apiErrorInvalidTranscriptModel     = APIError{Status: http.StatusBadRequest, Code: "transcript.invalid_model", Message: "Invalid transcript model"}
	apiErrorInvalidTranscriptLanguages = APIError{Status: http.StatusBadRequest, Code: "transcript.invalid_languages", Message: "Invalid transcript languages"}
	apiErrorInvalidTranscriptField     = APIError{Status: http.StatusBadRequest, Code: "transcript.invalid_field", Message: "Invalid transcript field"}
	apiErrorTranscriptNotFound         = APIError{Status: http.StatusNotFound, Code: "transcript.not_found", Message: "Transcript not found"}
	apiErrorTranscriptNotReady         = APIError{Status: http.StatusConflict, Code: "transcript.not_ready", Message: "Transcript artifact is not ready"}

	apiErrorInvalidAIConfig        = APIError{Status: http.StatusBadRequest, Code: "ai.invalid_config", Message: "Invalid AI config"}
	apiErrorInvalidAIGateway       = APIError{Status: http.StatusBadRequest, Code: "ai.invalid_gateway", Message: "Invalid AI gateway"}
	apiErrorMissingAICredentials   = APIError{Status: http.StatusBadRequest, Code: "ai.missing_credentials", Message: "Missing AI credentials"}
	apiErrorInvalidAIModel         = APIError{Status: http.StatusBadRequest, Code: "ai.invalid_model", Message: "Invalid AI model"}
	apiErrorInvalidAIAudio         = APIError{Status: http.StatusBadRequest, Code: "ai.invalid_audio", Message: "Invalid AI audio"}
	apiErrorAIProviderUnauthorized = APIError{Status: http.StatusBadGateway, Code: "ai.provider_unauthorized", Message: "AI provider rejected credentials"}
	apiErrorAIProviderPayment      = APIError{Status: http.StatusBadGateway, Code: "ai.provider_payment_required", Message: "AI provider requires payment"}
	apiErrorAIProviderRateLimited  = APIError{Status: http.StatusTooManyRequests, Code: "ai.provider_rate_limited", Message: "AI provider rate limited the request"}
	apiErrorAIProviderFailed       = APIError{Status: http.StatusBadGateway, Code: "ai.provider_failed", Message: "AI provider request failed"}

	apiErrorInvalidAuditLogID = APIError{Status: http.StatusBadRequest, Code: "audit.invalid_id", Message: "Invalid audit log id"}
	apiErrorAuditLogNotFound  = APIError{Status: http.StatusNotFound, Code: "audit.not_found", Message: "Audit log not found"}

	apiErrorInvalidWebhookEndpointID        = APIError{Status: http.StatusBadRequest, Code: "webhook.invalid_endpoint_id", Message: "Invalid webhook endpoint id"}
	apiErrorInvalidWebhookDeliveryID        = APIError{Status: http.StatusBadRequest, Code: "webhook.invalid_delivery_id", Message: "Invalid webhook delivery id"}
	apiErrorInvalidWebhookURL               = APIError{Status: http.StatusBadRequest, Code: "webhook.invalid_url", Message: "Invalid webhook URL"}
	apiErrorUnsafeWebhookURL                = APIError{Status: http.StatusBadRequest, Code: "webhook.unsafe_url", Message: "Webhook URL is not a safe public HTTPS destination"}
	apiErrorInvalidWebhookEventType         = APIError{Status: http.StatusBadRequest, Code: "webhook.invalid_event_type", Message: "Invalid webhook event type"}
	apiErrorWebhookEventTypeUnavailable     = APIError{Status: http.StatusConflict, Code: "webhook.event_type_unavailable", Message: "Webhook event type is not available"}
	apiErrorInvalidWebhookAPIVersion        = APIError{Status: http.StatusBadRequest, Code: "webhook.invalid_api_version", Message: "Invalid webhook API version"}
	apiErrorWebhookEndpointLimit            = APIError{Status: http.StatusConflict, Code: "webhook.endpoint_limit_reached", Message: "Webhook endpoint limit reached"}
	apiErrorWebhookEndpointNotFound         = APIError{Status: http.StatusNotFound, Code: "webhook.endpoint_not_found", Message: "Webhook endpoint not found"}
	apiErrorWebhookDeliveryNotFound         = APIError{Status: http.StatusNotFound, Code: "webhook.delivery_not_found", Message: "Webhook delivery not found"}
	apiErrorWebhookDeliveryNotRedeliverable = APIError{Status: http.StatusConflict, Code: "webhook.delivery_not_redeliverable", Message: "Webhook delivery cannot be redelivered"}
	apiErrorWebhookEventErased              = APIError{Status: http.StatusGone, Code: "webhook.event_erased", Message: "Webhook event body was erased"}
	apiErrorWebhookRevisionConflict         = APIError{Status: http.StatusPreconditionFailed, Code: "webhook.endpoint_revision_conflict", Message: "Webhook endpoint revision does not match"}
	apiErrorWebhookIdempotencyRequired      = APIError{Status: http.StatusBadRequest, Code: "webhook.idempotency_key_required", Message: "Idempotency-Key is required"}
	apiErrorWebhookIdempotencyConflict      = APIError{Status: http.StatusConflict, Code: "webhook.idempotency_conflict", Message: "Idempotency key was used for another request"}
	apiErrorWebhookIdempotencyExpired       = APIError{Status: http.StatusConflict, Code: "webhook.idempotency_expired", Message: "Idempotency key has expired"}

	apiErrorInvalidJourneyID         = APIError{Status: http.StatusBadRequest, Code: "journey.invalid_id", Message: "Invalid journey id"}
	apiErrorInvalidJourneyEvent      = APIError{Status: http.StatusBadRequest, Code: "journey.invalid_event", Message: "Invalid journey event"}
	apiErrorJourneyNotFound          = APIError{Status: http.StatusNotFound, Code: "journey.not_found", Message: "Journey not found"}
	apiErrorJourneyLedgerUnavailable = APIError{Status: http.StatusServiceUnavailable, Code: "journey.ledger_unavailable", Message: "Journey ledger is unavailable"}

	apiErrorInvalidStatusResult = APIError{Status: http.StatusBadRequest, Code: "status.invalid_result", Message: "Invalid monitor result"}
	apiErrorStatusUnavailable   = APIError{Status: http.StatusServiceUnavailable, Code: "status.unavailable", Message: "Status is unavailable"}

	apiErrorInvalidIntegrationCallbackURL       = APIError{Status: http.StatusBadRequest, Code: "integration.invalid_callback_url", Message: "Invalid callback URL"}
	apiErrorInvalidIntegrationProvider          = APIError{Status: http.StatusBadRequest, Code: "integration.invalid_provider", Message: "Invalid integration provider"}
	apiErrorInvalidIntegrationService           = APIError{Status: http.StatusBadRequest, Code: "integration.invalid_service", Message: "Invalid integration service"}
	apiErrorInvalidIntegrationConnectionID      = APIError{Status: http.StatusBadRequest, Code: "integration.invalid_connection_id", Message: "Invalid integration connection id"}
	apiErrorInvalidIntegrationAction            = APIError{Status: http.StatusBadRequest, Code: "integration.invalid_action", Message: "Invalid integration action"}
	apiErrorInvalidIntegrationActionInput       = APIError{Status: http.StatusBadRequest, Code: "integration.invalid_action_input", Message: "Use either action arguments or text"}
	apiErrorInvalidIntegrationActionText        = APIError{Status: http.StatusBadRequest, Code: "integration.invalid_action_text", Message: "Invalid integration action text"}
	apiErrorIntegrationProviderUnauthorized     = APIError{Status: http.StatusBadGateway, Code: "integration.provider_unauthorized", Message: "Integration provider rejected the request"}
	apiErrorIntegrationProviderRateLimited      = APIError{Status: http.StatusTooManyRequests, Code: "integration.provider_rate_limited", Message: "Integration provider rate limited the request"}
	apiErrorIntegrationProviderAuthUnconfigured = APIError{Status: http.StatusServiceUnavailable, Code: "integration.provider_unavailable", Message: "Integration provider auth is not configured"}
	apiErrorIntegrationProviderUnavailable      = APIError{Status: http.StatusBadGateway, Code: "integration.provider_unavailable", Message: "Integration provider unavailable"}
	apiErrorIntegrationConnectionNotFound       = APIError{Status: http.StatusNotFound, Code: "integration.connection_not_found", Message: "Integration connection not found"}
	apiErrorIntegrationConnectionAlreadyExists  = APIError{Status: http.StatusConflict, Code: "integration.connection_already_exists", Message: "Integration connection already exists"}
	apiErrorIntegrationConnectionNotActive      = APIError{Status: http.StatusConflict, Code: "integration.connection_not_active", Message: "Integration connection is not active"}
	apiErrorIntegrationActionNotAllowed         = APIError{Status: http.StatusForbidden, Code: "integration.action_not_allowed", Message: "Integration action not allowed"}
)

func writeAPIError(w http.ResponseWriter, err APIError) {
	writeError(w, err.Status, err.Code, err.Message)
}
