package providerbridge

import (
	"github.com/q9labs/chalk/apps/api/internal/provideroperations"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
	"testing"
)

func TestScreenRevocationIncludesAudioButNotMicrophone(t *testing.T) {
	participantID, err := utilities.ParseID("33333333-3333-4333-8333-333333333333")
	if err != nil {
		t.Fatal(err)
	}
	input := provideroperations.OperationInput{Effect: provideroperations.EffectRevokePublication, ParticipantID: participantID, PublicationSource: "screen"}
	for _, source := range []string{"screen", "screen_audio", "microphone", "camera"} {
		got := publicationMatchesOperation(provideroperations.Publication{ParticipantID: participantID, Source: source}, input)
		want := source == "screen" || source == "screen_audio"
		if got != want {
			t.Fatalf("source %s targeted=%t, want %t", source, got, want)
		}
	}
}
