package telemetry

import (
	"context"
	"log/slog"
	"math"
	"regexp"
)

// The node writes many lines that must stay on the node: the standard library's own diagnostics
// (a TLS handshake error names the peer address), parser errors that quote SDP, control-request
// lines. Only the diagnosis trail leaves, and only through this table. A record leaves when its
// `event` attribute names a row, with the row's fields and no others, rewritten to carry the event
// name as its body. The journal keeps every line unfiltered.

// idFields name who and where an event happened. Every event may carry them.
var idFields = []string{
	"event", "tenant_id", "episode_id", "participant_id", "generation",
	"connection_id", "session_kind", "node_incarnation", "trace_id", "journey_id",
}

// exportedEvents maps each exportable event to the fields it adds to idFields. A field is a token,
// an id, a number or a flag, never free text: an error string has no row here. Adding an event
// or a field is a review decision, and the drift test in the media package fails until it is made.
var exportedEvents = map[string][]string{
	"sfu.session.registered":      {"allocation"},
	"sfu.session.refused":         {"code"},
	"sfu.admission.refused":       {"reason", "sessions"},
	"sfu.session.closed":          {"cause", "lifetime_ms", "publications", "subscriptions"},
	"sfu.peer.state":              {"state"},
	"sfu.ice.state":               {"state", "path"},
	"sfu.dtls.state":              {"state"},
	"sfu.publication.started":     {"source", "media_kind"},
	"sfu.publication.stopped":     {"source", "media_kind", "reason"},
	"sfu.subscription.started":    {"publisher_id", "source", "media_kind", "mid"},
	"sfu.subscription.stopped":    {"publisher_id", "source", "media_kind", "mid", "reason"},
	"sfu.subscription.paused":     {"publisher_id", "source", "media_kind", "mid", "reason"},
	"sfu.subscription.resumed":    {"publisher_id", "source", "media_kind", "mid", "was"},
	"sfu.subscription.layer":      {"publisher_id", "source", "media_kind", "mid", "rid"},
	"sfu.camera.plan":             {"level", "was", "ceiling_packets"},
	"sfu.source.lease_opened":     {"source", "revision"},
	"sfu.source.lease_lost":       {"source", "cause", "revision"},
	"sfu.subscription.congestion": {"connectionId", "mid", "rid", "reason", "estimateBps", "provenBps", "deliveredShare", "probing", "hostPressure", "ackedBps", "lossShare", "lossy", "trend", "decreaseCause", "decreaseAgoMs", "decreaseFromBps", "decreaseToBps", "decreaseAckedBps"},
}

// ExportedEvents lists the events that may leave the node, for the test that keeps the table and
// the code that emits events in step.
func ExportedEvents() []string {
	names := make([]string, 0, len(exportedEvents))
	for name := range exportedEvents {
		names = append(names, name)
	}
	return names
}

// ExportedFields lists the fields an event may export, or nil when the event may not leave.
func ExportedFields(event string) []string {
	extra, ok := exportedEvents[event]
	if !ok {
		return nil
	}
	return append(append([]string(nil), idFields...), extra...)
}

// token is the shape of every exported string: an enum value, an id or a candidate-type path. It
// has no space, quote, bracket or equals sign, so a sentence, a SDP line or an `ip:port` pair
// embedded in text cannot pass; the field list keeps a bare address out as well.
var token = regexp.MustCompile(`^[A-Za-z0-9._:/-]{1,128}$`)

// exportOnly passes the exportable events of the records it handles to next and drops the rest.
type exportOnly struct {
	next  slog.Handler
	attrs []slog.Attr
	// grouped marks a handler made by WithGroup. Its attributes sit under a group name, so none
	// is a top-level field and nothing leaves.
	grouped bool
}

func newExportOnly(next slog.Handler) *exportOnly {
	return &exportOnly{next: next}
}

func (h *exportOnly) Enabled(ctx context.Context, level slog.Level) bool {
	return !h.grouped && h.next.Enabled(ctx, level)
}

func (h *exportOnly) Handle(ctx context.Context, record slog.Record) error {
	if h.grouped {
		return nil
	}
	values := make(map[string]slog.Value, 16)
	for _, attr := range h.attrs {
		values[attr.Key] = attr.Value.Resolve()
	}
	record.Attrs(func(attr slog.Attr) bool {
		values[attr.Key] = attr.Value.Resolve()
		return true
	})
	event, ok := eventName(values["event"])
	if !ok {
		return nil
	}
	extra, ok := exportedEvents[event]
	if !ok {
		return nil
	}
	exported := slog.NewRecord(record.Time, record.Level, event, record.PC)
	for _, name := range append(append([]string(nil), idFields...), extra...) {
		if value, present := values[name]; present && exportable(value) {
			exported.AddAttrs(slog.Attr{Key: name, Value: value})
		}
	}
	return h.next.Handle(ctx, exported)
}

func (h *exportOnly) WithAttrs(attrs []slog.Attr) slog.Handler {
	next := *h
	next.attrs = append(append([]slog.Attr(nil), h.attrs...), attrs...)
	return &next
}

func (h *exportOnly) WithGroup(string) slog.Handler {
	next := *h
	next.grouped = true
	return &next
}

func eventName(value slog.Value) (string, bool) {
	if value.Kind() != slog.KindString {
		return "", false
	}
	return value.String(), true
}

// exportable reports whether a value is a bounded token, a finite number or a flag.
func exportable(value slog.Value) bool {
	switch value.Kind() {
	case slog.KindString:
		return token.MatchString(value.String())
	case slog.KindInt64, slog.KindUint64, slog.KindBool:
		return true
	case slog.KindFloat64:
		number := value.Float64()
		return !math.IsNaN(number) && !math.IsInf(number, 0)
	default:
		return false
	}
}
