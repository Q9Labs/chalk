package httpapi

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/adapters/cloudflare/sfu"
	"github.com/q9labs/chalk/apps/api/internal/config"
	"github.com/q9labs/chalk/apps/api/internal/mediaplane"
	"github.com/q9labs/chalk/apps/api/internal/mediapublications"
	"github.com/q9labs/chalk/apps/api/internal/provideroperations"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

func TestConfirmFailedRemoteTracksInspectsCloudflareAndPreservesListenerResult(t *testing.T) {
	for _, test := range []struct {
		name             string
		sessionTrack     string
		retries          int
		wantEnabled      bool
		wantSessionReads int
	}{
		{name: "gone publication is retired", retries: 1, wantEnabled: false, wantSessionReads: 1},
		{name: "present publication stays enabled and listener failures dedupe", sessionTrack: `{"location":"local","mid":"camera-mid","trackName":"camera-track","status":"active"}`, retries: 5, wantEnabled: true, wantSessionReads: 1},
	} {
		t.Run(test.name, func(t *testing.T) {
			ctx := context.Background()
			tenantID := sfuLivenessTestID(t, "11111111-1111-4111-8111-111111111111")
			episodeID := sfuLivenessTestID(t, "22222222-2222-4222-8222-222222222222")
			participantID := sfuLivenessTestID(t, "33333333-3333-4333-8333-333333333333")
			repository := &sfuLivenessRepository{
				participants: []mediapublications.PublicationParticipant{{
					ID: participantID, Generation: 1, ConnectionID: "publisher-connection",
				}},
			}
			registry := mediapublications.NewService(repository)
			references, err := registry.RecordPublishedTracks(ctx, mediapublications.RecordInput{
				TenantID: tenantID, EpisodeID: episodeID, ParticipantID: participantID, ParticipantGeneration: 1,
				ConnectionID: "publisher-connection",
				Tracks:       []mediapublications.PublishedTrack{{Source: "camera", MID: "camera-mid", TrackName: "camera-track"}},
			})
			if err != nil {
				t.Fatalf("record publication: %v", err)
			}
			if len(references) != 1 {
				t.Fatalf("recorded references=%d, want 1", len(references))
			}

			transport := &sfuLivenessTransport{
				trackName:    "camera-track",
				sessionID:    "publisher-connection",
				sessionTrack: test.sessionTrack,
			}
			adapter, err := sfu.NewAdapterWithClient(config.CloudflareRealtimeConfig{
				RealtimeAppID: "app", RealtimeAppSecret: "test-secret", RequestTimeout: time.Second,
			}, &http.Client{Transport: transport}, "https://cloudflare.test")
			if err != nil {
				t.Fatalf("create Cloudflare adapter: %v", err)
			}
			plane := mediaplane.NewServiceForProvider(mediaplane.ProviderCloudflareSFU, adapter)
			tracks := []mediaplane.Track{{
				Location: "remote", TrackName: "camera-track", SessionID: "publisher-connection",
			}}
			request := sfuTracksEndpointRequest{
				TenantID: tenantID, EpisodeID: episodeID, ParticipantID: participantID,
				Body: sfuTracksRequest{ConnectionID: "listener-connection", Tracks: tracks},
			}

			for attempt := 0; attempt < test.retries; attempt++ {
				response, providerErr := plane.AddTracks(ctx, mediaplane.TracksRequest{
					ConnectionID: "listener-connection",
					Tracks:       tracks,
				})
				if providerErr == nil || len(response.TrackErrors) != 1 {
					t.Fatalf("listener result response=%+v error=%v, want one per-track failure", response, providerErr)
				}
				responseBefore := response
				errorBefore := providerErr

				confirmFailedRemoteTracks(ctx, &plane, registry, request, response, providerErr)

				if !reflect.DeepEqual(response, responseBefore) || !reflect.DeepEqual(providerErr, errorBefore) {
					t.Fatalf("listener result changed by liveness check: before=(%+v, %v), after=(%+v, %v)",
						responseBefore, errorBefore, response, providerErr)
				}
			}

			snapshot, err := registry.Latest(ctx, tenantID, episodeID)
			if err != nil {
				t.Fatalf("read latest publication snapshot: %v", err)
			}
			if len(snapshot.Publications) != 1 || snapshot.Publications[0].Enabled != test.wantEnabled {
				t.Fatalf("latest publications=%+v, want enabled=%t", snapshot.Publications, test.wantEnabled)
			}
			if got := transport.sessionReadCount(); got != test.wantSessionReads {
				t.Fatalf("publisher session GET count=%d, want %d", got, test.wantSessionReads)
			}
		})
	}
}

func TestConfirmFailedRemoteTracksOnlyCountsMissingPublications(t *testing.T) {
	tests := []struct {
		name             string
		statusCode       int
		body             string
		transportErr     error
		wantConfirmation bool
	}{
		{
			name:       "top-level gone listener session",
			statusCode: http.StatusGone,
			body:       `{"errorCode":"session_error"}`,
		},
		{
			name: "per-track connection_not_found for listener session",
			body: `{"tracks":[{"location":"remote","sessionId":"listener-connection","trackName":"camera-track","errorCode":"connection_not_found"}]}`,
		},
		{
			name: "per-track session_error for listener session",
			body: `{"tracks":[{"location":"remote","sessionId":"listener-connection","trackName":"camera-track","errorCode":"session_error"}]}`,
		},
		{
			name: "per-track timeout",
			body: `{"tracks":[{"location":"remote","sessionId":"publisher-connection","trackName":"camera-track","errorCode":"timeout"}]}`,
		},
		{
			name: "per-track internal_error",
			body: `{"tracks":[{"location":"remote","sessionId":"publisher-connection","trackName":"camera-track","errorCode":"internal_error"}]}`,
		},
		{
			name: "per-track rate_limited",
			body: `{"tracks":[{"location":"remote","sessionId":"publisher-connection","trackName":"camera-track","errorCode":"rate_limited"}]}`,
		},
		{
			name:       "top-level server failure",
			statusCode: http.StatusServiceUnavailable,
			body:       `{"errorCode":"internal_error"}`,
		},
		{
			name:       "top-level rate limit",
			statusCode: http.StatusTooManyRequests,
			body:       `{"errorCode":"rate_limited"}`,
		},
		{
			name:         "transport timeout",
			transportErr: context.DeadlineExceeded,
		},
		{
			name:             "per-track not_found_track_error",
			body:             `{"tracks":[{"location":"remote","sessionId":"publisher-connection","trackName":"camera-track","errorCode":"not_found_track_error"}]}`,
			wantConfirmation: true,
		},
		{
			name:             "per-track normalized track_not_found",
			body:             `{"tracks":[{"location":"remote","sessionId":"publisher-connection","trackName":"camera-track","errorCode":"track_not_found"}]}`,
			wantConfirmation: true,
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			ctx := context.Background()
			transport := &sfuLivenessTransport{
				addTracksStatus: test.statusCode,
				addTracksBody:   test.body,
				addTracksErr:    test.transportErr,
			}
			adapter, err := sfu.NewAdapterWithClient(config.CloudflareRealtimeConfig{
				RealtimeAppID: "app", RealtimeAppSecret: "test-secret", RequestTimeout: time.Second,
			}, &http.Client{Transport: transport}, "https://cloudflare.test")
			if err != nil {
				t.Fatalf("create Cloudflare adapter: %v", err)
			}
			plane := mediaplane.NewServiceForProvider(mediaplane.ProviderCloudflareSFU, adapter)
			requested := mediaplane.Track{Location: "remote", TrackName: "camera-track", SessionID: "publisher-connection"}
			request := sfuTracksEndpointRequest{
				TenantID:      sfuLivenessTestID(t, "11111111-1111-4111-8111-111111111111"),
				EpisodeID:     sfuLivenessTestID(t, "22222222-2222-4222-8222-222222222222"),
				ParticipantID: sfuLivenessTestID(t, "33333333-3333-4333-8333-333333333333"),
				Body:          sfuTracksRequest{ConnectionID: "listener-connection", Tracks: []mediaplane.Track{requested}},
			}
			response, providerErr := plane.AddTracks(ctx, mediaplane.TracksRequest{
				ConnectionID: request.Body.ConnectionID,
				Tracks:       []mediaplane.Track{requested},
			})
			confirmer := &sfuLivenessConfirmer{}
			confirmFailedRemoteTracks(ctx, &plane, confirmer, request, response, providerErr)

			if test.wantConfirmation {
				want := mediapublications.RemoteTrackIdentity{ConnectionID: "publisher-connection", TrackName: "camera-track"}
				if len(confirmer.inputs) != 1 || !reflect.DeepEqual(confirmer.inputs[0].Failed, []mediapublications.RemoteTrackIdentity{want}) {
					t.Fatalf("confirmer inputs=%+v, want missing publication identity %v", confirmer.inputs, want)
				}
			} else if len(confirmer.inputs) != 0 {
				t.Fatalf("confirmer inputs=%+v, want no publication failure evidence", confirmer.inputs)
			}
		})
	}
}

type sfuLivenessConfirmer struct {
	mediapublications.Registry
	inputs []mediapublications.RemoteTrackFailureInput
}

func (confirmer *sfuLivenessConfirmer) ConfirmRemoteTrackFailures(
	_ context.Context,
	input mediapublications.RemoteTrackFailureInput,
	_ mediapublications.PublisherSessionReader,
) (mediapublications.RemoteTrackFailureResult, error) {
	confirmer.inputs = append(confirmer.inputs, input)
	return mediapublications.RemoteTrackFailureResult{}, nil
}

type sfuLivenessTransport struct {
	mu              sync.Mutex
	trackName       string
	sessionID       string
	sessionTrack    string
	sessionReads    int
	addTracksStatus int
	addTracksBody   string
	addTracksErr    error
}

func (transport *sfuLivenessTransport) RoundTrip(request *http.Request) (*http.Response, error) {
	transport.mu.Lock()
	defer transport.mu.Unlock()

	var body string
	switch {
	case request.Method == http.MethodPost && strings.HasSuffix(request.URL.Path, "/sessions/listener-connection/tracks/new"):
		if transport.addTracksErr != nil {
			return nil, transport.addTracksErr
		}
		if transport.addTracksBody != "" {
			body = transport.addTracksBody
		} else {
			body = fmt.Sprintf(`{"tracks":[{"location":"remote","trackName":%q,"sessionId":%q,"errorCode":"unknown","errorDescription":"track not found"}]}`,
				transport.trackName, transport.sessionID)
		}
		statusCode := transport.addTracksStatus
		if statusCode == 0 {
			statusCode = http.StatusOK
		}
		return &http.Response{
			StatusCode: statusCode,
			Header:     http.Header{"Content-Type": []string{"application/json"}},
			Body:       io.NopCloser(strings.NewReader(body)),
			Request:    request,
		}, nil
	case request.Method == http.MethodGet && strings.HasSuffix(request.URL.Path, "/sessions/publisher-connection"):
		transport.sessionReads++
		tracks := "[]"
		if transport.sessionTrack != "" {
			tracks = "[" + transport.sessionTrack + "]"
		}
		body = fmt.Sprintf(`{"tracks":%s}`, tracks)
	default:
		return nil, fmt.Errorf("unexpected fake Cloudflare request: %s %s", request.Method, request.URL.Path)
	}

	return &http.Response{
		StatusCode: http.StatusOK,
		Header:     http.Header{"Content-Type": []string{"application/json"}},
		Body:       io.NopCloser(strings.NewReader(body)),
		Request:    request,
	}, nil
}

func (transport *sfuLivenessTransport) sessionReadCount() int {
	transport.mu.Lock()
	defer transport.mu.Unlock()
	return transport.sessionReads
}

type sfuLivenessRepository struct {
	participants []mediapublications.PublicationParticipant
	observations []provideroperations.Observation
}

func (repository *sfuLivenessRepository) AppendPublicationObservation(
	ctx context.Context,
	input provideroperations.ObservationInput,
	publisher mediapublications.PublicationParticipant,
) (provideroperations.Observation, error) {
	for _, participant := range repository.participants {
		if participant.ID == publisher.ID && participant.Generation == publisher.Generation &&
			participant.ConnectionID == publisher.ConnectionID {
			return repository.AppendObservation(ctx, input)
		}
	}
	return provideroperations.Observation{}, mediapublications.ErrInvalidPublication
}

func (repository *sfuLivenessRepository) AppendObservation(
	_ context.Context,
	input provideroperations.ObservationInput,
) (provideroperations.Observation, error) {
	observation := provideroperations.Observation{
		TenantID: input.TenantID, EpisodeID: input.EpisodeID, Incarnation: input.Incarnation,
		Sequence: input.Sequence, Publications: append([]provideroperations.Publication(nil), input.Publications...),
	}
	repository.observations = append(repository.observations, observation)
	return observation, nil
}

func (repository *sfuLivenessRepository) ListObservations(
	_ context.Context,
	_, _ utilities.ID,
	_ *provideroperations.Cursor,
	_ int,
) (provideroperations.ObservationPage, error) {
	return provideroperations.ObservationPage{Observations: repository.observations}, nil
}

func (repository *sfuLivenessRepository) ListPublicationParticipants(
	_ context.Context,
	_, _ utilities.ID,
) ([]mediapublications.PublicationParticipant, error) {
	return repository.participants, nil
}

func sfuLivenessTestID(t *testing.T, value string) utilities.ID {
	t.Helper()
	id, err := utilities.ParseID(value)
	if err != nil {
		t.Fatalf("parse test ID: %v", err)
	}
	return id
}
