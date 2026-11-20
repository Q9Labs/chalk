package sdktelemetry

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"reflect"
	"slices"
	"time"
)

// Request is one batch. Version 1 is the legacy wire: a client session is one run of an
// app on a device, with no acknowledgment. Version 2 is the ledger wire: a source is one
// boot of the SDK, and the server settles its seqs.
type Request struct {
	// Version is Version (1) or LedgerVersion (2).
	Version int `json:"version"`
	// ClientSessionID names the client session. Version 1 requires it; version 2 refuses it.
	ClientSessionID string `json:"client_session_id,omitempty"`
	// SourceID names the SDK boot whose seqs the events carry. Version 2 requires it.
	SourceID string `json:"source_id,omitempty"`
	// BatchID names this batch; a retry of the same batch sends the same id. Version 2 requires it.
	BatchID string `json:"batch_id,omitempty"`
	// NextSeq is the seq the source will give its next record, so every seq of the batch is below it.
	// Version 2 requires it.
	NextSeq *int64 `json:"next_seq,omitempty"`
	// End says the source has stopped sending: closed when it ended cleanly, abandoned when its
	// owner went away without saying. Version 2 only, optional.
	End string `json:"end,omitempty"`
	// Events holds 1 to 100 events in version 1. In version 2 it holds 0 to 100, and empty only when End is set.
	Events []Event `json:"events"`
}

// SeqRange is the half-open range [From, To) of seqs.
type SeqRange struct {
	From int64 `json:"from"`
	To   int64 `json:"to"`
}

// Rejection names one event the server refused for its content. The refusal is final.
type Rejection struct {
	Seq    int64  `json:"seq"`
	Reason string `json:"reason"`
}

// Response says how many events of the batch were kept. A rejected event is
// logged with the reason; the client drops it and does not send it again. Acks
// and Rejections are lists, never null; a version 1 batch has no ledger, so both are empty.
type Response struct {
	Accepted   int         `json:"accepted"`
	Rejected   int         `json:"rejected"`
	Duplicates int         `json:"duplicates"`
	Acks       []SeqRange  `json:"acks"`
	Rejections []Rejection `json:"rejections"`
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
	switch request.Version {
	case Version:
		return request, request.checkLegacyFrame()
	case LedgerVersion:
		return request, request.checkLedgerFrame()
	}
	return request, "version"
}

func (r Request) checkLegacyFrame() string {
	switch {
	case r.SourceID != "" || r.BatchID != "" || r.NextSeq != nil || r.End != "":
		return "schema"
	case !uuidPattern.MatchString(r.ClientSessionID):
		return "client_session_id"
	case len(r.Events) == 0 || len(r.Events) > EventLimit:
		return "event_count"
	}
	return ""
}

// checkLedgerFrame checks the frame of a version 2 batch, then marks each event that breaks a
// rule that needs the frame. It refuses the whole batch when it cannot name an event's seq,
// because the answer could not say which events it settled.
func (r *Request) checkLedgerFrame() string {
	switch {
	case r.ClientSessionID != "":
		return "client_session_id"
	case !uuidPattern.MatchString(r.SourceID):
		return "source_id"
	case !uuidPattern.MatchString(r.BatchID):
		return "batch_id"
	case r.NextSeq == nil || *r.NextSeq < 0 || *r.NextSeq > MaxMilliseconds:
		return "next_seq"
	case r.End != "" && !slices.Contains(fieldEnums["end"], r.End):
		return "end"
	case len(r.Events) > EventLimit || (len(r.Events) == 0 && r.End == ""):
		return "event_count"
	}
	seen := make(map[int64]bool, len(r.Events))
	for index := range r.Events {
		event := &r.Events[index]
		if !event.seqRead || event.seqValue() < 0 || event.seqValue() > MaxMilliseconds {
			return "seq"
		}
		if seen[event.seqValue()] {
			return "duplicate_seq"
		}
		seen[event.seqValue()] = true
		event.checkLedger(*r.NextSeq)
	}
	return ""
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
// client session (version 1) or source and batch (version 2), the participant and the server's
// receive time go on every row. The response names the seqs of a version 2 batch that were
// accepted or rejected; it has no ledger behind it, so it never reports a duplicate.
func Log(ctx context.Context, logger *slog.Logger, request Request, received time.Time, stamp ...any) Response {
	logger = logger.With(stamp...)
	if request.Version == LedgerVersion {
		logger = logger.With("source_id", request.SourceID, "batch_id", request.BatchID)
	} else {
		logger = logger.With("client_session_id", request.ClientSessionID)
	}
	logger = logger.With("received_at", received.UTC().Format(time.RFC3339Nano))
	response := Response{Acks: []SeqRange{}, Rejections: []Rejection{}}
	var settled []int64
	for _, event := range request.Events {
		if reason := event.Rejection(); reason != "" {
			response.Rejected++
			eventType, seq := event.Seen()
			logger.WarnContext(ctx, "Rejected SDK telemetry event", "event", "sdk.telemetry.rejected", "reason", reason, "type", eventType, "seq", seq)
			if request.Version == LedgerVersion {
				response.Rejections = append(response.Rejections, Rejection{Seq: event.seqValue(), Reason: reason})
				settled = append(settled, event.seqValue())
			}
			continue
		}
		response.Accepted++
		logger.InfoContext(ctx, "SDK telemetry", append([]any{"event", "sdk.telemetry"}, event.Attributes()...)...)
		if request.Version == LedgerVersion {
			settled = append(settled, event.seqValue())
		}
	}
	response.Acks = Ranges(settled)
	return response
}

// Ranges merges seqs into the fewest half-open ranges, in ascending order. The result is never nil.
func Ranges(seqs []int64) []SeqRange {
	ranges := []SeqRange{}
	for _, seq := range slices.Sorted(slices.Values(seqs)) {
		if last := len(ranges) - 1; last >= 0 && seq <= ranges[last].To {
			ranges[last].To = max(ranges[last].To, seq+1)
			continue
		}
		ranges = append(ranges, SeqRange{From: seq, To: seq + 1})
	}
	return ranges
}
