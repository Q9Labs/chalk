package httpapi

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"slices"

	"github.com/q9labs/chalk/apps/api/internal/observability"
)

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
	case "recv_paused_videos", "recv_hidden_videos":
		return 64
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
	if reason := callStatsLabelRejection(sample); reason != "" {
		return reason
	}
	return callStatsRangeRejection(sample)
}

func callStatsLabelRejection(sample callStatsSample) string {
	for _, label := range []struct{ field, value string }{
		{"connection_type", sample.ConnectionType}, {"local_candidate_type", sample.LocalCandidateType},
		{"remote_candidate_type", sample.RemoteCandidateType}, {"relay_protocol", sample.RelayProtocol}, {"send_layer", sample.SendLayer},
	} {
		if (label.value != "" || label.field == "connection_type") && !slices.Contains(CallStatsFieldEnum(label.field), label.value) {
			return label.field + "_label"
		}
	}
	return ""
}

func callStatsRangeRejection(sample callStatsSample) string {
	for _, counter := range []struct {
		field string
		value *int64
	}{
		{"rtt_ms", sample.RTTMS}, {"send_bitrate_kbps", sample.SendBitrateKbps}, {"send_jitter_ms", sample.SendJitterMS},
		{"recv_bitrate_kbps", sample.RecvBitrateKbps}, {"recv_jitter_ms", sample.RecvJitterMS}, {"recv_height", sample.RecvHeight},
		{"freeze_count", sample.FreezeCount}, {"freeze_ms", sample.FreezeMS},
		{"recv_paused_videos", sample.RecvPausedVideos}, {"recv_hidden_videos", sample.RecvHiddenVideos},
	} {
		if counter.value != nil && (*counter.value < 0 || *counter.value > CallStatsMaximum(counter.field)) {
			return counter.field + "_range"
		}
	}
	for _, loss := range []struct {
		field string
		value *float64
	}{{"send_loss_pct", sample.SendLossPct}, {"recv_loss_pct", sample.RecvLossPct}} {
		if loss.value != nil && (*loss.value < 0 || *loss.value > float64(CallStatsMaximum(loss.field))) {
			return loss.field + "_range"
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
