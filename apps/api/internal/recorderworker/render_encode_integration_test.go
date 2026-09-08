package recorderworker

import (
	"bytes"
	"context"
	"image"
	"image/color"
	"image/draw"
	"image/png"
	"os/exec"
	"path/filepath"
	"strconv"
	"testing"
	"time"
)

func TestRecordingEncodePreservesFrameClock(t *testing.T) {
	for _, tool := range []string{"ffmpeg", "ffprobe"} {
		if _, err := exec.LookPath(tool); err != nil {
			t.Skipf("recording encode integration requires %s: %v", tool, err)
		}
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	runner := ExecCommandRunner{}
	audioPath := filepath.Join(t.TempDir(), "mix.wav")
	if output, err := runner.Run(ctx, "ffmpeg", "-hide_banner", "-nostdin", "-loglevel", "error",
		"-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo", "-t", "1.1", "-c:a", "pcm_s16le", audioPath); err != nil {
		t.Fatalf("create audio fixture: %v: %s", err, output)
	}
	var frame bytes.Buffer
	canvas := image.NewRGBA(image.Rect(0, 0, 192, 108))
	draw.Draw(canvas, canvas.Bounds(), image.NewUniform(color.RGBA{R: 40, G: 80, B: 120, A: 255}), image.Point{}, draw.Src)
	if err := png.Encode(&frame, canvas); err != nil {
		t.Fatalf("encode frame fixture: %v", err)
	}
	for _, fps := range []int{24, 30, 60} {
		t.Run(strconv.Itoa(fps), func(t *testing.T) {
			plan, err := BuildRecordingEncodePlan(audioPath, filepath.Join(t.TempDir(), "recording.mp4"), RecordingEncodeConfig{
				Width: 192, Height: 108, FPS: fps, DurationMs: 1_001, Encoder: EncoderLibX264,
			})
			if err != nil {
				t.Fatalf("build encode plan: %v", err)
			}
			frames := bytes.NewReader(bytes.Repeat(frame.Bytes(), int(plan.FrameCount)))
			if _, err := EncodeRecordingFrames(ctx, runner, plan, frames); err != nil {
				t.Fatalf("encode recording: %v", err)
			}
			if _, err := VerifyRecordingMedia(ctx, runner, plan.Output, RecordingMediaExpectation{
				Width: 192, Height: 108, FPS: fps, FrameCount: plan.FrameCount, DurationMs: plan.OutputDuration,
			}); err != nil {
				t.Fatalf("verify recording frame and audio clock: %v", err)
			}
		})
	}
}
