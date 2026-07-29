package whiteboardfiles

import (
	"context"
	"encoding/hex"
	"errors"
	"fmt"
	"mime"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/q9labs/chalk/apps/api/internal/objectstorage"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

const (
	maxFileIDBytes = 128
	maxFileBytes   = 256 << 20
)

var (
	ErrInvalidInput       = errors.New("invalid whiteboard file input")
	ErrPermissionDenied   = errors.New("whiteboard file permission denied")
	ErrSceneChanged       = errors.New("whiteboard scene changed")
	ErrFileExists         = errors.New("whiteboard file already exists")
	ErrUploadNotFound     = errors.New("whiteboard upload not found")
	ErrUploadExpired      = errors.New("whiteboard upload expired")
	ErrUploadNotReady     = errors.New("whiteboard upload not ready")
	ErrFileNotFound       = errors.New("whiteboard file not found")
	ErrFileTransferFailed = errors.New("whiteboard file transfer failed")
	ErrCleanupLeaseLost   = errors.New("whiteboard file cleanup lease lost")
)

type Subject struct {
	TenantID              utilities.ID
	RoomID                utilities.ID
	SessionID             utilities.ID
	ParticipantSessionID  utilities.ID
	ParticipantGeneration int64
}

type InitiateInput struct {
	Subject    Subject
	SceneID    utilities.ID
	FileID     string
	MIMEType   string
	ByteLength int64
	SHA256     string
}

type UploadInstructions struct {
	UploadID  utilities.ID
	Method    string
	URL       string
	Headers   map[string]string
	ExpiresAt time.Time
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

type ReserveInput struct {
	Upload
}

type CompleteInput struct {
	UploadID                utilities.ID
	ImmutableObjectIdentity string
}

type Repository interface {
	Reserve(context.Context, ReserveInput) error
	Fail(context.Context, utilities.ID) error
	ClaimFinalize(context.Context, Subject, utilities.ID, time.Time) (Upload, error)
	Complete(context.Context, CompleteInput) error
	ReadyFile(context.Context, Subject, string) (Upload, error)
}

type ObjectStore interface {
	InspectObject(context.Context, string) (objectstorage.ObjectFacts, error)
	DeleteObject(context.Context, string) error
	CreateUploadURL(context.Context, objectstorage.CreateUploadURLInput) (objectstorage.SignedURL, error)
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

func (s Service) Initiate(ctx context.Context, input InitiateInput) (UploadInstructions, error) {
	if s.repository == nil || s.objects == nil {
		return UploadInstructions{}, objectstorage.ErrStoreUnavailable
	}
	sha256, mimeType, err := validateInitiate(input)
	if err != nil {
		return UploadInstructions{}, err
	}
	uploadID, err := utilities.NewID()
	if err != nil {
		return UploadInstructions{}, fmt.Errorf("generate whiteboard upload id: %w", err)
	}

	now := s.now().UTC()
	expiresAt := now.Add(10 * time.Minute)
	objectKey := objectKey(input.Subject, input.SceneID, uploadID)
	upload := Upload{
		UploadID: uploadID, Subject: input.Subject, SceneID: input.SceneID,
		FileID: input.FileID, ObjectKey: objectKey, MIMEType: mimeType,
		ByteLength: input.ByteLength, SHA256: sha256, ExpiresAt: expiresAt,
	}
	if err := s.repository.Reserve(ctx, ReserveInput{Upload: upload}); err != nil {
		return UploadInstructions{}, err
	}

	signed, err := s.objects.CreateUploadURL(ctx, objectstorage.CreateUploadURLInput{
		Key: objectKey, ContentType: mimeType, ContentLength: input.ByteLength,
		ExpiresIn: expiresAt.Sub(now), IfNoneMatch: true,
		Metadata: map[string]string{
			"chalk-upload-id": uploadID.String(),
			"chalk-sha256":    input.SHA256,
		},
	})
	if err != nil {
		_ = s.repository.Fail(ctx, uploadID)
		return UploadInstructions{}, fmt.Errorf("create whiteboard upload url: %w", err)
	}
	headers, err := exactHeaders(signed.SignedHeader)
	if err != nil {
		_ = s.repository.Fail(ctx, uploadID)
		return UploadInstructions{}, err
	}

	return UploadInstructions{
		UploadID: uploadID, Method: signed.Method, URL: signed.URL,
		Headers: headers, ExpiresAt: signed.ExpiresAt,
	}, nil
}

func (s Service) Finalize(ctx context.Context, subject Subject, uploadID utilities.ID) error {
	if s.repository == nil || s.objects == nil || invalidSubject(subject) || uploadID.IsZero() {
		return ErrInvalidInput
	}
	upload, err := s.repository.ClaimFinalize(ctx, subject, uploadID, s.now().UTC())
	if err != nil {
		return err
	}

	facts, err := s.objects.InspectObject(ctx, upload.ObjectKey)
	if err != nil {
		_ = s.repository.Fail(ctx, uploadID)
		return fmt.Errorf("inspect whiteboard upload: %w", err)
	}
	if facts.Size != upload.ByteLength ||
		!strings.EqualFold(facts.ContentType, upload.MIMEType) ||
		facts.Metadata["chalk-upload-id"] != upload.UploadID.String() ||
		!strings.EqualFold(facts.Metadata["chalk-sha256"], hex.EncodeToString(upload.SHA256[:])) ||
		strings.TrimSpace(facts.ETag) == "" {
		_ = s.objects.DeleteObject(ctx, upload.ObjectKey)
		_ = s.repository.Fail(ctx, uploadID)
		return ErrFileTransferFailed
	}

	if err := s.repository.Complete(ctx, CompleteInput{UploadID: uploadID, ImmutableObjectIdentity: facts.ETag}); err != nil {
		return err
	}
	return nil
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

func validateInitiate(input InitiateInput) ([32]byte, string, error) {
	var digest [32]byte
	if invalidSubject(input.Subject) || input.SceneID.IsZero() || !validFileID(input.FileID) || input.ByteLength <= 0 || input.ByteLength > maxFileBytes {
		return digest, "", ErrInvalidInput
	}
	decoded, err := hex.DecodeString(input.SHA256)
	if err != nil || len(decoded) != len(digest) {
		return digest, "", ErrInvalidInput
	}
	copy(digest[:], decoded)

	mimeType, _, err := mime.ParseMediaType(strings.TrimSpace(input.MIMEType))
	if err != nil || !strings.HasPrefix(strings.ToLower(mimeType), "image/") {
		return digest, "", ErrInvalidInput
	}
	return digest, strings.ToLower(mimeType), nil
}

func invalidSubject(subject Subject) bool {
	return subject.TenantID.IsZero() || subject.RoomID.IsZero() || subject.SessionID.IsZero() ||
		subject.ParticipantSessionID.IsZero() || subject.ParticipantGeneration <= 0
}

func validFileID(value string) bool {
	return value != "" && utf8.ValidString(value) && len(value) <= maxFileIDBytes
}

func objectKey(subject Subject, sceneID, uploadID utilities.ID) string {
	return strings.Join([]string{
		"whiteboard-v1", "tenants", subject.TenantID.String(), "sessions",
		subject.SessionID.String(), "scenes", sceneID.String(), "uploads",
		uploadID.String(),
	}, "/")
}

func exactHeaders(header map[string][]string) (map[string]string, error) {
	result := make(map[string]string, len(header))
	for name, values := range header {
		if len(values) != 1 || strings.TrimSpace(name) == "" {
			return nil, ErrFileTransferFailed
		}
		result[name] = values[0]
	}
	return result, nil
}
