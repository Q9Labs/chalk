package recorderworker

import (
	"context"
	"path/filepath"
	"reflect"
	"testing"
)

func TestBuildTranscriptionAudioPlanIsExplicitLosslessMono16k(t *testing.T) {
	t.Parallel()
	input := filepath.Join(t.TempDir(), "microphone.wav")
	output := filepath.Join(t.TempDir(), "chunk.flac")
	plan, err := BuildTranscriptionAudioPlan(input, output, 1_234, 5_678)
	if err != nil {
		t.Fatalf("build transcription plan: %v", err)
	}
	want := []string{"ffmpeg", "-hide_banner", "-nostdin", "-loglevel", "error", "-i", input, "-ss", "1.234", "-t", "5.678", "-map", "0:a:0", "-vn", "-map_metadata", "-1", "-c:a", "flac", "-compression_level", "8", "-ar", "16000", "-ac", "1", output}
	if !reflect.DeepEqual(plan.Command, want) || plan.Codec != "flac" || plan.SampleRateHz != 16_000 || plan.Channels != 1 {
		t.Fatalf("transcription plan = %#v", plan)
	}
}

func TestVerifyTranscriptionAudioRejectsDurationDrift(t *testing.T) {
	t.Parallel()
	runner := &transcriptionProbeRunner{output: []byte(`{"streams":[{"codec_type":"audio","codec_name":"flac","sample_rate":"16000","channels":1}],"format":{"duration":"1.250"}}`)}
	if _, err := VerifyTranscriptionAudio(context.Background(), runner, filepath.Join(t.TempDir(), "chunk.flac"), 1_000); err == nil {
		t.Fatal("duration drift was accepted")
	}
}

type transcriptionProbeRunner struct {
	output []byte
}

func (runner *transcriptionProbeRunner) Run(context.Context, string, ...string) ([]byte, error) {
	return append([]byte(nil), runner.output...), nil
}
