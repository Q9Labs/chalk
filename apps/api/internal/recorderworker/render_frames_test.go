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

func TestFrameRenderResultBindsIdentityAndFrameClock(t *testing.T) {
	request := frameRequestForTest(t.TempDir())
	result := FrameRenderResult{
		SchemaVersion: FrameRenderResultVersion, RecordingID: request.RecordingID, EpisodeID: request.EpisodeID,
		PresentationSHA256: request.PresentationSHA256, UIBuildSHA256: request.UIBuildSHA256, DecodedMediaSHA256: request.DecodedMediaSHA256,
		Width: request.Width, Height: request.Height, FPS: request.FPS,
		FrameCount: 31, FirstElapsedMs: 0, LastElapsedMs: 1_000,
		StartupWallMs: 1, PreparationWallMs: 2, CaptureWallMs: 3, OutputWallMs: 1, InspectionWallMs: 1, WallDurationMs: 10,
	}
	if err := result.Validate(request); err != nil {
		t.Fatalf("validate frame result: %v", err)
	}
	result.LastElapsedMs = 999
	if err := result.Validate(request); err == nil {
		t.Fatal("frame clock drift was accepted")
	}
	result.LastElapsedMs = 1_000
	result.CaptureWallMs = result.WallDurationMs
	if err := result.Validate(request); err == nil {
		t.Fatal("impossible frame timing breakdown was accepted")
	}
}

func frameRequestForTest(workspace string) FrameRenderRequest {
	return FrameRenderRequest{
		SchemaVersion: FrameRenderRequestVersion, RecordingID: "recording-1", EpisodeID: "episode-1",
		WorkspaceDirectory: workspace,
		PresentationPath:   filepath.Join(workspace, "recording-presentation.json"), PresentationSHA256: strings.Repeat("a", 64),
		UIBuildSHA256:    strings.Repeat("c", 64),
		AssetDirectory:   filepath.Join(workspace, "assets"),
		DecodedMediaPath: filepath.Join(workspace, "decoded-media.json"), DecodedMediaSHA256: strings.Repeat("b", 64),
		Width: 1280, Height: 720, FPS: 30, DurationMs: 1_001,
	}
}
