package httpapi

import (
	"encoding/json"
	"testing"

	"github.com/q9labs/chalk/apps/api/internal/episodes"
	"github.com/q9labs/chalk/apps/api/internal/objectstorage"
	"github.com/q9labs/chalk/apps/api/internal/spaces"
	"github.com/q9labs/chalk/apps/api/internal/transcripts"
)

func TestResponseCollectionsEncodeEmptyArrays(t *testing.T) {
	for _, test := range []struct {
		name     string
		response any
		field    string
	}{
		{"transcript artifact", newTranscriptArtifactResponse(transcripts.Transcript{}), "languages"},
		{"participant", newParticipantResponse(episodes.Participant{}), "capabilities"},
	} {
		t.Run(test.name, func(t *testing.T) {
			encoded, err := json.Marshal(test.response)
			if err != nil {
				t.Fatal(err)
			}
			var fields map[string]json.RawMessage
			if err := json.Unmarshal(encoded, &fields); err != nil {
				t.Fatal(err)
			}
			if string(fields[test.field]) != "[]" {
				t.Fatalf("%s=%s, want []", test.field, fields[test.field])
			}
		})
	}
	response := newSpaceResponse(spaces.Space{Roles: []spaces.Role{{Name: "observer"}}})
	if len(response.Roles) != 1 || response.Roles[0].Capabilities == nil {
		t.Fatal("Space role capabilities must be an array")
	}
}

func TestSignedHeadersEncodeStringArrays(t *testing.T) {
	response := cloneSignedHeaders(objectstorage.SignedURL{SignedHeader: map[string][]string{"X-Empty": nil, "Content-Type": {"video/mp4"}}})
	encoded, err := json.Marshal(response)
	if err != nil {
		t.Fatal(err)
	}
	if string(encoded) != `{"Content-Type":["video/mp4"],"X-Empty":[]}` {
		t.Fatalf("headers=%s", encoded)
	}
}
