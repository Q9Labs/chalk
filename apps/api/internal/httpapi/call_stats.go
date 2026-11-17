package httpapi

import (
	"context"
	"net/http"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/accessgrants"
	"github.com/q9labs/chalk/apps/api/internal/ratelimit"
	"github.com/q9labs/chalk/apps/api/internal/sdktelemetry"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

// This route serves SDKs from before client telemetry. See connection_reports.go: it is
// deleted with that route, and until then it logs each sample as a call_stats event.

const CallStatsBodyLimit = 32768
const CallStatsSampleLimit = 30

var callStatsParticipantLimit = ratelimit.Policy{Name: "call_stats.participant", Limit: 30, Window: 10 * time.Minute}

type callStatsRequest struct {
	TenantID utilities.ID
	Stats    callStats
	Origin   []any
	// Frame is why the request was refused before its samples were read, or empty.
	Frame string
}

type callStats struct {
	Version int               `json:"version"`
	Samples []callStatsSample `json:"samples"`
}

// A sample summarizes one window of the device's getStats polling. Optional
// fields are absent when the browser did not report them, never zero.
type callStatsSample struct {
	ElapsedMS           int64    `json:"elapsed_ms"`
	WindowMS            int64    `json:"window_ms"`
	ConnectionType      string   `json:"connection_type"`
	LocalCandidateType  string   `json:"local_candidate_type,omitempty"`
	RemoteCandidateType string   `json:"remote_candidate_type,omitempty"`
	RelayProtocol       string   `json:"relay_protocol,omitempty"`
	RTTMS               *int64   `json:"rtt_ms,omitempty"`
	SendBitrateKbps     *int64   `json:"send_bitrate_kbps,omitempty"`
	SendLossPct         *float64 `json:"send_loss_pct,omitempty"`
	SendJitterMS        *int64   `json:"send_jitter_ms,omitempty"`
	SendLayer           string   `json:"send_layer,omitempty"`
	RecvBitrateKbps     *int64   `json:"recv_bitrate_kbps,omitempty"`
	RecvLossPct         *float64 `json:"recv_loss_pct,omitempty"`
	RecvJitterMS        *int64   `json:"recv_jitter_ms,omitempty"`
	RecvHeight          *int64   `json:"recv_height,omitempty"`
	FreezeCount         *int64   `json:"freeze_count,omitempty"`
	FreezeMS            *int64   `json:"freeze_ms,omitempty"`
	RecvPausedVideos    *int64   `json:"recv_paused_videos,omitempty"`
	RecvHiddenVideos    *int64   `json:"recv_hidden_videos,omitempty"`
}

func decodeCallStats(r *http.Request) (callStatsRequest, error) {
	tenantID, err := tenantIDRequest(r)
	if err != nil {
		return callStatsRequest{}, err
	}
	request := callStatsRequest{TenantID: tenantID, Origin: telemetryOrigin(r)}
	request.Frame = sdktelemetry.DecodeStrict(http.MaxBytesReader(nil, r.Body, CallStatsBodyLimit), &request.Stats)
	return request, nil
}

// telemetry translates the samples into call_stats events, numbered in the order listed.
func (stats callStats) telemetry(clientSessionID string) (sdktelemetry.Request, string) {
	switch {
	case stats.Version != sdktelemetry.Version:
		return sdktelemetry.Request{}, "version"
	case len(stats.Samples) == 0 || len(stats.Samples) > CallStatsSampleLimit:
		return sdktelemetry.Request{}, "sample_count"
	}
	batch := sdktelemetry.Request{Version: sdktelemetry.Version, ClientSessionID: clientSessionID}
	for index, sample := range stats.Samples {
		event := sdktelemetry.Event{Type: "call_stats", Seq: int64(index), ElapsedMS: sample.ElapsedMS, Stats: &sdktelemetry.StatsWindow{
			WindowMS: sample.WindowMS, ConnectionType: sample.ConnectionType,
			LocalCandidateType: sample.LocalCandidateType, RemoteCandidateType: sample.RemoteCandidateType, RelayProtocol: sample.RelayProtocol,
			RTTMS: sample.RTTMS, SendBitrateKbps: sample.SendBitrateKbps, SendLossPct: sample.SendLossPct, SendJitterMS: sample.SendJitterMS,
			SendLayer: sample.SendLayer, RecvBitrateKbps: sample.RecvBitrateKbps, RecvLossPct: sample.RecvLossPct, RecvJitterMS: sample.RecvJitterMS,
			RecvHeight: sample.RecvHeight, FreezeCount: sample.FreezeCount, FreezeMS: sample.FreezeMS,
			RecvPausedVideos: sample.RecvPausedVideos, RecvHiddenVideos: sample.RecvHiddenVideos,
		}}
		if reason := event.Check(); reason != "" {
			return sdktelemetry.Request{}, reason
		}
		batch.Events = append(batch.Events, event)
	}
	return batch, ""
}

// A still-valid signed credential is enough: the last summary is sent as the
// participant leaves, after active presence may already be gone.
func callStatsEndpoint(verifier ParticipantMediaVerifier) Endpoint[callStatsRequest, struct{}] {
	return Post("/v1/tenants/{tenant_id}/call-stats", "uploadCallStats", decodeCallStats,
		func(ctx context.Context, request callStatsRequest) (struct{}, error) {
			subject, ok := accessgrants.SubjectFromContext(ctx)
			if !ok {
				return struct{}{}, apiErrorUnauthenticated
			}
			if subject.TenantID != request.TenantID {
				return struct{}{}, apiErrorForbidden
			}
			legacy := []any{"legacy_route", "call-stats"}
			if request.Frame != "" {
				return struct{}{}, rejectTelemetry(ctx, subject, request.Frame, legacy...)
			}
			sessionID := legacySessionID(ctx)
			batch, reason := request.Stats.telemetry(sessionID)
			if reason != "" {
				return struct{}{}, rejectTelemetry(ctx, subject, reason, legacy...)
			}
			logTelemetry(ctx, subject, batch, request.Origin, legacy...)
			return struct{}{}, nil
		}).Auth(APIAuthParticipantMedia).Middleware(requireParticipantMediaCredential(verifier)).RateLimit(callStatsParticipantLimit).
		Parameters(tenantIDParameter()).
		RequestBodyWithLimit("CallStatsRequest", callStats{}, CallStatsBodyLimit).
		RespondsNoBody(http.StatusNoContent).
		Errors(apiErrorInvalidTenantID, apiErrorForbidden, apiErrorInvalidRequest, apiErrorPayloadTooLarge, apiErrorUnauthenticated, apiErrorRateLimited, apiErrorServiceUnavailable, apiErrorInternal)
}
