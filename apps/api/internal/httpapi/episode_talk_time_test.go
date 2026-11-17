package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/q9labs/chalk/apps/api/internal/authentication"
	"github.com/q9labs/chalk/apps/api/internal/authorization"
	"github.com/q9labs/chalk/apps/api/internal/episodes"
	"github.com/q9labs/chalk/apps/api/internal/talktime"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

type fakeTalkTime struct {
	outcome talktime.Outcome
	err     error
}

func (f fakeTalkTime) Get(context.Context, utilities.ID, utilities.ID, utilities.ID) (talktime.Outcome, error) {
	return f.outcome, f.err
}

type denyingTenants struct{}

func (denyingTenants) AuthorizeTenant(context.Context, authentication.Principal, utilities.ID, authorization.TenantPermission) error {
	return authorization.ErrForbidden
}

func serveTalkTime(t *testing.T, service EpisodeTalkTimeService, authorizer TenantAuthorizer) *httptest.ResponseRecorder {
	t.Helper()
	tenant, _ := utilities.NewID()
	space, _ := utilities.NewID()
	episode, _ := utilities.NewID()
	ctx := authentication.ContextWithPrincipal(context.Background(), authentication.Principal{Kind: authentication.PrincipalAPIKey, TenantID: tenant})
	request := httptest.NewRequest(http.MethodGet, "/", nil).WithContext(ctx)
	routed := chi.NewRouteContext()
	routed.URLParams.Add("tenant_id", tenant.String())
	routed.URLParams.Add("space_id", space.String())
	routed.URLParams.Add("episode_id", episode.String())
	request = request.WithContext(context.WithValue(request.Context(), chi.RouteCtxKey, routed))
	response := httptest.NewRecorder()
	getEpisodeTalkTimeEndpoint(service, authorizer).ServeHTTP(response, request)
	return response
}

func TestEpisodeTalkTimeAvailableCarriesTheMeasurements(t *testing.T) {
	participant := "11111111-1111-4111-8111-111111111111"
	recordingID, _ := utilities.NewID()
	outcome := talktime.Available{
		Recordings: []talktime.Placement{{RecordingID: recordingID, OffsetMS: 30_000, Transcribed: true}, {OffsetMS: 90_000}},
		Report: talktime.Report{
			EpisodeDurationMS: 60_000, TotalTalkMS: 10_000, OverlapMS: 0, SilenceMS: 50_000, BucketMS: 1_000,
			Speakers: []talktime.Speaker{
				{ID: participant, ParticipantID: participant, DisplayName: "Alice", TalkMS: 8_000, Share: 0.8, Turns: 1, Intervals: []talktime.Interval{{StartMS: 1_000, EndMS: 9_000}}, BucketTalkMS: []int64{0, 1_000}},
				{ID: "ref:dana", DisplayName: "Dana", TalkMS: 2_000, Share: 0.2, Turns: 1, Intervals: []talktime.Interval{}, BucketTalkMS: []int64{}},
			},
		},
	}
	response := serveTalkTime(t, fakeTalkTime{outcome: outcome}, allowAllTenants{})
	if response.Code != http.StatusOK {
		t.Fatalf("response = %d %s", response.Code, response.Body.String())
	}
	var body struct {
		Source   string `json:"source"`
		Status   string `json:"status"`
		TalkTime struct {
			EpisodeDurationMS int64 `json:"episode_duration_ms"`
			Recordings        []struct {
				OffsetMS    int64 `json:"offset_ms"`
				Transcribed bool  `json:"transcribed"`
			} `json:"recordings"`
			Speakers []struct {
				SpeakerKey    string  `json:"speaker_key"`
				ParticipantID *string `json:"participant_id"`
				TalkMS        int64   `json:"talk_ms"`
				Share         float64 `json:"share"`
				Intervals     []struct {
					StartMS int64 `json:"start_ms"`
					EndMS   int64 `json:"end_ms"`
				} `json:"intervals"`
			} `json:"speakers"`
		} `json:"talk_time"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body.Source != "transcript" || body.Status != "available" || body.TalkTime.EpisodeDurationMS != 60_000 || len(body.TalkTime.Recordings) != 2 || body.TalkTime.Recordings[0].OffsetMS != 30_000 || !body.TalkTime.Recordings[0].Transcribed || body.TalkTime.Recordings[1].Transcribed || len(body.TalkTime.Speakers) != 2 {
		t.Fatalf("body = %s", response.Body.String())
	}
	alice, dana := body.TalkTime.Speakers[0], body.TalkTime.Speakers[1]
	if alice.ParticipantID == nil || *alice.ParticipantID != participant || alice.TalkMS != 8_000 || alice.Share != 0.8 || len(alice.Intervals) != 1 || alice.Intervals[0].EndMS != 9_000 {
		t.Fatalf("Alice = %+v", alice)
	}
	if dana.ParticipantID != nil || dana.SpeakerKey != "ref:dana" {
		t.Fatalf("a speaker with no matching Participant has a null participant_id: %+v", dana)
	}
}

func TestEpisodeTalkTimeStatusesWithoutMeasurementsHaveNoTalkTime(t *testing.T) {
	for outcome, status := range map[talktime.Outcome]string{
		talktime.NoTranscript{}:      "no_transcript",
		talktime.TranscriptPending{}: "transcript_pending",
		talktime.Live{}:              "live",
	} {
		response := serveTalkTime(t, fakeTalkTime{outcome: outcome}, allowAllTenants{})
		var body map[string]json.RawMessage
		if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
			t.Fatal(err)
		}
		if response.Code != http.StatusOK || string(body["status"]) != `"`+status+`"` || string(body["source"]) != `"transcript"` || string(body["talk_time"]) != "null" {
			t.Fatalf("%s: %d %s", status, response.Code, response.Body.String())
		}
	}
}

func TestEpisodeTalkTimeAnswersLikeAttendanceForMissingEpisodesAndForbiddenTenants(t *testing.T) {
	missing := serveTalkTime(t, fakeTalkTime{err: episodes.ErrEpisodeNotFound}, allowAllTenants{})
	if missing.Code != http.StatusNotFound {
		t.Fatalf("missing Episode = %d %s", missing.Code, missing.Body.String())
	}
	forbidden := serveTalkTime(t, fakeTalkTime{outcome: talktime.Live{}}, denyingTenants{})
	if forbidden.Code != http.StatusForbidden {
		t.Fatalf("forbidden = %d %s", forbidden.Code, forbidden.Body.String())
	}
	unavailable := serveTalkTime(t, nil, allowAllTenants{})
	if unavailable.Code != http.StatusServiceUnavailable {
		t.Fatalf("no service = %d %s", unavailable.Code, unavailable.Body.String())
	}
}

type talkTimeSpy struct{ calls int }

func (s *talkTimeSpy) Get(context.Context, utilities.ID, utilities.ID, utilities.ID) (talktime.Outcome, error) {
	s.calls++
	return talktime.Live{}, nil
}

func TestMCPInspectEpisodesTalkTimeViewReachesTheService(t *testing.T) {
	spy := &talkTimeSpy{}
	handler := NewMCPHandler(Options{EpisodeTalkTime: spy, TenantAuthz: allowAllTenants{}})
	principal := scopeTestPrincipal(t, authentication.PrincipalAPIKey, authentication.ScopeEpisodesRead)
	space, _ := utilities.NewID()
	episode, _ := utilities.NewID()
	arguments := `{"view":"talk_time","space_id":"` + space.String() + `","episode_id":"` + episode.String() + `"}`
	request := httptest.NewRequest(http.MethodPost, "/mcp", strings.NewReader(toolCallBody("chalk_inspect_episodes", arguments)))
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Accept", "application/json, text/event-stream")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request.WithContext(authentication.ContextWithPrincipal(request.Context(), principal)))
	if response.Code != http.StatusOK || strings.Contains(response.Body.String(), `"isError":true`) || !strings.Contains(response.Body.String(), `\"status\":\"live\"`) || spy.calls != 1 {
		t.Fatalf("%d calls=%d %s", response.Code, spy.calls, response.Body.String())
	}
}
