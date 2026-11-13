package recordingrender

import (
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

type TranscriptionChunk struct {
	ChunkID               utilities.ID
	Index                 int
	Generation            int64
	StartMillis           int64
	EndMillis             int64
	SourceStartMillis     int64
	SourceEndMillis       int64
	ParticipantRef        string
	ParticipantGeneration int64
	DisplayNameSnapshot   string
	TrackID               string
	TrackEpoch            string
	IdentityKind          string
	TrackClass            string
	Overlap               bool
	Object                CommitObjectReference
}

type TranscriptionSource struct {
	SchemaVersion      string
	PresentationSHA256 []byte
	Manifest           CommitObjectReference
	Chunks             []TranscriptionChunk
}

// TranscriptionPreparationInput atomically admits the microphone source
// material prepared by the transcription job. A nil source records that the
// sealed capture did not contain a microphone source.
type TranscriptionPreparationInput struct {
	Authority           Authority
	CommitDigest        []byte
	PresentationSHA256  []byte
	DurationMillis      int64
	TranscriptionSource *TranscriptionSource
}

type TranscriptionResult struct {
	SourceID utilities.ID
	JobIDs   []utilities.ID
}
