package httpapi

import (
	"crypto/sha256"
	"fmt"
	"testing"
)

func TestTelemetryV2InitialJoinKeepsCorrelation(t *testing.T) {
	f := newTelemetryFixture(t)
	const eventID = "9a4f0000-0000-4000-8000-000000000701"
	body := ledgerBody(ledgerSource, ledgerBatch, 1, fmt.Sprintf(`{"type":"initial_join","seq":0,"elapsed_ms":8000,"event_id":%q,"op_id":%q,"join_signal":"transport_timeout"}`, eventID, telemetrySession))
	if answer := f.answer(t, f.telemetryToken, body); answer.Accepted != 1 || answer.Rejected != 0 {
		t.Fatalf("initial Join answer = %+v, want one accepted event", answer)
	}
	rows := f.rows(t, "sdk.telemetry")
	if len(rows) != 1 {
		t.Fatalf("initial Join rows = %d, want one", len(rows))
	}
	want := map[string]string{
		"event_id":            eventID,
		"op_id":               telemetrySession,
		"source_id":           ledgerSource,
		"join_signal":         "transport_timeout",
		"episode_id":          f.subject.EpisodeID.String(),
		"participant_id_hash": fmt.Sprintf("%x", sha256.Sum256([]byte(f.subject.ParticipantID.String()))),
	}
	for name, value := range want {
		if rows[0][name] != value {
			t.Errorf("%s = %v, want %s", name, rows[0][name], value)
		}
	}
}
