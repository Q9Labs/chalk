// Package sdktelemetry is the closed vocabulary of events a Chalk client reports
// about its own calls. A client sends them in batches. The server checks each
// event on its own, stamps who sent it from the credential and writes one log row
// per event. Only enumerated codes and bounded numbers pass: no free text, so
// nothing a user typed or a device named can reach a log.
package sdktelemetry

import (
	"bytes"
	"encoding/json"
	"regexp"
)

// MIDPattern is the shape of a media id, which the SFU also logs for the same subscription.
const MIDPattern = `^[0-9A-Za-z_-]{1,16}$`

const (
	// Version is the legacy wire version: batches name a client session and get no acknowledgment.
	// The call-stats route and the connection report translate into it as well.
	Version = 1
	// LedgerVersion is the wire version whose batches name a source and a batch, carry an id on
	// every event, and are settled seq by seq in the answer.
	LedgerVersion = 2
	// BodyLimit is the largest request body, the same as the browser's keepalive limit.
	BodyLimit = 65536
	// EventLimit is the most events in one request.
	EventLimit = 100
	// MaxMilliseconds is the largest duration, offset and count of events.
	MaxMilliseconds = 2147483647
	// MaxTracks is the most remote tracks one stats window names.
	MaxTracks = 32
	// MaxDropRanges is the most seq ranges one drop record names.
	MaxDropRanges = 64
	// MaxReceiveCount is the largest receive counter.
	MaxReceiveCount = 10000
	// MaxTrackPackets is the most packets one track can count in a window.
	MaxTrackPackets = 10000000
	// MinWindowMS and MaxWindowMS bound a measured stats window. A gap window has no
	// measurement and may be as long as the outage that caused it.
	MinWindowMS = 1000
	MaxWindowMS = 60000
)

var (
	uuidPattern = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`)
	midPattern  = regexp.MustCompile(MIDPattern)
)

// Event is one thing a client saw. A version 2 batch carries kernel records, which name their
// registry event by kind and name and are checked against the registry, beside events of the
// legacy vocabulary. In a legacy event, Type picks which of the other fields may be set: a field
// that Type does not name makes the event invalid.
type Event struct {
	Type string `json:"type"`
	// Seq counts the events of one client session (version 1) or source (version 2) from zero, in the
	// order they happened.
	Seq int64 `json:"seq"`
	// ElapsedMS is the client's monotonic time since its session began.
	ElapsedMS int64 `json:"elapsed_ms"`
	// EventID names this record for good, so a copy that arrives twice collapses into one. It is an
	// envelope field like Seq, not a field of any type. Version 2 requires it.
	EventID string `json:"event_id,omitempty"`
	// OpID joins the intent and the result of one operation, and the SFU's view of it.
	OpID string `json:"op_id,omitempty"`

	State            string         `json:"state,omitempty"`
	Step             string         `json:"step,omitempty"`
	Outcome          string         `json:"outcome,omitempty"`
	Code             string         `json:"code,omitempty"`
	Phase            string         `json:"phase,omitempty"`
	Mechanism        string         `json:"mechanism,omitempty"`
	Attempt          *int64         `json:"attempt,omitempty"`
	DurationMS       *int64         `json:"duration_ms,omitempty"`
	OutageMS         *int64         `json:"outage_ms,omitempty"`
	HeartbeatGapMS   *int64         `json:"heartbeat_gap_ms,omitempty"`
	CloseCode        *int64         `json:"close_code,omitempty"`
	HTTPStatus       *int64         `json:"http_status,omitempty"`
	MediaErrorKind   string         `json:"media_error_kind,omitempty"`
	MediaErrorStep   string         `json:"media_error_step,omitempty"`
	GrantedAudio     string         `json:"granted_audio,omitempty"`
	GrantedVideo     string         `json:"granted_video,omitempty"`
	Source           string         `json:"source,omitempty"`
	PublicationState string         `json:"publication_state,omitempty"`
	ProjectionState  string         `json:"projection_state,omitempty"`
	ReceiveState     string         `json:"receive_state,omitempty"`
	TrackState       string         `json:"track_state,omitempty"`
	ElementState     string         `json:"element_state,omitempty"`
	PlayResult       string         `json:"play_result,omitempty"`
	ReceiveCounts    *ReceiveCounts `json:"receive_counts,omitempty"`
	ReceiversStopped *int64         `json:"receivers_stopped,omitempty"`
	BundleTagHeld    *bool          `json:"bundle_tag_held,omitempty"`
	UploadFailure    string         `json:"upload_failure,omitempty"`
	Action           string         `json:"action,omitempty"`
	DeviceKind       string         `json:"device_kind,omitempty"`
	PermissionState  string         `json:"permission_state,omitempty"`
	RenderCause      string         `json:"render_cause,omitempty"`
	ErrorName        string         `json:"error_name,omitempty"`
	PlatformState    string         `json:"platform_state,omitempty"`
	EndReason        string         `json:"end_reason,omitempty"`
	Stats            *StatsWindow   `json:"stats,omitempty"`
	// Dropped is how many events the client's outbox lost to its byte bound.
	Dropped *int64 `json:"dropped,omitempty"`
	// DroppedSeqs names the seqs the outbox gave up on, as half-open ranges. Version 2 requires it
	// on a drop record, which carries at most MaxDropRanges of them.
	DroppedSeqs []SeqRange `json:"dropped_seqs,omitempty"`
	// DropReason says why the outbox gave them up. Version 2 requires it on a drop record.
	DropReason string `json:"drop_reason,omitempty"`

	// rejection is why this event failed its own check, set while decoding.
	rejection string
	// seen is the type and sequence number read from an event that failed its check.
	seen seenEvent
	// seqRead says the body gave a readable seq, so the seq can name the event in an answer.
	seqRead bool
	// record is the kernel record this event carries, or nil for an event of the legacy vocabulary.
	record *record
}

type seenEvent struct {
	Type string `json:"type"`
	Seq  int64  `json:"seq"`
}

// ReceiveCounts says how far each announced audio track got on its way to a speaker.
type ReceiveCounts struct {
	Announced     *int64 `json:"announced,omitempty"`
	PullRequested *int64 `json:"pull_requested,omitempty"`
	PullFailed    *int64 `json:"pull_failed,omitempty"`
	PullSucceeded *int64 `json:"pull_succeeded,omitempty"`
	TrackReceived *int64 `json:"track_received,omitempty"`
	BytesFlowing  *int64 `json:"bytes_flowing,omitempty"`
	ElementBound  *int64 `json:"element_bound,omitempty"`
	Playing       *int64 `json:"playing,omitempty"`
	ProjectionOff *int64 `json:"projection_off,omitempty"`
}

// Rejection says why the event failed its own check, or is empty for a valid one.
// It is a fixed label, never decoder text or input.
func (e Event) Rejection() string { return e.rejection }

// Refused is the event as the ledger settles it when it refuses the event's content after the
// event passed its own check: a rejection with the given fixed reason that keeps the type and seq.
func (e Event) Refused(reason string) Event {
	refused := Event{rejection: reason, seqRead: true}
	refused.seen = seenEvent{Type: e.Type, Seq: e.Seq}.known()
	return refused
}

// Seen returns the type and sequence number of an invalid event as far as they could be read.
func (e Event) Seen() (eventType string, seq int64) {
	return e.seen.Type, e.seen.Seq
}

// IsRecord says the event is a kernel record that passed its registry check.
func (e Event) IsRecord() bool { return e.record != nil }

// UnmarshalJSON checks one event alone, so that one bad event cannot fail its batch.
func (e *Event) UnmarshalJSON(data []byte) error {
	if isRecordJSON(data) {
		*e = decodeRecord(data)
		return nil
	}
	type plain Event
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	var decoded plain
	if err := decoder.Decode(&decoded); err != nil {
		*e = Event{rejection: "schema"}
		var read struct {
			Type string `json:"type"`
			Seq  *int64 `json:"seq"`
		}
		_ = json.Unmarshal(data, &read)
		e.seqRead = read.Seq != nil
		if e.seqRead {
			e.seen = seenEvent{Type: read.Type, Seq: *read.Seq}
		}
		e.seen = e.seen.known()
		return nil
	}
	*e = Event(decoded)
	e.rejection = orderingMissing(data)
	e.seqRead = e.rejection != "seq_missing"
	if e.rejection == "" {
		e.rejection = e.Check()
	}
	if e.rejection != "" {
		e.seen = seenEvent{Type: e.Type, Seq: e.Seq}.known()
	}
	return nil
}

// known drops a type outside the closed list, so a rejected event cannot put its own text in a log row.
func (s seenEvent) known() seenEvent {
	if _, ok := specs[s.Type]; !ok {
		s.Type = ""
	}
	return s
}

// seqValue is the seq of the event as far as it could be read, also for an event that failed its check.
func (e Event) seqValue() int64 {
	if e.rejection != "" {
		return e.seen.Seq
	}
	return e.Seq
}

// checkLedger marks the event when it breaks a rule of a version 2 batch whose source will
// give its next record nextSeq. An event that already failed its own check keeps that reason.
func (e *Event) checkLedger(nextSeq int64) {
	if e.rejection != "" {
		return
	}
	e.rejection = e.ledgerRejection(nextSeq)
	if e.rejection != "" {
		e.seen = seenEvent{Type: e.Type, Seq: e.Seq}.known()
	}
}

func (e Event) ledgerRejection(nextSeq int64) string {
	switch {
	case e.EventID == "":
		return "event_id_missing"
	case e.Seq >= nextSeq:
		return "seq_range"
	case e.Type != "telemetry_dropped":
		return ""
	case len(e.DroppedSeqs) == 0:
		return "dropped_seqs_missing"
	case e.DropReason == "":
		return "drop_reason_missing"
	}
	var total int64
	for _, dropped := range e.DroppedSeqs {
		total += dropped.To - dropped.From
	}
	if e.Dropped == nil || total != *e.Dropped {
		return "dropped_count"
	}
	for _, dropped := range e.DroppedSeqs {
		if dropped.To > e.Seq {
			return "dropped_seqs_range"
		}
	}
	return ""
}

// orderingMissing names the sequence field an event left out or set to null. Without it a zero
// would stand in for an order the client never gave, and hide a gap in the session.
func orderingMissing(data []byte) string {
	var given struct {
		Seq       *int64 `json:"seq"`
		ElapsedMS *int64 `json:"elapsed_ms"`
	}
	_ = json.Unmarshal(data, &given)
	switch {
	case given.Seq == nil:
		return "seq_missing"
	case given.ElapsedMS == nil:
		return "elapsed_ms_missing"
	}
	return ""
}
