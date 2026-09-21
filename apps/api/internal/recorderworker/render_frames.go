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
	"strings"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/recordingpipeline"
)

const (
	FrameRenderRequestVersion = "recording-frame-render-request.v1"
	FrameRenderResultVersion  = "recording-frame-render-result.v1"
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
	UIBuildSHA256      string `json:"ui_build_sha256"`
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
	if !isLowerSHA256(request.PresentationSHA256) || !isLowerSHA256(request.UIBuildSHA256) || !isLowerSHA256(request.DecodedMediaSHA256) {
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

type FrameRenderResult struct {
	SchemaVersion      string `json:"schema_version"`
	RecordingID        string `json:"recording_id"`
	EpisodeID          string `json:"episode_id"`
	PresentationSHA256 string `json:"presentation_sha256"`
	UIBuildSHA256      string `json:"ui_build_sha256"`
	DecodedMediaSHA256 string `json:"decoded_media_sha256"`
	Width              int    `json:"width"`
	Height             int    `json:"height"`
	FPS                int    `json:"fps"`
	FrameCount         int64  `json:"frame_count"`
	FirstElapsedMs     int64  `json:"first_elapsed_ms"`
	LastElapsedMs      int64  `json:"last_elapsed_ms"`
	StartupWallMs      int64  `json:"startup_wall_ms"`
	PreparationWallMs  int64  `json:"frame_preparation_wall_ms"`
	CaptureWallMs      int64  `json:"frame_capture_wall_ms"`
	OutputWallMs       int64  `json:"output_wall_ms"`
	InspectionWallMs   int64  `json:"inspection_wall_ms"`
	WallDurationMs     int64  `json:"wall_duration_ms"`
}

func (result FrameRenderResult) Validate(request FrameRenderRequest) error {
	expectedFrames := (request.DurationMs*int64(request.FPS) + 999) / 1000
	expectedLast := (expectedFrames - 1) * 1000 / int64(request.FPS)
	if result.SchemaVersion != FrameRenderResultVersion || result.RecordingID != request.RecordingID || result.EpisodeID != request.EpisodeID || result.PresentationSHA256 != request.PresentationSHA256 || result.UIBuildSHA256 != request.UIBuildSHA256 || result.DecodedMediaSHA256 != request.DecodedMediaSHA256 {
		return errors.New("frame render result identity does not match its request")
	}
	if result.Width != request.Width || result.Height != request.Height || result.FPS != request.FPS || result.FrameCount != expectedFrames || result.FirstElapsedMs != 0 || result.LastElapsedMs != expectedLast ||
		!frameTimingsFit(result) {
		return errors.New("frame render result timing does not match its request")
	}
	return nil
}

func frameTimingsFit(result FrameRenderResult) bool {
	if result.WallDurationMs < 0 {
		return false
	}
	total := int64(0)
	for _, duration := range []int64{result.StartupWallMs, result.PreparationWallMs, result.CaptureWallMs, result.OutputWallMs, result.InspectionWallMs} {
		if duration < 0 || duration > result.WallDurationMs-total {
			return false
		}
		total += duration
	}
	return true
}

type FrameProcess interface {
	Frames() io.Reader
	Wait() (FrameRenderResult, error)
	Cancel()
}

type FrameProducer interface {
	Start(context.Context, FrameRenderRequest) (FrameProcess, error)
}

type FrameEncodeResult struct {
	Frames         FrameRenderResult
	EncodeDuration time.Duration
	TotalDuration  time.Duration
}

func RenderFrameStream(ctx context.Context, producer FrameProducer, encoder StreamingCommandRunner, request FrameRenderRequest, plan RecordingEncodePlan) (FrameEncodeResult, error) {
	if producer == nil || encoder == nil {
		return FrameEncodeResult{}, errors.New("frame producer and recording encoder are required")
	}
	if err := request.Validate(); err != nil {
		return FrameEncodeResult{}, err
	}
	if plan.Width != request.Width || plan.Height != request.Height || plan.FPS != request.FPS || plan.SourceDuration != request.DurationMs {
		return FrameEncodeResult{}, errors.New("frame request and recording encode plan do not match")
	}
	started := time.Now()
	process, err := producer.Start(ctx, request)
	if err != nil {
		return FrameEncodeResult{}, fmt.Errorf("start recording frame stream: %w", err)
	}
	encodeDuration, encodeErr := EncodeRecordingFrames(ctx, encoder, plan, process.Frames())
	if encodeErr != nil {
		process.Cancel()
	}
	frameResult, frameErr := process.Wait()
	result := FrameEncodeResult{Frames: frameResult, EncodeDuration: encodeDuration, TotalDuration: time.Since(started)}
	if err := errors.Join(encodeErr, frameErr); err != nil {
		return result, err
	}
	return result, nil
}

type NodeFrameProducer struct {
	NodePath      string
	ScriptPath    string
	Concurrency   int
	ProfileOutput string
}

func (producer NodeFrameProducer) Start(ctx context.Context, request FrameRenderRequest) (FrameProcess, error) {
	if err := request.Validate(); err != nil {
		return nil, err
	}
	if producer.Concurrency < 0 || producer.Concurrency > 8 {
		return nil, errors.New("recording frame concurrency must be between 1 and 8")
	}
	if !filepath.IsAbs(producer.NodePath) || !filepath.IsAbs(producer.ScriptPath) {
		return nil, errors.New("node executable and recording renderer script paths must be absolute")
	}
	profilePath := ""
	if producer.ProfileOutput != "" {
		if filepath.IsAbs(producer.ProfileOutput) || filepath.Base(producer.ProfileOutput) != producer.ProfileOutput {
			return nil, errors.New("recording renderer profile output must be a file name")
		}
		profilePath = filepath.Join(request.WorkspaceDirectory, producer.ProfileOutput)
	}
	requestFile, err := os.CreateTemp(request.WorkspaceDirectory, "frame-render-request-*.json")
	if err != nil {
		return nil, fmt.Errorf("create frame render request: %w", err)
	}
	requestPath := requestFile.Name()
	removeRequest := true
	defer func() {
		_ = requestFile.Close()
		if removeRequest {
			_ = os.Remove(requestPath)
		}
	}()
	encoder := json.NewEncoder(requestFile)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(request); err != nil {
		return nil, fmt.Errorf("write frame render request: %w", err)
	}
	if err := requestFile.Close(); err != nil {
		return nil, fmt.Errorf("close frame render request: %w", err)
	}
	resultFile, err := os.CreateTemp(request.WorkspaceDirectory, "frame-render-result-*.json")
	if err != nil {
		return nil, fmt.Errorf("create frame render result path: %w", err)
	}
	resultPath := resultFile.Name()
	if err := resultFile.Close(); err != nil {
		_ = os.Remove(resultPath)
		return nil, fmt.Errorf("close frame render result path: %w", err)
	}
	if err := os.Remove(resultPath); err != nil {
		return nil, fmt.Errorf("prepare frame render result path: %w", err)
	}

	args := []string{producer.ScriptPath, "--request", requestPath, "--result", resultPath, "--concurrency", strconv.Itoa(max(1, producer.Concurrency))}
	if profilePath != "" {
		args = append(args, "--profile-output", profilePath)
	}
	commandContext, cancel := context.WithCancel(ctx)
	command := exec.CommandContext(commandContext, producer.NodePath, args...)
	stdout, err := command.StdoutPipe()
	if err != nil {
		cancel()
		_ = os.Remove(resultPath)
		return nil, fmt.Errorf("open frame renderer output: %w", err)
	}
	stderr := &boundedCommandOutput{maximum: maximumFrameStderrBytes}
	command.Stderr = stderr
	if err := command.Start(); err != nil {
		cancel()
		_ = stdout.Close()
		_ = os.Remove(resultPath)
		return nil, fmt.Errorf("start frame renderer: %w", err)
	}
	removeRequest = false
	return &nodeFrameProcess{
		request: request, requestPath: requestPath, resultPath: resultPath,
		command: command, stdout: stdout, stderr: stderr, cancel: cancel,
	}, nil
}

type nodeFrameProcess struct {
	request     FrameRenderRequest
	requestPath string
	resultPath  string
	command     *exec.Cmd
	stdout      io.ReadCloser
	stderr      *boundedCommandOutput
	cancel      context.CancelFunc
}

func (process *nodeFrameProcess) Frames() io.Reader { return process.stdout }

func (process *nodeFrameProcess) Cancel() { process.cancel() }

func (process *nodeFrameProcess) Wait() (FrameRenderResult, error) {
	defer process.cancel()
	defer os.Remove(process.requestPath)
	defer os.Remove(process.resultPath)
	if err := process.command.Wait(); err != nil {
		return FrameRenderResult{}, fmt.Errorf("recording frame renderer: %w: %s", err, process.stderr.String())
	}
	resultFile, err := os.Open(process.resultPath)
	if err != nil {
		return FrameRenderResult{}, fmt.Errorf("open frame render result: %w", err)
	}
	defer resultFile.Close()
	decoder := json.NewDecoder(io.LimitReader(resultFile, maximumFrameResultBytes+1))
	decoder.DisallowUnknownFields()
	var result FrameRenderResult
	if err := decoder.Decode(&result); err != nil {
		return FrameRenderResult{}, fmt.Errorf("decode frame render result: %w", err)
	}
	var trailing json.RawMessage
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		return FrameRenderResult{}, errors.New("frame render result contains trailing JSON or exceeds its size bound")
	}
	if info, err := resultFile.Stat(); err != nil || info.Size() > maximumFrameResultBytes {
		return FrameRenderResult{}, errors.New("frame render result exceeds its size bound")
	}
	if err := result.Validate(process.request); err != nil {
		return FrameRenderResult{}, err
	}
	return result, nil
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

type RenderMetrics struct {
	SchemaVersion      string       `json:"schema_version"`
	Encoder            VideoEncoder `json:"encoder"`
	HardwareEncoder    bool         `json:"hardware_encoder"`
	Width              int          `json:"width"`
	Height             int          `json:"height"`
	FPS                int          `json:"fps"`
	FrameCount         int64        `json:"frame_count"`
	SourceDurationMs   int64        `json:"source_duration_ms"`
	OutputDurationMs   int64        `json:"output_duration_ms"`
	FrameWallMs        int64        `json:"frame_wall_ms"`
	EncodeWallMs       int64        `json:"encode_wall_ms"`
	TotalWallMs        int64        `json:"total_wall_ms"`
	RealtimeFactor     float64      `json:"realtime_factor"`
	InputBytes         int64        `json:"input_bytes"`
	OutputBytes        int64        `json:"output_bytes"`
	PresentationSHA256 string       `json:"presentation_sha256"`
	UIBuildSHA256      string       `json:"ui_build_sha256"`
	DecodedSHA256      string       `json:"decoded_media_sha256"`
}

func NewRenderMetrics(request FrameRenderRequest, frames FrameRenderResult, plan RecordingEncodePlan, encodeDuration, totalDuration time.Duration, inputBytes, outputBytes int64) (RenderMetrics, error) {
	if err := frames.Validate(request); err != nil || encodeDuration < 0 || totalDuration < encodeDuration || inputBytes < 0 || outputBytes <= 0 {
		return RenderMetrics{}, errors.New("render metrics inputs are invalid")
	}
	realtimeFactor := float64(totalDuration.Milliseconds()) / float64(request.DurationMs)
	return RenderMetrics{
		SchemaVersion: "recording-render-metrics.v1", Encoder: plan.Encoder, HardwareEncoder: plan.HardwareEncoder,
		Width: request.Width, Height: request.Height, FPS: request.FPS, FrameCount: frames.FrameCount,
		SourceDurationMs: request.DurationMs, OutputDurationMs: plan.OutputDuration,
		FrameWallMs: frames.WallDurationMs, EncodeWallMs: encodeDuration.Milliseconds(), TotalWallMs: totalDuration.Milliseconds(), RealtimeFactor: realtimeFactor,
		InputBytes: inputBytes, OutputBytes: outputBytes, PresentationSHA256: request.PresentationSHA256, UIBuildSHA256: request.UIBuildSHA256, DecodedSHA256: request.DecodedMediaSHA256,
	}, nil
}
