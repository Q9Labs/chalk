package recordingrender

import (
	"context"
	"errors"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/artifactpolicy"
	"github.com/q9labs/chalk/apps/api/internal/objectstorage"
	"github.com/q9labs/chalk/apps/api/internal/recordingkeys"
	"github.com/q9labs/chalk/apps/api/internal/recordingpipeline"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

const (
	InputSchemaVersion                     = "recording_render_input.v1"
	PresentationSchemaVersion              = "recording_presentation.v1"
	TranscriptionSourceSchemaVersion       = "recording-transcription-source.v1"
	DefaultGrantTTL                        = 10 * time.Minute
	MaximumGrantTTL                        = 30 * time.Minute
	MaximumCaptureObjects                  = 10_000
	MaximumTranscriptionChunks             = 4_096
	MaximumAssetObjects                    = 256
	MaximumRenderInputBytes          int64 = 64 << 30
	MaximumManifestBytes             int64 = 1 << 20
	MaximumVideoBytes                int64 = 32 << 30
	MaximumAudioBytes                int64 = 500 << 20
)

var (
	ErrInvalidRequest           = errors.New("invalid recording render request")
	ErrAuthorityMismatch        = errors.New("recording render authority mismatch")
	ErrLeaseStale               = errors.New("recording render lease is stale")
	ErrInputNotFound            = errors.New("recording render input not found")
	ErrInputIncomplete          = errors.New("recording render input is incomplete")
	ErrInputTooLarge            = errors.New("recording render input exceeds bounds")
	ErrKeyNotFound              = errors.New("recording render key not found")
	ErrAllocationNotFound       = errors.New("recording render allocation not found")
	ErrAllocationConflict       = errors.New("recording render allocation conflict")
	ErrAllocationExpired        = errors.New("recording render allocation expired")
	ErrObjectFactsMismatch      = errors.New("recording render object facts mismatch")
	ErrCommitConflict           = errors.New("recording render commit conflict")
	ErrTranscriptionUnavailable = errors.New("recording render transcription runtime unavailable")
	ErrRepositoryUnavailable    = errors.New("recording render repository unavailable")
	ErrStorageUnavailable       = errors.New("recording render storage unavailable")
	ErrKMSUnavailable           = errors.New("recording render kms unavailable")
)

type ObjectPurpose string

const (
	PurposeRecordingVideo        ObjectPurpose = "recording_video"
	PurposeTranscriptionManifest ObjectPurpose = "transcription_manifest"
	PurposeTranscriptionAudio    ObjectPurpose = "transcription_audio"
)

type Authority struct {
	TenantID          utilities.ID
	SpaceID           utilities.ID
	EpisodeID         utilities.ID
	RecordingID       utilities.ID
	JobID             utilities.ID
	RenderInputHandle utilities.ID
	KeyHandle         utilities.ID
	ObjectHandle      utilities.ID
	AttemptCount      int
	FencingGeneration int64
	CaptureEpoch      int64
	EnvelopeDigest    []byte
	LeaseToken        string
	LeaseOwner        string
	LeaseExpiresAt    time.Time
}

type ObjectFacts struct {
	ObjectKey     string
	ObjectVersion string
	ObjectETag    string
	ContentType   string
	ByteSize      int64
	SHA256        []byte
}

type CaptureObject struct {
	ObjectFacts
	CaptureEpoch         int64
	CaptureJobID         utilities.ID
	KeyHandle            utilities.ID
	EnvelopeDigest       []byte
	SequenceNumber       int64
	MonotonicStartMillis int64
	MonotonicEndMillis   int64
	MediaStartMillis     int64
	MediaEndMillis       int64
	Codec                string
	Layer                *string
}

type Presentation struct {
	Handle         utilities.ID
	SchemaVersion  string
	ProfileVersion string
	DurationMillis int64
	SHA256         []byte
	CaptureReadyAt time.Time
	Object         ObjectFacts
	AssetManifest  ObjectFacts
	Assets         []ObjectFacts
}

type StoredInput struct {
	SchemaVersion     string
	TranscriptionMode artifactpolicy.TranscriptionMode
	Authority         Authority
	// SourceExpiresAt is the immutable capture-completion retention boundary
	// shared by deferred presentation exports and audio preparation.
	SourceExpiresAt time.Time
	Capture         []CaptureObject
	Presentation    Presentation
}

type DownloadGrant struct {
	Method        string
	URL           string
	ExpiresAt     time.Time
	SignedHeaders map[string][]string
}

type DownloadableObject struct {
	ObjectFacts
	Download DownloadGrant
}

type DownloadableCaptureObject struct {
	CaptureObject
	Download DownloadGrant
}

type ResolvedInput struct {
	SchemaVersion              string
	TranscriptionMode          artifactpolicy.TranscriptionMode
	TenantID                   utilities.ID
	SpaceID                    utilities.ID
	EpisodeID                  utilities.ID
	RecordingID                utilities.ID
	CaptureEpoch               int64
	CaptureReadyAt             time.Time
	DurationMillis             int64
	Capture                    []DownloadableCaptureObject
	Presentation               DownloadableObject
	PresentationHandle         utilities.ID
	PresentationSchemaVersion  string
	PresentationProfileVersion string
	PresentationSHA256         []byte
	AssetManifest              DownloadableObject
	Assets                     []DownloadableObject
}

type EncryptedKey struct {
	KeyHandle      utilities.ID
	CiphertextBlob []byte
	Context        recordingkeys.EncryptionContext
}

type DataKey struct {
	KeyHandle    utilities.ID
	Plaintext    []byte
	CaptureEpoch int64
}

type AccessKeyInput struct {
	Authority    Authority
	CaptureEpoch int64
}

type ReserveObjectInput struct {
	Authority            Authority
	Purpose              ObjectPurpose
	ReservationRequestID utilities.ID
}

type FinalizeObjectInput struct {
	Authority      Authority
	AllocationID   utilities.ID
	Purpose        ObjectPurpose
	ContentType    string
	ByteSize       int64
	SHA256         []byte
	DurationMillis *int64
}

type CommitObjectInput struct {
	Authority    Authority
	AllocationID utilities.ID
	UploadToken  string
}

type Allocation struct {
	ID                     utilities.ID
	ReservationRequestID   utilities.ID
	AllocationVersion      int64
	Authority              Authority
	Purpose                ObjectPurpose
	State                  string
	Object                 ObjectFacts
	ExpectedContentType    string
	ExpectedByteSize       int64
	ExpectedSHA256         []byte
	ExpectedDurationMillis *int64
	UploadTokenHash        []byte
	UploadExpiresAt        *time.Time
	CommittedAt            *time.Time
	CreatedAt              time.Time
}

type ReservedObject struct {
	AllocationID      utilities.ID
	ObjectKey         string
	Purpose           ObjectPurpose
	AllocationVersion int64
}

type FinalizedObject struct {
	ReservedObject
	UploadToken string
	Upload      objectstorage.SignedURL
	ExpiresAt   time.Time
}

type CommittedObject struct {
	ReservedObject
	Object         ObjectFacts
	DurationMillis *int64
	CommittedAt    time.Time
}

type CommitObjectReference struct {
	AllocationID   utilities.ID
	Purpose        ObjectPurpose
	Object         ObjectFacts
	DurationMillis *int64
}

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

type CommitInput struct {
	Authority           Authority
	CommitDigest        []byte
	PresentationSHA256  []byte
	DurationMillis      int64
	Video               CommitObjectReference
	FFprobeFactsDigest  []byte
	TranscriptionSource *TranscriptionSource
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

type CommitResult struct {
	Artifact      recordingpipeline.Artifact
	Transcription *TranscriptionResult
}

type Repository interface {
	ResolveInput(context.Context, Authority) (StoredInput, error)
	GetCaptureKey(context.Context, AccessKeyInput) (EncryptedKey, error)
	ReserveObject(context.Context, ReserveObjectInput, utilities.ID, string, time.Time) (Allocation, error)
	GetObjectAllocation(context.Context, Authority, utilities.ID) (Allocation, error)
	FinalizeObject(context.Context, Allocation) (Allocation, error)
	GetObjectAllocationByTokenHash(context.Context, Authority, []byte) (Allocation, error)
	CommitObject(context.Context, Allocation, objectstorage.ObjectFacts, time.Time) (CommittedObject, error)
	Commit(context.Context, CommitInput, time.Time) (CommitResult, error)
	CommitTranscriptionPreparation(context.Context, TranscriptionPreparationInput, time.Time) (*TranscriptionResult, error)
}

type DispatcherWake func(context.Context, utilities.ID)
