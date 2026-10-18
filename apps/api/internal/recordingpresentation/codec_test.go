package recordingpresentation

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"testing"
)

func TestDecodeCanonicalRoundTrip(t *testing.T) {
	t.Parallel()

	input := fixture(t, "minimal-valid.json")
	timeline, err := Decode(input)
	if err != nil {
		t.Fatalf("decode valid fixture: %v", err)
	}
	encoded, err := Encode(timeline)
	if err != nil {
		t.Fatalf("encode valid fixture: %v", err)
	}
	decoded, err := Decode(encoded)
	if err != nil {
		t.Fatalf("decode canonical bytes: %v", err)
	}
	if decoded.Clock.DurationMillis != 5_000 || len(decoded.Events) != 2 {
		t.Fatalf("decoded timeline = %#v", decoded)
	}
}

func TestDecodeRejectsPrivateAndUnorderedEvents(t *testing.T) {
	t.Parallel()

	for _, name := range []string{"invalid-private-field.json", "invalid-event-order.json"} {
		name := name
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			_, err := Decode(fixture(t, name))
			if !errors.Is(err, ErrInvalidTimeline) {
				t.Fatalf("error = %v, want %v", err, ErrInvalidTimeline)
			}
		})
	}
}

func fixture(t *testing.T, name string) []byte {
	t.Helper()
	path := filepath.Join("..", "..", "..", "..", "contract", "schema", "fixtures", "recording-presentation-v1", name)
	contents, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read fixture: %v", err)
	}
	return contents
}

func TestRecordingAcceptsSharedCallReactionSet(t *testing.T) {
	t.Parallel()
	contents, err := os.ReadFile(filepath.Join("..", "..", "..", "..", "contract", "schema", "sync-v1.json"))
	if err != nil {
		t.Fatal(err)
	}
	var contract struct {
		Collaboration struct {
			Reactions []string `json:"reactions"`
		} `json:"collaboration"`
	}
	if err := json.Unmarshal(contents, &contract); err != nil {
		t.Fatal(err)
	}
	timeline, err := Decode(fixture(t, "minimal-valid.json"))
	if err != nil {
		t.Fatal(err)
	}
	for _, emoji := range contract.Collaboration.Reactions {
		timeline.Initial.Reactions = []Reaction{{ID: "reaction-1", ParticipantID: timeline.Initial.Participants[0].ID, DisplayName: "Sam", Value: emoji, OccurredAtMillis: 0, ExpiresAtMillis: 500}}
		if _, err := Encode(timeline); err != nil {
			t.Errorf("encode reaction %q: %v", emoji, err)
		}
	}
}
