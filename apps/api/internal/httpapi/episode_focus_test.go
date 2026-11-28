package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/q9labs/chalk/apps/api/internal/authentication"
	"github.com/q9labs/chalk/apps/api/internal/authorization"
	"github.com/q9labs/chalk/apps/api/internal/episodes"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

type episodeFocusProbe struct {
	artifact episodes.FocusArtifact
	calls    int
}

func (p *admissionLifecycleProbe) GetEpisodeFocus(context.Context, utilities.ID, utilities.ID, utilities.ID) (episodes.FocusArtifact, error) {
	return episodes.FocusArtifact{}, nil
}

func (p *episodeFocusProbe) GetEpisodeFocus(context.Context, utilities.ID, utilities.ID, utilities.ID) (episodes.FocusArtifact, error) {
	p.calls++
	return p.artifact, nil
}

func episodeFocusRouter(service episodeFocusService, key *authentication.Principal) http.Handler {
	router := chi.NewRouter()
	router.Use(func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if key != nil {
				r = r.WithContext(authentication.ContextWithPrincipal(r.Context(), *key))
			}
			next.ServeHTTP(w, r)
		})
	})
	getEpisodeFocusEndpoint(service, authorization.NewTenantPolicy(nil, nil)).Mount(router, RateLimitOptions{})
	return router
}

func TestEpisodeFocusRouteAuthorization(t *testing.T) {
	const (
		tenant  = "11111111-1111-4111-8111-111111111111"
		space   = "33333333-3333-4333-8333-333333333333"
		episode = "44444444-4444-4444-8444-444444444444"
	)
	path := "/tenants/" + tenant + "/spaces/" + space + "/episodes/" + episode + "/focus"
	key := func(scopes ...authentication.Scope) *authentication.Principal {
		return &authentication.Principal{Kind: authentication.PrincipalAPIKey, APIKeyID: mustID(t, "55555555-5555-4555-8555-555555555555"), TenantID: mustID(t, tenant), Scopes: scopes}
	}
	for _, tc := range []struct {
		name  string
		key   *authentication.Principal
		want  int
		calls int
	}{
		{"no credential", nil, http.StatusUnauthorized, 0},
		{"episodes read alone is not enough", key(authentication.ScopeEpisodesRead), http.StatusForbidden, 0},
		{"focus read", key(authentication.ScopeFocusRead), http.StatusOK, 1},
	} {
		t.Run(tc.name, func(t *testing.T) {
			probe := &episodeFocusProbe{artifact: episodes.FocusArtifact{EpisodeID: mustID(t, episode)}}
			response := httptest.NewRecorder()
			episodeFocusRouter(probe, tc.key).ServeHTTP(response, httptest.NewRequest(http.MethodGet, path, nil))
			if response.Code != tc.want {
				t.Fatalf("status = %d, want %d: %s", response.Code, tc.want, response.Body.String())
			}
			if probe.calls != tc.calls {
				t.Fatalf("service calls = %d, want %d", probe.calls, tc.calls)
			}
		})
	}
}

func TestEpisodeFocusResponseCountsAwayTimeOutsideAllowWindows(t *testing.T) {
	at := func(minute int) time.Time { return time.Date(2027, 3, 1, 10, minute, 0, 0, time.UTC) }
	participantID := mustID(t, "66666666-6666-4666-8666-666666666666")
	artifact := episodes.FocusArtifact{
		EpisodeID: mustID(t, "44444444-4444-4444-8444-444444444444"),
		Participants: []episodes.FocusParticipant{{
			ParticipantID: participantID, DisplayName: "Ada", EpisodeStartsAt: at(0), EpisodeEndsAt: at(60),
			Intervals: []episodes.FocusInterval{
				{State: "active", StartedAt: at(0), EndedAt: at(10)},
				{State: "inactive", Windowed: true, StartedAt: at(10), EndedAt: at(20)},
				{State: "active", StartedAt: at(20), EndedAt: at(25)},
				{State: "background", StartedAt: at(25), EndedAt: at(50)},
			},
			StepAways: []episodes.FocusStepAway{{Reason: "reading", StartedAt: at(12), EndedAt: nil}},
		}},
		AllowWindows: []episodes.FocusAllowWindow{{ActorParticipantID: participantID, StartedAt: at(30), EndsAt: at(40)}},
	}

	response := newEpisodeFocusResponse(artifact)
	if len(response.Participants) != 1 || len(response.AllowWindows) != 1 {
		t.Fatalf("response shape = %+v", response)
	}
	person := response.Participants[0]
	if person.AwayTimeSeconds != 1500 || person.TimesAway != 3 || person.LongestAwaySeconds != 600 {
		t.Fatalf("away summary = %d/%d/%d, want 1500/3/600", person.AwayTimeSeconds, person.TimesAway, person.LongestAwaySeconds)
	}
	if person.ReportingCoverageSeconds != 3000 {
		t.Fatalf("reporting coverage = %d, want 3000", person.ReportingCoverageSeconds)
	}
	if person.ReportingCoverageRatio < 0.833 || person.ReportingCoverageRatio > 0.834 {
		t.Fatalf("reporting ratio = %f, want about 0.833", person.ReportingCoverageRatio)
	}
	encoded, err := json.Marshal(response)
	if err != nil {
		t.Fatal(err)
	}
	var decoded map[string]any
	if err := json.Unmarshal(encoded, &decoded); err != nil {
		t.Fatal(err)
	}
	if decoded["episode_id"] != artifact.EpisodeID.String() {
		t.Fatalf("episode_id = %v", decoded["episode_id"])
	}
}
