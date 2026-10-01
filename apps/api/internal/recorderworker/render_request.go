package recorderworker

import (
	"errors"
	"path/filepath"
	"strings"

	"github.com/q9labs/chalk/apps/api/internal/recordingpipeline"
)

const (
	FrameRenderRequestVersion = "recording-frame-render-request.v1"
	maximumFrameResultBytes   = 64 << 10
	maximumFrameStderrBytes   = 64 << 10
)

type FrameRenderRequest struct {
	SchemaVersion      string `json:"schema_version"`
	RecordingID        string `json:"recording_id"`
	EpisodeID          string `json:"episode_id"`
	WorkspaceDirectory string `json:"workspace_directory"`
	PresentationPath   string `json:"presentation_path"`
	PresentationSHA256 string `json:"presentation_sha256"`
	AssetDirectory     string `json:"asset_directory"`
	DecodedMediaPath   string `json:"decoded_media_path"`
	DecodedMediaSHA256 string `json:"decoded_media_sha256"`
	Width              int    `json:"width"`
	Height             int    `json:"height"`
	FPS                int    `json:"fps"`
	DurationMs         int64  `json:"duration_ms"`
}

func (request FrameRenderRequest) Validate() error {
	if request.SchemaVersion != FrameRenderRequestVersion || request.RecordingID == "" || request.EpisodeID == "" {
		return errors.New("frame render request identity is incomplete")
	}
	if request.Width <= 0 || request.Height <= 0 || request.Width%2 != 0 || request.Height%2 != 0 || request.Width > 3840 || request.Height > 2160 || request.FPS <= 0 || request.FPS > 60 || request.DurationMs <= 0 || request.DurationMs > recordingpipeline.MaximumRecordingDuration.Milliseconds() {
		return errors.New("frame render request dimensions, frame rate, or duration are invalid")
	}
	if !isLowerSHA256(request.PresentationSHA256) || !isLowerSHA256(request.DecodedMediaSHA256) {
		return errors.New("frame render request checksums must be lowercase SHA-256 values")
	}
	for _, path := range []string{request.WorkspaceDirectory, request.PresentationPath, request.AssetDirectory, request.DecodedMediaPath} {
		if !filepath.IsAbs(path) {
			return errors.New("frame render request paths must be absolute")
		}
	}
	if !pathWithin(request.WorkspaceDirectory, request.PresentationPath) || !pathWithin(request.WorkspaceDirectory, request.AssetDirectory) || !pathWithin(request.WorkspaceDirectory, request.DecodedMediaPath) {
		return errors.New("frame render inputs must stay inside the attempt workspace")
	}
	return nil
}

type boundedCommandOutput struct {
	bytes   []byte
	maximum int
	cut     bool
}

func (output *boundedCommandOutput) Write(value []byte) (int, error) {
	written := len(value)
	remaining := output.maximum - len(output.bytes)
	if remaining > 0 {
		if len(value) < remaining {
			remaining = len(value)
		}
		output.bytes = append(output.bytes, value[:remaining]...)
	}
	if remaining < len(value) {
		output.cut = true
	}
	return written, nil
}

func (output *boundedCommandOutput) String() string {
	value := strings.TrimSpace(string(output.bytes))
	if output.cut {
		return value + " [truncated]"
	}
	return value
}

func pathWithin(root, candidate string) bool {
	relative, err := filepath.Rel(filepath.Clean(root), filepath.Clean(candidate))
	return err == nil && relative != ".." && !strings.HasPrefix(relative, ".."+string(filepath.Separator))
}

func isLowerSHA256(value string) bool {
	if len(value) != 64 {
		return false
	}
	for _, character := range value {
		if character < '0' || character > '9' {
			if character < 'a' || character > 'f' {
				return false
			}
		}
	}
	return true
}
