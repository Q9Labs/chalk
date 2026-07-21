package mediapublications

import (
	"errors"
	"testing"
)

func TestParseReferenceRoundTripsVersionOneFields(t *testing.T) {
	publicationID := encodeReference("connection-123", "mid-456", "camera-track", 9)

	reference, err := ParseReference(publicationID)
	if err != nil {
		t.Fatalf("parse reference: %v", err)
	}
	want := Reference{Version: 1, ConnectionID: "connection-123", MID: "mid-456", TrackName: "camera-track", ParticipantGeneration: 9, HasMID: true, HasParticipantGeneration: true}
	if reference != want {
		t.Fatalf("reference = %#v, want %#v", reference, want)
	}
}

func TestParseReferenceIdentifiesLegacyReferenceWithoutMID(t *testing.T) {
	reference, err := ParseReference("connection-123|camera-track")
	if err != nil {
		t.Fatalf("parse legacy reference: %v", err)
	}
	want := Reference{Version: 0, ConnectionID: "connection-123", TrackName: "camera-track", HasMID: false, HasParticipantGeneration: false}
	if reference != want {
		t.Fatalf("reference = %#v, want %#v", reference, want)
	}
}

func TestParseReferenceRejectsMalformedOrNonCanonicalReferences(t *testing.T) {
	for _, publicationID := range []string{
		"connection-only",
		"connection|track|ambiguous",
		"chalk_pub_v1.invalid!",
		"chalk_pub_v2.payload|track",
		publicationReferencePrefix + "e30",
		" connection|track",
		"connection |track",
	} {
		t.Run(publicationID, func(t *testing.T) {
			if _, err := ParseReference(publicationID); !errors.Is(err, ErrInvalidPublication) {
				t.Fatalf("error = %v, want invalid publication", err)
			}
		})
	}
}
