package sfu

// Temporary diagnostics for the 5.2.6 connection_not_found investigation. Not for merge.
// Logs each Cloudflare request with session ids reduced to 6 hex characters of a SHA-256.

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"log/slog"
	"regexp"
	"runtime"
	"strings"
)

var diagSessionID = regexp.MustCompile(`/sessions/([^/]+)`)

func diagShort(id string) string {
	sum := sha256.Sum256([]byte(id))
	return hex.EncodeToString(sum[:3])
}

func diagCallers() string {
	pcs := make([]uintptr, 24)
	n := runtime.Callers(3, pcs)
	frames := runtime.CallersFrames(pcs[:n])
	var names []string
	for {
		frame, more := frames.Next()
		if i := strings.Index(frame.Function, "apps/api/internal/"); i >= 0 && !strings.Contains(frame.Function, "adapters/cloudflare/sfu") {
			names = append(names, frame.Function[i+len("apps/api/internal/"):])
		}
		if !more || len(names) >= 5 {
			break
		}
	}
	return strings.Join(names, " < ")
}

func diagRequest(ctx context.Context, method, path, operation string, body any, status int, err error, response []byte) {
	hashedPath := diagSessionID.ReplaceAllStringFunc(path, func(match string) string {
		return "/sessions/" + diagShort(strings.TrimPrefix(match, "/sessions/"))
	})
	summary := map[string]any{}
	if raw, marshalErr := json.Marshal(body); marshalErr == nil {
		var decoded struct {
			Force  bool `json:"force"`
			Tracks []struct {
				Location  string `json:"location"`
				SessionID string `json:"sessionId"`
				TrackName string `json:"trackName"`
				Mid       string `json:"mid"`
			} `json:"tracks"`
		}
		if json.Unmarshal(raw, &decoded) == nil {
			var tracks []string
			for _, track := range decoded.Tracks {
				entry := track.Location + ":" + track.Mid + ":" + track.TrackName
				if track.SessionID != "" {
					entry += "@" + diagShort(track.SessionID)
				}
				tracks = append(tracks, entry)
			}
			summary["tracks"] = tracks
			summary["force"] = decoded.Force
		}
	}
	var providerBody struct {
		ErrorCode string `json:"errorCode"`
		Tracks    []struct {
			Mid       string `json:"mid"`
			TrackName string `json:"trackName"`
			SessionID string `json:"sessionId"`
			ErrorCode string `json:"errorCode"`
		} `json:"tracks"`
	}
	var trackErrors []string
	if json.Unmarshal(response, &providerBody) == nil {
		for _, track := range providerBody.Tracks {
			if track.ErrorCode != "" {
				trackErrors = append(trackErrors, track.TrackName+"@"+diagShort(track.SessionID)+"="+track.ErrorCode)
			}
		}
	}
	attrs := []any{"event", "cf_diag", "op", operation, "method", method, "path", hashedPath, "status", status, "req", summary, "top_error", providerBody.ErrorCode, "track_errors", trackErrors}
	if err != nil {
		attrs = append(attrs, "error", err.Error())
	}
	if status < 200 || status >= 300 {
		snippet := string(response)
		if len(snippet) > 200 {
			snippet = snippet[:200]
		}
		attrs = append(attrs, "resp", diagSessionID.ReplaceAllString(snippet, "$0"))
	}
	if operation == "close_tracks" || operation == "create_connection" {
		attrs = append(attrs, "callers", diagCallers())
	}
	slog.InfoContext(ctx, "cf_diag", attrs...)
}
