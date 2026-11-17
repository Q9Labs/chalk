package talktime

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/episodes"
	"github.com/q9labs/chalk/apps/api/internal/objectstorage"
	"github.com/q9labs/chalk/apps/api/internal/transcripts"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

// MaxRecordings bounds how many Recordings of one Episode feed talk time.
const MaxRecordings = 50

var ErrTranscriptArtifact = errors.New("talk time transcript artifact unreadable")

// Episodes is the slice of the Episode service talk time needs.
type Episodes interface {
	GetEpisode(context.Context, utilities.ID, utilities.ID, utilities.ID) (episodes.Episode, error)
	GetEpisodeAttendance(context.Context, utilities.ID, utilities.ID, utilities.ID) ([]episodes.AttendanceParticipant, error)
}

type Repository interface {
	// ListRecordings returns at most limit Recordings of the Episode, oldest first.
	ListRecordings(ctx context.Context, tenantID, spaceID, episodeID utilities.ID, limit int) ([]Recording, error)
}

type Objects interface {
	GetObject(ctx context.Context, key string) (objectstorage.ObjectReader, error)
}

// Recording is one Recording of an Episode and the transcript made from it.
type Recording struct {
	ID     utilities.ID
	Status string
	// StartedAt is when the Recording's timeline began.
	StartedAt time.Time
	// Transcript is nil when no transcript was ever requested for the Recording.
	Transcript *transcripts.Transcript
	// AutomaticTranscription is true when the Episode's policy transcribes every
	// Recording on its own.
	AutomaticTranscription bool
}

// Outcome is what talk time can say about an Episode: exactly one of
// Available, NoTranscript, TranscriptPending or Live.
type Outcome interface{ outcome() }

// Available carries the measurements.
type Available struct {
	Report Report
	// Recordings are the Episode's Recordings, oldest first, with where each
	// one's timeline sits on the Episode's.
	Recordings []Placement
}

// Placement is one Recording on the Episode timeline.
type Placement struct {
	RecordingID utilities.ID
	// OffsetMS is how far into the Episode the Recording's timeline begins.
	OffsetMS int64
	// Transcribed is true when the Recording's transcript was measured.
	Transcribed bool
}

// NoTranscript means no Recording has a transcript and none is on the way.
type NoTranscript struct{}

// TranscriptPending means a transcript is being made but is not complete.
type TranscriptPending struct{}

// Live means the Episode has not ended.
type Live struct{}

func (Available) outcome()         {}
func (NoTranscript) outcome()      {}
func (TranscriptPending) outcome() {}
func (Live) outcome()              {}

type Service struct {
	episodes   Episodes
	repository Repository
	objects    Objects
}

func NewService(episodes Episodes, repository Repository, objects Objects) Service {
	return Service{episodes: episodes, repository: repository, objects: objects}
}

func (s Service) Get(ctx context.Context, tenantID, spaceID, episodeID utilities.ID) (Outcome, error) {
	episode, err := s.episodes.GetEpisode(ctx, tenantID, spaceID, episodeID)
	if err != nil {
		return nil, err
	}
	if episode.Status != episodes.EpisodeStatusEnded {
		return Live{}, nil
	}
	recordings, err := s.repository.ListRecordings(ctx, tenantID, spaceID, episodeID, MaxRecordings)
	if err != nil {
		return nil, fmt.Errorf("list Episode Recordings for talk time: %w", err)
	}

	start := episode.StartedAt
	if start.IsZero() {
		start = episode.CreatedAt
	}
	var cues []Cue
	placements := make([]Placement, 0, len(recordings))
	transcribed := 0
	pending := false
	for _, recording := range recordings {
		placement := Placement{RecordingID: recording.ID, OffsetMS: recordingOffsetMS(start, recording.StartedAt)}
		switch {
		case recording.Transcript != nil && recording.Transcript.DocumentReady():
			document, err := s.readDocument(ctx, *recording.Transcript)
			if err != nil {
				return nil, err
			}
			transcribed++
			placement.Transcribed = true
			cues = append(cues, episodeCues(document, placement.OffsetMS)...)
		case transcriptInProgress(recording):
			pending = true
		}
		placements = append(placements, placement)
	}

	if transcribed == 0 {
		if pending {
			return TranscriptPending{}, nil
		}
		return NoTranscript{}, nil
	}
	attendance, err := s.episodes.GetEpisodeAttendance(ctx, tenantID, spaceID, episodeID)
	if err != nil {
		return nil, err
	}
	participants := make([]Participant, 0, len(attendance))
	for _, attendee := range attendance {
		participants = append(participants, Participant{ID: attendee.ParticipantID.String(), DisplayName: attendee.DisplayName})
	}
	end := episode.EndedAt
	if end.IsZero() {
		end = episode.UpdatedAt
	}
	report := Compute(Input{DurationMS: end.Sub(start).Milliseconds(), Participants: participants, Cues: cues})
	return Available{Report: report, Recordings: placements}, nil
}

func (s Service) readDocument(ctx context.Context, transcript transcripts.Transcript) (transcripts.Document, error) {
	artifact, err := s.objects.GetObject(ctx, *transcript.ArtifactKey)
	if err != nil {
		return transcripts.Document{}, fmt.Errorf("read transcript %s artifact: %w", transcript.ID, err)
	}
	if artifact.Body == nil {
		return transcripts.Document{}, fmt.Errorf("%w: transcript %s has no body", ErrTranscriptArtifact, transcript.ID)
	}
	if !transcript.ArtifactMatches(artifact.Key, artifact.Size, artifact.ContentType) {
		_ = artifact.Body.Close()
		return transcripts.Document{}, fmt.Errorf("%w: transcript %s artifact does not match its row", ErrTranscriptArtifact, transcript.ID)
	}
	document, readErr := transcripts.ReadDocument(artifact.Body, transcripts.MaxDocumentBytes)
	closeErr := artifact.Body.Close()
	if err := errors.Join(readErr, closeErr); err != nil {
		return transcripts.Document{}, fmt.Errorf("%w: transcript %s: %w", ErrTranscriptArtifact, transcript.ID, err)
	}
	return document, nil
}

// transcriptInProgress reports whether a transcript for the Recording is
// being made or is about to be: a transcription that is not finished or
// failed for good, or a Recording that automatic transcription has not
// reached yet.
func transcriptInProgress(recording Recording) bool {
	if transcript := recording.Transcript; transcript != nil {
		switch transcript.Status {
		case transcripts.StatusPreparing, transcripts.StatusTranscribing, transcripts.StatusVerifying, transcripts.StatusRetryableFailure:
			return transcript.DeletedAt == nil
		case transcripts.StatusNotRequested:
			return recording.AutomaticTranscription && recording.Status != "failed"
		}
		return false
	}
	return recording.AutomaticTranscription && recording.Status != "failed"
}

// recordingOffsetMS is how far into the Episode a Recording's timeline begins.
// A Recording that claims to start before the Episode is placed at its start.
func recordingOffsetMS(episodeStart, recordingStart time.Time) int64 {
	return max(recordingStart.Sub(episodeStart).Milliseconds(), 0)
}

func episodeCues(document transcripts.Document, offsetMS int64) []Cue {
	cues := make([]Cue, 0, len(document.Cues))
	for _, cue := range document.Cues {
		if cue.Identity == nil {
			continue
		}
		name := ""
		if cue.Identity.DisplayName != nil {
			name = *cue.Identity.DisplayName
		}
		cues = append(cues, Cue{StartMS: cue.StartMS + offsetMS, EndMS: cue.EndMS + offsetMS, Ref: cue.Identity.ParticipantRef, DisplayName: name})
	}
	return cues
}
