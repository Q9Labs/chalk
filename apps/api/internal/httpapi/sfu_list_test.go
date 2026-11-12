package httpapi

import (
	"context"
	"testing"

	"github.com/q9labs/chalk/apps/api/internal/mediapublications"
	"github.com/q9labs/chalk/apps/api/internal/provideroperations"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

type latestRegistry struct {
	mediapublications.Registry
	snapshot mediapublications.Snapshot
}

func (r latestRegistry) Latest(context.Context, utilities.ID, utilities.ID) (mediapublications.Snapshot, error) {
	return r.snapshot, nil
}

func TestTheListKeepsAMicrophoneMutedInPlaceAndMarksItPaused(t *testing.T) {
	ids := make([]utilities.ID, 4)
	for index := range ids {
		id, err := utilities.NewID()
		if err != nil {
			t.Fatal(err)
		}
		ids[index] = id
	}
	registry := latestRegistry{snapshot: mediapublications.Snapshot{
		Publications: []provideroperations.Publication{
			{ParticipantID: ids[2], Source: "microphone", Enabled: true, PublicationID: "mic-live"},
			{ParticipantID: ids[3], Source: "microphone", Enabled: false, PublicationID: "mic-held"},
			{ParticipantID: ids[3], Source: "camera", Enabled: false, PublicationID: "camera-held"},
			{ParticipantID: ids[2], Source: "camera", Enabled: false, PublicationID: "camera-retired"},
			{ParticipantID: ids[2], Source: "screen", Enabled: false, PublicationID: ""},
		},
		Held: map[string]struct{}{"mic-held": {}, "camera-held": {}},
	}}
	list, err := listPublications(context.Background(), registry, ids[0], ids[1])
	if err != nil {
		t.Fatal(err)
	}
	got := map[string]bool{}
	for _, publication := range list.Publications {
		got[publication.PublicationID] = publication.Paused
	}
	want := map[string]bool{"mic-live": false, "mic-held": true}
	if len(got) != len(want) || got["mic-live"] != false || got["mic-held"] != true {
		t.Fatalf("listed %v, want %v (a muted camera, a retired publication and a closed one stay off the list)", got, want)
	}
}
