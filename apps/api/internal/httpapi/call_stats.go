package httpapi

import (
	"context"
	"crypto/sha256"
	"fmt"
	"net/http"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/accessgrants"
	"github.com/q9labs/chalk/apps/api/internal/observability"
	"github.com/q9labs/chalk/apps/api/internal/ratelimit"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

const CallStatsBodyLimit = 32768

const CallStatsSampleLimit = 30

const CallStatsMinWindowMS = 1000

const CallStatsMaxWindowMS = 60000

const CallStatsMaxElapsedMS = 2147483647

var callStatsParticipantLimit = ratelimit.Policy{Name: "call_stats.participant", Limit: 30, Window: 10 * time.Minute}

type callStatsRequest struct {
	TenantID utilities.ID
	Stats    callStats
	Origin   []any
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
	// RecvPausedVideos counts remote videos the SFU had paused for network at the
	// end of the window. Only an SDK on a plane that reports subscription state sends it.
	RecvPausedVideos *int64 `json:"recv_paused_videos,omitempty"`
	// RecvHiddenVideos counts remote videos the viewer chose not to receive at the end of
	// the window because their tiles were hidden or off screen. They send nothing on purpose.
	RecvHiddenVideos *int64 `json:"recv_hidden_videos,omitempty"`
}

// A still-valid signed credential is enough: the last summary is sent as the
// participant leaves, after active presence may already be gone.
func callStatsEndpoint(verifier ParticipantMediaVerifier) Endpoint[callStatsRequest, struct{}] {
	return Post("/v1/tenants/{tenant_id}/call-stats", "uploadCallStats", func(r *http.Request) (callStatsRequest, error) {
		tenantID, err := tenantIDRequest(r)
		if err != nil {
			return callStatsRequest{}, err
		}
		stats, err := decodeCallStats(r)
		return callStatsRequest{TenantID: tenantID, Stats: stats, Origin: callStatsOrigin(r)}, err
	},
		func(ctx context.Context, request callStatsRequest) (struct{}, error) {
			subject, ok := accessgrants.SubjectFromContext(ctx)
			if !ok {
				return struct{}{}, apiErrorUnauthenticated
			}
			if subject.TenantID != request.TenantID {
				return struct{}{}, apiErrorForbidden
			}
			// provider and provider_session_id join a summary to the media plane's own
			// logs for the same connection, which the API's SFU adapters log under these keys.
			logger := observability.RequestLogger(ctx).With(request.Origin...).With(
				"event", "sdk.call_stats",
				"tenant_id", subject.TenantID.String(), "space_id", subject.SpaceID.String(), "episode_id", subject.EpisodeID.String(),
				"provider", subject.Provider, "provider_session_id", subject.ConnectionID,
				"participant_id_hash", fmt.Sprintf("%x", sha256.Sum256([]byte(subject.ParticipantID.String()))))
			for _, sample := range request.Stats.Samples {
				logger.InfoContext(ctx, "SDK call stats", sample.logAttributes()...)
			}
			return struct{}{}, nil
		}).Auth(APIAuthParticipantMedia).Middleware(requireParticipantMediaCredential(verifier)).RateLimit(callStatsParticipantLimit).
		Parameters(tenantIDParameter()).
		RequestBodyWithLimit("CallStatsRequest", callStats{}, CallStatsBodyLimit).
		RespondsNoBody(http.StatusNoContent).
		Errors(apiErrorInvalidTenantID, apiErrorForbidden, apiErrorInvalidRequest, apiErrorPayloadTooLarge, apiErrorUnauthenticated, apiErrorRateLimited, apiErrorServiceUnavailable, apiErrorInternal)
}
