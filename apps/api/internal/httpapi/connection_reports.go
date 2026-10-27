package httpapi

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"slices"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/accessgrants"
	"github.com/q9labs/chalk/apps/api/internal/observability"
	"github.com/q9labs/chalk/apps/api/internal/ratelimit"
	"go.opentelemetry.io/otel/trace"
)

const ConnectionReportBodyLimit = 32768
const ConnectionReportEventLimit = 64
const ConnectionReportMaxMilliseconds = 2147483647

var connectionReportParticipantLimit = ratelimit.Policy{Name: "connection_reports.participant", Limit: 6, Window: 10 * time.Minute}

type connectionReport struct {
	Version int                     `json:"version"`
	Trigger string                  `json:"trigger"`
	Events  []connectionReportEvent `json:"events"`
}

type connectionReportEvent struct {
	Event          string `json:"event"`
	ElapsedMS      int64  `json:"elapsed_ms"`
	State          string `json:"state,omitempty"`
	Step           string `json:"step,omitempty"`
	Outcome        string `json:"outcome,omitempty"`
	Code           string `json:"code,omitempty"`
	Phase          string `json:"phase,omitempty"`
	Attempt        *int64 `json:"attempt,omitempty"`
	DurationMS     *int64 `json:"duration_ms,omitempty"`
	HeartbeatGapMS *int64 `json:"heartbeat_gap_ms,omitempty"`
	CloseCode      *int64 `json:"close_code,omitempty"`
	HTTPStatus     *int64 `json:"http_status,omitempty"`
}

// These are also the OpenAPI enums. No peer text, URLs, payloads or identities
// can pass the boundary, even if a caller bypasses the SDK's projection.
func ConnectionReportFieldEnum(field string) []string {
	switch field {
	case "trigger":
		return []string{"join_failed", "connection_lost", "recovery_exhausted"}
	case "event":
		return []string{"space_join_span", "state_changed", "connection_failed", "sync_connect_failed", "sync_dial_timeout", "access_refreshed", "access_refresh_failed", "recovery_attempt", "recovery_succeeded", "recovery_exhausted", "cleanup_completed", "cleanup_unconfirmed", "sync_socket_open", "sync_socket_close", "sync_heartbeat_gap", "media_state", "media_http_error"}
	case "state":
		return []string{"idle", "joining", "live", "reconnecting", "leaving", "left", "failed"}
	case "step":
		return []string{"join", "acquire_initial_media", "access_initialize", "create_media_client", "create_sync_client", "start_media", "start_sync", "wait_for_sync_live", "confirm_entered"}
	case "outcome":
		return []string{"started", "succeeded", "failed", "cancelled"}
	case "phase":
		return []string{"idle", "connecting", "live", "recovering", "failed", "stopped", "new", "connected", "disconnected", "closed"}
	case "code":
		return []string{"invalid_state", "invalid_access", "access_unavailable", "permission_denied", "device_not_found", "device_busy", "device_constraint_invalid", "media_capture_failed", "sync_start_failed", "state_digest_recovery_failed", "sync_hello_timeout", "media_start_failed", "join_cleanup_unconfirmed", "sync_recovery_exhausted", "media_recovery_exhausted", "command_rejected", "leave_unconfirmed", "episode_ended", "unsupported_environment", "internal_error", "collaboration_unavailable", "chat_cursor_reset_required", "rate_limited", "invalid_payload"}
	default:
		return nil
	}
}

func decodeConnectionReport(r *http.Request) (connectionReport, error) {
	r.Body = http.MaxBytesReader(nil, r.Body, ConnectionReportBodyLimit)
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	var report connectionReport
	if err := decoder.Decode(&report); err != nil {
		return report, connectionReportDecodeError(err)
	}
	if err := decoder.Decode(new(json.RawMessage)); err != io.EOF {
		return report, connectionReportDecodeError(err)
	}
	if report.Version != 1 || !slices.Contains(ConnectionReportFieldEnum("trigger"), report.Trigger) || len(report.Events) == 0 || len(report.Events) > ConnectionReportEventLimit {
		return report, apiErrorInvalidRequest
	}
	var previous int64
	for _, event := range report.Events {
		if !slices.Contains(ConnectionReportFieldEnum("event"), event.Event) || event.ElapsedMS < previous || event.ElapsedMS > ConnectionReportMaxMilliseconds {
			return report, apiErrorInvalidRequest
		}
		previous = event.ElapsedMS
		for field, value := range map[string]string{"state": event.State, "step": event.Step, "outcome": event.Outcome, "code": event.Code, "phase": event.Phase} {
			if value != "" && !slices.Contains(ConnectionReportFieldEnum(field), value) {
				return report, apiErrorInvalidRequest
			}
		}
		for _, value := range []*int64{event.Attempt, event.DurationMS, event.HeartbeatGapMS} {
			if value != nil && (*value < 0 || *value > ConnectionReportMaxMilliseconds) {
				return report, apiErrorInvalidRequest
			}
		}
		if event.CloseCode != nil && (*event.CloseCode < 1000 || *event.CloseCode > 4999) {
			return report, apiErrorInvalidRequest
		}
		if event.HTTPStatus != nil && (*event.HTTPStatus < 400 || *event.HTTPStatus > 599) {
			return report, apiErrorInvalidRequest
		}
	}
	return report, nil
}

func connectionReportDecodeError(err error) error {
	var oversized *http.MaxBytesError
	if errors.As(err, &oversized) {
		return apiErrorPayloadTooLarge
	}
	return apiErrorInvalidRequest
}

// A still-valid signed credential is enough: a failed join or expired presence
// must be able to report without active-participant or readiness authorization.
func connectionReportEndpoint(verifier ParticipantMediaVerifier) Endpoint[connectionReport, struct{}] {
	return Post("/v1/connection-reports", "/connection-reports", "reportConnectionFailure", decodeConnectionReport,
		func(ctx context.Context, report connectionReport) (struct{}, error) {
			subject, ok := accessgrants.SubjectFromContext(ctx)
			if !ok {
				return struct{}{}, apiErrorUnauthenticated
			}
			observability.RequestLogger(ctx).WarnContext(ctx, "SDK connection failure", "event", "sdk.connection_report",
				"trace_id", trace.SpanContextFromContext(ctx).TraceID().String(),
				"tenant_id", subject.TenantID.String(), "space_id", subject.SpaceID.String(), "episode_id", subject.EpisodeID.String(),
				"participant_id_hash", fmt.Sprintf("%x", sha256.Sum256([]byte(subject.ParticipantID.String()))), "report", report)
			return struct{}{}, nil
		}).Auth(APIAuthParticipantMedia).Middleware(requireParticipantMediaCredential(verifier)).RateLimit(connectionReportParticipantLimit).
		RequestBodyWithLimit("ConnectionReportRequest", connectionReport{}, ConnectionReportBodyLimit).
		RespondsNoBody(http.StatusNoContent).
		Errors(apiErrorInvalidRequest, apiErrorPayloadTooLarge, apiErrorUnauthenticated, apiErrorRateLimited, apiErrorServiceUnavailable)
}
