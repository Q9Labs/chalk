package httpapi

import (
	"bytes"
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/q9labs/chalk/apps/api/internal/accessgrants"
	"github.com/q9labs/chalk/apps/api/internal/episodes"
	"github.com/q9labs/chalk/apps/api/internal/mediaplane"
	"github.com/q9labs/chalk/apps/api/internal/mediapublications"
	"github.com/q9labs/chalk/apps/api/internal/spaces"
	"github.com/q9labs/chalk/apps/api/internal/tenants"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

const participantMediaCredential = "media.header.signature"

type participantMediaVerifierStub struct {
	subject accessgrants.Subject
	called  int
}

func (v *participantMediaVerifierStub) Verify(_ context.Context, _ string) (accessgrants.Subject, error) {
	v.called++
	return v.subject, nil
}

type activeParticipantAuthorizerStub struct {
	subject accessgrants.Subject
	called  int
}

func (a *activeParticipantAuthorizerStub) AuthorizeActiveParticipant(_ context.Context, subject accessgrants.Subject) (bool, error) {
	a.called++
	a.subject = subject
	return true, nil
}

func TestParticipantMediaRouteRejectsMismatchedConnectionBeforeProviderCall(t *testing.T) {
	subject := participantMediaSubject(t)
	verifier := &participantMediaVerifierStub{subject: subject}
	authorizer := &activeParticipantAuthorizerStub{}

	router := chi.NewRouter()
	router.Use(requireParticipantMedia(verifier, authorizer))
	sfuAddTracksEndpoint(nil, nil, nil, nil, nil).Mount(router, RateLimitOptions{})

	path := fmt.Sprintf(
		"/tenants/%s/spaces/%s/episodes/%s/participants/%s/media/sfu/tracks",
		subject.TenantID,
		subject.SpaceID,
		subject.EpisodeID,
		subject.ParticipantID,
	)
	request := httptest.NewRequest(http.MethodPost, path, bytes.NewBufferString(`{"connection_id":"another-connection","tracks":[]}`))
	request.Header.Set("Authorization", "Bearer "+participantMediaCredential)
	response := httptest.NewRecorder()

	router.ServeHTTP(response, request)

	if response.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want %d", response.Code, http.StatusForbidden)
	}
	if response.Body.String() != `{"error":{"code":"access.forbidden","message":"Access denied"}}`+"\n" {
		t.Fatalf("body = %q", response.Body.String())
	}
	if verifier.called != 1 || authorizer.called != 1 || authorizer.subject != subject {
		t.Fatalf("authentication calls: verifier=%d authorizer=%d subject=%#v", verifier.called, authorizer.called, authorizer.subject)
	}
}

func TestReceiveOnlyCloseRejectsMismatchedConnectionBeforeProviderCall(t *testing.T) {
	subject := participantMediaSubject(t)
	verifier := &participantMediaVerifierStub{subject: subject}
	authorizer := &activeParticipantAuthorizerStub{}

	router := chi.NewRouter()
	router.Use(requireParticipantMedia(verifier, authorizer))
	sfuCloseTracksEndpoint(nil, nil, nil, nil, nil).Mount(router, RateLimitOptions{})

	path := fmt.Sprintf(
		"/tenants/%s/spaces/%s/episodes/%s/participants/%s/media/sfu/tracks/close",
		subject.TenantID,
		subject.SpaceID,
		subject.EpisodeID,
		subject.ParticipantID,
	)
	request := httptest.NewRequest(http.MethodPut, path, bytes.NewBufferString(`{"connection_id":"another-connection","receive_only":true,"force":true,"tracks":[{"mid":"1","source":"microphone","publication_id":"remote"}]}`))
	request.Header.Set("Authorization", "Bearer "+participantMediaCredential)
	response := httptest.NewRecorder()

	router.ServeHTTP(response, request)

	if response.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want %d", response.Code, http.StatusForbidden)
	}
	if response.Body.String() != `{"error":{"code":"access.forbidden","message":"Access denied"}}`+"\n" {
		t.Fatalf("body = %q", response.Body.String())
	}
	if verifier.called != 1 || authorizer.called != 1 || authorizer.subject != subject {
		t.Fatalf("authentication calls: verifier=%d authorizer=%d subject=%#v", verifier.called, authorizer.called, authorizer.subject)
	}
}

func TestParticipantMediaAddTracksLabelsProviderCallWithRouteIDs(t *testing.T) {
	subject := participantMediaSubject(t)
	plane := &addTracksRouteFixture{}
	router := chi.NewRouter()
	router.Use(requireParticipantMedia(&participantMediaVerifierStub{subject: subject}, &activeParticipantAuthorizerStub{}))
	sfuAddTracksEndpoint(plane, plane, plane, plane, nil).Mount(router, RateLimitOptions{})

	path := fmt.Sprintf("/tenants/%s/spaces/%s/episodes/%s/participants/%s/media/sfu/tracks", subject.TenantID, subject.SpaceID, subject.EpisodeID, subject.ParticipantID)
	request := httptest.NewRequest(http.MethodPost, path, bytes.NewBufferString(`{"connection_id":"connection-123","tracks":[{"location":"remote","sessionId":"sender","trackName":"camera"}]}`))
	request.Header.Set("Authorization", "Bearer "+participantMediaCredential)
	response := httptest.NewRecorder()
	router.ServeHTTP(response, request)

	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", response.Code, response.Body.String())
	}
	if plane.request.SpaceID != subject.SpaceID.String() || plane.request.EpisodeID != subject.EpisodeID.String() {
		t.Fatalf("provider request labels = space %q episode %q, want %s and %s", plane.request.SpaceID, plane.request.EpisodeID, subject.SpaceID, subject.EpisodeID)
	}
}

func TestParticipantMediaDeferredTracksStayHiddenUntilAvailable(t *testing.T) {
	subject := participantMediaSubject(t)
	plane := &addTracksRouteFixture{response: mediaplane.TracksResponse{Tracks: []mediaplane.Track{{Mid: "0", TrackName: "microphone-track"}}}}
	registry := &publicationRouteRegistryFixture{}
	router := chi.NewRouter()
	router.Use(requireParticipantMedia(&participantMediaVerifierStub{subject: subject}, &activeParticipantAuthorizerStub{}))
	sfuAddTracksEndpoint(plane, plane, plane, plane, registry).Mount(router, RateLimitOptions{})

	path := fmt.Sprintf("/tenants/%s/spaces/%s/episodes/%s/participants/%s/media/sfu/tracks?defer_publication=true", subject.TenantID, subject.SpaceID, subject.EpisodeID, subject.ParticipantID)
	request := httptest.NewRequest(http.MethodPost, path, bytes.NewBufferString(`{"connection_id":"connection-123","tracks":[{"location":"local","mid":"0","source":"microphone","trackName":"microphone-track"}]}`))
	request.Header.Set("Authorization", "Bearer "+participantMediaCredential)
	response := httptest.NewRecorder()
	router.ServeHTTP(response, request)

	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", response.Code, response.Body.String())
	}
	if !registry.recordInput.Pending || registry.recordInput.ParticipantID != subject.ParticipantID {
		t.Fatalf("record input = %+v", registry.recordInput)
	}
	if !strings.Contains(response.Body.String(), `"publicationsPending":true`) || !strings.Contains(response.Body.String(), `"publication_id":"connection-123|microphone-track"`) {
		t.Fatalf("deferred response = %s", response.Body.String())
	}
}

func TestMarkSFUPublicationsAvailableAuthorizesAndChecksConnectionReferences(t *testing.T) {
	subject := participantMediaSubject(t)
	registry := &publicationRouteRegistryFixture{}
	plane := &addTracksRouteFixture{}
	router := chi.NewRouter()
	router.Use(requireParticipantMedia(&participantMediaVerifierStub{subject: subject}, &activeParticipantAuthorizerStub{}))
	sfuPublicationsAvailableEndpoint(plane, plane, plane, plane, registry).Mount(router, RateLimitOptions{})
	path := fmt.Sprintf("/tenants/%s/spaces/%s/episodes/%s/participants/%s/media/sfu/publications/available", subject.TenantID, subject.SpaceID, subject.EpisodeID, subject.ParticipantID)
	request := httptest.NewRequest(http.MethodPost, path, bytes.NewBufferString(`{"connection_id":"connection-123","tracks":[{"source":"microphone","publication_id":"connection-123|microphone-track"}]}`))
	request.Header.Set("Authorization", "Bearer "+participantMediaCredential)
	response := httptest.NewRecorder()
	router.ServeHTTP(response, request)
	if response.Code != http.StatusOK || response.Body.String() != `{"accepted":true}`+"\n" {
		t.Fatalf("status = %d, body = %s", response.Code, response.Body.String())
	}
	if len(registry.availabilityInputs) != 1 || registry.availabilityInputs[0].ParticipantID != subject.ParticipantID || !registry.availabilityInputs[0].Enabled {
		t.Fatalf("availability inputs = %+v", registry.availabilityInputs)
	}

	registry.availabilityInputs = nil
	request = httptest.NewRequest(http.MethodPost, path, bytes.NewBufferString(`{"connection_id":"connection-123","tracks":[{"source":"microphone","publication_id":"another-connection|microphone-track"}]}`))
	request.Header.Set("Authorization", "Bearer "+participantMediaCredential)
	response = httptest.NewRecorder()
	router.ServeHTTP(response, request)
	if response.Code != http.StatusBadRequest || len(registry.availabilityInputs) != 0 {
		t.Fatalf("mismatched reference status = %d, availability inputs = %+v", response.Code, registry.availabilityInputs)
	}

	wrongParticipantPath := strings.Replace(path, subject.ParticipantID.String(), "55555555-5555-4555-8555-555555555555", 1)
	request = httptest.NewRequest(http.MethodPost, wrongParticipantPath, bytes.NewBufferString(`{"connection_id":"connection-123","tracks":[{"source":"microphone","publication_id":"connection-123|microphone-track"}]}`))
	request.Header.Set("Authorization", "Bearer "+participantMediaCredential)
	response = httptest.NewRecorder()
	router.ServeHTTP(response, request)
	if response.Code != http.StatusForbidden || len(registry.availabilityInputs) != 0 {
		t.Fatalf("wrong participant status = %d, availability inputs = %+v", response.Code, registry.availabilityInputs)
	}
}

type addTracksRouteFixture struct {
	SpaceService
	TenantService
	mediaplane.Plane
	request  mediaplane.TracksRequest
	response mediaplane.TracksResponse
}

func (*addTracksRouteFixture) GetSpace(context.Context, utilities.ID, utilities.ID) (spaces.Space, error) {
	return spaces.Space{}, nil
}
func (*addTracksRouteFixture) GetTenant(context.Context, utilities.ID) (tenants.Tenant, error) {
	return tenants.Tenant{}, nil
}
func (*addTracksRouteFixture) GetEpisode(context.Context, utilities.ID, utilities.ID, utilities.ID) (episodes.Episode, error) {
	return episodes.Episode{}, nil
}
func (f *addTracksRouteFixture) Resolve(context.Context, tenants.Tenant, spaces.Space) (*mediaplane.Service, error) {
	service := mediaplane.NewServiceForProvider(mediaplane.ProviderCloudflareSFU, f)
	return &service, nil
}
func (f *addTracksRouteFixture) AddTracks(_ context.Context, request mediaplane.TracksRequest) (mediaplane.TracksResponse, error) {
	f.request = request
	return f.response, nil
}
func (*addTracksRouteFixture) Renegotiate(context.Context, mediaplane.RenegotiateRequest) error {
	return nil
}

type publicationRouteRegistryFixture struct {
	mediapublications.Registry
	recordInput        mediapublications.RecordInput
	availabilityInputs []mediapublications.AvailabilityInput
}

func (f *publicationRouteRegistryFixture) RecordPublishedTracks(_ context.Context, input mediapublications.RecordInput) ([]mediapublications.PublishedReference, error) {
	f.recordInput = input
	references := make([]mediapublications.PublishedReference, 0, len(input.Tracks))
	for _, track := range input.Tracks {
		references = append(references, mediapublications.PublishedReference{
			Source: track.Source, MID: track.MID, TrackName: track.TrackName, PublicationID: input.ConnectionID + "|" + track.TrackName,
		})
	}
	return references, nil
}

func (f *publicationRouteRegistryFixture) RecordPublicationAvailability(_ context.Context, input mediapublications.AvailabilityInput) error {
	f.availabilityInputs = append(f.availabilityInputs, input)
	return nil
}

func participantMediaSubject(t *testing.T) accessgrants.Subject {
	t.Helper()
	return accessgrants.Subject{
		TenantID:               participantMediaID(t, "11111111-1111-4111-8111-111111111111"),
		SpaceID:                participantMediaID(t, "22222222-2222-4222-8222-222222222222"),
		EpisodeID:              participantMediaID(t, "33333333-3333-4333-8333-333333333333"),
		ParticipantID:          participantMediaID(t, "44444444-4444-4444-8444-444444444444"),
		ParticipantGeneration:  7,
		Provider:               accessgrants.ProviderCloudflareSFU,
		CloudflareConnectionID: "connection-123",
	}
}

func participantMediaID(t *testing.T, raw string) utilities.ID {
	t.Helper()
	id, err := utilities.ParseID(raw)
	if err != nil {
		t.Fatal(err)
	}
	return id
}
