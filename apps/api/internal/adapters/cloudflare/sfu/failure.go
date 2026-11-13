package sfu

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"

	"github.com/q9labs/chalk/apps/api/internal/mediaplane"
)

const (
	failureStageTransport  providerFailureStage = "transport"
	failureStageHTTPStatus providerFailureStage = "http_status"
	failureStageDecode     providerFailureStage = "decode"
	failureStageTopLevel   providerFailureStage = "top_level"
	failureStageTrack      providerFailureStage = "track"
	failureStageContract   providerFailureStage = "contract"
)

type providerFailureStage string

type providerFailure struct {
	operation                  string
	stage                      providerFailureStage
	statusCode                 int
	statusClass                string
	providerCode               string
	transportCause             mediaplane.TransportCause
	trackCode                  string
	details                    providerFailureDetails
	missingRemoteTracks        []mediaplane.RemoteTrackIdentity
	exactRemoteAbsence         bool
	partialRemoteTracks        bool
	retryableTrackAvailability bool
}

func (e providerFailure) Error() string {
	message := fmt.Sprintf(
		"cloudflare sfu %s failed: stage=%s status=%d status_class=%s provider_code=%s",
		e.operation,
		e.stage,
		e.statusCode,
		e.statusClass,
		e.providerCode,
	)
	if e.details.rawCode != "" {
		message += " provider_raw_code=" + e.details.rawCode
	}
	if e.details.messageFingerprint != "" {
		message += " provider_message_fingerprint=" + e.details.messageFingerprint
	}
	return message
}

func (e providerFailure) ProviderFailureCode() string { return e.providerCode }

func (e providerFailure) UpstreamStatus() int { return e.statusCode }

func (e providerFailure) UpstreamCode() string { return e.providerCode }

func (e providerFailure) Unwrap() error {
	switch {
	case e.transportCause == mediaplane.TransportCauseCallerCanceled:
		return context.Canceled
	case e.providerCode == "plane_unavailable":
		return mediaplane.ErrPlaneUnavailable
	case e.statusCode == http.StatusUnauthorized, e.statusCode == http.StatusForbidden:
		return mediaplane.ErrProviderUnauthorized
	case e.statusCode == http.StatusNotFound, e.statusCode == http.StatusGone:
		if connectionOperation(e.operation) {
			return mediaplane.ErrConnectionNotFound
		}
		return mediaplane.ErrEpisodeNotFound
	case e.statusCode == http.StatusTooManyRequests:
		return mediaplane.ErrProviderRateLimited
	default:
		return mediaplane.ErrProviderFailed
	}
}

func isSuccessfulHTTPStatus(statusCode int) bool {
	return statusCode >= http.StatusOK && statusCode < http.StatusMultipleChoices
}

func newProviderFailure(operation string, stage providerFailureStage, statusCode int, providerCode string) providerFailure {
	return providerFailure{
		operation:    normalizedOperation(operation),
		stage:        stage,
		statusCode:   statusCode,
		statusClass:  providerStatusClass(statusCode),
		providerCode: normalizedProviderCode(providerCode),
	}
}

func normalizedOperation(operation string) string {
	switch operation {
	case "add_tracks", "close_tracks", "create_connection", "renegotiate", "update_tracks", "verify_connection":
		return operation
	default:
		return "unknown"
	}
}

func connectionOperation(operation string) bool {
	switch operation {
	case "add_tracks", "close_tracks", "renegotiate", "update_tracks", "verify_connection":
		return true
	default:
		return false
	}
}

func providerStatusClass(statusCode int) string {
	if statusCode < 100 || statusCode > 599 {
		return "none"
	}
	return fmt.Sprintf("%dxx", statusCode/100)
}

func providerRejectionCode(code string, message string) string {
	if strings.TrimSpace(code) == "" {
		if messageCode := providerMessageCode(message); messageCode != "" {
			return messageCode
		}
		return "provider_rejected"
	}
	return code
}

func normalizedProviderCode(code string) string {
	switch strings.ToLower(strings.TrimSpace(code)) {
	case "invalid_request", "bad_request":
		return "invalid_request"
	case "invalid_track":
		return "invalid_track"
	case "session_not_found", "connection_not_found":
		return "connection_not_found"
	case "session_not_connected", "not_connected", "connection_not_ready", "session_not_ready", "connection_not_connected":
		return "connection_not_connected"
	case "track_not_found":
		return "track_not_found"
	case "empty_track_error":
		return "empty_track_error"
	case "track_already_closed":
		return "track_already_closed"
	case "unauthorized", "forbidden":
		return "unauthorized"
	case "rate_limited", "too_many_requests":
		return "rate_limited"
	case "timeout", "request_timeout", "deadline_exceeded":
		return "timeout"
	case "transport_error":
		return "transport_error"
	case "client_canceled":
		return "client_canceled"
	case "plane_unavailable":
		return "plane_unavailable"
	case "invalid_json":
		return "invalid_json"
	case "invalid_contract":
		return "invalid_contract"
	case "provider_rejected":
		return "provider_rejected"
	case "internal_error", "upstream_error":
		return "provider_internal"
	default:
		return "unknown"
	}
}

func sfuStatusError(operation string, statusCode int, payload []byte) error {
	var envelope providerErrorEnvelope
	_ = json.Unmarshal(payload, &envelope)
	code := envelope.ErrorCode
	message := envelope.ErrorDescription
	if strings.TrimSpace(code) == "" {
		for _, providerError := range envelope.Errors {
			if strings.TrimSpace(providerError.Code) != "" {
				code = providerError.Code
			}
			if strings.TrimSpace(message) == "" {
				message = providerError.Message
			}
			if strings.TrimSpace(code) != "" && strings.TrimSpace(message) != "" {
				break
			}
		}
	}
	if strings.TrimSpace(code) == "" {
		switch statusCode {
		case http.StatusUnauthorized, http.StatusForbidden:
			code = "unauthorized"
		case http.StatusNotFound, http.StatusGone:
			code = "session_not_found"
		case http.StatusTooManyRequests:
			code = "rate_limited"
		case http.StatusTooEarly:
			code = "session_not_connected"
		case http.StatusRequestTimeout, http.StatusGatewayTimeout:
			code = "timeout"
		default:
			code = "unknown"
		}
	}

	if statusCode == http.StatusTooEarly && code == "session_error" && providerMessageCode(message) == "connection_not_connected" {
		code = "session_not_connected"
	}
	failure := newProviderFailure(operation, failureStageHTTPStatus, statusCode, providerRejectionCode(code, message))
	failure.details.rawCode = observableHTTPProviderCode(payload)
	return failure
}
