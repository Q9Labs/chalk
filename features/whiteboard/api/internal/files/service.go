package whiteboardfiles

import (
	"context"
	"errors"
	"fmt"
	"time"
	"unicode/utf8"

	"github.com/q9labs/chalk/apps/api/internal/objectstorage"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

const (
	maxFileIDBytes = 128
)

var (
	ErrInvalidInput       = errors.New("invalid whiteboard file input")
	ErrPermissionDenied   = errors.New("whiteboard file permission denied")
	ErrFileNotFound       = errors.New("whiteboard file not found")
	ErrFileTransferFailed = errors.New("whiteboard file transfer failed")
	ErrCleanupLeaseLost   = errors.New("whiteboard file cleanup lease lost")
)

type Subject struct {
	TenantID              utilities.ID
	SpaceID               utilities.ID
	EpisodeID             utilities.ID
	ParticipantID         utilities.ID
	ParticipantGeneration int64
}

type Upload struct {
	UploadID   utilities.ID
	Subject    Subject
	SceneID    utilities.ID
	FileID     string
	ObjectKey  string
	MIMEType   string
	ByteLength int64
	SHA256     [32]byte
	ExpiresAt  time.Time
}

type Download struct {
	URL       string
	ExpiresAt time.Time
}

type Repository interface {
	ReadyFile(context.Context, Subject, string) (Upload, error)
}

type ObjectStore interface {
	CreateDownloadURL(context.Context, objectstorage.CreateDownloadURLInput) (objectstorage.SignedURL, error)
}

type Service struct {
	repository Repository
	objects    ObjectStore
	now        func() time.Time
}

func NewService(repository Repository, objects ObjectStore) Service {
	return Service{repository: repository, objects: objects, now: time.Now}
}

func (s Service) Download(ctx context.Context, subject Subject, fileID string) (Download, error) {
	if s.repository == nil || s.objects == nil || invalidSubject(subject) || !validFileID(fileID) {
		return Download{}, ErrInvalidInput
	}
	file, err := s.repository.ReadyFile(ctx, subject, fileID)
	if err != nil {
		return Download{}, err
	}
	signed, err := s.objects.CreateDownloadURL(ctx, objectstorage.CreateDownloadURLInput{Key: file.ObjectKey, ExpiresIn: 2 * time.Minute})
	if err != nil {
		return Download{}, fmt.Errorf("create whiteboard download url: %w", err)
	}
	return Download{URL: signed.URL, ExpiresAt: signed.ExpiresAt}, nil
}

func invalidSubject(subject Subject) bool {
	return subject.TenantID.IsZero() || subject.SpaceID.IsZero() || subject.EpisodeID.IsZero() ||
		subject.ParticipantID.IsZero() || subject.ParticipantGeneration <= 0
}

func validFileID(value string) bool {
	return value != "" && utf8.ValidString(value) && len(value) <= maxFileIDBytes
}
