package chatattachments

import (
	"context"
	"errors"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/objectstorage"
	"github.com/q9labs/chalk/apps/api/internal/synctokens"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

const (
	maxClientAttachmentIDBytes = 64
	minClientAttachmentIDBytes = 16
	maxFileNameBytes           = 255
	maxFileBytes               = 25 << 20
	uploadLifetime             = 10 * time.Minute
	unattachedLifetime         = 24 * time.Hour
	downloadLifetime           = 2 * time.Minute
	finalizeLeaseDuration      = 2 * time.Minute
	finalizeMutationTimeout    = 2 * time.Second
)

var (
	ErrInvalidInput               = errors.New("invalid chat attachment input")
	ErrPermissionDenied           = errors.New("chat attachment permission denied")
	ErrClientAttachmentIDConflict = errors.New("chat client attachment id conflict")
	ErrQuotaExceeded              = errors.New("chat attachment quota exceeded")
	ErrUploadNotFound             = errors.New("chat attachment upload not found")
	ErrUploadExpired              = errors.New("chat attachment upload expired")
	ErrUploadNotReady             = errors.New("chat attachment upload not ready")
	ErrAttachmentNotFound         = errors.New("chat attachment not found")
	ErrFileTransferFailed         = errors.New("chat attachment transfer failed")
)

// Subject is the Participant a Sync credential names.
type Subject = synctokens.Subject

type InitiateInput struct {
	Subject            Subject
	ClientAttachmentID string
	FileName           string
	MIMEType           string
	ByteLength         int64
	SHA256             string
}

type Attachment struct {
	AttachmentID utilities.ID
	FileName     string
	MIMEType     string
	ByteLength   int64
}

type Upload struct {
	Attachment
	UploadID             utilities.ID
	ObjectKey            string
	SHA256               [32]byte
	RequestFingerprint   [32]byte
	Status               string
	ExpiresAt            time.Time
	FinalizeClaimToken   utilities.ID
	FinalizeClaimedUntil time.Time
}

type UploadInstructions struct {
	AttachmentID utilities.ID
	UploadID     utilities.ID
	Method       string
	URL          string
	Headers      map[string]string
	ExpiresAt    time.Time
}

type Download struct {
	URL       string
	ExpiresAt time.Time
}

type ReserveInput struct {
	Subject            Subject
	ClientAttachmentID string
	Upload             Upload
}

type CompleteInput struct {
	UploadID                utilities.ID
	FinalizeClaimToken      utilities.ID
	ImmutableObjectIdentity string
	ExpiresAt               time.Time
	Now                     time.Time
}

type Repository interface {
	Reserve(context.Context, ReserveInput) (Upload, error)
	ClaimFinalize(context.Context, Subject, utilities.ID, time.Time, time.Time) (Upload, error)
	Complete(context.Context, CompleteInput) error
	Fail(context.Context, utilities.ID, utilities.ID) error
	ReleaseFinalize(context.Context, utilities.ID, utilities.ID) error
	AuthorizedDownload(context.Context, Subject, utilities.ID) (Upload, error)
}

type ObjectStore interface {
	GetObject(context.Context, string) (objectstorage.ObjectReader, error)
	InspectObject(context.Context, string) (objectstorage.ObjectFacts, error)
	DeleteObject(context.Context, string) error
	CreateUploadURL(context.Context, objectstorage.CreateUploadURLInput) (objectstorage.SignedURL, error)
	CreateDownloadURL(context.Context, objectstorage.CreateDownloadURLInput) (objectstorage.SignedURL, error)
}

type Service struct {
	repository Repository
	objects    ObjectStore
	now        func() time.Time
	telemetry  *requestTelemetry
}
