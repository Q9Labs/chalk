package httpapi

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"slices"
	"strings"
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
}

// These are also the OpenAPI enums, so no free text can enter the log through a
// caller that bypasses the SDK.
func CallStatsFieldEnum(field string) []string {
	switch field {
	case "connection_type":
		return []string{"udp", "tcp", "turn", "unknown"}
	case "local_candidate_type", "remote_candidate_type":
		return []string{"host", "srflx", "prflx", "relay"}
	case "relay_protocol":
		return []string{"udp", "tcp", "tls"}
	case "send_layer":
		return []string{"h", "m", "l"}
	default:
		return nil
	}
}

// CallStatsMaximum is the inclusive upper bound of a numeric sample field.
func CallStatsMaximum(field string) int64 {
	switch field {
	case "send_loss_pct", "recv_loss_pct":
		return 100
	case "send_bitrate_kbps", "recv_bitrate_kbps":
		return 100000
	case "rtt_ms", "send_jitter_ms", "recv_jitter_ms":
		return 60000
	case "recv_height":
		return 4320
	case "freeze_count":
		return 10000
	case "freeze_ms":
		return 600000
	default:
		return 0
	}
}

func decodeCallStats(r *http.Request) (callStats, error) {
	r.Body = http.MaxBytesReader(nil, r.Body, CallStatsBodyLimit)
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	var stats callStats
	if err := decoder.Decode(&stats); err != nil {
		var oversized *http.MaxBytesError
		if errors.As(err, &oversized) {
			return stats, rejectCallStats(r, "body_too_large")
		}
		return stats, rejectCallStats(r, "schema")
	}
	if err := decoder.Decode(new(json.RawMessage)); err != io.EOF {
		return stats, rejectCallStats(r, "trailing_json")
	}
	if stats.Version != 1 {
		return stats, rejectCallStats(r, "version")
	}
	if len(stats.Samples) == 0 || len(stats.Samples) > CallStatsSampleLimit {
		return stats, rejectCallStats(r, "sample_count")
	}
	for _, sample := range stats.Samples {
		if reason := validateCallStatsSample(sample); reason != "" {
			return stats, rejectCallStats(r, reason)
		}
	}
	return stats, nil
}

func validateCallStatsSample(sample callStatsSample) string {
	if sample.ElapsedMS < 0 || sample.ElapsedMS > CallStatsMaxElapsedMS {
		return "elapsed_range"
	}
	if sample.WindowMS < CallStatsMinWindowMS || sample.WindowMS > CallStatsMaxWindowMS {
		return "window_range"
	}
	for field, value := range map[string]string{"connection_type": sample.ConnectionType, "local_candidate_type": sample.LocalCandidateType, "remote_candidate_type": sample.RemoteCandidateType, "relay_protocol": sample.RelayProtocol, "send_layer": sample.SendLayer} {
		if (value != "" || field == "connection_type") && !slices.Contains(CallStatsFieldEnum(field), value) {
			return field + "_label"
		}
	}
	for field, value := range map[string]*int64{"rtt_ms": sample.RTTMS, "send_bitrate_kbps": sample.SendBitrateKbps, "send_jitter_ms": sample.SendJitterMS, "recv_bitrate_kbps": sample.RecvBitrateKbps, "recv_jitter_ms": sample.RecvJitterMS, "recv_height": sample.RecvHeight, "freeze_count": sample.FreezeCount, "freeze_ms": sample.FreezeMS} {
		if value != nil && (*value < 0 || *value > CallStatsMaximum(field)) {
			return field + "_range"
		}
	}
	for field, value := range map[string]*float64{"send_loss_pct": sample.SendLossPct, "recv_loss_pct": sample.RecvLossPct} {
		if value != nil && (*value < 0 || *value > float64(CallStatsMaximum(field))) {
			return field + "_range"
		}
	}
	return ""
}

// Reasons are fixed labels from the checks above, never decoder errors or input.
func rejectCallStats(r *http.Request, reason string) error {
	ctx := r.Context()
	observability.RequestLogger(ctx).WarnContext(ctx, "Rejected SDK call stats", "event", "sdk.call_stats.rejected", "reason", reason)
	if reason == "body_too_large" {
		return apiErrorPayloadTooLarge
	}
	return apiErrorInvalidRequest
}

var countryCode = regexp.MustCompile(`^[A-Z]{2}$`)

// callStatsOrigin names where the call came from without an address: the edge's
// country code and coarse browser and OS families from the User-Agent.
func callStatsOrigin(r *http.Request) []any {
	country := r.Header.Get("CF-IPCountry")
	if !countryCode.MatchString(country) {
		country = "unknown"
	}
	family, system := clientFamilies(r.UserAgent())
	return []any{"country", country, "client_family", family, "client_os", system}
}

func clientFamilies(userAgent string) (family, system string) {
	has := func(parts ...string) bool {
		for _, part := range parts {
			if strings.Contains(userAgent, part) {
				return true
			}
		}
		return false
	}
	switch {
	case has("Edg/", "EdgA/", "EdgiOS/"):
		family = "edge"
	case has("OPR/"):
		family = "opera"
	case has("SamsungBrowser/"):
		family = "samsung"
	case has("Firefox/", "FxiOS/"):
		family = "firefox"
	case has("Chrome/", "CriOS/"):
		family = "chrome"
	case has("Safari/"):
		family = "safari"
	case has("CFNetwork", "okhttp", "ReactNative", "Hermes"):
		family = "native"
	default:
		family = "other"
	}
	switch {
	case has("Android", "okhttp"):
		system = "android"
	case has("iPhone", "iPad", "iPod", "CFNetwork"):
		system = "ios"
	case has("Windows"):
		system = "windows"
	case has("CrOS"):
		system = "chromeos"
	case has("Mac OS X", "Macintosh"):
		system = "macos"
	case has("Linux", "X11"):
		system = "linux"
	default:
		system = "other"
	}
	return family, system
}

// A still-valid signed credential is enough: the last summary is sent as the
// participant leaves, after active presence may already be gone.
func callStatsEndpoint(verifier ParticipantMediaVerifier) Endpoint[callStatsRequest, struct{}] {
	return Post("/v1/tenants/{tenant_id}/call-stats", "/tenants/{tenant_id}/call-stats", "uploadCallStats", func(r *http.Request) (callStatsRequest, error) {
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
			logger := observability.RequestLogger(ctx).With(request.Origin...).With(
				"event", "sdk.call_stats",
				"tenant_id", subject.TenantID.String(), "space_id", subject.SpaceID.String(), "episode_id", subject.EpisodeID.String(),
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

func (s callStatsSample) logAttributes() []any {
	attributes := []any{"elapsed_ms", s.ElapsedMS, "window_ms", s.WindowMS, "connection_type", s.ConnectionType}
	for key, value := range map[string]string{"local_candidate_type": s.LocalCandidateType, "remote_candidate_type": s.RemoteCandidateType, "relay_protocol": s.RelayProtocol, "send_layer": s.SendLayer} {
		if value != "" {
			attributes = append(attributes, key, value)
		}
	}
	for key, value := range map[string]*int64{"rtt_ms": s.RTTMS, "send_bitrate_kbps": s.SendBitrateKbps, "send_jitter_ms": s.SendJitterMS, "recv_bitrate_kbps": s.RecvBitrateKbps, "recv_jitter_ms": s.RecvJitterMS, "recv_height": s.RecvHeight, "freeze_count": s.FreezeCount, "freeze_ms": s.FreezeMS} {
		if value != nil {
			attributes = append(attributes, key, *value)
		}
	}
	for key, value := range map[string]*float64{"send_loss_pct": s.SendLossPct, "recv_loss_pct": s.RecvLossPct} {
		if value != nil {
			attributes = append(attributes, key, *value)
		}
	}
	return attributes
}
