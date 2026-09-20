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

func TestRenderTranscriptionHonorsEpisodePolicyBeforeExportingAudio(t *testing.T) {
	for _, mode := range []artifactpolicy.TranscriptionMode{
		artifactpolicy.TranscriptionDisabled,
		artifactpolicy.TranscriptionOnDemand,
		artifactpolicy.TranscriptionAutomatic,
	} {
		t.Run(string(mode), func(t *testing.T) {
			runner := &transcriptionPolicyRunner{err: errors.New("audio export reached")}
			attempt := &ProductionRenderAttempt{
				config:    ProductionRenderAttemptConfig{Commands: runner},
				workspace: t.TempDir(),
			}
			index := recordingdecode.Index{Sources: []recordingdecode.Source{{
				SourceID: "microphone-1", Kind: "microphone", Path: "microphone-1.flac",
				StartMS: 0, EndMS: 337_551,
			}}}
			source, err := attempt.persistTranscription(context.Background(), recordingrender.ResolvedInput{
				TranscriptionMode: mode,
			}, recordingpresentation.Timeline{}, attempt.workspace, index)
			if mode == artifactpolicy.TranscriptionDisabled {
				if err != nil || source != nil || runner.calls != 0 {
					t.Fatalf("disabled transcription exported audio: source=%v error=%v commands=%d", source, err, runner.calls)
				}
				return
			}
			if !errors.Is(err, runner.err) || runner.calls != 1 {
				t.Fatalf("enabled transcription export: error=%v commands=%d", err, runner.calls)
			}
		})
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
