package httpapi

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync"
	"testing"

	"github.com/q9labs/chalk/apps/api/internal/mediapublications"
	"github.com/q9labs/chalk/apps/api/internal/provideroperations"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

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
			body = fmt.Sprintf(`{"tracks":[{"location":"remote","trackName":%q,"sessionId":%q,"errorCode":"not_found_track_error"}]}`,
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
