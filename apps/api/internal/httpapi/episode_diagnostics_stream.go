package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/episodediagnostics"
)

const diagnosticMaxSSEDataBytes = 64*1024 - len("data: ")

var errDiagnosticSSEDataTooLarge = errors.New("diagnostic SSE data payload exceeds the single-line decoder limit")

type diagnosticSSEDataTooLargeError struct {
	payloadBytes int
}

func (e *diagnosticSSEDataTooLargeError) Error() string {
	return fmt.Sprintf("%s: got %d bytes, limit is %d", errDiagnosticSSEDataTooLarge, e.payloadBytes, diagnosticMaxSSEDataBytes)
}

func (e *diagnosticSSEDataTooLargeError) Unwrap() error {
	return errDiagnosticSSEDataTooLarge
}

func episodeDiagnosticStreamHandler(options EpisodeDiagnosticsHTTPOptions) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		operator, reference, ok := authenticateDiagnosticOperator(w, r, options, "stream")
		if !ok {
			return
		}
		if options.Service == nil {
			writeEpisodeDiagnosticsError(w, episodediagnostics.ErrDisabled)
			return
		}
		filter, err := diagnosticFilterFromRequest(r)
		if err != nil {
			writeEpisodeDiagnosticsError(w, err)
			return
		}
		matchingFilter, err := options.Service.PrepareFilter(filter)
		if err != nil {
			writeEpisodeDiagnosticsError(w, err)
			return
		}
		after, err := optionalDiagnosticCursor(r.URL.Query().Get("after"))
		if err != nil {
			writeEpisodeDiagnosticsError(w, err)
			return
		}
		if lastEventID := strings.TrimSpace(r.Header.Get("Last-Event-ID")); lastEventID != "" {
			last, parseErr := optionalDiagnosticCursor(lastEventID)
			if parseErr != nil {
				writeEpisodeDiagnosticsError(w, parseErr)
				return
			}
			after = last
		}
		cursor := int64(0)
		if after != nil {
			cursor = *after
		}
		heartbeat := options.StreamHeartbeatInterval
		if heartbeat <= 0 {
			heartbeat = diagnosticDefaultHeartbeat
		}
		deadline := options.StreamDeadline
		if deadline <= 0 {
			deadline = diagnosticDefaultStreamLimit
		}
		pollInterval := options.StreamPollInterval
		if pollInterval <= 0 {
			pollInterval = diagnosticDefaultPollInterval
		}
		batchSize := options.StreamBatchSize
		if batchSize <= 0 {
			batchSize = diagnosticDefaultBatchSize
		}
		if batchSize > episodediagnostics.MaxPageSize {
			batchSize = episodediagnostics.MaxPageSize
		}
		filterFingerprint := episodediagnostics.FilterFingerprint(filter)
		if requestedFingerprint := diagnosticFilterFingerprintFromRequest(r); requestedFingerprint != "" && requestedFingerprint != filterFingerprint {
			writeEpisodeDiagnosticsError(w, errors.New("invalid diagnostic filter fingerprint"))
			return
		}
		streamContext, cancel := context.WithTimeout(r.Context(), deadline)
		defer cancel()

		w.Header().Set("Content-Type", "text/event-stream; charset=utf-8")
		w.Header().Set("Cache-Control", "private, no-store, no-cache, no-transform")
		w.Header().Set("Connection", "keep-alive")
		w.Header().Set("X-Accel-Buffering", "no")
		control := episodediagnostics.DiagnosticStreamControlV1{
			SchemaVersion:            "DiagnosticStreamControl/v1",
			HeartbeatIntervalSeconds: int(heartbeat / time.Second),
			MaxConnectionSeconds:     int(deadline / time.Second),
			AfterCursor:              cursor,
			FilterFingerprint:        filterFingerprint,
			MaxPendingDeltas:         batchSize,
		}
		if err := writeDiagnosticSSEWithDeadline(w, "control", "", control); err != nil {
			return
		}
		if err := flushDiagnosticStream(w); err != nil {
			return
		}

		heartbeatTicker := time.NewTicker(heartbeat)
		defer heartbeatTicker.Stop()
		pollTicker := time.NewTicker(pollInterval)
		defer pollTicker.Stop()
		pollNow := make(chan struct{}, 1)
		pollNow <- struct{}{}
		for {
			select {
			case <-streamContext.Done():
				reason := "client_disconnected"
				if errors.Is(streamContext.Err(), context.DeadlineExceeded) {
					reason = "deadline"
				}
				_ = writeDiagnosticStreamClose(w, reason, cursor)
				return
			case <-heartbeatTicker.C:
				if err := writeDiagnosticSSEWithDeadline(w, "heartbeat", "", map[string]any{"schemaVersion": "DiagnosticStreamHeartbeat/v1", "at": time.Now().UTC()}); err != nil {
					return
				}
				if err := flushDiagnosticStream(w); err != nil {
					return
				}
			case <-pollTicker.C:
				select {
				case pollNow <- struct{}{}:
				default:
				}
			case <-pollNow:
				changedDiagnostic, changes, changeErr := options.Service.Changes(streamContext, operator, reference, cursor, batchSize)
				if changeErr != nil {
					_ = writeDiagnosticStreamClose(w, "server_error", cursor)
					return
				}
				startCursor := cursor
				for _, change := range changes {
					if change.Cursor <= startCursor {
						continue
					}
					payload, payloadErr := diagnosticStreamDeltaPayload(reference, filterFingerprint, matchingFilter, change)
					if payloadErr != nil {
						payload = diagnosticStreamGapPayload(reference, filterFingerprint, change.Cursor, "invalid_projection_payload")
					}
					if err := writeDiagnosticStreamDelta(streamContext, w, reference, filterFingerprint, change.Cursor, change.Kind, payload); err != nil {
						return
					}
					if err := flushDiagnosticStream(w); err != nil {
						return
					}
					if change.Cursor > cursor {
						cursor = change.Cursor
					}
				}
				if changedDiagnostic.ProjectedCursor > cursor && len(changes) == 0 {
					// The projector can advance without a retained change row. The
					// next durable page refill is the only safe way to reconstruct it.
					payload := diagnosticStreamGapPayload(reference, filterFingerprint, changedDiagnostic.ProjectedCursor, "projection_gap")
					if err := writeDiagnosticStreamDelta(streamContext, w, reference, filterFingerprint, changedDiagnostic.ProjectedCursor, episodediagnostics.StreamDeltaGap, payload); err != nil {
						return
					}
					if err := flushDiagnosticStream(w); err != nil {
						return
					}
					cursor = changedDiagnostic.ProjectedCursor
				}
			}
		}
	}
}

func writeDiagnosticSSE(w http.ResponseWriter, event, id string, payload any) error {
	encoded, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	if len(encoded) > diagnosticMaxSSEDataBytes {
		return &diagnosticSSEDataTooLargeError{payloadBytes: len(encoded)}
	}
	if id != "" {
		if _, err := fmt.Fprintf(w, "id: %s\n", id); err != nil {
			return err
		}
	}
	if event != "" {
		if _, err := fmt.Fprintf(w, "event: %s\n", event); err != nil {
			return err
		}
	}
	_, err = fmt.Fprintf(w, "data: %s\n\n", encoded)
	return err
}

func writeDiagnosticStreamDelta(ctx context.Context, w http.ResponseWriter, reference, filterFingerprint string, cursor int64, kind episodediagnostics.StreamDeltaKind, payload any) error {
	id := strconv.FormatInt(cursor, 10)
	err := writeDiagnosticSSEWithDeadline(w, "delta", id, payload)
	if !errors.Is(err, errDiagnosticSSEDataTooLarge) {
		return err
	}
	var oversized *diagnosticSSEDataTooLargeError
	if errors.As(err, &oversized) && kind != episodediagnostics.StreamSnapshot {
		slog.WarnContext(ctx, "episode diagnostics stream delta refilled",
			"event", "episode_diagnostics.stream_delta_refilled",
			"kind", diagnosticStreamKindForLog(kind),
			"reason", "snapshot_refresh",
			"payload_bytes", oversized.payloadBytes,
			"limit_bytes", diagnosticMaxSSEDataBytes,
		)
	}
	return writeDiagnosticSSEWithDeadline(w, "delta", id, diagnosticStreamRefreshPayload(reference, filterFingerprint, cursor))
}

func diagnosticStreamKindForLog(kind episodediagnostics.StreamDeltaKind) string {
	switch kind {
	case episodediagnostics.StreamEventAppended, episodediagnostics.StreamOperationUpdated, episodediagnostics.StreamIssueUpdated, episodediagnostics.StreamBranchUpdated, episodediagnostics.StreamDeltaGap:
		return string(kind)
	default:
		return "unknown"
	}
}

func writeDiagnosticSSEWithDeadline(w http.ResponseWriter, event, id string, payload any) error {
	// A write deadline turns a disconnected or slow SSE consumer into a
	// bounded failure instead of pinning one API goroutine forever. Response
	// recorders do not support deadlines, so that error is intentionally ignored.
	_ = http.NewResponseController(w).SetWriteDeadline(time.Now().Add(10 * time.Second))
	return writeDiagnosticSSE(w, event, id, payload)
}

func flushDiagnosticStream(w http.ResponseWriter) error {
	return http.NewResponseController(w).Flush()
}

func diagnosticFilterFingerprintFromRequest(r *http.Request) string {
	for _, key := range []string{"X-Chalk-Diagnostics-Filter-Fingerprint", "X-Diagnostic-Filter-Fingerprint"} {
		if value := strings.TrimSpace(r.Header.Get(key)); value != "" {
			return value
		}
	}
	for _, key := range []string{"filter_fingerprint", "filterFingerprint"} {
		if value := strings.TrimSpace(r.URL.Query().Get(key)); value != "" {
			return value
		}
	}
	return ""
}

func writeDiagnosticStreamClose(w http.ResponseWriter, reason string, cursor int64) error {
	closePayload := episodediagnostics.DiagnosticStreamCloseV1{SchemaVersion: "DiagnosticStreamClose/v1", Reason: reason, ResumableCursor: cursor, RefillRequired: reason == "projection_gap" || reason == "server_error"}
	err := writeDiagnosticSSEWithDeadline(w, "close", "", closePayload)
	if err == nil {
		err = flushDiagnosticStream(w)
	}
	return err
}

func diagnosticStreamDeltaPayload(reference, filterFingerprint string, filter episodediagnostics.DiagnosticFilterV1, change episodediagnostics.ProjectionChange) (map[string]any, error) {
	payload := map[string]any{
		"schemaVersion":     "DiagnosticStreamDelta/v1",
		"reference":         reference,
		"cursor":            change.Cursor,
		"kind":              change.Kind,
		"filterFingerprint": filterFingerprint,
	}
	switch change.Kind {
	case episodediagnostics.StreamEventAppended:
		var event episodediagnostics.AcceptedDiagnosticEvent
		if err := json.Unmarshal(change.Payload, &event); err != nil {
			return nil, err
		}
		if !diagnosticEventMatchesFilter(event, filter) {
			return diagnosticStreamGapPayload(reference, filterFingerprint, change.Cursor, "filtered"), nil
		}
		// Projection payloads are an internal persistence seam. Redact the
		// provider HMAC after filtering before serializing any SSE response.
		redactDiagnosticEventProvider(&event)
		payload["event"] = event
	case episodediagnostics.StreamOperationUpdated:
		var operation episodediagnostics.DiagnosticOperationDetail
		if err := json.Unmarshal(change.Payload, &operation); err != nil {
			return nil, err
		}
		if !diagnosticOperationMatchesFilter(operation, filter) {
			return diagnosticStreamGapPayload(reference, filterFingerprint, change.Cursor, "filtered"), nil
		}
		redactDiagnosticOperationProvider(&operation)
		payload["operation"] = operation
	case episodediagnostics.StreamIssueUpdated:
		var issue episodediagnostics.DiagnosticIssueDetail
		if err := json.Unmarshal(change.Payload, &issue); err != nil {
			return nil, err
		}
		if !diagnosticIssueMatchesFilter(issue, filter) {
			return diagnosticStreamGapPayload(reference, filterFingerprint, change.Cursor, "filtered"), nil
		}
		payload["issue"] = issue
	case episodediagnostics.StreamBranchUpdated:
		var branch episodediagnostics.DiagnosticBranchDetail
		if err := json.Unmarshal(change.Payload, &branch); err != nil {
			return nil, err
		}
		payload["branch"] = branch
	case episodediagnostics.StreamSnapshot:
		return diagnosticStreamRefreshPayload(reference, filterFingerprint, change.Cursor), nil
	case episodediagnostics.StreamDeltaGap:
		var gap episodediagnostics.StreamGap
		if err := json.Unmarshal(change.Payload, &gap); err != nil {
			return nil, err
		}
		payload["gap"] = gap
	default:
		return nil, errors.New("unsupported diagnostic projection change")
	}
	return payload, nil
}

func redactDiagnosticEventProvider(event *episodediagnostics.AcceptedDiagnosticEvent) {
	if event == nil || event.Correlation == nil {
		return
	}
	event.Correlation.ProviderID = ""
	correlation := event.Correlation
	if correlation.JourneyID == "" && correlation.TraceID == "" && correlation.SpanID == "" && correlation.RequestID == "" && correlation.CommandID == "" && correlation.RetryGroupRef == "" && correlation.Attempt == 0 {
		event.Correlation = nil
	}
}

func redactDiagnosticOperationProvider(operation *episodediagnostics.DiagnosticOperationDetail) {
	if operation == nil {
		return
	}
	if operation.ProviderID != nil {
		operation.ProviderID = episodediagnostics.SafeIdentifierFor("provider", "redacted")
	}
	operation.ProviderLookupID = ""
}

func diagnosticStreamGapPayload(reference, filterFingerprint string, cursor int64, reason string) map[string]any {
	from := cursor
	if from > 0 {
		from--
	}
	return map[string]any{
		"schemaVersion":     "DiagnosticStreamDelta/v1",
		"reference":         reference,
		"cursor":            cursor,
		"kind":              episodediagnostics.StreamDeltaGap,
		"filterFingerprint": filterFingerprint,
		"gap": episodediagnostics.StreamGap{
			FromCursor: &from,
			ToCursor:   &cursor,
			Reason:     reason,
		},
	}
}

func diagnosticStreamRefreshPayload(reference, filterFingerprint string, cursor int64) map[string]any {
	return map[string]any{
		"schemaVersion":     "DiagnosticStreamDelta/v1",
		"reference":         reference,
		"cursor":            cursor,
		"kind":              episodediagnostics.StreamDeltaGap,
		"filterFingerprint": filterFingerprint,
		"gap": episodediagnostics.StreamGap{
			FromCursor: &cursor,
			ToCursor:   &cursor,
			Reason:     "snapshot_refresh",
		},
	}
}

func diagnosticEventMatchesFilter(event episodediagnostics.AcceptedDiagnosticEvent, filter episodediagnostics.DiagnosticFilterV1) bool {
	// These dimensions are resolved through the durable event query (or its
	// operation/issue joins), not carried on the accepted Event itself. A
	// filtered stream must not optimistically expose a row it cannot prove
	// matches; the subsequent snapshot marker supplies the bounded refill.
	if filter.ParticipantID != "" || filter.OperationKind != "" || filter.IssueState != "" {
		return false
	}
	if filter.Source != "" && event.Source != filter.Source {
		return false
	}
	if filter.State != "" && string(event.State) != filter.State {
		return false
	}
	if filter.ReleaseID != "" && (event.Release == nil || event.Release.ID != filter.ReleaseID) {
		return false
	}
	if filter.FromCursor != nil && event.Cursor < *filter.FromCursor || filter.ToCursor != nil && event.Cursor > *filter.ToCursor {
		return false
	}
	if !filter.FromTime.IsZero() && event.OccurredAt.Before(filter.FromTime) || !filter.ToTime.IsZero() && event.OccurredAt.After(filter.ToTime) {
		return false
	}
	if filter.JourneyID != "" || filter.TraceID != "" || filter.SpanID != "" || filter.RequestID != "" || filter.CommandID != "" || filter.ProviderID != "" {
		correlation := event.Correlation
		if correlation == nil {
			return false
		}
		if filter.JourneyID != "" && correlation.JourneyID != filter.JourneyID || filter.TraceID != "" && correlation.TraceID != filter.TraceID || filter.SpanID != "" && correlation.SpanID != filter.SpanID || filter.RequestID != "" && correlation.RequestID != filter.RequestID || filter.CommandID != "" && correlation.CommandID != filter.CommandID || filter.ProviderID != "" && correlation.ProviderID != filter.ProviderID {
			return false
		}
	}
	return true
}

func diagnosticOperationMatchesFilter(operation episodediagnostics.DiagnosticOperationDetail, filter episodediagnostics.DiagnosticFilterV1) bool {
	if filter.ParticipantID != "" || filter.IssueState != "" {
		return false
	}
	if filter.OperationKind != "" && operation.Kind != filter.OperationKind {
		return false
	}
	if filter.State != "" && string(operation.State) != filter.State {
		return false
	}
	if filter.ReleaseID != "" && operation.ReleaseID != filter.ReleaseID {
		return false
	}
	if filter.Source != "" && operation.Source != filter.Source {
		return false
	}
	if filter.FromTime.After(operation.StartedAt) || filter.ToTime.Before(operation.StartedAt) {
		return false
	}
	for _, pair := range []struct {
		value  any
		wanted string
	}{
		{operation.RequestID, filter.RequestID},
		{operation.CommandID, filter.CommandID},
		{operation.ProviderID, filter.ProviderID},
		{operation.JourneyID, filter.JourneyID},
		{operation.TraceID, filter.TraceID},
		{operation.SpanID, filter.SpanID},
	} {
		if pair.wanted != "" && !diagnosticIdentifierMatches(pair.value, pair.wanted) {
			return false
		}
	}
	return true
}

func diagnosticIssueMatchesFilter(issue episodediagnostics.DiagnosticIssueDetail, filter episodediagnostics.DiagnosticFilterV1) bool {
	if filter.IssueState != "" && issue.State != filter.IssueState {
		return false
	}
	return filter.ParticipantID == "" && filter.Source == "" && filter.OperationKind == "" && filter.State == "" && filter.ReleaseID == "" && filter.JourneyID == "" && filter.TraceID == "" && filter.SpanID == "" && filter.RequestID == "" && filter.CommandID == "" && filter.ProviderID == "" && filter.FromCursor == nil && filter.ToCursor == nil && filter.FromTime.IsZero() && filter.ToTime.IsZero()
}

func diagnosticIdentifierMatches(value any, wanted string) bool {
	switch typed := value.(type) {
	case string:
		return typed == wanted
	case episodediagnostics.SafeIdentifier:
		return typed.Value == wanted
	case *episodediagnostics.SafeIdentifier:
		return typed != nil && typed.Value == wanted
	case map[string]any:
		candidate, _ := typed["value"].(string)
		return candidate == wanted
	default:
		return false
	}
}
