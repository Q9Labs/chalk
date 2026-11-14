package httpapi

import (
	"context"
	"crypto/sha256"
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

type liveChecker struct {
	readyChecker
	count int64
	err   error
}

func (c liveChecker) LiveParticipants(context.Context) (int64, error) { return c.count, c.err }

// The live participant count is what a release waits on before it restarts production, and it is usage data: only
// a request with the operator read token sees it. An unreadable count is left out, so the reader sees "unknown"
// and never a made-up zero.
func TestReadyzShowsTheLiveParticipantCountOnlyToTheOperatorReadToken(t *testing.T) {
	const token = "operator-read-token-for-tests"
	hash := sha256.Sum256([]byte(token))
	read := func(checker ReadinessChecker, hash []byte, authorization string) (int, map[string]json.RawMessage) {
		recorder := httptest.NewRecorder()
		request := httptest.NewRequest(http.MethodGet, "/readyz", nil)
		if authorization != "" {
			request.Header.Set("Authorization", authorization)
		}
		NewRouter(Options{Readiness: checker, OperatorReadTokenSHA256: hash}).ServeHTTP(recorder, request)
		var body map[string]json.RawMessage
		_ = json.Unmarshal(recorder.Body.Bytes(), &body)
		return recorder.Code, body
	}
	hidden := func(name string, checker ReadinessChecker, hash []byte, authorization string) {
		t.Helper()
		code, body := read(checker, hash, authorization)
		if _, found := body["live_participants"]; code != http.StatusOK || found {
			t.Fatalf("%s: %d, field present %v", name, code, found)
		}
	}

	code, body := read(liveChecker{count: 4}, hash[:], "Bearer "+token)
	if code != http.StatusOK || string(body["live_participants"]) != "4" {
		t.Fatalf("/readyz for the operator with 4 live participants: %d %s", code, body["live_participants"])
	}
	code, body = read(liveChecker{}, hash[:], "Bearer "+token)
	if code != http.StatusOK || string(body["live_participants"]) != "0" {
		t.Fatalf("/readyz for the operator with no live participants: %d %s", code, body["live_participants"])
	}
	hidden("no token", liveChecker{count: 4}, hash[:], "")
	hidden("wrong token", liveChecker{count: 4}, hash[:], "Bearer another-token")
	hidden("no hash configured", liveChecker{count: 4}, nil, "Bearer "+token)
	hidden("a hash of the wrong length", liveChecker{count: 4}, hash[:8], "Bearer "+token)
	hidden("unreadable count", liveChecker{err: errors.New("database is slow")}, hash[:], "Bearer "+token)
	hidden("a checker that cannot count", readyChecker{}, hash[:], "Bearer "+token)
}

func containsKey(raw []byte, key string) bool {
	var body map[string]json.RawMessage
	_ = json.Unmarshal(raw, &body)
	_, found := body[key]
	return found
}
