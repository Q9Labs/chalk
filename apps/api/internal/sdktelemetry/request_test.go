package sdktelemetry

import (
	"bytes"
	"context"
	"encoding/json"
	"log/slog"
	"slices"
	"strings"
	"testing"
	"time"
)

const (
	testSource = "0b7c2b8e-3a41-4d6e-9c57-0b1d2e3f4a5b"
	testBatch  = "5d1e2b8e-3a41-4d6e-9c57-0b1d2e3f4a5b"
	testEvent  = "9a4f2b8e-3a41-4d6e-9c57-0b1d2e3f4a5b"
)

func ledgerEvent(seq int, extra string) string {
	return `{"event_id":"` + testEvent + `","seq":` + itoa(seq) + `,"elapsed_ms":5,"type":"call_ended","end_reason":"left"` + extra + `}`
}

func itoa(n int) string {
	raw, _ := json.Marshal(n)
	return string(raw)
}

func TestFramesAreCheckedByVersion(t *testing.T) {
	ledger := func(fields string, events ...string) string {
		return `{"version":2,` + fields + `"events":[` + strings.Join(events, ",") + `]}`
	}
	frame := `"source_id":"` + testSource + `","batch_id":"` + testBatch + `","next_seq":10,`
	cases := []struct {
		name   string
		body   string
		reason string
	}{
		{"version 1 as before", `{"version":1,"client_session_id":"` + testSource + `","events":[{"seq":0,"elapsed_ms":1,"type":"problem_reported"}]}`, ""},
		{"version 1 without events", `{"version":1,"client_session_id":"` + testSource + `","events":[]}`, "event_count"},
		{"version 1 without a session", `{"version":1,"events":[{"seq":0,"elapsed_ms":1,"type":"problem_reported"}]}`, "client_session_id"},
		{"version 1 with a source", `{"version":1,"client_session_id":"` + testSource + `","source_id":"` + testSource + `","events":[{"seq":0,"elapsed_ms":1,"type":"problem_reported"}]}`, "schema"},
		{"unknown version", `{"version":3,"events":[]}`, "version"},
		{"version 2", ledger(frame, ledgerEvent(0, "")), ""},
		{"version 2 end with no events", ledger(frame + `"end":"closed",`), ""},
		{"version 2 empty without end", ledger(frame), "event_count"},
		{"version 2 with a session", ledger(frame+`"client_session_id":"`+testSource+`",`, ledgerEvent(0, "")), "client_session_id"},
		{"version 2 without a source", ledger(`"batch_id":"`+testBatch+`","next_seq":10,`, ledgerEvent(0, "")), "source_id"},
		{"version 2 with a bad batch", ledger(`"source_id":"`+testSource+`","batch_id":"x","next_seq":10,`, ledgerEvent(0, "")), "batch_id"},
		{"version 2 without next_seq", ledger(`"source_id":"`+testSource+`","batch_id":"`+testBatch+`",`, ledgerEvent(0, "")), "next_seq"},
		{"version 2 negative next_seq", ledger(`"source_id":"`+testSource+`","batch_id":"`+testBatch+`","next_seq":-1,`, ledgerEvent(0, "")), "next_seq"},
		{"version 2 next_seq over the cap", ledger(`"source_id":"`+testSource+`","batch_id":"`+testBatch+`","next_seq":2147483648,`, ledgerEvent(0, "")), "next_seq"},
		{"version 2 unknown end", ledger(frame+`"end":"gone",`, ledgerEvent(0, "")), "end"},
		{"version 2 over the event limit", ledger(frame, slices.Repeat([]string{`{"seq":0,"elapsed_ms":1,"type":"problem_reported"}`}, 101)...), "event_count"},
		{"version 2 duplicate seq", ledger(frame, ledgerEvent(3, ""), ledgerEvent(3, "")), "duplicate_seq"},
		{"version 2 event without a seq", ledger(frame, `{"event_id":"`+testEvent+`","elapsed_ms":1,"type":"problem_reported"}`), "seq"},
		{"version 2 negative seq", ledger(frame, ledgerEvent(-1, "")), "seq"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if _, reason := Decode(strings.NewReader(tc.body)); reason != tc.reason {
				t.Fatalf("frame reason = %q, want %q", reason, tc.reason)
			}
		})
	}
}

func TestLedgerEventsAreRejectedEachOnItsOwn(t *testing.T) {
	dropped := func(seq int, extra string) string {
		return `{"event_id":"` + testEvent + `","seq":` + itoa(seq) + `,"elapsed_ms":5,"type":"telemetry_dropped"` + extra + `}`
	}
	cases := []struct {
		name   string
		event  string
		reason string
	}{
		{"valid", ledgerEvent(4, ""), ""},
		{"no event id", `{"seq":4,"elapsed_ms":5,"type":"call_ended","end_reason":"left"}`, "event_id_missing"},
		{"event id that is not an id", `{"event_id":"x","seq":4,"elapsed_ms":5,"type":"call_ended","end_reason":"left"}`, "event_id_label"},
		{"seq at next_seq", ledgerEvent(10, ""), "seq_range"},
		{"drop record", dropped(8, `,"dropped":3,"drop_reason":"queue_full","dropped_seqs":[{"from":2,"to":5}]`), ""},
		{"drop record of two ranges", dropped(8, `,"dropped":3,"drop_reason":"refused","dropped_seqs":[{"from":0,"to":1},{"from":4,"to":6}]`), ""},
		{"drop range ending below the record", dropped(8, `,"dropped":1,"drop_reason":"refused","dropped_seqs":[{"from":7,"to":8}]`), ""},
		{"drop without ranges", dropped(8, `,"dropped":3,"drop_reason":"queue_full"`), "dropped_seqs_missing"},
		{"drop without a reason", dropped(8, `,"dropped":3,"dropped_seqs":[{"from":2,"to":5}]`), "drop_reason_missing"},
		{"drop count off by one", dropped(8, `,"dropped":4,"drop_reason":"queue_full","dropped_seqs":[{"from":2,"to":5}]`), "dropped_count"},
		{"drop range reaching the record", dropped(8, `,"dropped":2,"drop_reason":"queue_full","dropped_seqs":[{"from":7,"to":9}]`), "dropped_seqs_range"},
		{"drop range of an earlier source", dropped(2, `,"dropped":5,"drop_reason":"credential_expired","dropped_source_id":"`+testSource+`","dropped_seqs":[{"from":30,"to":35}]`), ""},
		{"event that fails its own check keeps its reason", `{"event_id":"` + testEvent + `","seq":4,"elapsed_ms":5,"type":"call_ended"}`, "end_reason_missing"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			body := `{"version":2,"source_id":"` + testSource + `","batch_id":"` + testBatch + `","next_seq":10,"events":[` + tc.event + `]}`
			request, frame := Decode(strings.NewReader(body))
			if frame != "" {
				t.Fatalf("frame reason = %q, want none", frame)
			}
			if got := request.Events[0].Rejection(); got != tc.reason {
				t.Fatalf("rejection = %q, want %q", got, tc.reason)
			}
		})
	}
}

func TestRangesMergeSeqs(t *testing.T) {
	cases := []struct {
		name string
		seqs []int64
		want []SeqRange
	}{
		{"none", nil, []SeqRange{}},
		{"one", []int64{5}, []SeqRange{{5, 6}}},
		{"a run", []int64{40, 41, 42}, []SeqRange{{40, 43}}},
		{"out of order with a hole", []int64{9, 3, 4, 5}, []SeqRange{{3, 6}, {9, 10}}},
	}
	for _, tc := range cases {
		if got := Ranges(tc.seqs); !slices.Equal(got, tc.want) {
			t.Errorf("%s: ranges = %v, want %v", tc.name, got, tc.want)
		}
	}
}

func TestLogAnswersAVersionTwoBatchSeqBySeq(t *testing.T) {
	body := `{"version":2,"source_id":"` + testSource + `","batch_id":"` + testBatch + `","next_seq":10,"events":[` +
		ledgerEvent(2, "") + `,` + ledgerEvent(3, "") + `,{"event_id":"` + testEvent + `","seq":4,"elapsed_ms":5,"type":"call_ended"},` + ledgerEvent(12, "") + `]}`
	request, frame := Decode(strings.NewReader(body))
	if frame != "" {
		t.Fatalf("frame reason = %q", frame)
	}
	logs := &bytes.Buffer{}
	response := Log(context.Background(), slog.New(slog.NewJSONHandler(logs, nil)), request, time.Unix(0, 0))
	if response.Accepted != 2 || response.Rejected != 2 || response.Duplicates != 0 {
		t.Fatalf("counts = %+v, want 2 accepted, 2 rejected", response)
	}
	if want := []SeqRange{{2, 5}, {12, 13}}; !slices.Equal(response.Acks, want) {
		t.Fatalf("acks = %v, want %v", response.Acks, want)
	}
	if want := []Rejection{{4, "end_reason_missing"}, {12, "seq_range"}}; !slices.Equal(response.Rejections, want) {
		t.Fatalf("rejections = %v, want %v", response.Rejections, want)
	}
	for _, want := range []string{`"source_id":"` + testSource + `"`, `"batch_id":"` + testBatch + `"`, `"event_id":"` + testEvent + `"`} {
		if !strings.Contains(logs.String(), want) {
			t.Errorf("logs lack %s", want)
		}
	}
	if strings.Contains(logs.String(), "client_session_id") {
		t.Error("a version 2 row names a client session")
	}
}

func TestLogOfAVersionOneBatchHasNoLedgerAnswer(t *testing.T) {
	body := `{"version":1,"client_session_id":"` + testSource + `","events":[{"seq":0,"elapsed_ms":1,"type":"problem_reported"},{"seq":1,"elapsed_ms":1,"type":"nope"}]}`
	request, frame := Decode(strings.NewReader(body))
	if frame != "" {
		t.Fatalf("frame reason = %q", frame)
	}
	response := Log(context.Background(), slog.New(slog.NewJSONHandler(&bytes.Buffer{}, nil)), request, time.Unix(0, 0))
	if response.Accepted != 1 || response.Rejected != 1 || response.Acks == nil || len(response.Acks) != 0 || response.Rejections == nil || len(response.Rejections) != 0 {
		t.Fatalf("response = %+v, want 1 accepted, 1 rejected and empty lists", response)
	}
	encoded, _ := json.Marshal(response)
	if !strings.Contains(string(encoded), `"acks":[]`) || !strings.Contains(string(encoded), `"rejections":[]`) {
		t.Fatalf("encoded = %s, want empty lists", encoded)
	}
}
