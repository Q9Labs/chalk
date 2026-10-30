package httpapi

import (
	"errors"
	"net/http"

	"github.com/q9labs/chalk/apps/api/internal/accessgrants"
	"github.com/q9labs/chalk/platform/httpcontract"
)

var apiErrorMediaTokenRequired = httpcontract.APIError{Status: http.StatusBadRequest, Code: "media_token.required", Message: "Current media token is required unless replacing the media connection"}

// Keep credential rejection codes in the route contract as well as its mapper.
var accessGrantTokenErrors = []struct {
	cause    error
	response httpcontract.APIError
}{
	{accessgrants.ErrMalformedCredential, httpcontract.APIError{Status: 400, Code: "media_token.malformed", Message: "Malformed media token"}},
	{accessgrants.ErrInvalidHeader, httpcontract.APIError{Status: 400, Code: "media_token.invalid_header", Message: "Invalid media token header"}},
	{accessgrants.ErrUnknownKey, httpcontract.APIError{Status: 401, Code: "media_token.unknown_key", Message: "Unknown media token signing key"}},
	{accessgrants.ErrInvalidSignature, httpcontract.APIError{Status: 401, Code: "media_token.invalid_signature", Message: "Invalid media token signature"}},
	{accessgrants.ErrInvalidIssuer, httpcontract.APIError{Status: 401, Code: "media_token.invalid_issuer", Message: "Invalid media token issuer"}},
	{accessgrants.ErrInvalidAudience, httpcontract.APIError{Status: 401, Code: "media_token.invalid_audience", Message: "Invalid media token audience"}},
	{accessgrants.ErrInvalidTimeClaims, httpcontract.APIError{Status: 400, Code: "media_token.invalid_time_claims", Message: "Invalid media token time claims"}},
	{accessgrants.ErrNotYetValid, httpcontract.APIError{Status: 401, Code: "media_token.not_yet_valid", Message: "Media token is not yet valid"}},
	{accessgrants.ErrExpired, httpcontract.APIError{Status: 401, Code: "media_token.expired", Message: "Media token has expired"}},
	{accessgrants.ErrLifetimeExceeded, httpcontract.APIError{Status: 400, Code: "media_token.lifetime_exceeded", Message: "Media token lifetime exceeds the limit"}},
	{accessgrants.ErrInvalidSubject, httpcontract.APIError{Status: 400, Code: "media_token.invalid_subject", Message: "Invalid media token subject"}},
	{accessgrants.ErrSubjectMismatch, httpcontract.APIError{Status: 403, Code: "media_token.subject_mismatch", Message: "Media token does not match the requested participant"}},
	{accessgrants.ErrConnectionSuperseded, httpcontract.APIError{Status: 409, Code: "participant.connection_superseded", Message: "Participant media connection has been superseded"}},
	{accessgrants.ErrRefreshPending, httpcontract.APIError{Status: 409, Code: "participant.media_replacement_pending", Message: "Participant media replacement is still pending; retry this request"}},
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

func accessGrantErrors(existing []httpcontract.APIError) []httpcontract.APIError {
	result := append(existing, apiErrorMediaTokenRequired)
	for _, rejection := range accessGrantTokenErrors {
		result = append(result, rejection.response)
	}
	return result
}

func accessGrantAPIError(err error) httpcontract.APIError {
	if apiErr, ok := errorAsAPIError(err); ok {
		return apiErr
	}
	if apiErr, ok := episodeLifecycleEndpointAPIError(err); ok {
		return apiErr
	}
	return apiErrorInternal
}
