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
	apiErrorUnauthenticated     = APIError{Status: http.StatusUnauthorized, Code: "unauthenticated", Message: "Authentication required"}
	apiErrorForbidden           = APIError{Status: http.StatusForbidden, Code: "forbidden", Message: "Access denied"}
	apiErrorServiceUnavailable  = APIError{Status: http.StatusServiceUnavailable, Code: "service_unavailable", Message: "Service is not ready"}
	apiErrorInvalidRequest      = APIError{Status: http.StatusBadRequest, Code: "invalid_request", Message: "Invalid request body"}
	apiErrorInvalidPageSize     = APIError{Status: http.StatusBadRequest, Code: "invalid_page_size", Message: "Invalid page size"}
	apiErrorInvalidCursor       = APIError{Status: http.StatusBadRequest, Code: "invalid_cursor", Message: "Invalid cursor"}
	apiErrorInvalidTenantID     = APIError{Status: http.StatusBadRequest, Code: "invalid_tenant_id", Message: "Invalid tenant id"}
	apiErrorInvalidTenantName   = APIError{Status: http.StatusBadRequest, Code: "invalid_tenant_name", Message: "Invalid tenant name"}
	apiErrorInvalidTenantRegion = APIError{Status: http.StatusBadRequest, Code: "invalid_tenant_region", Message: "Invalid tenant region"}
	apiErrorInvalidTenantField  = APIError{Status: http.StatusBadRequest, Code: "invalid_tenant_field", Message: "Invalid tenant field"}
	apiErrorTenantNotFound      = APIError{Status: http.StatusNotFound, Code: "not_found", Message: "Tenant not found"}
	apiErrorRateLimited         = APIError{Status: http.StatusTooManyRequests, Code: "rate_limited", Message: "Too many requests"}
	apiErrorPayloadTooLarge     = APIError{Status: http.StatusRequestEntityTooLarge, Code: "payload_too_large", Message: "Request body is too large"}
	apiErrorInternal            = APIError{Status: http.StatusInternalServerError, Code: "internal_error", Message: "Internal server error"}

	apiErrorInvalidEmail              = APIError{Status: http.StatusBadRequest, Code: "invalid_email", Message: "Invalid email"}
	apiErrorInvalidPassword           = APIError{Status: http.StatusBadRequest, Code: "invalid_password", Message: "Invalid password"}
	apiErrorInvalidUserID             = APIError{Status: http.StatusBadRequest, Code: "invalid_user_id", Message: "Invalid user id"}
	apiErrorInvalidUserName           = APIError{Status: http.StatusBadRequest, Code: "invalid_user_name", Message: "Invalid user name"}
	apiErrorInvalidUserEmail          = APIError{Status: http.StatusBadRequest, Code: "invalid_user_email", Message: "Invalid user email"}
	apiErrorEmailAlreadyRegistered    = APIError{Status: http.StatusConflict, Code: "email_already_registered", Message: "Email already registered"}
	apiErrorEmailVerificationRequired = APIError{Status: http.StatusForbidden, Code: "email_verification_required", Message: "Email verification is required"}
	apiErrorInvalidCredentials        = APIError{Status: http.StatusUnauthorized, Code: "invalid_credentials", Message: "Invalid email or password"}
	apiErrorOAuthNotConfigured        = APIError{Status: http.StatusServiceUnavailable, Code: "oauth_not_configured", Message: "OAuth is not configured"}
	apiErrorInvalidOAuthState         = APIError{Status: http.StatusBadRequest, Code: "invalid_oauth_state", Message: "Invalid OAuth state"}
	apiErrorOAuthEmailConflict        = APIError{Status: http.StatusConflict, Code: "oauth_email_conflict", Message: "Email is already registered with another sign-in method"}
	apiErrorOAuthEmailNotVerified     = APIError{Status: http.StatusUnauthorized, Code: "oauth_email_not_verified", Message: "Google email is not verified"}
	apiErrorUserNotFound              = APIError{Status: http.StatusNotFound, Code: "not_found", Message: "User not found"}

	apiErrorInvalidMembershipID   = APIError{Status: http.StatusBadRequest, Code: "invalid_membership_id", Message: "Invalid membership id"}
	apiErrorInvalidMembershipRole = APIError{Status: http.StatusBadRequest, Code: "invalid_membership_role", Message: "Invalid membership role"}
	apiErrorMembershipNotFound    = APIError{Status: http.StatusNotFound, Code: "not_found", Message: "Membership not found"}

	apiErrorInvalidRoomID        = APIError{Status: http.StatusBadRequest, Code: "invalid_room_id", Message: "Invalid room id"}
	apiErrorInvalidSessionID     = APIError{Status: http.StatusBadRequest, Code: "invalid_session_id", Message: "Invalid session id"}
	apiErrorInvalidRoomName      = APIError{Status: http.StatusBadRequest, Code: "invalid_room_name", Message: "Invalid room name"}
	apiErrorInvalidRoomSlug      = APIError{Status: http.StatusBadRequest, Code: "invalid_room_slug", Message: "Invalid room slug"}
	apiErrorInvalidRoomStatus    = APIError{Status: http.StatusBadRequest, Code: "invalid_room_status", Message: "Invalid room status"}
	apiErrorInvalidMediaPlane    = APIError{Status: http.StatusBadRequest, Code: "invalid_media_plane", Message: "Invalid media plane"}
	apiErrorInvalidSessionStatus = APIError{Status: http.StatusBadRequest, Code: "invalid_session_status", Message: "Invalid session status"}
	apiErrorInvalidRoomField     = APIError{Status: http.StatusBadRequest, Code: "invalid_room_field", Message: "Invalid room field"}
	apiErrorRoomSlugAlreadyUsed  = APIError{Status: http.StatusConflict, Code: "room_slug_already_used", Message: "Room slug already used"}
	apiErrorRoomNotFound         = APIError{Status: http.StatusNotFound, Code: "not_found", Message: "Room not found"}
	apiErrorSessionNotFound      = APIError{Status: http.StatusNotFound, Code: "not_found", Message: "Room session not found"}

	apiErrorInvalidRecordingID        = APIError{Status: http.StatusBadRequest, Code: "invalid_recording_id", Message: "Invalid recording id"}
	apiErrorInvalidRecordingStatus    = APIError{Status: http.StatusBadRequest, Code: "invalid_recording_status", Message: "Invalid recording status"}
	apiErrorInvalidStorageProvider    = APIError{Status: http.StatusBadRequest, Code: "invalid_storage_provider", Message: "Invalid storage provider"}
	apiErrorInvalidStorageKey         = APIError{Status: http.StatusBadRequest, Code: "invalid_storage_key", Message: "Invalid storage key"}
	apiErrorInvalidRecordingField     = APIError{Status: http.StatusBadRequest, Code: "invalid_recording_field", Message: "Invalid recording field"}
	apiErrorInvalidURLExpiration      = APIError{Status: http.StatusBadRequest, Code: "invalid_url_expiration", Message: "Invalid url expiration"}
	apiErrorRecordingNotReady         = APIError{Status: http.StatusBadRequest, Code: "recording_not_ready", Message: "Recording is not ready for download"}
	apiErrorRecordingNotFound         = APIError{Status: http.StatusNotFound, Code: "not_found", Message: "Recording not found"}
	apiErrorRecordingArtifactNotFound = APIError{Status: http.StatusNotFound, Code: "not_found", Message: "Recording artifact not found"}

	apiErrorInvalidTranscriptID        = APIError{Status: http.StatusBadRequest, Code: "invalid_transcript_id", Message: "Invalid transcript id"}
	apiErrorInvalidTranscriptStatus    = APIError{Status: http.StatusBadRequest, Code: "invalid_transcript_status", Message: "Invalid transcript status"}
	apiErrorInvalidTranscriptProvider  = APIError{Status: http.StatusBadRequest, Code: "invalid_transcript_provider", Message: "Invalid transcript provider"}
	apiErrorInvalidTranscriptModel     = APIError{Status: http.StatusBadRequest, Code: "invalid_transcript_model", Message: "Invalid transcript model"}
	apiErrorInvalidTranscriptLanguages = APIError{Status: http.StatusBadRequest, Code: "invalid_transcript_languages", Message: "Invalid transcript languages"}
	apiErrorInvalidTranscriptField     = APIError{Status: http.StatusBadRequest, Code: "invalid_transcript_field", Message: "Invalid transcript field"}
	apiErrorTranscriptNotFound         = APIError{Status: http.StatusNotFound, Code: "not_found", Message: "Transcript not found"}

	apiErrorInvalidAuditLogID = APIError{Status: http.StatusBadRequest, Code: "invalid_audit_log_id", Message: "Invalid audit log id"}
	apiErrorAuditLogNotFound  = APIError{Status: http.StatusNotFound, Code: "not_found", Message: "Audit log not found"}

	apiErrorInvalidIntegrationCallbackURL       = APIError{Status: http.StatusBadRequest, Code: "invalid_callback_url", Message: "Invalid callback URL"}
	apiErrorInvalidIntegrationProvider          = APIError{Status: http.StatusBadRequest, Code: "invalid_integration_provider", Message: "Invalid integration provider"}
	apiErrorInvalidIntegrationService           = APIError{Status: http.StatusBadRequest, Code: "invalid_integration_service", Message: "Invalid integration service"}
	apiErrorInvalidIntegrationConnectionID      = APIError{Status: http.StatusBadRequest, Code: "invalid_integration_connection_id", Message: "Invalid integration connection id"}
	apiErrorInvalidIntegrationAction            = APIError{Status: http.StatusBadRequest, Code: "invalid_integration_action", Message: "Invalid integration action"}
	apiErrorInvalidIntegrationActionInput       = APIError{Status: http.StatusBadRequest, Code: "invalid_integration_action_input", Message: "Use either action arguments or text"}
	apiErrorInvalidIntegrationActionText        = APIError{Status: http.StatusBadRequest, Code: "invalid_integration_action_text", Message: "Invalid integration action text"}
	apiErrorIntegrationProviderUnauthorized     = APIError{Status: http.StatusBadGateway, Code: "integration_provider_unauthorized", Message: "Integration provider rejected the request"}
	apiErrorIntegrationProviderRateLimited      = APIError{Status: http.StatusTooManyRequests, Code: "integration_provider_rate_limited", Message: "Integration provider rate limited the request"}
	apiErrorIntegrationProviderAuthUnconfigured = APIError{Status: http.StatusServiceUnavailable, Code: "integration_provider_unavailable", Message: "Integration provider auth is not configured"}
	apiErrorIntegrationProviderUnavailable      = APIError{Status: http.StatusBadGateway, Code: "integration_provider_unavailable", Message: "Integration provider unavailable"}
	apiErrorIntegrationConnectionNotFound       = APIError{Status: http.StatusNotFound, Code: "integration_connection_not_found", Message: "Integration connection not found"}
	apiErrorIntegrationConnectionAlreadyExists  = APIError{Status: http.StatusConflict, Code: "integration_connection_already_exists", Message: "Integration connection already exists"}
	apiErrorIntegrationConnectionNotActive      = APIError{Status: http.StatusConflict, Code: "integration_connection_not_active", Message: "Integration connection is not active"}
	apiErrorIntegrationActionNotAllowed         = APIError{Status: http.StatusForbidden, Code: "integration_action_not_allowed", Message: "Integration action not allowed"}
)

func writeAPIError(w http.ResponseWriter, err APIError) {
	writeError(w, err.Status, err.Code, err.Message)
}
