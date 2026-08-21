package httpapi_test

import (
	"context"
	"errors"
	"net/http"
	"testing"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/accessgrants"
	"github.com/q9labs/chalk/apps/api/internal/authentication"
	"github.com/q9labs/chalk/apps/api/internal/authorization"
	"github.com/q9labs/chalk/apps/api/internal/episodes"
	"github.com/q9labs/chalk/apps/api/internal/httpapi"
	"github.com/q9labs/chalk/apps/api/internal/synctokens"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

type dashboardLifecycleService struct {
	lifecycleService
	joinResult  episodes.SelfJoinResult
	findResult  episodes.SelfJoinResult
	joinErr     error
	findErr     error
	leaveErr    error
	leaveInput  episodes.SelfLeaveInput
	joinCalled  bool
	findCalled  bool
	leaveCalled bool
}

func (s *dashboardLifecycleService) JoinSelf(_ context.Context, _ episodes.SelfJoinInput) (episodes.SelfJoinResult, error) {
	s.joinCalled = true
	return s.joinResult, s.joinErr
}
func (s *dashboardLifecycleService) FindSelf(_ context.Context, _ episodes.SelfAccessInput) (episodes.SelfJoinResult, error) {
	s.findCalled = true
	return s.findResult, s.findErr
}
func (s *dashboardLifecycleService) LeaveSelf(_ context.Context, input episodes.SelfLeaveInput) (episodes.SelfLeaveResult, error) {
	s.leaveCalled = true
	s.leaveInput = input
	return episodes.SelfLeaveResult{}, s.leaveErr
}

func TestDashboardSpaceSelfRoutesJoinRefreshAndLeave(t *testing.T) {
	fixture := newAccessGrantFixture(t)
	service := &dashboardLifecycleService{
		joinResult: episodes.SelfJoinResult{
			Episode:     episodes.Episode{TenantID: fixture.tenantID, SpaceID: fixture.spaceID, ID: fixture.episodeID, Status: episodes.EpisodeStatusActive},
			Participant: episodes.Participant{ID: fixture.participantID, TenantID: fixture.tenantID, SpaceID: fixture.spaceID, EpisodeID: fixture.episodeID, Generation: 7, Role: "owner", Capabilities: []string{"publishAudio"}},
			Intent:      episodes.Intent{ID: mustTenantID(t, "55555555-5555-4555-8555-555555555555"), IntentName: episodes.IntentParticipantJoined},
		},
	}
	options := authenticatedOptions(t, httpapi.Options{
		Episodes: service,
		SyncTokens: syncTokenIssuerFunc(func(context.Context, synctokens.Input) (synctokens.Token, error) {
			return synctokens.Token{Value: "sync-dashboard", ExpiresAt: fixtureExpiry()}, nil
		}),
		SyncTokenRefresh: syncTokenRefreshIssuerFunc(func(context.Context, synctokens.SubjectKey) (synctokens.Token, error) {
			return synctokens.Token{Value: "sync-dashboard-refresh", ExpiresAt: fixtureExpiry()}, nil
		}),
		ParticipantMediaIssuer: participantMediaIssuerFunc(func(context.Context, accessgrants.Subject) (accessgrants.MediaCredential, error) {
			return accessgrants.MediaCredential{Token: "media-dashboard", ExpiresAt: fixtureExpiry()}, nil
		}),
		ParticipantMediaVerify: participantMediaVerifierFunc(func(context.Context, string) (accessgrants.Subject, error) {
			return fixture.subject(7, "connection-current"), nil
		}),
		ParticipantMediaActive: activeParticipantAuthorizerFunc(func(context.Context, accessgrants.Subject) (bool, error) { return true, nil }),
		ParticipantGeneration:  participantGenerationAuthorizerFunc(func(context.Context, synctokens.SubjectKey, int64) (bool, error) { return true, nil }),
		Spaces:                 fixture.spaceService(), Tenants: fixture.tenants(), MediaPlane: fixture.resolver(),
	})

	join := bearerRequestWithBody(http.MethodPost, dashboardSelfPath(fixture, "team-space"), authenticatedFixtureToken(), `{"display_name":"Ada"}`)
	join.Header.Set("Idempotency-Key", "dashboard-self-join-0001")
	joined := requestWithOptionsAndRequest(t, join, options)
	if joined.Code != http.StatusCreated || !service.joinCalled {
		t.Fatalf("join status/call = %d/%t; body=%s", joined.Code, service.joinCalled, joined.Body.String())
	}

	service.findResult = service.joinResult
	refresh := bearerRequestWithBody(http.MethodPost, dashboardSelfPath(fixture, "team-space")+"/access-grants", authenticatedFixtureToken(), `{"participant_generation":7,"replace_media_connection":true}`)
	refreshed := requestWithOptionsAndRequest(t, refresh, options)
	if refreshed.Code != http.StatusCreated || !service.findCalled {
		t.Fatalf("refresh status/call = %d/%t; body=%s", refreshed.Code, service.findCalled, refreshed.Body.String())
	}

	leave := bearerRequestWithBody(http.MethodDelete, dashboardSelfPath(fixture, "team-space"), authenticatedFixtureToken(), `{}`)
	leave.Header.Set("Idempotency-Key", "dashboard-self-leave-0001")
	left := requestWithOptionsAndRequest(t, leave, options)
	if left.Code != http.StatusNoContent || !service.leaveCalled || left.Body.Len() != 0 {
		t.Fatalf("leave status/call/body = %d/%t/%q", left.Code, service.leaveCalled, left.Body.String())
	}
}

func TestDashboardSpaceSelfRoutesRequireAccountAndTenantWrite(t *testing.T) {
	fixture := newAccessGrantFixture(t)
	path := dashboardSelfPath(fixture, "team-space")
	unauthenticated := requestWithOptionsAndBody(t, http.MethodPost, path, `{"display_name":"Ada"}`, httpapi.Options{Authentication: authenticationService{}, Episodes: &dashboardLifecycleService{}})
	if unauthenticated.Code != http.StatusUnauthorized {
		t.Fatalf("unauthenticated status = %d, want 401", unauthenticated.Code)
	}
	forbidden := bearerRequestWithBody(http.MethodPost, path, authenticatedFixtureToken(), `{"display_name":"Ada"}`)
	forbidden.Header.Set("Idempotency-Key", "dashboard-self-join-0001")
	response := requestWithOptionsAndRequest(t, forbidden, authenticatedOptions(t, httpapi.Options{Episodes: &dashboardLifecycleService{}, TenantAuthz: tenantAuthorizer{authorizeTenant: func(context.Context, authentication.Principal, utilities.ID, authorization.TenantPermission) error {
		return authorization.ErrForbidden
	}}}))
	if response.Code != http.StatusForbidden {
		t.Fatalf("forbidden status = %d, want 403", response.Code)
	}
}

func TestDashboardSpaceSelfJoinCleansUpWhenGrantPreparationFails(t *testing.T) {
	fixture := newAccessGrantFixture(t)
	service := &dashboardLifecycleService{
		joinResult: episodes.SelfJoinResult{
			Episode:     episodes.Episode{TenantID: fixture.tenantID, SpaceID: fixture.spaceID, ID: fixture.episodeID, Status: episodes.EpisodeStatusActive},
			Participant: episodes.Participant{ID: fixture.participantID, TenantID: fixture.tenantID, SpaceID: fixture.spaceID, EpisodeID: fixture.episodeID, Generation: 7, Status: episodes.ParticipantStatusJoining},
			Intent:      episodes.Intent{ID: mustTenantID(t, "55555555-5555-4555-8555-555555555555"), IntentName: episodes.IntentParticipantJoined},
		},
	}
	options := authenticatedOptions(t, httpapi.Options{
		Episodes: service,
		SyncTokens: syncTokenIssuerFunc(func(context.Context, synctokens.Input) (synctokens.Token, error) {
			return synctokens.Token{Value: "sync-dashboard", ExpiresAt: fixtureExpiry()}, nil
		}),
		ParticipantMediaIssuer: participantMediaIssuerFunc(func(context.Context, accessgrants.Subject) (accessgrants.MediaCredential, error) {
			return accessgrants.MediaCredential{}, errors.New("media issuer unavailable")
		}),
		Spaces: fixture.spaceService(), Tenants: fixture.tenants(), MediaPlane: fixture.resolver(),
	})

	request := bearerRequestWithBody(http.MethodPost, dashboardSelfPath(fixture, "team-space"), authenticatedFixtureToken(), `{"display_name":"Ada"}`)
	request.Header.Set("Idempotency-Key", "dashboard-self-join-0001")
	response := requestWithOptionsAndRequest(t, request, options)

	if response.Code < http.StatusInternalServerError {
		t.Fatalf("status = %d; body=%s", response.Code, response.Body.String())
	}
	if !service.leaveCalled {
		t.Fatal("failed grant preparation did not request participant cleanup")
	}
	if service.leaveInput.ParticipantGeneration != 7 {
		t.Fatalf("cleanup generation = %d, want 7", service.leaveInput.ParticipantGeneration)
	}
	if service.leaveInput.Request.Key == "dashboard-self-join-0001" || len(service.leaveInput.Request.Key) < 16 {
		t.Fatalf("cleanup request key = %q, want an independent valid key", service.leaveInput.Request.Key)
	}
}

func TestDashboardSpaceSelfRouteMapsArchivedAndMissingSpace(t *testing.T) {
	fixture := newAccessGrantFixture(t)
	tests := []struct {
		name string
		err  error
		want string
	}{
		{name: "archived", err: episodes.ErrAdmissionClosed, want: "request.invalid"},
		{name: "missing", err: episodes.ErrSpaceNotFound, want: "space.not_found"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			service := &dashboardLifecycleService{joinErr: test.err}
			request := bearerRequestWithBody(http.MethodPost, dashboardSelfPath(fixture, "team-space"), authenticatedFixtureToken(), `{"display_name":"Ada"}`)
			request.Header.Set("Idempotency-Key", "dashboard-self-join-0001")
			response := requestWithOptionsAndRequest(t, request, authenticatedOptions(t, httpapi.Options{Episodes: service, ParticipantMediaIssuer: participantMediaIssuerFunc(func(context.Context, accessgrants.Subject) (accessgrants.MediaCredential, error) {
				return accessgrants.MediaCredential{}, nil
			})}))
			if response.Code >= http.StatusInternalServerError {
				t.Fatalf("status = %d; body=%s", response.Code, response.Body.String())
			}
			assertErrorCode(t, response, test.want)
		})
	}
}

func dashboardSelfPath(fixture accessGrantFixture, slug string) string {
	return "/v1/tenants/" + fixture.tenantID.String() + "/spaces/by-slug/" + slug + "/participants/self"
}

func fixtureExpiry() time.Time {
	return time.Date(2026, 8, 10, 12, 5, 0, 0, time.UTC)
}
