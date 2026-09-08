package recorderworker

import (
	"context"
	"errors"
	"strings"
	"testing"
)

func TestBuildRecordingEncodePlanRequiresExplicitHardwareEncoder(t *testing.T) {
	plan, err := BuildRecordingEncodePlan("mix.wav", "recording.mp4", RecordingEncodeConfig{
		Width: 1280, Height: 720, FPS: 30, DurationMs: 1_001, Encoder: EncoderVideoToolbox,
	})
	if err != nil {
		t.Fatalf("build encode plan: %v", err)
	}
	if !plan.HardwareEncoder || plan.FrameCount != 31 || plan.OutputDuration != 1_034 {
		t.Fatalf("unexpected hardware plan: %#v", plan)
	}
	command := strings.Join(plan.Command, " ")
	if !strings.Contains(command, "-c:v h264_videotoolbox") || !strings.Contains(command, "-allow_sw 0") {
		t.Fatalf("hardware plan permits an implicit fallback: %s", command)
	}
}

func TestBuildRecordingEncodePlanRejectsUnknownEncoder(t *testing.T) {
	_, err := BuildRecordingEncodePlan("mix.wav", "recording.mp4", RecordingEncodeConfig{
		Width: 1280, Height: 720, FPS: 30, DurationMs: 1_000, Encoder: VideoEncoder("auto"),
	})
	if err == nil {
		t.Fatal("unknown encoder was accepted")
	}
}

func TestVerifyRecordingMediaChecksFrameAndAudioClock(t *testing.T) {
	valid := `{
  "streams": [
    {"codec_type":"video","codec_name":"h264","profile":"High","pix_fmt":"yuv420p","width":1280,"height":720,"avg_frame_rate":"30/1","start_time":"0.000000","duration":"1.033333","nb_frames":"31"},
    {"codec_type":"audio","codec_name":"aac","profile":"LC","sample_rate":"48000","channels":2,"start_time":"0.000000","duration":"1.033000"}
  ],
  "format":{"format_name":"mov,mp4,m4a,3gp,3g2,mj2","start_time":"0.000000","duration":"1.034000","size":"1234"}
}`
	runner := commandRunnerStub{output: []byte(valid)}
	_, err := VerifyRecordingMedia(context.Background(), runner, "recording.mp4", RecordingMediaExpectation{
		Width: 1280, Height: 720, FPS: 30, FrameCount: 31, DurationMs: 1_034,
	})
	if err != nil {
		t.Fatalf("verify synchronized recording: %v", err)
	}

	drifted := strings.Replace(valid, `"start_time":"0.000000","duration":"1.033000"`, `"start_time":"0.200000","duration":"1.033000"`, 1)
	_, err = VerifyRecordingMedia(context.Background(), commandRunnerStub{output: []byte(drifted)}, "recording.mp4", RecordingMediaExpectation{
		Width: 1280, Height: 720, FPS: 30, FrameCount: 31, DurationMs: 1_034,
	})
	if err == nil || !strings.Contains(err.Error(), "not synchronized") {
		t.Fatalf("audio drift error = %v", err)
	}
}

type commandRunnerStub struct {
	output []byte
	err    error
}

func (r commandRunnerStub) Run(context.Context, string, ...string) ([]byte, error) {
	if r.err != nil {
		return r.output, r.err
	}
	return r.output, nil
}

func TestProbeVideoEncoderReportsUnavailableBackend(t *testing.T) {
	err := ProbeVideoEncoder(context.Background(), commandRunnerStub{output: []byte("no device"), err: errors.New("exit status 1")}, EncoderNVENC)
	if err == nil || !strings.Contains(err.Error(), "h264_nvenc") || !strings.Contains(err.Error(), "no device") {
		t.Fatalf("probe error = %v", err)
	}
}
