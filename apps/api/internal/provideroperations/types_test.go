package provideroperations

import (
	"errors"
	"testing"

	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

func TestCanonicalizeObservationAllowsPausedPublicationIdentity(t *testing.T) {
	tenantID := observationID(t, "11111111-1111-4111-8111-111111111111")
	episodeID := observationID(t, "22222222-2222-4222-8222-222222222222")
	participantID := observationID(t, "33333333-3333-4333-8333-333333333333")
	input := ObservationInput{TenantID: tenantID, EpisodeID: episodeID, Incarnation: 1, Sequence: 2, Publications: []Publication{{ParticipantID: participantID, Source: "microphone", Enabled: false, PublicationID: "publisher-connection|microphone-track"}}}
	canonical, _, _, err := CanonicalizeObservation(input)
	if err != nil || canonical.Publications[0].PublicationID != input.Publications[0].PublicationID {
		t.Fatalf("paused publication was rejected or changed: observation=%+v error=%v", canonical, err)
	}
	input.Publications[0].Enabled = true
	input.Publications[0].PublicationID = ""
	if _, _, _, err := CanonicalizeObservation(input); !errors.Is(err, ErrInvalidPublicationID) {
		t.Fatalf("enabled publication without identity error = %v, want %v", err, ErrInvalidPublicationID)
	}
}

func observationID(t *testing.T, raw string) utilities.ID {
	t.Helper()
	id, err := utilities.ParseID(raw)
	if err != nil {
		t.Fatalf("parse ID: %v", err)
	}
	return id
}
