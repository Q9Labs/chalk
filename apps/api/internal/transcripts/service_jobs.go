package transcripts

import (
	"encoding/json"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

type RequestInput struct {
	TenantID            utilities.ID
	RecordingID         utilities.ID
	IdempotencyKey      string
	ManifestKey         string
	ManifestSHA256      []byte
	ManifestSize        int64
	ManifestContentType string
	Language            string
	Languages           []string
	Chunks              []ChunkInput
	Priority            int
	AttemptLimit        int
	JourneyID           utilities.ID
	Traceparent         string
	Tracestate          string
}

type Job struct {
	ID                   utilities.ID
	IdempotencyKey       string
	TenantID             utilities.ID
	SessionID            utilities.ID
	RecordingID          utilities.ID
	TranscriptID         utilities.ID
	ChunkID              utilities.ID
	ArtifactKind         string
	PayloadSchemaVersion int
	State                string
	Priority             int
	AvailableAt          time.Time
	Attempt              int
	AttemptLimit         int
	LeaseOwner           string
	LeaseExpiresAt       *time.Time
	ErrorCode            string
	ErrorDetail          string
	JourneyID            utilities.ID
	Traceparent          string
	Tracestate           string
	TerminalAt           *time.Time
	CreatedAt            time.Time
	UpdatedAt            time.Time
}

type Assignment struct {
	Job          Job
	LeaseToken   string
	Chunk        *ChunkInput
	Transcript   Transcript
	ChunkGETURL  string
	ResultPUTURL string
}

type ClaimInput struct {
	Owner         string
	LeaseDuration time.Duration
	Now           time.Time
}

type LeaseInput struct {
	JobID      utilities.ID
	Attempt    int
	LeaseOwner string
	LeaseToken string
	Now        time.Time
}

type RetryInput struct {
	LeaseInput
	AvailableAt time.Time
	ErrorCode   string
	ErrorDetail string
	Terminal    bool
}

type CancelInput struct {
	LeaseInput
	ErrorCode   string
	ErrorDetail string
}

type ResultInput struct {
	JobID                      utilities.ID
	Attempt                    int
	LeaseOwner                 string
	LeaseToken                 string
	ChunkID                    utilities.ID
	Generation                 int64
	AttemptID                  utilities.ID
	Provider                   string
	Model                      string
	ProviderVersion            string
	ProviderRequestID          string
	ResultKey                  string
	ResultSHA256               []byte
	ResultSize                 int64
	ResultContentType          string
	Language                   string
	BilledAudioSeconds         int
	Quality                    json.RawMessage
	ExecutionIdentity          string
	MeasuredAudioMS            int64
	ProviderDurationSeconds    *int
	ProviderObservedDurationMS *int64
	Now                        time.Time
}

type Result struct {
	ID                utilities.ID
	ChunkID           utilities.ID
	Generation        int64
	Accepted          bool
	Provider          string
	Model             string
	ProviderVersion   string
	ResultKey         string
	ResultSHA256      []byte
	ResultSize        int64
	ResultContentType string
	Language          string
	AcceptedAt        time.Time
}
