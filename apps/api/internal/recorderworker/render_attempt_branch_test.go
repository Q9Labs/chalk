package recorderworker

import (
	"context"
	"io"
	"strings"
	"testing"
)

type branchCompose struct{ request FrameRenderRequest }

func (compose *branchCompose) Compose(_ context.Context, request FrameRenderRequest, _ string) (ComposeResult, error) {
	compose.request = request
	return ComposeResult{}, nil
}

type branchFrames struct{ request FrameRenderRequest }

func (frames *branchFrames) Start(_ context.Context, request FrameRenderRequest) (FrameProcess, error) {
	frames.request = request
	return branchFrameProcess{request: request}, nil
}

type branchFrameProcess struct{ request FrameRenderRequest }

func (process branchFrameProcess) Frames() io.Reader { return strings.NewReader("frame") }
func (process branchFrameProcess) Cancel()           {}
func (process branchFrameProcess) Wait() (FrameRenderResult, error) {
	frames := (process.request.DurationMs*int64(process.request.FPS) + 999) / 1000
	return FrameRenderResult{
		SchemaVersion: FrameRenderResultVersion, RecordingID: process.request.RecordingID, EpisodeID: process.request.EpisodeID,
		PresentationSHA256: process.request.PresentationSHA256, UIBuildSHA256: process.request.UIBuildSHA256,
		DecodedMediaSHA256: process.request.DecodedMediaSHA256, Width: process.request.Width, Height: process.request.Height,
		FPS: process.request.FPS, FrameCount: frames, LastElapsedMs: (frames - 1) * 1000 / int64(process.request.FPS),
	}, nil
}

type branchEncoder struct{}

func (branchEncoder) RunStreaming(_ context.Context, input io.Reader, _ string, _ ...string) ([]byte, error) {
	_, err := io.Copy(io.Discard, input)
	return nil, err
}

func TestRenderVideoSelectsNativeOrBrowser(t *testing.T) {
	request := frameRequestForTest(t.TempDir())
	compose := &branchCompose{}
	frames := &branchFrames{}
	attempt := &ProductionRenderAttempt{config: ProductionRenderAttemptConfig{Compose: compose, Frames: frames, Encoder: EncoderLibX264, Streaming: branchEncoder{}}}
	expected, err := attempt.renderVideo(context.Background(), request, "mix.wav", "recording.mp4")
	if err != nil || compose.request.FPS != 15 || frames.request.FPS != 0 || expected.FPS != 15 || expected.FrameCount != 16 || expected.DurationMs != 1_067 {
		t.Fatalf("native selection: request=%#v browser=%#v expectation=%#v err=%v", compose.request, frames.request, expected, err)
	}
	attempt.config.Compose = nil
	expected, err = attempt.renderVideo(context.Background(), request, "mix.wav", "recording.mp4")
	if err != nil || frames.request.FPS != 30 || expected.FPS != 30 || expected.FrameCount != 31 || expected.DurationMs != 1_034 {
		t.Fatalf("browser selection: request=%#v expectation=%#v err=%v", frames.request, expected, err)
	}
}
