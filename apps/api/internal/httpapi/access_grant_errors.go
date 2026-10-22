package httpapi

import (
	"errors"
	"net/http"

	"github.com/q9labs/chalk/apps/api/internal/accessgrants"
)

var apiErrorMediaTokenRequired = APIError{Status: http.StatusBadRequest, Code: "media_token.required", Message: "Current media token is required unless replacing the media connection"}

// Keep credential rejection codes in the route contract as well as its mapper.
var accessGrantTokenErrors = []struct {
	cause    error
	response APIError
}{
	{accessgrants.ErrMalformedCredential, APIError{Status: 400, Code: "media_token.malformed", Message: "Malformed media token"}},
	{accessgrants.ErrInvalidHeader, APIError{Status: 400, Code: "media_token.invalid_header", Message: "Invalid media token header"}},
	{accessgrants.ErrUnknownKey, APIError{Status: 401, Code: "media_token.unknown_key", Message: "Unknown media token signing key"}},
	{accessgrants.ErrInvalidSignature, APIError{Status: 401, Code: "media_token.invalid_signature", Message: "Invalid media token signature"}},
	{accessgrants.ErrInvalidIssuer, APIError{Status: 401, Code: "media_token.invalid_issuer", Message: "Invalid media token issuer"}},
	{accessgrants.ErrInvalidAudience, APIError{Status: 401, Code: "media_token.invalid_audience", Message: "Invalid media token audience"}},
	{accessgrants.ErrInvalidTimeClaims, APIError{Status: 400, Code: "media_token.invalid_time_claims", Message: "Invalid media token time claims"}},
	{accessgrants.ErrNotYetValid, APIError{Status: 401, Code: "media_token.not_yet_valid", Message: "Media token is not yet valid"}},
	{accessgrants.ErrExpired, APIError{Status: 401, Code: "media_token.expired", Message: "Media token has expired"}},
	{accessgrants.ErrLifetimeExceeded, APIError{Status: 400, Code: "media_token.lifetime_exceeded", Message: "Media token lifetime exceeds the limit"}},
	{accessgrants.ErrInvalidSubject, APIError{Status: 400, Code: "media_token.invalid_subject", Message: "Invalid media token subject"}},
	{accessgrants.ErrSubjectMismatch, APIError{Status: 403, Code: "media_token.subject_mismatch", Message: "Media token does not match the requested participant"}},
	{accessgrants.ErrConnectionSuperseded, APIError{Status: 409, Code: "participant.connection_superseded", Message: "Participant media connection has been superseded"}},
	{accessgrants.ErrGenerationMismatch, apiErrorParticipantGenerationMismatch},
}

func accessGrantRefreshError(err error) error {
	for _, rejection := range accessGrantTokenErrors {
		if errors.Is(err, rejection.cause) {
			return rejection.response
		}
	}
	return err
}

func accessGrantErrors(existing []APIError) []APIError {
	result := append(existing, apiErrorMediaTokenRequired)
	for _, rejection := range accessGrantTokenErrors {
		result = append(result, rejection.response)
	}
	return result
}

func accessGrantAPIError(err error) APIError {
	if apiErr, ok := errorAsAPIError(err); ok {
		return apiErr
	}
	if apiErr, ok := episodeLifecycleEndpointAPIError(err); ok {
		return apiErr
	}
	return apiErrorInternal
}
