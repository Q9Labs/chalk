package whiteboardfiles

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/q9labs/chalk/apps/api/internal/objectstorage"
	"github.com/q9labs/chalk/apps/api/internal/synctokens"
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
)

// Subject is the Participant a Sync credential names.
type Subject = synctokens.Subject

type Upload struct {
	UploadID   utilities.ID
	Subject    Subject
	SceneID    utilities.ID
	FileID     string
	ObjectKey  string
	MIMEType   string
	ByteLength int64
	SHA256     [32]byte
	Status     string
	ExpiresAt  time.Time
}

type Download struct {
	URL       string
	ExpiresAt time.Time
}

type Repository interface {
	ReadyFile(context.Context, Subject, string) (Upload, error)
	Reserve(context.Context, Upload) (Upload, error)
	PendingOrReady(context.Context, FileRequest) (Upload, error)
	Finalize(context.Context, FileRequest, utilities.ID, string, time.Time) (bool, error)
}

type ObjectStore interface {
	CreateUploadURL(context.Context, objectstorage.CreateUploadURLInput) (objectstorage.SignedURL, error)
	GetObject(context.Context, string) (objectstorage.ObjectReader, error)
	CreateDownloadURL(context.Context, objectstorage.CreateDownloadURLInput) (objectstorage.SignedURL, error)
}

type Service struct {
	repository  Repository
	objects     ObjectStore
	now         func() time.Time
	verifySlots chan struct{}
}

func NewService(repository Repository, objects ObjectStore) Service {
	return Service{repository: repository, objects: objects, now: time.Now, verifySlots: make(chan struct{}, 2)}
}

func (s Service) Download(ctx context.Context, subject Subject, fileID string) (Download, error) {
	if s.repository == nil || s.objects == nil || !subject.IsComplete() || !validFileID(fileID) {
		return Download{}, ErrInvalidInput
	}
	file, err := s.repository.ReadyFile(ctx, subject, fileID)
	if err != nil {
		return Download{}, err
	}
	// Old rows may contain active formats such as SVG. Do not issue a
	// browser-navigable storage URL for them; keep the original object intact.
	if !rasterImage(file.MIMEType) {
		return Download{}, ErrFileNotFound
	}
	signed, err := s.objects.CreateDownloadURL(ctx, objectstorage.CreateDownloadURLInput{Key: file.ObjectKey, ExpiresIn: 2 * time.Minute})
	if err != nil {
		return Download{}, fmt.Errorf("create whiteboard download url: %w", err)
	}
	return Download{URL: signed.URL, ExpiresAt: signed.ExpiresAt}, nil
}

func validFileID(value string) bool {
	return value != "" && !strings.ContainsRune(value, 0) && utf8.ValidString(value) && len(value) <= maxFileIDBytes
}
