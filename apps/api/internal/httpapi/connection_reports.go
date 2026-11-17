package httpapi

import (
	"context"
	"net/http"
	"slices"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/accessgrants"
	"github.com/q9labs/chalk/apps/api/internal/observability"
	"github.com/q9labs/chalk/apps/api/internal/ratelimit"
	"github.com/q9labs/chalk/apps/api/internal/sdktelemetry"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

// This route serves SDKs from before client telemetry: mobile 3.0.6 and older embedders. It
// translates each report into the events of POST /v1/tenants/{tenant_id}/telemetry and
// logs them the same way, marked with legacy_route. Delete it, call-stats and their wire
// types when those SDKs are gone.

const ConnectionReportBodyLimit = 32768
const ConnectionReportEventLimit = 64

var connectionReportParticipantLimit = ratelimit.Policy{Name: "connection_reports.participant", Limit: 6, Window: 10 * time.Minute}

type connectionReportRequest struct {
	TenantID utilities.ID
	Report   connectionReport
	Origin   []any
	// Frame is why the report was refused before its events were read, or empty.
	Frame string
}

type connectionReport struct {
	Version int                     `json:"version"`
	Trigger string                  `json:"trigger"`
	Events  []connectionReportEvent `json:"events"`
}

type connectionReportEvent struct {
	Event            string                      `json:"event"`
	ElapsedMS        int64                       `json:"elapsed_ms"`
	State            string                      `json:"state,omitempty"`
	Step             string                      `json:"step,omitempty"`
	Outcome          string                      `json:"outcome,omitempty"`
	Code             string                      `json:"code,omitempty"`
	Phase            string                      `json:"phase,omitempty"`
	Attempt          *int64                      `json:"attempt,omitempty"`
	DurationMS       *int64                      `json:"duration_ms,omitempty"`
	HeartbeatGapMS   *int64                      `json:"heartbeat_gap_ms,omitempty"`
	CloseCode        *int64                      `json:"close_code,omitempty"`
	HTTPStatus       *int64                      `json:"http_status,omitempty"`
	MediaErrorKind   string                      `json:"media_error_kind,omitempty"`
	MediaErrorStep   string                      `json:"media_error_step,omitempty"`
	GrantedAudio     string                      `json:"granted_audio,omitempty"`
	GrantedVideo     string                      `json:"granted_video,omitempty"`
	Source           string                      `json:"source,omitempty"`
	PublicationState string                      `json:"publication_state,omitempty"`
	ProjectionState  string                      `json:"projection_state,omitempty"`
	ReceiveState     string                      `json:"receive_state,omitempty"`
	TrackState       string                      `json:"track_state,omitempty"`
	ElementState     string                      `json:"element_state,omitempty"`
	PlayResult       string                      `json:"play_result,omitempty"`
	ReceiveCounts    *sdktelemetry.ReceiveCounts `json:"receive_counts,omitempty"`
	ReceiversStopped *int64                      `json:"receivers_stopped,omitempty"`
	BundleTagHeld    *bool                       `json:"bundle_tag_held,omitempty"`
	UploadFailure    string                      `json:"upload_failure,omitempty"`
}

// connectionReportTriggers and connectionReportEvents are the vocabulary of the old
// SDKs, which does not grow.
var connectionReportTriggers = []string{"join_failed", "connection_lost", "recovery_exhausted", "media_projection_mismatch", "audio_receive_stuck", "audio_receive_summary", "upload_failed"}
var connectionReportEvents = []string{"space_join_span", "state_changed", "connection_failed", "sync_connect_failed", "sync_dial_timeout", "access_refreshed", "access_refresh_failed", "recovery_attempt", "recovery_succeeded", "recovery_exhausted", "cleanup_completed", "cleanup_unconfirmed", "sync_socket_open", "sync_socket_close", "sync_heartbeat_gap", "media_state", "media_http_error", "media_projection_mismatch", "audio_receive_stuck", "audio_receive_summary", "receivers_closed", "access_retry", "chat_upload_failed"}

// ConnectionReportFieldEnum lists the OpenAPI enums of the report. The labels shared with
// telemetry events are theirs.
func ConnectionReportFieldEnum(field string) []string {
	switch field {
	case "trigger":
		return connectionReportTriggers
	case "event":
		return connectionReportEvents
	default:
		return sdktelemetry.FieldEnum(field)
	}
}

func decodeConnectionReport(r *http.Request) (connectionReportRequest, error) {
	tenantID, err := tenantIDRequest(r)
	if err != nil {
		return connectionReportRequest{}, err
	}
	request := connectionReportRequest{TenantID: tenantID, Origin: telemetryOrigin(r)}
	request.Frame = sdktelemetry.DecodeStrict(http.MaxBytesReader(nil, r.Body, ConnectionReportBodyLimit), &request.Report)
	return request, nil
}

// telemetry translates a report into a batch. Events have no sequence numbers in the
// old SDKs, so they are numbered in the order the report lists them, and the session
// is the one the request's baggage names, if it names one. The reason is a fixed label.
func (report connectionReport) telemetry(clientSessionID string) (sdktelemetry.Request, string) {
	switch {
	case report.Version != sdktelemetry.Version:
		return sdktelemetry.Request{}, "version"
	case !slices.Contains(connectionReportTriggers, report.Trigger):
		return sdktelemetry.Request{}, "trigger"
	case len(report.Events) == 0 || len(report.Events) > ConnectionReportEventLimit:
		return sdktelemetry.Request{}, "event_count"
	}
	batch := sdktelemetry.Request{Version: sdktelemetry.Version, ClientSessionID: clientSessionID}
	for index, event := range report.Events {
		translated := sdktelemetry.Event{
			Type: event.Event, Seq: int64(index), ElapsedMS: event.ElapsedMS,
			State: event.State, Step: event.Step, Outcome: event.Outcome, Code: event.Code, Phase: event.Phase,
			Attempt: event.Attempt, DurationMS: event.DurationMS, HeartbeatGapMS: event.HeartbeatGapMS,
			CloseCode: event.CloseCode, HTTPStatus: event.HTTPStatus,
			MediaErrorKind: event.MediaErrorKind, MediaErrorStep: event.MediaErrorStep,
			GrantedAudio: event.GrantedAudio, GrantedVideo: event.GrantedVideo, Source: event.Source,
			PublicationState: event.PublicationState, ProjectionState: event.ProjectionState,
			ReceiveState: event.ReceiveState, TrackState: event.TrackState, ElementState: event.ElementState,
			PlayResult: event.PlayResult, ReceiveCounts: event.ReceiveCounts,
			ReceiversStopped: event.ReceiversStopped, BundleTagHeld: event.BundleTagHeld, UploadFailure: event.UploadFailure,
		}
		if !slices.Contains(connectionReportEvents, event.Event) {
			return sdktelemetry.Request{}, "type"
		}
		if reason := translated.Check(); reason != "" {
			return sdktelemetry.Request{}, reason
		}
		batch.Events = append(batch.Events, translated)
	}
	return batch, ""
}

// A still-valid signed credential is enough: a failed join or expired presence
// must be able to report without active-participant or readiness authorization.
func connectionReportEndpoint(verifier ParticipantMediaVerifier) Endpoint[connectionReportRequest, struct{}] {
	return Post("/v1/tenants/{tenant_id}/connection-reports", "reportConnectionFailure", decodeConnectionReport,
		func(ctx context.Context, request connectionReportRequest) (struct{}, error) {
			subject, ok := accessgrants.SubjectFromContext(ctx)
			if !ok {
				return struct{}{}, apiErrorUnauthenticated
			}
			if subject.TenantID != request.TenantID {
				return struct{}{}, apiErrorForbidden
			}
			legacy := []any{"legacy_route", "connection-reports", "trigger", request.Report.Trigger}
			if request.Frame != "" {
				return struct{}{}, rejectTelemetry(ctx, subject, request.Frame, legacy...)
			}
			sessionID, _ := observability.SessionIDFromContext(ctx)
			batch, reason := request.Report.telemetry(sessionID)
			if reason != "" {
				return struct{}{}, rejectTelemetry(ctx, subject, reason, legacy...)
			}
			logTelemetry(ctx, subject, batch, request.Origin, legacy...)
			return struct{}{}, nil
		}).Auth(APIAuthParticipantMedia).Middleware(requireParticipantMediaCredential(verifier)).RateLimit(connectionReportParticipantLimit).
		Parameters(tenantIDParameter()).
		RequestBodyWithLimit("ConnectionReportRequest", connectionReport{}, ConnectionReportBodyLimit).
		RespondsNoBody(http.StatusNoContent).
		Errors(apiErrorInvalidTenantID, apiErrorForbidden, apiErrorInvalidRequest, apiErrorPayloadTooLarge, apiErrorUnauthenticated, apiErrorRateLimited, apiErrorServiceUnavailable, apiErrorInternal)
}
