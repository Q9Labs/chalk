package recordingpresentation

import (
	"encoding/json"
	"testing"
	"time"
)

func TestScreenAnnotationAssetBindsCapturedEpochAndCut(t *testing.T) {
	const origin int64 = 100_000
	initialMark := annotationMark{Draft: json.RawMessage(`{}`), Author: json.RawMessage(`{}`), CreatedRevision: 1, CommittedAtMS: origin - 500}
	fact := ScreenAnnotationFact{
		CaptureEpoch: 2, PublicationID: "screen", SharerGeneration: 3,
		Layer:       annotationLayer{ID: "layer", PublicationID: "screen", SharerID: "sharer"},
		InitialAtMS: origin - 200, InitialRevision: 1, InitialMarks: []annotationMark{initialMark},
		ClosedAtMS: origin + 3000,
		Changes: []annotationRevision{
			{AtMS: origin + 1000, Revision: 2, Change: json.RawMessage(`{"kind":"control","paused":true}`)},
			{AtMS: origin + 3000, Revision: 3, Change: json.RawMessage(`{"kind":"clear","participant_id":null}`)},
		},
	}
	oldEpoch := fact
	oldEpoch.CaptureEpoch = 1
	wrongGeneration := fact
	wrongGeneration.SharerGeneration = 4
	source := CompletionSource{CaptureEpoch: 2, CaptureReadyAt: time.UnixMilli(origin), DurationMillis: 4000,
		ScreenAnnotation: []ScreenAnnotationFact{oldEpoch, fact, wrongGeneration}}
	sources := annotationSources{{2, "screen", "sharer", 3}: {"recording-source": {}}}
	var materials []assetMaterial
	if err := addScreenAnnotationAsset(source, sources, &materials, make(map[string]int)); err != nil {
		t.Fatal(err)
	}
	if len(materials) != 1 || materials[0].Asset.Kind != ScreenAnnotationAssetKind {
		t.Fatalf("expected one private annotation asset, got %d", len(materials))
	}
	var sidecar struct {
		Layers []boundAnnotation `json:"layers"`
	}
	if err := json.Unmarshal(materials[0].Body, &sidecar); err != nil {
		t.Fatal(err)
	}
	if len(sidecar.Layers) != 1 || len(sidecar.Layers[0].SourceIDs) != 1 || sidecar.Layers[0].SourceIDs[0] != "recording-source" {
		t.Fatal("annotation bound to an unobserved epoch or participant generation")
	}
	layer := sidecar.Layers[0].Sidecar
	if layer.Initial.AtMS != 0 || layer.Initial.Marks[0].CommittedAtMS != -500 || layer.ClosedAtMS != 3000 {
		t.Fatal("checkpoint, mark, or cut is not on the recording clock")
	}
	if len(layer.Changes) != 1 || layer.Changes[0].Revision != 2 || layer.Changes[0].AtMS != 1000 {
		t.Fatal("change at the capture cut was included")
	}
}
