package talktime

import (
	"context"
	"testing"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/episodes"
	"github.com/q9labs/chalk/apps/api/internal/objectstorage"
	"github.com/q9labs/chalk/apps/api/internal/recordingpipeline"
	"github.com/q9labs/chalk/apps/api/internal/transcripts"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

type fakeEpisodes struct{ episode episodes.Episode }

func (f fakeEpisodes) GetEpisode(context.Context, utilities.ID, utilities.ID, utilities.ID) (episodes.Episode, error) {
	return f.episode, nil
}

func (fakeEpisodes) GetEpisodeAttendance(context.Context, utilities.ID, utilities.ID, utilities.ID) ([]episodes.AttendanceParticipant, error) {
	return nil, nil
}

type fakeRepository struct{ recordings []Recording }

func (f fakeRepository) ListRecordings(context.Context, utilities.ID, utilities.ID, utilities.ID, int) ([]Recording, error) {
	return f.recordings, nil
}

type noObjects struct{}

func (noObjects) GetObject(context.Context, string) (objectstorage.ObjectReader, error) {
	return objectstorage.ObjectReader{}, nil
}

func outcomeFor(t *testing.T, recording Recording) Outcome {
	t.Helper()
	started := time.Date(2026, 1, 2, 3, 4, 5, 0, time.UTC)
	episode := episodes.Episode{Status: episodes.EpisodeStatusEnded, StartedAt: started, EndedAt: started.Add(time.Hour)}
	recording.StartedAt = started
	outcome, err := NewService(fakeEpisodes{episode: episode}, fakeRepository{recordings: []Recording{recording}}, noObjects{}).Get(context.Background(), utilities.ID{}, utilities.ID{}, utilities.ID{})
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	return outcome
}

func TestNoTranscriptRowFollowsTranscriptionPreparation(t *testing.T) {
	cases := []struct {
		name        string
		automatic   bool
		preparation recordingpipeline.TranscriptionPreparationStatus
		want        Outcome
	}{
		{"preparation in flight", true, recordingpipeline.TranscriptionPreparationPending, TranscriptPending{}},
		{"preparation failed", true, recordingpipeline.TranscriptionPreparationFailed, NoTranscript{}},
		{"preparation expired", true, recordingpipeline.TranscriptionPreparationExpired, NoTranscript{}},
		{"preparation finished without a source", true, recordingpipeline.TranscriptionPreparationNone, NoTranscript{}},
		{"on demand transcription never requested", false, recordingpipeline.TranscriptionPreparationPending, NoTranscript{}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := outcomeFor(t, Recording{AutomaticTranscription: tc.automatic, TranscriptionPreparation: tc.preparation})
			if got != tc.want {
				t.Fatalf("outcome = %#v, want %#v", got, tc.want)
			}
		})
	}
}

func TestTranscriptRowStatusDecidesOutcome(t *testing.T) {
	cases := []struct {
		status string
		want   Outcome
	}{
		{transcripts.StatusPreparing, TranscriptPending{}},
		{transcripts.StatusTranscribing, TranscriptPending{}},
		{transcripts.StatusVerifying, TranscriptPending{}},
		{transcripts.StatusRetryableFailure, TranscriptPending{}},
		{transcripts.StatusTerminalFailure, NoTranscript{}},
		{transcripts.StatusDeleted, NoTranscript{}},
		{transcripts.StatusNotRequested, NoTranscript{}},
	}
	for _, tc := range cases {
		t.Run(tc.status, func(t *testing.T) {
			got := outcomeFor(t, Recording{
				AutomaticTranscription:   true,
				TranscriptionPreparation: recordingpipeline.TranscriptionPreparationFailed,
				Transcript:               &transcripts.Transcript{Status: tc.status},
			})
			if got != tc.want {
				t.Fatalf("outcome = %#v, want %#v", got, tc.want)
			}
		})
	}
}
