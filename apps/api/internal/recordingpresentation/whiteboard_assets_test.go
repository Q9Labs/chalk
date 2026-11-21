package recordingpresentation

import (
	"encoding/json"
	"fmt"
	"testing"
	"time"
)

func TestRecordingWhiteboardAssetsDoNotConflictAcrossScenes(t *testing.T) {
	origin := time.Now()
	source := CompletionSource{
		CaptureReadyAt: origin, DurationMillis: 1000,
		WhiteboardTailEvents: []WhiteboardEventFact{
			{Name: "clear", OperationID: "clear", SceneID: "second", CompletedAt: origin.Add(time.Millisecond)},
			{Name: "submit_update", OperationID: "replace", SceneID: "second", Revision: 1, CompletedAt: origin.Add(2 * time.Millisecond),
				Elements: []json.RawMessage{json.RawMessage(`{"id":"image","type":"image","version":1,"index":"a0","payload":{"fileId":"frame"}}`)}},
		},
	}
	files := map[string]ObjectFact{
		"first:frame":  {Key: "original", SHA256: make([]byte, 32)},
		"second:frame": {Key: "replacement", SHA256: make([]byte, 32)},
	}
	initial := whiteboardState{
		SceneID: "first", Presenting: true, AppState: json.RawMessage("{}"),
		Elements: map[string]whiteboardElementWire{
			"image": {ID: "image", Type: "image", Version: 1, Index: "a0", Payload: json.RawMessage(`{"fileId":"frame"}`)},
		},
	}
	var materials []assetMaterial
	byID := make(map[string]int)
	if _, err := addWhiteboardStateAsset(initial, source, files, &materials, byID); err != nil {
		t.Fatal(err)
	}
	if _, err := scheduleWhiteboardTail(source, &initial, files, &materials, byID, func(int64, int, Event) {}); err != nil {
		t.Fatal(err)
	}
	for _, scene := range []string{"first", "second"} {
		fileID := scene + ":frame"
		if index, ok := byID["whiteboard_file:"+fileID]; !ok || materials[index].Existing.Key != files[fileID].Key {
			t.Fatalf("missing scoped file asset for %s", scene)
		}
		// For the second scene, clear creates the initial state and the image
		// is written into its next revision in the same history.
		found := false
		for _, asset := range materials {
			if asset.Asset.Kind != "whiteboard_state" {
				continue
			}
			var history whiteboardHistoryWire
			if err := json.Unmarshal(asset.Body, &history); err != nil {
				t.Fatal(err)
			}
			if history.SchemaVersion == whiteboardStateSchemaVersion {
				if err := json.Unmarshal(asset.Body, &history.Initial); err != nil {
					t.Fatal(err)
				}
			}
			if history.Initial.SceneID != scene {
				continue
			}
			elements := history.Initial.Elements
			for _, update := range history.Updates {
				elements = append(elements, update.Elements...)
			}
			for _, element := range elements {
				var payload struct {
					FileID string `json:"fileId"`
				}
				if err := json.Unmarshal(element.Payload, &payload); err != nil {
					t.Fatal(err)
				}
				found = found || payload.FileID == fileID
			}
		}
		if !found {
			t.Fatalf("missing scene-scoped file reference for %s", scene)
		}
	}
}

func TestRecordingWhiteboardDoesNotExportUnplacedFiles(t *testing.T) {
	files := make(map[string]ObjectFact)
	for i := 0; i < 257; i++ {
		files[fmt.Sprintf("scene:unused-%d", i)] = ObjectFact{Key: "upload", SHA256: make([]byte, 32)}
	}
	var materials []assetMaterial
	_, err := addWhiteboardStateAsset(whiteboardState{
		SceneID: "scene", Presenting: true, AppState: json.RawMessage("{}"),
	}, CompletionSource{}, files, &materials, make(map[string]int))
	if err != nil || len(materials) != 1 || materials[0].Asset.Kind != "whiteboard_state" {
		t.Fatalf("unplaced files must not consume the recording budget: %d assets, %v", len(materials), err)
	}
}
