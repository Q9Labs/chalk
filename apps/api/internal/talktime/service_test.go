package talktime

import (
	"context"
	"errors"
	"fmt"
	"io"
	"strings"
	"testing"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/episodes"
	"github.com/q9labs/chalk/apps/api/internal/objectstorage"
	"github.com/q9labs/chalk/apps/api/internal/transcripts"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

var (
	episodeStart = time.Date(2026, 11, 1, 10, 0, 0, 0, time.UTC)
	aliceID      = mustID(alice)
	bobID        = mustID(bob)
)

func mustID(value string) utilities.ID {
	id, err := utilities.ParseID(value)
	if err != nil {
		panic(err)
	}
	return id
}

type fakeEpisodes struct {
	episode    episodes.Episode
	attendance []episodes.AttendanceParticipant
	err        error
}

func (f fakeEpisodes) GetEpisode(context.Context, utilities.ID, utilities.ID, utilities.ID) (episodes.Episode, error) {
	return f.episode, f.err
}

func (f fakeEpisodes) GetEpisodeAttendance(context.Context, utilities.ID, utilities.ID, utilities.ID) ([]episodes.AttendanceParticipant, error) {
	return f.attendance, f.err
}

type fakeRepository struct{ recordings []Recording }

func (f fakeRepository) ListRecordings(context.Context, utilities.ID, utilities.ID, utilities.ID, int) ([]Recording, error) {
	return f.recordings, nil
}

type fakeObjects map[string]string

func (f fakeObjects) GetObject(_ context.Context, key string) (objectstorage.ObjectReader, error) {
	body, ok := f[key]
	if !ok {
		return objectstorage.ObjectReader{}, errors.New("missing object")
	}
	return objectstorage.ObjectReader{Object: objectstorage.Object{Key: key, Size: int64(len(body)), ContentType: "application/json"}, Body: io.NopCloser(strings.NewReader(body))}, nil
}

type spoken struct {
	ref        string
	name       string
	start, end int64
}

func transcriptJSON(cues ...spoken) string {
	var encoded []string
	for _, cue := range cues {
		encoded = append(encoded, fmt.Sprintf(`{"startMs":%d,"endMs":%d,"identity":{"kind":"participant","participantRef":%q,"participantGeneration":1,"trackId":"t","trackEpoch":"e"},"trackClass":"microphone","displayNameSnapshot":%q,"text":"hi","overlap":false,"provider":"deepinfra","model":"m","versionContract":"v","attempt":1}`, cue.start, cue.end, cue.ref, cue.name))
	}
	return `{"schemaVersion":"transcript.v1","jobId":"j","episodeId":"e","cues":[` + strings.Join(encoded, ",") + `],"provider":"deepinfra","model":"m","versionContract":"v","attempt":1,"measuredAudioMs":1}`
}

func completeTranscript(key string, body string) *transcripts.Transcript {
	size, contentType := int64(len(body)), "application/json"
	return &transcripts.Transcript{Status: transcripts.StatusComplete, ArtifactKey: &key, ArtifactSize: &size, ArtifactContentType: &contentType}
}

func endedEpisode() fakeEpisodes {
	return fakeEpisodes{
		episode: episodes.Episode{Status: episodes.EpisodeStatusEnded, StartedAt: episodeStart, EndedAt: episodeStart.Add(10 * time.Minute)},
		attendance: []episodes.AttendanceParticipant{
			{ParticipantID: aliceID, DisplayName: "Alice"},
			{ParticipantID: bobID, DisplayName: "Bob"},
		},
	}
}

func get(t *testing.T, episodes fakeEpisodes, recordings []Recording, objects fakeObjects) Outcome {
	t.Helper()
	outcome, err := NewService(episodes, fakeRepository{recordings}, objects).Get(context.Background(), utilities.ID{}, utilities.ID{}, utilities.ID{})
	if err != nil {
		t.Fatal(err)
	}
	return outcome
}

func TestGetPlacesEachRecordingOnTheEpisodeTimeline(t *testing.T) {
	first := transcriptJSON(spoken{alice, "Alice", 10_000, 20_000})
	second := transcriptJSON(spoken{alice, "Alice", 0, 5_000}, spoken{bob, "Bob", 2_000, 8_000})
	outcome := get(t, endedEpisode(), []Recording{
		{Status: "completed", StartedAt: episodeStart.Add(time.Minute), Transcript: completeTranscript("a", first)},
		{Status: "completed", StartedAt: episodeStart.Add(5 * time.Minute), Transcript: completeTranscript("b", second)},
	}, fakeObjects{"a": first, "b": second})

	available, ok := outcome.(Available)
	if !ok {
		t.Fatalf("outcome = %#v", outcome)
	}
	if available.RecordingsTotal != 2 || available.RecordingsTranscribed != 2 || available.Report.EpisodeDurationMS != 600_000 {
		t.Fatalf("available = %+v", available)
	}
	// Alice: 70s-80s in the first Recording, 300s-305s in the second.
	if got := speakerByID(t, available.Report, alice).Intervals; len(got) != 2 || got[0] != (Interval{70_000, 80_000}) || got[1] != (Interval{300_000, 305_000}) {
		t.Fatalf("Alice intervals = %+v", got)
	}
	if got := speakerByID(t, available.Report, bob).Intervals; len(got) != 1 || got[0] != (Interval{302_000, 308_000}) {
		t.Fatalf("Bob intervals = %+v", got)
	}
	if available.Report.OverlapMS != 3_000 {
		t.Fatalf("OverlapMS = %d", available.Report.OverlapMS)
	}
}

func TestGetPlacesARecordingThatStartsBeforeTheEpisodeAtItsStart(t *testing.T) {
	body := transcriptJSON(spoken{alice, "Alice", 1_000, 2_000})
	outcome := get(t, endedEpisode(), []Recording{{Status: "completed", StartedAt: episodeStart.Add(-time.Minute), Transcript: completeTranscript("a", body)}}, fakeObjects{"a": body})
	if got := speakerByID(t, outcome.(Available).Report, alice).Intervals; len(got) != 1 || got[0] != (Interval{1_000, 2_000}) {
		t.Fatalf("intervals = %+v", got)
	}
}

func TestGetMeasuresOnlyCompleteTranscriptsAndSaysHowManyThatIs(t *testing.T) {
	body := transcriptJSON(spoken{alice, "Alice", 0, 4_000})
	failed := completeTranscript("x", body)
	failed.Status = transcripts.StatusTerminalFailure
	outcome := get(t, endedEpisode(), []Recording{
		{Status: "completed", StartedAt: episodeStart, Transcript: completeTranscript("a", body)},
		{Status: "completed", StartedAt: episodeStart.Add(time.Minute), Transcript: failed},
		{Status: "completed", StartedAt: episodeStart.Add(2 * time.Minute)},
	}, fakeObjects{"a": body})
	available := outcome.(Available)
	if available.RecordingsTotal != 3 || available.RecordingsTranscribed != 1 {
		t.Fatalf("available = %+v", available)
	}
}

func TestGetStatuses(t *testing.T) {
	body := transcriptJSON(spoken{alice, "Alice", 0, 1_000})
	deleted := completeTranscript("a", body)
	now := episodeStart
	deleted.DeletedAt = &now
	inProgress := func(status string) *transcripts.Transcript { return &transcripts.Transcript{Status: status} }

	live := endedEpisode()
	live.episode.Status = episodes.EpisodeStatusActive

	for _, test := range []struct {
		name       string
		episodes   fakeEpisodes
		recordings []Recording
		want       Outcome
	}{
		{"episode still live", live, []Recording{{Status: "completed", Transcript: completeTranscript("a", body)}}, Live{}},
		{"episode ending", func() fakeEpisodes { e := endedEpisode(); e.episode.Status = episodes.EpisodeStatusEnding; return e }(), nil, Live{}},
		{"no recording", endedEpisode(), nil, NoTranscript{}},
		{"transcription never requested", endedEpisode(), []Recording{{Status: "completed"}}, NoTranscript{}},
		{"transcription not requested row", endedEpisode(), []Recording{{Status: "completed", Transcript: inProgress(transcripts.StatusNotRequested)}}, NoTranscript{}},
		{"transcription failed for good", endedEpisode(), []Recording{{Status: "completed", Transcript: inProgress(transcripts.StatusTerminalFailure)}}, NoTranscript{}},
		{"transcript deleted", endedEpisode(), []Recording{{Status: "completed", Transcript: deleted}}, NoTranscript{}},
		{"automatic transcription, recording failed", endedEpisode(), []Recording{{Status: "failed", AutomaticTranscription: true}}, NoTranscript{}},
		{"transcribing", endedEpisode(), []Recording{{Status: "completed", Transcript: inProgress(transcripts.StatusTranscribing)}}, TranscriptPending{}},
		{"preparing", endedEpisode(), []Recording{{Status: "completed", Transcript: inProgress(transcripts.StatusPreparing)}}, TranscriptPending{}},
		{"verifying", endedEpisode(), []Recording{{Status: "completed", Transcript: inProgress(transcripts.StatusVerifying)}}, TranscriptPending{}},
		{"retrying", endedEpisode(), []Recording{{Status: "completed", Transcript: inProgress(transcripts.StatusRetryableFailure)}}, TranscriptPending{}},
		{"automatic transcription, recording still processing", endedEpisode(), []Recording{{Status: "processing", AutomaticTranscription: true}}, TranscriptPending{}},
		{"automatic transcription, transcript not created yet", endedEpisode(), []Recording{{Status: "completed", AutomaticTranscription: true}}, TranscriptPending{}},
	} {
		t.Run(test.name, func(t *testing.T) {
			if got := get(t, test.episodes, test.recordings, fakeObjects{"a": body}); fmt.Sprintf("%T", got) != fmt.Sprintf("%T", test.want) {
				t.Fatalf("outcome = %#v, want %T", got, test.want)
			}
		})
	}
}

func TestGetMeasuresWhatIsDoneEvenWhenAnotherRecordingIsPending(t *testing.T) {
	body := transcriptJSON(spoken{alice, "Alice", 0, 1_000})
	outcome := get(t, endedEpisode(), []Recording{
		{Status: "completed", Transcript: completeTranscript("a", body)},
		{Status: "completed", Transcript: &transcripts.Transcript{Status: transcripts.StatusTranscribing}},
	}, fakeObjects{"a": body})
	if available, ok := outcome.(Available); !ok || available.RecordingsTotal != 2 || available.RecordingsTranscribed != 1 {
		t.Fatalf("outcome = %#v", outcome)
	}
}

func TestGetFailsWhenAnArtifactCannotBeRead(t *testing.T) {
	body := transcriptJSON(spoken{alice, "Alice", 0, 1_000})
	_, err := NewService(endedEpisode(), fakeRepository{[]Recording{{Status: "completed", Transcript: completeTranscript("missing", body)}}}, fakeObjects{}).Get(context.Background(), utilities.ID{}, utilities.ID{}, utilities.ID{})
	if err == nil {
		t.Fatal("a transcript that cannot be read must not look like silence")
	}
	_, err = NewService(endedEpisode(), fakeRepository{[]Recording{{Status: "completed", Transcript: completeTranscript("a", body)}}}, fakeObjects{"a": `{"nope":true}`}).Get(context.Background(), utilities.ID{}, utilities.ID{}, utilities.ID{})
	if !errors.Is(err, ErrTranscriptArtifact) {
		t.Fatalf("err = %v", err)
	}
}

func TestGetPassesEpisodeErrorsThrough(t *testing.T) {
	missing := endedEpisode()
	missing.err = episodes.ErrEpisodeNotFound
	_, err := NewService(missing, fakeRepository{}, fakeObjects{}).Get(context.Background(), utilities.ID{}, utilities.ID{}, utilities.ID{})
	if !errors.Is(err, episodes.ErrEpisodeNotFound) {
		t.Fatalf("err = %v", err)
	}
}
