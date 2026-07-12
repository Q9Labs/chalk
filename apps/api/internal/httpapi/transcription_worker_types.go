package httpapi

import (
	"context"
	"net/http"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/transcripts"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

const transcriptionWorkloadRole = "transcription-dispatcher"
const transcriptionWorkLeaseDuration = 15 * time.Minute

type TranscriptWorkerService interface {
	Claim(context.Context, transcripts.ClaimInput) (transcripts.Assignment, error)
	Heartbeat(context.Context, transcripts.LeaseInput, time.Time) (transcripts.Job, error)
	Retry(context.Context, transcripts.RetryInput) (transcripts.Job, error)
	Complete(context.Context, transcripts.LeaseInput) (transcripts.Job, error)
	Cancel(context.Context, transcripts.CancelInput) (transcripts.Job, error)
	AcceptResult(context.Context, transcripts.ResultInput) (transcripts.Result, error)
}

type WorkloadAuthorizer interface {
	AuthorizeWorkload(context.Context, *http.Request, string) error
}

type ChunkURLInput struct {
	JobID     utilities.ID
	Attempt   int
	Key       string
	ExpiresIn time.Duration
}
type ManifestURLInput struct {
	JobID     utilities.ID
	Attempt   int
	Key       string
	ExpiresIn time.Duration
}
type ResultURLInput struct {
	JobID       utilities.ID
	Attempt     int
	Key         string
	ContentType string
	MaxBytes    int64
	ExpiresIn   time.Duration
}
type ResultVerification struct {
	JobID       utilities.ID
	Attempt     int
	Key         string
	ContentType string
	Size        int64
	SHA256      []byte
}
type ChunkAuthority interface {
	CreateChunkGETURL(context.Context, ChunkURLInput) (string, error)
}
type ManifestAuthority interface {
	CreateManifestGETURL(context.Context, ManifestURLInput) (string, error)
}
type ResultAuthority interface {
	CreateResultPUTURL(context.Context, ResultURLInput) (string, error)
	VerifyResult(context.Context, ResultVerification) error
}

type NonceStore interface {
	Consume(context.Context, string, time.Duration) (bool, error)
}
