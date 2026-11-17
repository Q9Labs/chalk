package sdktelemetry

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"reflect"
	"time"
)

// Request is one batch. A client session is one run of an app on a device, and its
// events carry sequence numbers from zero, so a gap in them is a loss the server can see.
type Request struct {
	Version         int     `json:"version"`
	ClientSessionID string  `json:"client_session_id"`
	Events          []Event `json:"events"`
}

// Response says how many events of the batch were kept. A rejected event is
// logged with the reason; the client drops it and does not send it again.
type Response struct {
	Accepted int `json:"accepted"`
	Rejected int `json:"rejected"`
}

// DecodeStrict reads exactly one JSON value, refusing unknown fields and trailing data. The
// reason is a fixed label, never decoder text or input.
func DecodeStrict(body io.Reader, into any) string {
	decoder := json.NewDecoder(body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(into); err != nil {
		var oversized *http.MaxBytesError
		if errors.As(err, &oversized) {
			return "body_too_large"
		}
		return "schema"
	}
	if err := decoder.Decode(new(json.RawMessage)); err != io.EOF {
		return "trailing_json"
	}
	return ""
}

// Decode reads one batch from a body that the caller has already bounded. A batch
// is refused as a whole only when its frame is wrong; a bad event is marked
// and counted alone.
func Decode(body io.Reader) (Request, string) {
	var request Request
	if reason := DecodeStrict(body, &request); reason != "" {
		return request, reason
	}
	switch {
	case request.Version != Version:
		return request, "version"
	case !uuidPattern.MatchString(request.ClientSessionID):
		return request, "client_session_id"
	case len(request.Events) == 0 || len(request.Events) > EventLimit:
		return request, "event_count"
	}
	return request, ""
}

// Attributes are the log attributes of an event's row: its type, order and set fields.
// The stats window is flattened to the same names a call-stats row has always used.
func (e Event) Attributes() []any {
	attributes := []any{"type", e.Type, "seq", e.Seq, "elapsed_ms", e.ElapsedMS}
	return appendSet(attributes, reflect.ValueOf(e))
}

func appendSet(attributes []any, value reflect.Value) []any {
	for index := range value.NumField() {
		name, optional := jsonName(value.Type().Field(index))
		field := value.Field(index)
		if !optional || field.IsZero() {
			continue
		}
		field = reflect.Indirect(field)
		if name == "stats" {
			attributes = append(attributes, "window_ms", field.FieldByName("WindowMS").Int())
			attributes = appendSet(attributes, field)
			continue
		}
		attributes = append(attributes, name, field.Interface())
	}
	return attributes
}

// Log writes one row per event, and one per rejected event, to the request's logger. The
// client session, the participant and the server's receive time go on every row.
func Log(ctx context.Context, logger *slog.Logger, request Request, received time.Time, stamp ...any) Response {
	logger = logger.With(stamp...).With("client_session_id", request.ClientSessionID, "received_at", received.UTC().Format(time.RFC3339Nano))
	var response Response
	for _, event := range request.Events {
		if reason := event.Rejection(); reason != "" {
			response.Rejected++
			eventType, seq := event.Seen()
			logger.WarnContext(ctx, "Rejected SDK telemetry event", "event", "sdk.telemetry.rejected", "reason", reason, "type", eventType, "seq", seq)
			continue
		}
		response.Accepted++
		logger.InfoContext(ctx, "SDK telemetry", append([]any{"event", "sdk.telemetry"}, event.Attributes()...)...)
	}
	return response
}
