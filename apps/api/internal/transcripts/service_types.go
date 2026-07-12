package transcripts

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/pagination"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

var (
	ErrInvalidTranscriptID     = errors.New("invalid transcript id")
	ErrInvalidTenantID         = errors.New("invalid tenant id")
	ErrInvalidRecordingID      = errors.New("invalid recording id")
	ErrInvalidRoomID           = errors.New("invalid room id")
	ErrInvalidSessionID        = errors.New("invalid session id")
	ErrInvalidTranscriptStatus = errors.New("invalid transcript status")
	ErrInvalidProvider         = errors.New("invalid transcript provider")
	ErrInvalidModel            = errors.New("invalid transcript model")
	ErrInvalidLanguages        = errors.New("invalid transcript languages")
	ErrInvalidTranscriptField  = errors.New("invalid transcript field")
	ErrRecordingNotFound       = errors.New("recording not found")
	ErrSourceNotReady          = errors.New("transcription source not ready")
	ErrTranscriptNotFound      = errors.New("transcript not found")
	ErrArtifactRepository      = errors.New("transcription artifact repository unavailable")
	ErrInvalidIdempotencyKey   = errors.New("invalid transcription idempotency key")
	ErrInvalidManifest         = errors.New("invalid transcript manifest")
	ErrInvalidChunk            = errors.New("invalid transcript chunk")
	ErrInvalidLease            = errors.New("invalid artifact lease")
	ErrStaleLease              = errors.New("stale artifact lease")
	ErrJobNotFound             = errors.New("artifact job not found")
	ErrNoClaimableJob          = errors.New("no claimable artifact job")
	ErrDuplicateResult         = errors.New("transcript chunk result already accepted")
	ErrInvalidArtifact         = errors.New("invalid transcript artifact")
)

const (
	StatusPending          = "pending"
	StatusProcessing       = "processing"
	StatusCompleted        = "completed"
	StatusFailed           = "failed"
	StatusNotRequested     = "not_requested"
	StatusPreparing        = "preparing"
	StatusTranscribing     = "transcribing"
	StatusVerifying        = "verifying"
	StatusComplete         = "complete"
	StatusRetryableFailure = "retryable_failure"
	StatusTerminalFailure  = "terminal_failure"
	StatusDeleted          = "deleted"

	JobStatePending    = "pending"
	JobStateLeased     = "leased"
	JobStateRetryable  = "retryable"
	JobStateCompleted  = "completed"
	JobStateDeadLetter = "dead_letter"
	JobStateCancelled  = "cancelled"
)

type Transcript struct {
	ID                        utilities.ID
	TenantID                  utilities.ID
	RecordingID               utilities.ID
	RoomID                    utilities.ID
	SessionID                 utilities.ID
	Status                    string
	Provider                  string
	Model                     string
	Languages                 []string
	Text                      *string
	Metadata                  json.RawMessage
	ArtifactKey               *string
	ArtifactSHA256            []byte
	ArtifactSize              *int64
	ArtifactContentType       *string
	SourceManifestKey         *string
	SourceManifestSHA256      []byte
	SourceManifestSize        *int64
	SourceManifestContentType *string
	Generation                int64
	DeletedAt                 *time.Time
	CompletedAt               *time.Time
	UpdatedAt                 time.Time
	CreatedAt                 time.Time
}

type Repository interface {
	Create(context.Context, CreateInput) (Transcript, error)
	Get(context.Context, utilities.ID, utilities.ID) (Transcript, error)
	List(context.Context, utilities.ID, utilities.ID, pagination.PageRequest) (TranscriptList, error)
	Update(context.Context, utilities.ID, utilities.ID, UpdateInput) (Transcript, error)
}

// ArtifactRepository owns the asynchronous transcript and PostgreSQL job
// transaction. It is deliberately separate from Repository so legacy callers
// cannot mutate transcript content or lifecycle state accidentally.
type ArtifactRepository interface {
	Request(context.Context, RequestInput) (Transcript, Job, error)
	Claim(context.Context, ClaimInput) (Assignment, error)
	Heartbeat(context.Context, LeaseInput, time.Time) (Job, error)
	Retry(context.Context, RetryInput) (Job, error)
	Complete(context.Context, LeaseInput) (Job, error)
	Cancel(context.Context, CancelInput) (Job, error)
	Requeue(context.Context, utilities.ID, time.Time) (Job, error)
	RecoverExpired(context.Context, time.Time, time.Time) ([]Job, error)
	ResultKey(context.Context, LeaseInput) (string, error)
	Finalize(context.Context, FinalizeInput) (Transcript, error)
	AcceptResult(context.Context, ResultInput) (Result, error)
	Delete(context.Context, utilities.ID, utilities.ID) (Transcript, error)
}

type FinalizeInput struct {
	TranscriptID        utilities.ID
	ArtifactKey         string
	Provider            string
	Model               string
	Languages           []string
	ArtifactSHA256      []byte
	ArtifactSize        int64
	ArtifactContentType string
}

type SourceRepository interface {
	SeedSource(context.Context, SourceInput) error
	LoadSource(context.Context, utilities.ID, utilities.ID) (SourceInput, error)
}

type SourceInput struct {
	TenantID            utilities.ID
	RecordingID         utilities.ID
	ManifestKey         string
	ManifestSHA256      []byte
	ManifestSize        int64
	ManifestContentType string
	Chunks              []ChunkInput
}

type Service struct {
	repository Repository
	artifacts  ArtifactRepository
	cleanup    CleanupRepository
	finalizer  FinalizerRepository
	waker      DispatcherWaker
}

type DispatcherWakeInput struct {
	JobID       utilities.ID
	JourneyID   utilities.ID
	Traceparent string
	Tracestate  string
}

type DispatcherWaker interface {
	Wake(context.Context, DispatcherWakeInput)
}

type ChunkInput struct {
	ID             utilities.ID
	Index          int
	Generation     int64
	StartMS        int64
	EndMS          int64
	ParticipantRef string
	TrackEpoch     string
	IdentityKind   string
	TrackClass     string
	StorageKey     string
	ResultKey      string
	Checksum       []byte
	Size           int64
	ContentType    string
}
