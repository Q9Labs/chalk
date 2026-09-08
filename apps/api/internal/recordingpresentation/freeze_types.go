package recordingpresentation

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/captureplan"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

const AssetManifestSchemaVersion = "recording_presentation_assets.v1"

var (
	ErrInvalidCompletionAuthority = errors.New("invalid recording presentation completion authority")
	ErrInvalidCompletionSource    = errors.New("invalid recording presentation completion source")
	ErrCompletionSourceNotFound   = errors.New("recording presentation completion source not found")
	ErrObjectFactsMismatch        = errors.New("recording presentation object facts mismatch")
)

// CompletionAuthority is the capture-attempt authority used both for the
// unlocked source read and the final transactional commit. The final commit
// must independently revalidate every field.
type CompletionAuthority struct {
	JobID             utilities.ID
	AttemptCount      int
	FencingGeneration int64
	CaptureEpoch      int64
	EnvelopeDigest    []byte
	LeaseToken        string
	LeaseOwner        string
}

func (authority CompletionAuthority) Validate() error {
	if authority.JobID.IsZero() || authority.AttemptCount <= 0 ||
		authority.FencingGeneration <= 0 || authority.CaptureEpoch <= 0 ||
		len(authority.EnvelopeDigest) != 32 || authority.LeaseToken == "" || authority.LeaseOwner == "" {
		return ErrInvalidCompletionAuthority
	}
	return nil
}

type CompletionSourceReader interface {
	LoadCompletionSource(context.Context, CompletionAuthority) (CompletionSource, error)
}

type CompletionSource struct {
	PresentationHandle utilities.ID
	TenantID           utilities.ID
	SpaceID            utilities.ID
	EpisodeID          utilities.ID
	RecordingID        utilities.ID
	CaptureEpoch       int64
	CaptureReadyAt     time.Time
	DurationMillis     int64
	Profile            Profile
	SpaceName          string

	EpisodeControlStartRevision  int64
	EpisodeControlOriginEvents   []ControlEventFact
	EpisodeControlOriginRevision int64
	EpisodeControlTailEvents     []ControlEventFact

	ChatStartSequence         int64
	ChatRetainedFloorSequence *int64
	InitialChatMessages       []ChatMessageFact
	ChatTailMessages          []ChatMessageFact

	WhiteboardStartRevision  int64
	InitialWhiteboard        *WhiteboardSnapshotFact
	WhiteboardOriginEvents   []WhiteboardEventFact
	WhiteboardOriginRevision int64
	WhiteboardTailEvents     []WhiteboardEventFact
	WhiteboardFiles          []WhiteboardFileFact

	CapturePlanStartRevision int64
	CapturePlans             []CapturePlanFact
	Reactions                []ReactionFact

	BaselineControlState json.RawMessage
}

type ControlEventFact struct {
	Revision  int64
	Name      string
	Payload   json.RawMessage
	CreatedAt time.Time
}

type CapturePlanFact struct {
	Revision  int64
	Plan      captureplan.Plan
	CreatedAt time.Time
}

type ObjectFact struct {
	Key         string
	Version     string
	ETag        string
	ContentType string
	ByteSize    int64
	SHA256      []byte
}

type ChatAttachmentFact struct {
	ID       string
	FileName string
	Object   ObjectFact
}

type ChatMessageFact struct {
	ID                    string
	Sequence              int64
	ParticipantID         string
	ParticipantGeneration int64
	DisplayName           string
	Text                  string
	CreatedAt             time.Time
	Attachments           []ChatAttachmentFact
}

type WhiteboardSnapshotFact struct {
	SceneID    string
	Revision   int64
	Presenting bool
	AppState   json.RawMessage
	Elements   []json.RawMessage
}

type WhiteboardEventFact struct {
	OperationID string
	Name        string
	SceneID     string
	Revision    int64
	Elements    []json.RawMessage
	Presenting  *bool
	CompletedAt time.Time
}

type WhiteboardFileFact struct {
	ID     string
	Object ObjectFact
}

type ReactionFact struct {
	ID                    string
	ParticipantID         string
	ParticipantGeneration int64
	DisplayName           string
	Value                 string
	OccurredAt            time.Time
	ExpiresAt             time.Time
}

type PreparedPresentation struct {
	PresentationHandle  utilities.ID
	TenantID            utilities.ID
	SpaceID             utilities.ID
	EpisodeID           utilities.ID
	RecordingID         utilities.ID
	CaptureEpoch        int64
	SchemaVersion       string
	ProfileVersion      string
	DurationMillis      int64
	PresentationSHA256  []byte
	PresentationObject  ObjectFact
	AssetManifestObject ObjectFact
	Assets              []PreparedAsset
	FrozenAt            time.Time
}

type PreparedAsset struct {
	Ordinal int
	Asset   Asset
	Object  ObjectFact
}

type AssetManifest struct {
	SchemaVersion      string               `json:"schemaVersion"`
	PresentationHandle string               `json:"presentationHandle"`
	Assets             []AssetManifestEntry `json:"assets"`
}

type AssetManifestEntry struct {
	Ordinal       int    `json:"ordinal"`
	ID            string `json:"id"`
	Kind          string `json:"kind"`
	ObjectKey     string `json:"objectKey"`
	ObjectVersion string `json:"objectVersion"`
	ObjectETag    string `json:"objectEtag"`
	ContentType   string `json:"contentType"`
	ByteSize      int64  `json:"byteSize"`
	SHA256        string `json:"sha256"`
}
