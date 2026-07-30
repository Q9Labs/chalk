package chatattachments

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"mime"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/q9labs/chalk/apps/api/internal/objectstorage"
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
	ErrCleanupLeaseLost           = errors.New("chat attachment cleanup lease lost")
)

var allowedMIMETypes = map[string]struct{}{
	"image/png":          {},
	"image/jpeg":         {},
	"image/gif":          {},
	"image/webp":         {},
	"application/pdf":    {},
	"text/plain":         {},
	"application/msword": {},
	"application/vnd.openxmlformats-officedocument.wordprocessingml.document": {},
	"application/vnd.ms-excel": {},
	"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet":         {},
	"application/vnd.ms-powerpoint":                                             {},
	"application/vnd.openxmlformats-officedocument.presentationml.presentation": {},
	"application/vnd.oasis.opendocument.text":                                   {},
	"application/vnd.oasis.opendocument.spreadsheet":                            {},
	"application/vnd.oasis.opendocument.presentation":                           {},
}

type Subject struct {
	TenantID              utilities.ID
	RoomID                utilities.ID
	SessionID             utilities.ID
	ParticipantSessionID  utilities.ID
	ParticipantGeneration int64
}

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

func NewService(repository Repository, objects ObjectStore) Service {
	return Service{
		repository: repository,
		objects:    objects,
		now:        time.Now,
		telemetry:  newRequestTelemetry(nil, time.Now),
	}
}

func (s Service) Initiate(
	ctx context.Context,
	input InitiateInput,
) (result UploadInstructions, resultErr error) {
	ctx, finish := s.startRequest(ctx, "initiate")
	defer func() { finish(resultErr) }()

	if s.repository == nil || s.objects == nil {
		return UploadInstructions{}, objectstorage.ErrStoreUnavailable
	}
	fileName, mimeType, digest, fingerprint, err := validateInitiate(input)
	if err != nil {
		return UploadInstructions{}, err
	}
	attachmentID, err := utilities.NewID()
	if err != nil {
		return UploadInstructions{}, fmt.Errorf("generate chat attachment id: %w", err)
	}
	uploadID, err := utilities.NewID()
	if err != nil {
		return UploadInstructions{}, fmt.Errorf("generate chat attachment upload id: %w", err)
	}

	now := s.now().UTC()
	expiresAt := now.Add(uploadLifetime)
	upload, err := s.repository.Reserve(ctx, ReserveInput{
		Subject: input.Subject, ClientAttachmentID: input.ClientAttachmentID,
		Upload: Upload{
			Attachment: Attachment{
				AttachmentID: attachmentID, FileName: fileName,
				MIMEType: mimeType, ByteLength: input.ByteLength,
			},
			UploadID: uploadID, ObjectKey: objectKey(input.Subject, uploadID),
			SHA256: digest, RequestFingerprint: fingerprint, Status: "pending",
			ExpiresAt: expiresAt,
		},
	})
	if err != nil {
		return UploadInstructions{}, err
	}
	if upload.Status != "pending" || !upload.ExpiresAt.After(now) {
		return UploadInstructions{}, ErrUploadExpired
	}

	signed, err := s.objects.CreateUploadURL(ctx, objectstorage.CreateUploadURLInput{
		Key: upload.ObjectKey, ContentType: upload.MIMEType, ContentLength: upload.ByteLength,
		ChecksumSHA256: base64.StdEncoding.EncodeToString(upload.SHA256[:]),
		ExpiresIn:      upload.ExpiresAt.Sub(now), IfNoneMatch: true,
		Metadata: map[string]string{
			"chalk-upload-id":     upload.UploadID.String(),
			"chalk-attachment-id": upload.AttachmentID.String(),
		},
	})
	if err != nil {
		_ = s.repository.Fail(ctx, upload.UploadID, utilities.ID{})
		return UploadInstructions{}, fmt.Errorf("create chat attachment upload url: %w", err)
	}
	headers, err := signedHeaders(signed.SignedHeader)
	if err != nil {
		_ = s.repository.Fail(ctx, upload.UploadID, utilities.ID{})
		return UploadInstructions{}, err
	}

	return UploadInstructions{
		AttachmentID: upload.AttachmentID, UploadID: upload.UploadID,
		Method: signed.Method, URL: signed.URL, Headers: headers, ExpiresAt: signed.ExpiresAt,
	}, nil
}

func (s Service) Finalize(
	ctx context.Context,
	subject Subject,
	uploadID utilities.ID,
) (result Attachment, resultErr error) {
	ctx, finish := s.startRequest(ctx, "finalize")
	defer func() { finish(resultErr) }()

	if s.repository == nil || s.objects == nil || invalidSubject(subject) || uploadID.IsZero() {
		return Attachment{}, ErrInvalidInput
	}
	now := s.now().UTC()
	upload, err := s.repository.ClaimFinalize(
		ctx,
		subject,
		uploadID,
		now,
		now.Add(finalizeLeaseDuration),
	)
	if err != nil {
		return Attachment{}, err
	}
	if upload.Status == "ready" || upload.Status == "attached" {
		return upload.Attachment, nil
	}

	facts, err := s.objects.InspectObject(ctx, upload.ObjectKey)
	if err != nil {
		_ = s.repository.Fail(ctx, uploadID, upload.FinalizeClaimToken)
		return Attachment{}, fmt.Errorf("inspect chat attachment upload: %w", err)
	}
	if facts.Size != upload.ByteLength ||
		!strings.EqualFold(facts.ContentType, upload.MIMEType) ||
		facts.Metadata["chalk-upload-id"] != upload.UploadID.String() ||
		facts.Metadata["chalk-attachment-id"] != upload.AttachmentID.String() ||
		strings.TrimSpace(facts.ETag) == "" {
		return Attachment{}, s.rejectUpload(ctx, upload)
	}

	matches, err := s.objectDigestMatches(ctx, upload)
	if err != nil {
		_ = s.repository.Fail(ctx, uploadID, upload.FinalizeClaimToken)
		return Attachment{}, err
	}
	if !matches {
		return Attachment{}, s.rejectUpload(ctx, upload)
	}
	completedAt := s.now().UTC()
	if err := s.repository.Complete(ctx, CompleteInput{
		UploadID: uploadID, FinalizeClaimToken: upload.FinalizeClaimToken,
		ImmutableObjectIdentity: facts.ETag,
		ExpiresAt:               completedAt.Add(unattachedLifetime),
		Now:                     completedAt,
	}); err != nil {
		return Attachment{}, err
	}
	return upload.Attachment, nil
}

func (s Service) Download(
	ctx context.Context,
	subject Subject,
	attachmentID utilities.ID,
) (result Download, resultErr error) {
	ctx, finish := s.startRequest(ctx, "download")
	defer func() { finish(resultErr) }()

	if s.repository == nil || s.objects == nil || invalidSubject(subject) || attachmentID.IsZero() {
		return Download{}, ErrInvalidInput
	}
	attachment, err := s.repository.AuthorizedDownload(ctx, subject, attachmentID)
	if err != nil {
		return Download{}, err
	}
	input := objectstorage.CreateDownloadURLInput{Key: attachment.ObjectKey, ExpiresIn: downloadLifetime}
	if !previewable(attachment.MIMEType) {
		input.ContentDisposition = mime.FormatMediaType("attachment", map[string]string{"filename": attachment.FileName})
	}
	signed, err := s.objects.CreateDownloadURL(ctx, input)
	if err != nil {
		return Download{}, fmt.Errorf("create chat attachment download url: %w", err)
	}
	return Download{URL: signed.URL, ExpiresAt: signed.ExpiresAt}, nil
}

func (s Service) objectDigestMatches(ctx context.Context, upload Upload) (bool, error) {
	object, err := s.objects.GetObject(ctx, upload.ObjectKey)
	if err != nil {
		return false, fmt.Errorf("read chat attachment upload: %w", err)
	}
	defer object.Body.Close()

	digest := sha256.New()
	read, err := io.CopyN(digest, object.Body, upload.ByteLength+1)
	if err != nil && !errors.Is(err, io.EOF) {
		return false, fmt.Errorf("hash chat attachment upload: %w", err)
	}
	if read != upload.ByteLength {
		return false, nil
	}
	return bytes.Equal(digest.Sum(nil), upload.SHA256[:]), nil
}

func (s Service) rejectUpload(ctx context.Context, upload Upload) error {
	_ = s.objects.DeleteObject(ctx, upload.ObjectKey)
	_ = s.repository.Fail(ctx, upload.UploadID, upload.FinalizeClaimToken)
	return ErrFileTransferFailed
}

func (s Service) startRequest(
	ctx context.Context,
	operation string,
) (context.Context, func(error)) {
	if s.telemetry == nil {
		return ctx, func(error) {}
	}
	return s.telemetry.start(ctx, operation)
}

func validateInitiate(input InitiateInput) (string, string, [32]byte, [32]byte, error) {
	var digest [32]byte
	var fingerprint [32]byte
	if invalidSubject(input.Subject) ||
		len(input.ClientAttachmentID) < minClientAttachmentIDBytes ||
		len(input.ClientAttachmentID) > maxClientAttachmentIDBytes ||
		input.ByteLength <= 0 ||
		input.ByteLength > maxFileBytes {
		return "", "", digest, fingerprint, ErrInvalidInput
	}
	fileName, ok := validFileName(input.FileName)
	if !ok {
		return "", "", digest, fingerprint, ErrInvalidInput
	}
	mimeType, _, err := mime.ParseMediaType(strings.TrimSpace(input.MIMEType))
	mimeType = strings.ToLower(mimeType)
	if err != nil {
		return "", "", digest, fingerprint, ErrInvalidInput
	}
	if _, ok := allowedMIMETypes[mimeType]; !ok {
		return "", "", digest, fingerprint, ErrInvalidInput
	}
	decoded, err := hex.DecodeString(input.SHA256)
	if err != nil || len(decoded) != len(digest) || input.SHA256 != strings.ToLower(input.SHA256) {
		return "", "", digest, fingerprint, ErrInvalidInput
	}
	copy(digest[:], decoded)
	fingerprint = sha256.Sum256([]byte(fmt.Sprintf(
		"chat-attachment-v1\x00%s\x00%s\x00%d\x00%s",
		fileName, mimeType, input.ByteLength, input.SHA256,
	)))
	return fileName, mimeType, digest, fingerprint, nil
}

func validFileName(value string) (string, bool) {
	value = strings.TrimSpace(value)
	if value == "" || value == "." || value == ".." || !utf8.ValidString(value) ||
		len(value) > maxFileNameBytes || strings.ContainsAny(value, `/\`) {
		return "", false
	}
	for _, character := range value {
		if unicode.IsControl(character) {
			return "", false
		}
	}
	return value, true
}

func invalidSubject(subject Subject) bool {
	return subject.TenantID.IsZero() || subject.RoomID.IsZero() || subject.SessionID.IsZero() ||
		subject.ParticipantSessionID.IsZero() || subject.ParticipantGeneration <= 0
}

func previewable(mimeType string) bool {
	return mimeType == "image/png" || mimeType == "image/jpeg" ||
		mimeType == "image/gif" || mimeType == "image/webp"
}

func objectKey(subject Subject, uploadID utilities.ID) string {
	return strings.Join([]string{
		"chat-attachments-v1", "tenants", subject.TenantID.String(),
		"sessions", subject.SessionID.String(), "uploads", uploadID.String(),
	}, "/")
}

func signedHeaders(header map[string][]string) (map[string]string, error) {
	result := make(map[string]string, len(header))
	for name, values := range header {
		if len(values) != 1 || strings.TrimSpace(name) == "" {
			return nil, ErrFileTransferFailed
		}
		result[name] = values[0]
	}
	return result, nil
}
