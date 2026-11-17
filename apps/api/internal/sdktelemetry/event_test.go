package sdktelemetry

import (
	"encoding/json"
	"strings"
	"testing"
)

func decodeEvent(t *testing.T, raw string) Event {
	t.Helper()
	var event Event
	if err := json.Unmarshal([]byte(raw), &event); err != nil {
		t.Fatalf("decode %s: %v", raw, err)
	}
	return event
}

func TestEventsAreCheckedEachOnItsOwn(t *testing.T) {
	const op = "5f0c2b8e-3a41-4d6e-9c57-0b1d2e3f4a5b"
	cases := []struct {
		name   string
		event  string
		reason string
	}{
		{"join started", `{"type":"space_join_span","seq":0,"elapsed_ms":1,"step":"join","outcome":"started"}`, ""},
		{"join without an outcome", `{"type":"space_join_span","seq":0,"elapsed_ms":1}`, "outcome_missing"},
		{"receivers closed with bundle flag", `{"type":"receivers_closed","seq":1,"elapsed_ms":5,"receivers_stopped":3,"bundle_tag_held":true}`, ""},
		{"access retry in a join", `{"type":"access_retry","seq":1,"elapsed_ms":5,"state":"joining"}`, ""},
		{"receivers closed over the cap", `{"type":"receivers_closed","seq":1,"elapsed_ms":5,"receivers_stopped":10001}`, "receivers_stopped_range"},
		{"negative receivers closed", `{"type":"receivers_closed","seq":1,"elapsed_ms":5,"receivers_stopped":-1}`, "receivers_stopped_range"},
		{"receiver count on another event", `{"type":"access_retry","seq":1,"elapsed_ms":5,"receivers_stopped":1}`, "receivers_stopped_not_allowed"},
		{"bundle flag on another event", `{"type":"media_state","seq":1,"elapsed_ms":5,"bundle_tag_held":false}`, "bundle_tag_held_not_allowed"},
		{"unknown type", `{"type":"receivers_dropped","seq":1,"elapsed_ms":5}`, "type"},
		{"storage block", `{"type":"chat_upload_failed","seq":1,"elapsed_ms":5,"upload_failure":"storage_unreachable"}`, ""},
		{"unknown upload failure", `{"type":"chat_upload_failed","seq":1,"elapsed_ms":5,"upload_failure":"cors"}`, "upload_failure_label"},
		{"upload failure on another event", `{"type":"access_retry","seq":1,"elapsed_ms":5,"upload_failure":"initiate_failed"}`, "upload_failure_not_allowed"},
		{"free text as a code", `{"type":"state_changed","seq":1,"elapsed_ms":5,"code":"the user typed this"}`, "code_label"},
		{"unknown field", `{"type":"state_changed","seq":1,"elapsed_ms":5,"message":"hello"}`, "schema"},
		{"negative sequence", `{"type":"state_changed","seq":-1,"elapsed_ms":5}`, "elapsed_range"},
		{"recovery with mechanism and outage", `{"type":"recovery_succeeded","seq":2,"elapsed_ms":9,"mechanism":"sync_digest","outage_ms":3200}`, ""},
		{"unknown mechanism", `{"type":"recovery_succeeded","seq":2,"elapsed_ms":9,"mechanism":"magic"}`, "mechanism_label"},
		{"end of a call", `{"type":"call_ended","seq":9,"elapsed_ms":9,"end_reason":"time_limit"}`, ""},
		{"end without a reason", `{"type":"call_ended","seq":9,"elapsed_ms":9}`, "end_reason_missing"},
		{"mute intent", `{"type":"media_intent","seq":3,"elapsed_ms":9,"action":"unmute","source":"microphone","op_id":"` + op + `"}`, ""},
		{"mute intent without an operation", `{"type":"media_intent","seq":3,"elapsed_ms":9,"action":"unmute"}`, "op_id_missing"},
		{"operation that is not an id", `{"type":"media_intent","seq":3,"elapsed_ms":9,"action":"unmute","op_id":"abc"}`, "op_id_label"},
		{"mute result", `{"type":"media_result","seq":4,"elapsed_ms":9,"action":"unmute","op_id":"` + op + `","outcome":"succeeded","duration_ms":84}`, ""},
		{"device failure", `{"type":"device_failed","seq":5,"elapsed_ms":9,"error_name":"NotAllowedError","device_kind":"microphone","permission_state":"denied"}`, ""},
		{"device failure named freely", `{"type":"device_failed","seq":5,"elapsed_ms":9,"error_name":"MyDevice Pro","device_kind":"microphone"}`, "error_name_label"},
		{"render crash", `{"type":"render_crashed","seq":6,"elapsed_ms":9,"render_cause":"chunk_reload"}`, ""},
		{"drop count", `{"type":"telemetry_dropped","seq":7,"elapsed_ms":9,"dropped":12}`, ""},
		{"problem report marker", `{"type":"problem_reported","seq":8,"elapsed_ms":9}`, ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := decodeEvent(t, tc.event).Rejection(); got != tc.reason {
				t.Fatalf("rejection = %q, want %q", got, tc.reason)
			}
		})
	}
}

func TestStatsWindowsAreMeasuredOrMarkedAsGaps(t *testing.T) {
	cases := []struct {
		name   string
		stats  string
		reason string
	}{
		{"measured", `{"window_ms":30000,"connection_type":"udp","rtt_ms":40}`, ""},
		{"measured without a connection type", `{"window_ms":30000,"rtt_ms":40}`, "connection_type_missing"},
		{"measured window too short", `{"window_ms":500,"connection_type":"udp"}`, "window_ms_range"},
		{"measured window too long", `{"window_ms":60001,"connection_type":"udp"}`, "window_ms_range"},
		{"gap as long as an outage", `{"window_ms":900000,"gap":"offline"}`, ""},
		{"gap that measured something", `{"window_ms":900000,"gap":"offline","rtt_ms":0}`, "gap_measured"},
		{"gap with an unknown cause", `{"window_ms":1000,"gap":"because"}`, "stats.gap_label"},
		{"track with audio energy", `{"window_ms":30000,"connection_type":"udp","tracks":[{"mid":"3","kind":"audio","packets":10,"audio_energy":0,"playout":"playing"}]}`, ""},
		{"track without a mid", `{"window_ms":30000,"connection_type":"udp","tracks":[{"kind":"audio"}]}`, "tracks_incomplete"},
		{"track with a free mid", `{"window_ms":30000,"connection_type":"udp","tracks":[{"mid":"has a space","kind":"audio"}]}`, "stats.tracks.mid_label"},
		{"loss over one hundred percent", `{"window_ms":30000,"connection_type":"udp","recv_loss_pct":101}`, "stats.recv_loss_pct_range"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			event := decodeEvent(t, `{"type":"call_stats","seq":1,"elapsed_ms":30000,"stats":`+tc.stats+`}`)
			if got := event.Rejection(); got != tc.reason {
				t.Fatalf("rejection = %q, want %q", got, tc.reason)
			}
		})
	}
}

func TestARejectedEventStillSaysWhichOneItWas(t *testing.T) {
	event := decodeEvent(t, `{"type":"recovery_attempt","seq":41,"elapsed_ms":1,"message":"x"}`)
	if eventType, seq := event.Seen(); eventType != "recovery_attempt" || seq != 41 {
		t.Fatalf("seen = %q %d, want recovery_attempt 41", eventType, seq)
	}
	forged := decodeEvent(t, `{"type":"the user typed this","seq":2,"elapsed_ms":1,"message":"x"}`)
	if eventType, _ := forged.Seen(); eventType != "" {
		t.Fatalf("a type outside the closed list reached a log row: %q", eventType)
	}
}

func TestEveryTypeHasEnumsForItsLabelFields(t *testing.T) {
	for eventType, spec := range specs {
		for _, field := range append(spec.allowed, spec.required...) {
			switch field {
			case "attempt", "duration_ms", "outage_ms", "heartbeat_gap_ms", "close_code", "http_status", "receive_counts",
				"receivers_stopped", "bundle_tag_held", "stats", "dropped", "op_id":
				continue
			}
			if FieldEnum(field) == nil {
				t.Errorf("%s allows %s, which has no closed list of labels, so free text could pass", eventType, field)
			}
		}
	}
}

func TestAttributesFlattenStatsAndSkipUnsetFields(t *testing.T) {
	event := decodeEvent(t, `{"type":"call_stats","seq":3,"elapsed_ms":7,"stats":{"window_ms":30000,"connection_type":"udp","rtt_ms":0}}`)
	got := map[string]any{}
	attributes := event.Attributes()
	for index := 0; index < len(attributes); index += 2 {
		got[attributes[index].(string)] = attributes[index+1]
	}
	for key, want := range map[string]any{"type": "call_stats", "seq": int64(3), "window_ms": int64(30000), "connection_type": "udp", "rtt_ms": int64(0)} {
		if got[key] != want {
			t.Errorf("attribute %s = %v, want %v", key, got[key], want)
		}
	}
	if _, ok := got["send_loss_pct"]; ok || strings.Contains(strings.Join(keys(got), ","), "stats") {
		t.Errorf("attributes = %v, want no unset field and no stats group", got)
	}
}

func keys(values map[string]any) []string {
	names := make([]string, 0, len(values))
	for name := range values {
		names = append(names, name)
	}
	return names
}
