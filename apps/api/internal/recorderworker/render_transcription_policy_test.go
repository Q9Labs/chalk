package recorderworker

import (
	"context"
	"errors"
	"testing"

	"github.com/q9labs/chalk/apps/api/internal/artifactpolicy"
	"github.com/q9labs/chalk/apps/api/internal/recordingdecode"
	"github.com/q9labs/chalk/apps/api/internal/recordingpresentation"
	"github.com/q9labs/chalk/apps/api/internal/recordingrender"
)

func TestPersistTranscriptionPreparesMicrophoneSources(t *testing.T) {
	runner := &transcriptionPolicyRunner{err: errors.New("audio export reached")}
	attempt := &ProductionRenderAttempt{
		config:    ProductionRenderAttemptConfig{Commands: runner},
		workspace: t.TempDir(),
	}
	index := recordingdecode.Index{Sources: []recordingdecode.Source{{
		SourceID: "microphone-1", Kind: "microphone", Path: "microphone-1.flac",
		StartMS: 0, EndMS: 337_551,
	}}}
	_, err := attempt.persistTranscription(context.Background(), recordingrender.ResolvedInput{TranscriptionMode: artifactpolicy.TranscriptionOnDemand}, recordingpresentation.Timeline{}, attempt.workspace, index)
	if !errors.Is(err, runner.err) || runner.calls != 1 {
		t.Fatalf("on-demand transcription preparation error=%v commands=%d", err, runner.calls)
	}
}

type transcriptionPolicyRunner struct {
	err   error
	calls int
}

func (runner *transcriptionPolicyRunner) Run(context.Context, string, ...string) ([]byte, error) {
	runner.calls++
	return nil, runner.err
}
