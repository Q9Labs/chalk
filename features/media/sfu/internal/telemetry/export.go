package telemetry

import (
	"context"
	"log/slog"
	"math"
	"regexp"

	"github.com/q9labs/chalk/features/media/sfu/internal/media"
)

// The node writes many lines that must stay on the node: the standard library's own diagnostics
// (a TLS handshake error names the peer address), parser errors that quote SDP, control-request
// lines. Only the diagnosis trail leaves, and only through this table. A record leaves when its
// `event` attribute names a row, with the row's fields and no others, rewritten to carry the event
// name as its body. The journal keeps every line unfiltered.

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
	extra, ok := media.EventFields[event]
	if !ok {
		return nil
	}
	exported := slog.NewRecord(record.Time, record.Level, event, record.PC)
	for _, name := range append(append([]string(nil), media.IDFields...), extra...) {
		if value, present := values[name]; present && exportable(media.FieldSources[name], value) {
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
func exportable(kind media.FieldSource, value slog.Value) bool {
	switch kind {
	case media.Enum, media.ServerAssigned, media.RestrictedID:
		return value.Kind() == slog.KindString && token.MatchString(value.String())
	case media.Number:
		return exportableNumber(value)
	}
	return false
}

func exportableNumber(value slog.Value) bool {
	switch value.Kind() {
	case slog.KindInt64, slog.KindUint64, slog.KindBool:
		return true
	case slog.KindFloat64:
		return !math.IsNaN(value.Float64()) && !math.IsInf(value.Float64(), 0)
	}
	return false
}
