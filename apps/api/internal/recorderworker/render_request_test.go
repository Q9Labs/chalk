package recorderworker

import (
	"path/filepath"
	"strings"
	"testing"
)

func TestFrameRenderRequestKeepsInputsInsideAttemptWorkspace(t *testing.T) {
	workspace := t.TempDir()
	request := frameRequestForTest(workspace)
	if err := request.Validate(); err != nil {
		t.Fatalf("validate bounded frame request: %v", err)
	}

	request.DecodedMediaPath = filepath.Join(workspace, "..", "other", "decoded-media.json")
	if err := request.Validate(); err == nil || !strings.Contains(err.Error(), "inside") {
		t.Fatalf("escaped media path error = %v", err)
	}
}

func frameRequestForTest(workspace string) FrameRenderRequest {
	return FrameRenderRequest{
		SchemaVersion: FrameRenderRequestVersion, RecordingID: "recording-1", EpisodeID: "episode-1",
		WorkspaceDirectory: workspace,
		PresentationPath:   filepath.Join(workspace, "recording-presentation.json"), PresentationSHA256: strings.Repeat("a", 64),
		AssetDirectory:   filepath.Join(workspace, "assets"),
		DecodedMediaPath: filepath.Join(workspace, "decoded-media.json"), DecodedMediaSHA256: strings.Repeat("b", 64),
		Width: 1280, Height: 720, FPS: 30, DurationMs: 1_001,
	}
}
