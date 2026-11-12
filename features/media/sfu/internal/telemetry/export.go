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

// A source says where an exported field's value comes from. A value a Participant or a peer
// chooses (an SDP rid, a name, an address, any text) has no source here and cannot be exported:
// the node maps it to an enum or counts it first, and the raw value stays in the journal.
type source string

const (
	// serverAssigned values are made by the node: its incarnation, a transceiver mid.
	serverAssigned source = "server-assigned"
	// enum values come from a closed set in the node's code: a state, a cause, a reason.
	enum source = "enum"
	// number values are counts, sizes, rates and flags the node measured.
	number source = "number"
	// restrictedID values are ids the API issued or the node checked against a fixed pattern
	// (letters, digits and . _ : -; hex and dashes for trace and journey ids).
	restrictedID source = "restricted id"
)

// fieldSources lists every field that may leave the node, and where its value comes from.
var fieldSources = map[string]source{
	"event": enum, "tenant_id": restrictedID, "episode_id": restrictedID, "participant_id": restrictedID,
	"generation": number, "connection_id": restrictedID, "session_kind": enum, "node_incarnation": serverAssigned,
	"trace_id": restrictedID, "journey_id": restrictedID,

	"allocation": number, "code": enum, "reason": enum, "sessions": number, "cause": enum,
	"lifetime_ms": number, "publications": number, "subscriptions": number, "state": enum, "path": enum,
	"source": enum, "media_kind": enum, "publisher_id": restrictedID, "mid": serverAssigned,
	"was": enum, "layer": enum, "ceiling": enum, "server_limit": enum, "level": enum, "ceiling_packets": number, "revision": number,
	"connectionId": restrictedID, "estimateBps": number, "provenBps": number, "deliveredShare": number,
	"probing": number, "hostPressure": number, "ackedBps": number, "lossShare": number, "lossy": number,
	"trend": enum, "decreaseCause": enum, "decreaseAgoMs": number, "decreaseFromBps": number,
	"decreaseToBps": number, "decreaseAckedBps": number,
}

// idFields name who and where an event happened. Every event may carry them.
var idFields = []string{
	"event", "tenant_id", "episode_id", "participant_id", "generation",
	"connection_id", "session_kind", "node_incarnation", "trace_id", "journey_id",
}

// exportedEvents maps each exportable event to the fields it adds to idFields. Every field has a
// row in fieldSources. An error string has no row, and neither has a rid: the layer events carry
// `layer`, an enum the node derives from the rid.
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
	"sfu.subscription.layer":      {"publisher_id", "source", "media_kind", "mid", "layer", "ceiling", "server_limit"},
	"sfu.camera.plan":             {"level", "was", "ceiling_packets"},
	"sfu.source.lease_opened":     {"source", "revision"},
	"sfu.source.lease_lost":       {"source", "cause", "revision"},
	"sfu.subscription.congestion": {"connectionId", "mid", "layer", "reason", "estimateBps", "provenBps", "deliveredShare", "probing", "hostPressure", "ackedBps", "lossShare", "lossy", "trend", "decreaseCause", "decreaseAgoMs", "decreaseFromBps", "decreaseToBps", "decreaseAckedBps"},
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
		if value, present := values[name]; present && exportable(fieldSources[name], value) {
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

// exportable reports whether a value fits its field's source: a bounded token for the string
// sources, a finite number or a flag for a number.
func exportable(kind source, value slog.Value) bool {
	switch kind {
	case enum, serverAssigned, restrictedID:
		return value.Kind() == slog.KindString && token.MatchString(value.String())
	case number:
		switch value.Kind() {
		case slog.KindInt64, slog.KindUint64, slog.KindBool:
			return true
		case slog.KindFloat64:
			return !math.IsNaN(value.Float64()) && !math.IsInf(value.Float64(), 0)
		}
	}
	return false
}
