package feedback

import (
	"bytes"
	"encoding/hex"
	"encoding/json"
	"image"
	_ "image/jpeg"
	_ "image/png"
	"io"
	"math"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode"

	"github.com/q9labs/chalk/apps/api/internal/episodediagnostics"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

const (
	maxFeedbackMetadataLength = 128
	maxTelemetryAttributes    = 24
	maxTelemetryAttributeKey  = 64
	maxTelemetryAttributeText = 256
)

var (
	feedbackTokenPattern         = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:/@-]*$`)
	dashboardRequestKeyPattern   = regexp.MustCompile(`^chalk\.dashboard-request\.[a-z][a-z0-9_-]{0,63}$`)
	sensitiveTelemetryKeyPattern = regexp.MustCompile(`(?i)(?:authorization|cookie|credential|password|secret|private.?key|api.?key|[a-z0-9_]*token|(?:body|payload|request|response|sdp|candidate|track|media)(?:content|data)?$|display.?name|email|phone|username|ip.?address|[a-z0-9_]+(?:_id|_ids|_identifier|_identifiers|_slug|_key)$)`)
	unsafeFeedbackValuePattern   = regexp.MustCompile(`(?i)(?:https?://|wss?://|bearer\s+[a-z0-9._~+/=-]+|-----begin|candidate:|v=0\r?\n|\b(?:\d{1,3}\.){3}\d{1,3}\b|[\w.+-]+@[\w.-]+\.[a-z]{2,})`)
	traceparentPattern           = regexp.MustCompile(`^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$`)
)

type feedbackTelemetryEvent struct {
	Version            int                                     `json:"version"`
	EventID            string                                  `json:"event_id"`
	JourneyID          string                                  `json:"journey_id"`
	Sequence           int64                                   `json:"sequence"`
	OccurredAt         string                                  `json:"occurred_at"`
	Name               string                                  `json:"name"`
	Phase              string                                  `json:"phase"`
	State              string                                  `json:"state"`
	OriginKind         string                                  `json:"origin_kind"`
	FirstObservedLayer string                                  `json:"first_observed_layer"`
	UpstreamVisibility string                                  `json:"upstream_visibility"`
	ParentEventID      string                                  `json:"parent_event_id,omitempty"`
	TraceID            string                                  `json:"trace_id,omitempty"`
	SpanID             string                                  `json:"span_id,omitempty"`
	Traceparent        string                                  `json:"traceparent,omitempty"`
	Tracestate         string                                  `json:"tracestate,omitempty"`
	Attributes         episodediagnostics.DiagnosticAttributes `json:"attributes,omitempty"`
}

type feedbackTelemetryStorageSummary struct {
	PendingCount  *int `json:"pending_count,omitempty"`
	TimelineCount *int `json:"timeline_count,omitempty"`
	DroppedCount  *int `json:"dropped_count,omitempty"`
}

func validateFeedbackMetadata(e FeedbackEvidence) error {
	if e.App != nil {
		if !validFeedbackMetadata(e.App.Name, true) || !validFeedbackMetadata(e.App.Version, false) || !validFeedbackMetadata(e.App.Build, false) {
			return ErrInvalidEvidence
		}
	}
	if !validFeedbackMetadata(e.SDK.Client, true) {
		return ErrInvalidEvidence
	}
	for _, value := range []string{e.SDK.React, e.SDK.ReactNative, e.Platform.OSName, e.Platform.OSVersion, e.Platform.BrowserName, e.Platform.BrowserVersion, e.Platform.DeviceModel} {
		if !validFeedbackMetadata(value, false) {
			return ErrInvalidEvidence
		}
	}
	if e.Connection != nil {
		if !validFeedbackToken(e.Connection.State, true) || !validFeedbackToken(e.Connection.ErrorCode, false) {
			return ErrInvalidEvidence
		}
	}
	return nil
}

func validFeedbackMetadata(value string, required bool) bool {
	if value == "" {
		return !required
	}
	return len(value) <= maxFeedbackMetadataLength && strings.TrimSpace(value) == value && !containsControl(value) && !unsafeFeedbackValuePattern.MatchString(value)
}

func validFeedbackToken(value string, required bool) bool {
	if value == "" {
		return !required
	}
	return len(value) <= maxFeedbackMetadataLength && feedbackTokenPattern.MatchString(value) && !unsafeFeedbackValuePattern.MatchString(value)
}

func validateTelemetryEvent(raw json.RawMessage) error {
	if len(raw) == 0 || len(raw) > 2048 {
		return ErrInvalidEvidence
	}
	var event feedbackTelemetryEvent
	if err := decodeClosedJSON(raw, &event); err != nil {
		return ErrInvalidEvidence
	}
	if event.Version != 1 || event.Sequence < 0 || !validUtilityID(event.EventID) || !validUtilityID(event.JourneyID) {
		return ErrInvalidEvidence
	}
	if event.ParentEventID != "" && !validUtilityID(event.ParentEventID) {
		return ErrInvalidEvidence
	}
	if _, err := time.Parse(time.RFC3339Nano, event.OccurredAt); err != nil {
		return ErrInvalidEvidence
	}
	if !oneOf(event.Name, "journey.started", "journey.phase", "journey.terminal", "journey.linked", "http.request", "sync.frame", "rtc.summary", "diagnostic.timeline") ||
		!oneOf(event.Phase, "root", "authentication", "signaling", "media", "recovery", "terminal") ||
		!oneOf(event.State, "started", "in_progress", "succeeded", "failed", "cancelled", "observed") ||
		!oneOf(event.OriginKind, "client", "diagnostic", "http", "rtc", "sync") ||
		!oneOf(event.FirstObservedLayer, "client", "diagnostic", "http", "rtc", "sync") ||
		!oneOf(event.UpstreamVisibility, "local", "propagated") {
		return ErrInvalidEvidence
	}
	if !validOptionalHex(event.TraceID, 16) || !validOptionalHex(event.SpanID, 8) {
		return ErrInvalidEvidence
	}
	if event.Traceparent != "" && !traceparentPattern.MatchString(event.Traceparent) {
		return ErrInvalidEvidence
	}
	if event.Tracestate != "" && (len(event.Tracestate) > 512 || !printableASCII(event.Tracestate) || unsafeFeedbackValuePattern.MatchString(event.Tracestate)) {
		return ErrInvalidEvidence
	}
	return validateTelemetryAttributes(event.Attributes)
}

func validateTelemetryAttributes(attributes episodediagnostics.DiagnosticAttributes) error {
	if len(attributes) > maxTelemetryAttributes {
		return ErrInvalidEvidence
	}
	for key, value := range attributes {
		if key == "" || len(key) > maxTelemetryAttributeKey || sensitiveTelemetryKeyPattern.MatchString(strings.ToLower(strings.ReplaceAll(key, "-", "_"))) {
			return ErrInvalidEvidence
		}
		switch typed := value.(type) {
		case bool:
		case string:
			if len(typed) > maxTelemetryAttributeText || containsControl(typed) || unsafeFeedbackValuePattern.MatchString(typed) {
				return ErrInvalidEvidence
			}
		case float64:
			if math.IsNaN(typed) || math.IsInf(typed, 0) {
				return ErrInvalidEvidence
			}
		case json.Number:
			number, err := strconv.ParseFloat(string(typed), 64)
			if err != nil || math.IsNaN(number) || math.IsInf(number, 0) {
				return ErrInvalidEvidence
			}
		default:
			return ErrInvalidEvidence
		}
	}
	return nil
}

func validateLocalStateEntries(entries []FeedbackLocalStateEntry) error {
	seen := make(map[string]struct{}, len(entries))
	for _, entry := range entries {
		if _, exists := seen[entry.Key]; exists {
			return ErrInvalidEvidence
		}
		seen[entry.Key] = struct{}{}
		encoded, err := json.Marshal(entry.Value)
		if err != nil || entry.Value == nil {
			return ErrInvalidEvidence
		}
		switch {
		case entry.Key == "chalk.web.telemetry.v1" || entry.Key == "chalk.mobile.telemetry.v1":
			var summary feedbackTelemetryStorageSummary
			if decodeClosedJSON(encoded, &summary) != nil || !validTelemetryStorageSummary(summary) {
				return ErrInvalidEvidence
			}
		case entry.Key == "chalk.tenant-hint":
			var tenantID string
			if decodeClosedJSON(encoded, &tenantID) != nil || !validUtilityID(tenantID) {
				return ErrInvalidEvidence
			}
		case dashboardRequestKeyPattern.MatchString(entry.Key):
			var pending bool
			if decodeClosedJSON(encoded, &pending) != nil || !pending {
				return ErrInvalidEvidence
			}
		default:
			return ErrInvalidEvidence
		}
	}
	return nil
}

func validTelemetryStorageSummary(summary feedbackTelemetryStorageSummary) bool {
	if summary.PendingCount == nil && summary.TimelineCount == nil && summary.DroppedCount == nil {
		return false
	}
	for _, value := range []*int{summary.PendingCount, summary.TimelineCount, summary.DroppedCount} {
		if value != nil && (*value < 0 || *value > 500) {
			return false
		}
	}
	return true
}

func validateScreenshotBytes(data []byte, mimeType string, width, height int) error {
	if http.DetectContentType(data) != mimeType {
		return ErrInvalidScreenshot
	}
	actualWidth, actualHeight, err := imageDimensions(data, mimeType)
	if err != nil || actualWidth != width || actualHeight != height {
		return ErrInvalidScreenshot
	}
	return nil
}

func imageDimensions(data []byte, mimeType string) (int, int, error) {
	if mimeType != "image/webp" {
		config, _, err := image.DecodeConfig(bytes.NewReader(data))
		if err != nil {
			return 0, 0, err
		}
		return config.Width, config.Height, nil
	}
	return webPDimensions(data)
}

func webPDimensions(data []byte) (int, int, error) {
	if len(data) < 30 || string(data[:4]) != "RIFF" || string(data[8:12]) != "WEBP" {
		return 0, 0, ErrInvalidScreenshot
	}
	switch string(data[12:16]) {
	case "VP8X":
		return 1 + littleEndian24(data[24:27]), 1 + littleEndian24(data[27:30]), nil
	case "VP8L":
		if data[20] != 0x2f {
			return 0, 0, ErrInvalidScreenshot
		}
		width := 1 + int(data[21]) + (int(data[22]&0x3f) << 8)
		height := 1 + (int(data[22]&0xc0) >> 6) + (int(data[23]) << 2) + (int(data[24]&0x0f) << 10)
		return width, height, nil
	case "VP8 ":
		if data[23] != 0x9d || data[24] != 0x01 || data[25] != 0x2a {
			return 0, 0, ErrInvalidScreenshot
		}
		width := int(data[26]) | (int(data[27]&0x3f) << 8)
		height := int(data[28]) | (int(data[29]&0x3f) << 8)
		return width, height, nil
	default:
		return 0, 0, ErrInvalidScreenshot
	}
}

func littleEndian24(value []byte) int {
	return int(value[0]) | int(value[1])<<8 | int(value[2])<<16
}

func validUtilityID(value string) bool {
	id, err := utilities.ParseID(value)
	return err == nil && !id.IsZero()
}

func validOptionalHex(value string, bytesLength int) bool {
	if value == "" {
		return true
	}
	decoded, err := hex.DecodeString(value)
	if err != nil || len(decoded) != bytesLength {
		return false
	}
	for _, part := range decoded {
		if part != 0 {
			return value == strings.ToLower(value)
		}
	}
	return false
}

func decodeClosedJSON(data []byte, target any) error {
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	decoder.UseNumber()
	if err := decoder.Decode(target); err != nil {
		return err
	}
	if err := decoder.Decode(&struct{}{}); err != io.EOF {
		return ErrInvalidEvidence
	}
	return nil
}

func oneOf(value string, allowed ...string) bool {
	for _, candidate := range allowed {
		if value == candidate {
			return true
		}
	}
	return false
}

func printableASCII(value string) bool {
	for _, character := range value {
		if character < 0x20 || character > 0x7e || unicode.IsControl(character) {
			return false
		}
	}
	return true
}
