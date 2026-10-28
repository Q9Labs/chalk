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
	"github.com/q9labs/chalk/apps/api/internal/utilities"
	"go.opentelemetry.io/otel/trace"
)

const ConnectionReportBodyLimit = 32768
const ConnectionReportEventLimit = 64
const ConnectionReportMaxMilliseconds = 2147483647

var connectionReportParticipantLimit = ratelimit.Policy{Name: "connection_reports.participant", Limit: 6, Window: 10 * time.Minute}

type connectionReportRequest struct {
	TenantID utilities.ID
	Report   connectionReport
}

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
	MediaErrorKind string `json:"media_error_kind,omitempty"`
	MediaErrorStep string `json:"media_error_step,omitempty"`
	GrantedAudio   string `json:"granted_audio,omitempty"`
	GrantedVideo   string `json:"granted_video,omitempty"`
}

// These are also the OpenAPI enums. No peer text, URLs, payloads or identities
// can pass the boundary, even if a caller bypasses the SDK's projection.
func ConnectionReportFieldEnum(field string) []string {
	switch field {
	case "media_error_kind":
		return []string{"NotAllowedError", "NotReadableError", "NotFoundError", "OverconstrainedError", "AbortError", "SecurityError", "InvalidStateError", "OperationError", "NotSupportedError", "CloudflareSFUError", "network", "timeout", "unknown"}
	case "media_error_step":
		return []string{"local_capture", "peer_connection", "access_refresh", "sfu_tracks", "sfu_close_tracks", "sfu_renegotiate", "sfu_publications"}
	case "granted_audio", "granted_video":
		return []string{"granted", "not_granted", "unknown"}
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
		return report, connectionReportDecodeError(r, err, "schema")
	}
	if err := decoder.Decode(new(json.RawMessage)); err != io.EOF {
		return report, connectionReportDecodeError(r, err, "trailing_json")
	}
	if report.Version != 1 {
		return report, rejectConnectionReport(r, "version")
	}
	if !slices.Contains(ConnectionReportFieldEnum("trigger"), report.Trigger) {
		return report, rejectConnectionReport(r, "trigger")
	}
	if len(report.Events) == 0 || len(report.Events) > ConnectionReportEventLimit {
		return report, rejectConnectionReport(r, "event_count")
	}
	var previous int64
	for _, event := range report.Events {
		if !slices.Contains(ConnectionReportFieldEnum("event"), event.Event) {
			return report, rejectConnectionReport(r, "event_label")
		}
		if event.ElapsedMS < 0 || event.ElapsedMS > ConnectionReportMaxMilliseconds {
			return report, rejectConnectionReport(r, "elapsed_range")
		}
		if event.ElapsedMS < previous {
			return report, rejectConnectionReport(r, "event_order")
		}
		previous = event.ElapsedMS
		for field, value := range map[string]string{"state": event.State, "step": event.Step, "outcome": event.Outcome, "code": event.Code, "phase": event.Phase, "media_error_kind": event.MediaErrorKind, "media_error_step": event.MediaErrorStep, "granted_audio": event.GrantedAudio, "granted_video": event.GrantedVideo} {
			if value != "" && !slices.Contains(ConnectionReportFieldEnum(field), value) {
				return report, rejectConnectionReport(r, field+"_label")
			}
		}
		for field, value := range map[string]*int64{"attempt": event.Attempt, "duration_ms": event.DurationMS, "heartbeat_gap_ms": event.HeartbeatGapMS} {
			if value != nil && (*value < 0 || *value > ConnectionReportMaxMilliseconds) {
				return report, rejectConnectionReport(r, field+"_range")
			}
		}
		if event.CloseCode != nil && (*event.CloseCode < 1000 || *event.CloseCode > 4999) {
			return report, rejectConnectionReport(r, "close_code_range")
		}
		if event.HTTPStatus != nil && (*event.HTTPStatus < 400 || *event.HTTPStatus > 599) {
			return report, rejectConnectionReport(r, "http_status_range")
		}
	}
	return report, nil
}

func connectionReportDecodeError(r *http.Request, err error, reason string) error {
	var oversized *http.MaxBytesError
	if errors.As(err, &oversized) {
		return rejectConnectionReport(r, "body_too_large")
	}
	return rejectConnectionReport(r, reason)
}

// Reasons are fixed labels from the checks above, never decoder errors or input.
func rejectConnectionReport(r *http.Request, reason string) error {
	ctx := r.Context()
	logger := observability.RequestLogger(ctx)
	if subject, ok := accessgrants.SubjectFromContext(ctx); ok {
		logger = logger.With("participant_id_hash", fmt.Sprintf("%x", sha256.Sum256([]byte(subject.ParticipantID.String()))))
	}
	logger.WarnContext(ctx, "Rejected SDK connection report", "event", "sdk.connection_report.rejected",
		"trace_id", trace.SpanContextFromContext(ctx).TraceID().String(), "reason", reason)
	if reason == "body_too_large" {
		return apiErrorPayloadTooLarge
	}
	return apiErrorInvalidRequest
}

// A still-valid signed credential is enough: a failed join or expired presence
// must be able to report without active-participant or readiness authorization.
func connectionReportEndpoint(verifier ParticipantMediaVerifier) Endpoint[connectionReportRequest, struct{}] {
	return Post("/v1/tenants/{tenant_id}/connection-reports", "/tenants/{tenant_id}/connection-reports", "reportConnectionFailure", func(r *http.Request) (connectionReportRequest, error) {
		tenantID, err := tenantIDRequest(r)
		if err != nil {
			return connectionReportRequest{}, err
		}
		report, err := decodeConnectionReport(r)
		return connectionReportRequest{TenantID: tenantID, Report: report}, err
	},
		func(ctx context.Context, request connectionReportRequest) (struct{}, error) {
			subject, ok := accessgrants.SubjectFromContext(ctx)
			if !ok {
				return struct{}{}, apiErrorUnauthenticated
			}
			if subject.TenantID != request.TenantID {
				return struct{}{}, apiErrorForbidden
			}
			report := request.Report
			encoded, err := json.Marshal(report)
			if err != nil {
				return struct{}{}, apiErrorInternal
			}
			observability.RequestLogger(ctx).WarnContext(ctx, "SDK connection failure", "event", "sdk.connection_report",
				"trace_id", trace.SpanContextFromContext(ctx).TraceID().String(),
				"tenant_id", subject.TenantID.String(), "space_id", subject.SpaceID.String(), "episode_id", subject.EpisodeID.String(),
				"participant_id_hash", fmt.Sprintf("%x", sha256.Sum256([]byte(subject.ParticipantID.String()))), "trigger", report.Trigger, "report", string(encoded))
			return struct{}{}, nil
		}).Auth(APIAuthParticipantMedia).Middleware(requireParticipantMediaCredential(verifier)).RateLimit(connectionReportParticipantLimit).
		Parameters(tenantIDParameter()).
		RequestBodyWithLimit("ConnectionReportRequest", connectionReport{}, ConnectionReportBodyLimit).
		RespondsNoBody(http.StatusNoContent).
		Errors(apiErrorInvalidTenantID, apiErrorForbidden, apiErrorInvalidRequest, apiErrorPayloadTooLarge, apiErrorUnauthenticated, apiErrorRateLimited, apiErrorServiceUnavailable, apiErrorInternal)
}
