package sfu

import (
	"context"
	"errors"
	"log/slog"
	"slices"
	"strings"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/mediaplane"
)

// The retry field says how an attempt relates to a session replacement: a first attempt that found the
// session gone and was retried on a fresh one, the retry itself, or neither.
const (
	addTracksRetryNone                 = "none"
	addTracksRetrySessionReplaced      = "session_replaced"
	addTracksRetryAfterSessionReplaced = "after_session_replaced"
)

type addTracksAttempt struct {
	latency    time.Duration
	statusCode int
	// The session's age and whether its connection had negotiated when the attempt started, so a
	// timeout on a dead session reads differently from one on a live session. Age is -1 when unknown.
	sessionAgeMs      int64
	sessionNegotiated bool
}

// logAddTracksCall records one structured line per add-tracks attempt so a single
// failed publish shows where the time went. It never logs SDP bodies, track
// names, remote session IDs, credentials or client addresses.
func logAddTracksCall(ctx context.Context, input mediaplane.TracksRequest, trackErrors []mediaplane.TrackError, attempt addTracksAttempt, err error, retry string, recovered bool) {
	outcome, providerCode := "ok", ""
	level := slog.LevelInfo
	if err != nil {
		outcome, providerCode = "unknown", "unknown"
		level = slog.LevelWarn
		var failure providerFailure
		if errors.As(err, &failure) {
			outcome, providerCode = string(failure.stage), failure.providerCode
		}
	}
	if recovered {
		// The provider error stays in http_status and provider_code, but the client saw a success.
		outcome, level = "recovered", slog.LevelInfo
	}
	errorKinds := make([]string, 0, min(len(trackErrors), 16))
	for _, failure := range trackErrors[:min(len(trackErrors), 16)] {
		errorKinds = append(errorKinds, failure.Code)
	}
	slog.Default().Log(
		ctx,
		level,
		"Cloudflare SFU add tracks",
		"event", "cloudflare_sfu.add_tracks",
		"space_id", input.SpaceID,
		"episode_id", input.EpisodeID,
		"provider_session_id", input.ConnectionID,
		"track_count", len(input.Tracks),
		"track_kinds", addTracksKinds(input.Tracks),
		"track_error_kinds", errorKinds,
		"sdp_type", addTracksSDPType(input.SessionDescription),
		"sdp_rid_count", addTracksRIDCount(input.SessionDescription),
		"simulcast_track_count", addTracksSimulcastCount(input.Tracks),
		"upstream_latency_ms", attempt.latency.Milliseconds(),
		"outcome", outcome,
		"http_status", attempt.statusCode,
		"provider_code", providerCode,
		"retry", retry,
		"session_age_ms", attempt.sessionAgeMs,
		"session_negotiated", attempt.sessionNegotiated,
	)
}

// addTracksKinds lists each requested track as its media source for local
// publishes, or "remote" for pulls, sorted so equal requests log equally.
func addTracksKinds(tracks []mediaplane.Track) []string {
	kinds := make([]string, 0, len(tracks))
	for _, track := range tracks {
		if track.Location == "remote" {
			kinds = append(kinds, "remote")
			continue
		}
		kinds = append(kinds, track.Source)
	}
	slices.Sort(kinds)
	return kinds
}

func addTracksSDPType(description *mediaplane.SessionDescription) string {
	if description == nil {
		return "none"
	}
	switch descriptionType := strings.ToLower(strings.TrimSpace(description.Type)); descriptionType {
	case "offer", "answer":
		return descriptionType
	default:
		return "unknown"
	}
}

// addTracksRIDCount counts the simulcast RID declarations in the browser's SDP;
// zero means the publisher sent a single encoding.
func addTracksRIDCount(description *mediaplane.SessionDescription) int {
	if description == nil {
		return 0
	}
	count := 0
	for line := range strings.Lines(description.SDP) {
		if strings.HasPrefix(line, "a=rid:") {
			count++
		}
	}
	return count
}

func addTracksSimulcastCount(tracks []mediaplane.Track) int {
	count := 0
	for _, track := range tracks {
		if track.Simulcast != nil {
			count++
		}
	}
	return count
}
