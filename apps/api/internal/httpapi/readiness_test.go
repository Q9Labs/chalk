package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

type readyChecker struct{}

func (readyChecker) Check(context.Context) error { return nil }

// The own-SFU retirement backlog is reported by /readyz and never fails it: an old node that stays
// silent must not take the API out of service.
func TestReadyzReportsTheRetirementBacklogWithoutFailingReadiness(t *testing.T) {
	router := NewRouter(Options{
		Readiness:         readyChecker{},
		RetirementBacklog: func() (int, time.Duration, bool) { return 3, 90 * time.Minute, true },
	})
	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/readyz", nil))
	if recorder.Code != http.StatusOK {
		t.Fatalf("/readyz with an old unpaid debt answered %d, want 200", recorder.Code)
	}
	var body struct {
		Debts map[string]int64 `json:"sfu_retirement_debts"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body.Debts["count"] != 3 || body.Debts["oldest_age_seconds"] != 5400 {
		t.Fatalf("/readyz debts %+v, want count 3 and 5400 seconds", body.Debts)
	}

	unobserved := NewRouter(Options{Readiness: readyChecker{}, RetirementBacklog: func() (int, time.Duration, bool) { return 0, 0, false }})
	recorder = httptest.NewRecorder()
	unobserved.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/readyz", nil))
	if recorder.Code != http.StatusOK || json.Valid(recorder.Body.Bytes()) && containsKey(recorder.Body.Bytes(), "sfu_retirement_debts") {
		t.Fatalf("/readyz before the worker's first pass: %d %s", recorder.Code, recorder.Body.String())
	}
}

// The live participant count is what a release waits on before it restarts production. An unreadable
// count is left out of /readyz, so the reader sees "unknown" and never a made-up zero.
func TestReadyzReportsTheLiveParticipantCountAndLeavesItOutWhenUnreadable(t *testing.T) {
	read := func(live func(context.Context) (int64, error)) (int, map[string]json.RawMessage) {
		recorder := httptest.NewRecorder()
		NewRouter(Options{Readiness: readyChecker{}, LiveParticipants: live}).ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/readyz", nil))
		var body map[string]json.RawMessage
		_ = json.Unmarshal(recorder.Body.Bytes(), &body)
		return recorder.Code, body
	}

	code, body := read(func(context.Context) (int64, error) { return 4, nil })
	if code != http.StatusOK || string(body["live_participants"]) != "4" {
		t.Fatalf("/readyz with 4 live participants: %d %s", code, body["live_participants"])
	}
	code, body = read(func(context.Context) (int64, error) { return 0, nil })
	if code != http.StatusOK || string(body["live_participants"]) != "0" {
		t.Fatalf("/readyz with no live participants: %d %s", code, body["live_participants"])
	}
	code, body = read(func(context.Context) (int64, error) { return 0, errors.New("database is slow") })
	if _, found := body["live_participants"]; code != http.StatusOK || found {
		t.Fatalf("/readyz with an unreadable count: %d, field present %v", code, found)
	}
	code, body = read(nil)
	if _, found := body["live_participants"]; code != http.StatusOK || found {
		t.Fatalf("/readyz with no count reader: %d, field present %v", code, found)
	}
}

func containsKey(raw []byte, key string) bool {
	var body map[string]json.RawMessage
	_ = json.Unmarshal(raw, &body)
	_, found := body[key]
	return found
}
