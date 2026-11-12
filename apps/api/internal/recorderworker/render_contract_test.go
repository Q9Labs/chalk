package recorderworker

import (
	"encoding/json"
	"os"
	"strings"
	"testing"

	"github.com/q9labs/chalk/apps/api/internal/recordingdecode"
)

// renderContract is contract/schema/recording-render-v1.json: the facts the
// Node renderer's generated constants take from one file.
type renderContract struct {
	FrameRenderRequest struct {
		Version       string `json:"version"`
		MaxWidth      int    `json:"maxWidth"`
		MaxHeight     int    `json:"maxHeight"`
		MaxFPS        int    `json:"maxFps"`
		MaxDurationMs int64  `json:"maxDurationMs"`
	} `json:"frameRenderRequest"`
	ComposeResult struct {
		Version string `json:"version"`
	} `json:"composeResult"`
	VideoEncoders []string `json:"videoEncoders"`
	DecodedMedia  struct {
		Version string `json:"version"`
	} `json:"decodedMedia"`
	FrameCounts []struct {
		DurationMs int64 `json:"durationMs"`
		FPS        int   `json:"fps"`
		Frames     int64 `json:"frames"`
	} `json:"frameCounts"`
}

func loadRenderContract(t *testing.T) renderContract {
	t.Helper()
	body, err := os.ReadFile("../../../../contract/schema/recording-render-v1.json")
	if err != nil {
		t.Fatal(err)
	}
	var contract renderContract
	if err := json.Unmarshal(body, &contract); err != nil {
		t.Fatal(err)
	}
	return contract
}

func TestRenderRequestMatchesTheSharedContract(t *testing.T) {
	contract := loadRenderContract(t).FrameRenderRequest
	if FrameRenderRequestVersion != contract.Version {
		t.Fatalf("request version %q, contract %q", FrameRenderRequestVersion, contract.Version)
	}
	valid := func(mutate func(*FrameRenderRequest)) error {
		request := FrameRenderRequest{
			SchemaVersion: FrameRenderRequestVersion, RecordingID: "recording", EpisodeID: "episode",
			WorkspaceDirectory: "/work", PresentationPath: "/work/presentation.json", AssetDirectory: "/work/assets", DecodedMediaPath: "/work/decoded",
			PresentationSHA256: strings.Repeat("a", 64), DecodedMediaSHA256: strings.Repeat("b", 64),
			Width: 640, Height: 360, FPS: 30, DurationMs: 1000,
		}
		mutate(&request)
		return request.Validate()
	}
	for name, test := range map[string]struct {
		mutate func(*FrameRenderRequest)
		ok     bool
	}{
		"widest width":       {func(r *FrameRenderRequest) { r.Width = contract.MaxWidth }, true},
		"past widest width":  {func(r *FrameRenderRequest) { r.Width = contract.MaxWidth + 2 }, false},
		"tallest height":     {func(r *FrameRenderRequest) { r.Height = contract.MaxHeight }, true},
		"past tallest":       {func(r *FrameRenderRequest) { r.Height = contract.MaxHeight + 2 }, false},
		"fastest frame rate": {func(r *FrameRenderRequest) { r.FPS = contract.MaxFPS }, true},
		"past fastest":       {func(r *FrameRenderRequest) { r.FPS = contract.MaxFPS + 1 }, false},
		"longest duration":   {func(r *FrameRenderRequest) { r.DurationMs = contract.MaxDurationMs }, true},
		"past longest":       {func(r *FrameRenderRequest) { r.DurationMs = contract.MaxDurationMs + 1 }, false},
	} {
		if err := valid(test.mutate); (err == nil) != test.ok {
			t.Errorf("%s: Validate() = %v, want ok=%v", name, err, test.ok)
		}
	}
}

func TestComposeContractMatchesTheSharedContract(t *testing.T) {
	contract := loadRenderContract(t)
	if composeResultVersion != contract.ComposeResult.Version {
		t.Fatalf("compose result version %q, contract %q", composeResultVersion, contract.ComposeResult.Version)
	}
	if recordingdecode.SchemaVersion != contract.DecodedMedia.Version {
		t.Fatalf("decoded media version %q, contract %q", recordingdecode.SchemaVersion, contract.DecodedMedia.Version)
	}
	encoders := []string{string(EncoderLibX264), string(EncoderVideoToolbox), string(EncoderNVENC)}
	if strings.Join(encoders, ",") != strings.Join(contract.VideoEncoders, ",") {
		t.Fatalf("encoders %v, contract %v", encoders, contract.VideoEncoders)
	}
	for _, count := range contract.FrameCounts {
		request := FrameRenderRequest{SchemaVersion: FrameRenderRequestVersion, RecordingID: "recording", EpisodeID: "episode", FPS: count.FPS, DurationMs: count.DurationMs}
		result := ComposeResult{SchemaVersion: composeResultVersion, RecordingID: "recording", EpisodeID: "episode", FPS: count.FPS, FrameCount: count.Frames}
		if err := result.Validate(request); err != nil {
			t.Errorf("%d ms at %d fps should be %d frames: %v", count.DurationMs, count.FPS, count.Frames, err)
		}
		result.FrameCount++
		if err := result.Validate(request); err == nil {
			t.Errorf("%d ms at %d fps accepted %d frames", count.DurationMs, count.FPS, result.FrameCount)
		}
	}
}
