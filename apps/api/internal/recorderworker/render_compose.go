package recorderworker

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"syscall"
	"time"
)

const composeResultVersion = "recording-compose-result.v1"

type ComposeResult struct {
	SchemaVersion      string `json:"schema_version"`
	RecordingID        string `json:"recording_id"`
	EpisodeID          string `json:"episode_id"`
	PresentationSHA256 string `json:"presentation_sha256"`
	DecodedMediaSHA256 string `json:"decoded_media_sha256"`
	Width              int    `json:"width"`
	Height             int    `json:"height"`
	FPS                int    `json:"fps"`
	FrameCount         int64  `json:"frame_count"`
	OverlayCount       int64  `json:"overlay_count"`
	SegmentCount       int64  `json:"segment_count"`
	PlanWallMs         int64  `json:"plan_wall_ms"`
	PaintWallMs        int64  `json:"paint_wall_ms"`
	CompositeWallMs    int64  `json:"composite_wall_ms"`
	MuxWallMs          int64  `json:"mux_wall_ms"`
	WallDurationMs     int64  `json:"wall_duration_ms"`
}

func (result ComposeResult) Validate(request FrameRenderRequest) error {
	frames := (request.DurationMs*int64(request.FPS) + 999) / 1000
	if result.SchemaVersion != composeResultVersion || result.RecordingID != request.RecordingID || result.EpisodeID != request.EpisodeID ||
		result.PresentationSHA256 != request.PresentationSHA256 || result.DecodedMediaSHA256 != request.DecodedMediaSHA256 ||
		result.Width != request.Width || result.Height != request.Height || result.FPS != request.FPS || result.FrameCount != frames {
		return errors.New("recording compose result does not match its request")
	}
	return nil
}

type ComposeProducer interface {
	Compose(context.Context, FrameRenderRequest, string) (ComposeResult, error)
}

type NodeComposeProducer struct {
	NodePath   string
	ScriptPath string
	FFmpegPath string
	Encoder    VideoEncoder
	Threads    int
}

func (producer NodeComposeProducer) Compose(ctx context.Context, request FrameRenderRequest, output string) (ComposeResult, error) {
	if err := request.Validate(); err != nil {
		return ComposeResult{}, err
	}
	if !filepath.IsAbs(producer.NodePath) || !filepath.IsAbs(producer.ScriptPath) || !filepath.IsAbs(producer.FFmpegPath) {
		return ComposeResult{}, errors.New("recording compose executable paths must be absolute")
	}
	if producer.Encoder != EncoderLibX264 && producer.Encoder != EncoderVideoToolbox {
		return ComposeResult{}, errors.New("recording compose encoder must be libx264 or h264_videotoolbox")
	}
	if producer.Threads < 1 || producer.Threads > 64 {
		return ComposeResult{}, errors.New("recording compose threads must be between 1 and 64")
	}
	if !filepath.IsAbs(output) || !pathWithin(request.WorkspaceDirectory, output) || output == request.WorkspaceDirectory {
		return ComposeResult{}, errors.New("recording compose output must be inside the workspace")
	}
	if _, err := os.Lstat(output); err == nil {
		return ComposeResult{}, errors.New("recording compose output already exists")
	} else if !errors.Is(err, os.ErrNotExist) {
		return ComposeResult{}, fmt.Errorf("inspect recording compose output: %w", err)
	}
	validOutput := false
	defer func() {
		if !validOutput {
			_ = os.Remove(output)
		}
	}()

	requestFile, err := os.CreateTemp(request.WorkspaceDirectory, "compose-request-*.json")
	if err != nil {
		return ComposeResult{}, fmt.Errorf("create recording compose request: %w", err)
	}
	requestPath := requestFile.Name()
	defer os.Remove(requestPath)
	encoder := json.NewEncoder(requestFile)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(request); err != nil {
		_ = requestFile.Close()
		return ComposeResult{}, fmt.Errorf("write recording compose request: %w", err)
	}
	if err := requestFile.Close(); err != nil {
		return ComposeResult{}, fmt.Errorf("close recording compose request: %w", err)
	}
	resultFile, err := os.CreateTemp(request.WorkspaceDirectory, "compose-result-*.json")
	if err != nil {
		return ComposeResult{}, fmt.Errorf("create recording compose result path: %w", err)
	}
	resultPath := resultFile.Name()
	defer os.Remove(resultPath)
	if err := resultFile.Close(); err != nil {
		return ComposeResult{}, fmt.Errorf("close recording compose result path: %w", err)
	}
	if err := os.Remove(resultPath); err != nil {
		return ComposeResult{}, fmt.Errorf("prepare recording compose result path: %w", err)
	}

	args := []string{producer.ScriptPath, "--request", requestPath, "--result", resultPath, "--output", output,
		"--ffmpeg", producer.FFmpegPath, "--encoder", string(producer.Encoder), "--threads", strconv.Itoa(producer.Threads)}
	command := exec.CommandContext(ctx, producer.NodePath, args...)
	command.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	command.WaitDelay = 3 * time.Second
	stderr := &boundedCommandOutput{maximum: maximumFrameStderrBytes}
	command.Stderr = stderr
	command.Cancel = func() error {
		pid := command.Process.Pid
		// Signal the whole group, including FFmpeg children. Escalate if any ignore SIGTERM.
		time.AfterFunc(2*time.Second, func() { _ = syscall.Kill(-pid, syscall.SIGKILL) })
		return syscall.Kill(-pid, syscall.SIGTERM)
	}
	if err := command.Run(); err != nil {
		return ComposeResult{}, fmt.Errorf("recording compositor: %w: %s", err, stderr.String())
	}
	file, err := os.Open(resultPath)
	if err != nil {
		return ComposeResult{}, fmt.Errorf("open recording compose result: %w", err)
	}
	defer file.Close()
	decoder := json.NewDecoder(io.LimitReader(file, maximumFrameResultBytes+1))
	decoder.DisallowUnknownFields()
	var result ComposeResult
	if err := decoder.Decode(&result); err != nil {
		return ComposeResult{}, fmt.Errorf("decode recording compose result: %w", err)
	}
	var trailing json.RawMessage
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		return ComposeResult{}, errors.New("recording compose result contains trailing JSON or exceeds its size bound")
	}
	if info, err := file.Stat(); err != nil || info.Size() > maximumFrameResultBytes {
		return ComposeResult{}, errors.New("recording compose result exceeds its size bound")
	}
	if err := result.Validate(request); err != nil {
		return ComposeResult{}, err
	}
	validOutput = true
	return result, nil
}
