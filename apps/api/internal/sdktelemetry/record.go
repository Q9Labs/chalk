package sdktelemetry

import (
	"bytes"
	"encoding/json"
	"log/slog"
	"maps"
	"math"
	"slices"

	"github.com/q9labs/chalk/apps/api/internal/obs"
)

// RecordOwned are the fields the API stamps on a kernel record's row from the credential and the frame. A record that
// carries one is rejected, so a client can neither name another seat nor reach into the delivery ledger's fields.
var RecordOwned = []string{
	"tenant_id", "space_id", "episode_id", "participant_id", "generation", "user_id", "agent_id", "provider_media_id",
	"source_id", "batch_id", "next_seq", "end", "dropped_seqs", "drop_reason",
}

// record is a kernel record of a ledger batch: the registry event it names and its other fields as they were sent. The
// client kernel made it (sdks/typescript/client/src/obs/kernel.ts) and the outbox gave it its seq.
type record struct {
	kind, name string
	fields     map[string]any
}

// isRecordJSON says the event names its record kind, so it is a kernel record rather than one of the legacy vocabulary.
func isRecordJSON(data []byte) bool {
	var probe struct {
		Kind json.RawMessage `json:"kind"`
	}
	return json.Unmarshal(data, &probe) == nil && probe.Kind != nil
}

// decodeRecord checks one kernel record against the registry, the way UnmarshalJSON checks an event of the legacy
// vocabulary against its table: alone, so one bad record cannot fail its batch.
func decodeRecord(data []byte) Event {
	var fields map[string]any
	decoder := json.NewDecoder(bytes.NewReader(data))
	if err := decoder.Decode(&fields); err != nil || fields == nil {
		return Event{rejection: "schema"}
	}
	seq, seqRead := wireSeq(fields["seq"])
	event := Event{Seq: seq, seqRead: seqRead}
	if eventID, ok := fields["event_id"].(string); ok {
		event.EventID = eventID
	}
	kind, _ := fields["kind"].(string)
	name, _ := fields["name"].(string)
	delete(fields, "kind")
	delete(fields, "name")
	event.rejection = recordRejection(seqRead, kind, name, fields)
	if event.rejection != "" {
		event.seen = seenEvent{Seq: seq}
		return event
	}
	event.record = &record{kind: kind, name: name, fields: fields}
	return event
}

func recordRejection(seqRead bool, kind, name string, fields map[string]any) string {
	if !seqRead {
		return "seq_missing"
	}
	return obs.ClientRecordProblem(kind, name, fields, RecordOwned)
}

// wireSeq reads a seq the way the ledger counts: a whole number from 0 to MaxMilliseconds.
func wireSeq(value any) (int64, bool) {
	number, ok := value.(float64)
	if !ok || number != math.Trunc(number) || number < 0 || number > MaxMilliseconds {
		return 0, false
	}
	return int64(number), true
}

// recordAttrs are the attributes of a kernel record's row in the registry row shape: the record's fields under their registry
// names in name order, then kind and name, as the server kernels write theirs (obs.send). A whole number goes out as an
// integer, so the row reads the same as a server kernel's.
func (r record) attrs() []slog.Attr {
	attrs := make([]slog.Attr, 0, len(r.fields)+2)
	for _, field := range slices.Sorted(maps.Keys(r.fields)) {
		attrs = append(attrs, recordAttr(field, r.fields[field]))
	}
	return append(attrs, slog.String(obs.FieldKind, r.kind), slog.String(obs.FieldName, r.name))
}

func recordAttr(field string, value any) slog.Attr {
	if number, ok := value.(float64); ok && number == math.Trunc(number) {
		return slog.Int64(field, int64(number))
	}
	return slog.Any(field, value)
}
