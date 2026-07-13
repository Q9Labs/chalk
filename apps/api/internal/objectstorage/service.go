package objectstorage

import (
	"context"
	"errors"
	"io"
	"mime"
	"strings"
	"time"
	"unicode"
)

const maxObjectKeyBytes = 1024

const (
	maxMetadataEntries    = 16
	maxMetadataKeyBytes   = 64
	maxMetadataValueBytes = 256
)

var (
	ErrInvalidObjectKey     = errors.New("invalid object key")
	ErrInvalidContentType   = errors.New("invalid object content type")
	ErrInvalidObjectBody    = errors.New("invalid object body")
	ErrInvalidObjectSize    = errors.New("invalid object size")
	ErrInvalidMetadata      = errors.New("invalid object metadata")
	ErrInvalidURLExpiration = errors.New("invalid object url expiration")
	ErrStoreUnavailable     = errors.New("object store unavailable")
	ErrObjectNotFound       = errors.New("object not found")
	ErrObjectAlreadyExists  = errors.New("object already exists")
	ErrProviderFailed       = errors.New("object storage provider failed")
)

type Store interface {
	PutObject(ctx context.Context, input PutObjectInput) (Object, error)
	GetObject(ctx context.Context, key string) (ObjectReader, error)
	InspectObject(ctx context.Context, key string) (ObjectFacts, error)
	DeleteObject(ctx context.Context, key string) error
	CreateUploadURL(ctx context.Context, input CreateUploadURLInput) (SignedURL, error)
	CreateDownloadURL(ctx context.Context, input CreateDownloadURLInput) (SignedURL, error)
	CreateDeleteURL(ctx context.Context, input CreateDeleteURLInput) (SignedURL, error)
}

type Service struct {
	store Store
}

type PutObjectInput struct {
	Key           string
	Body          io.Reader
	ContentType   string
	ContentLength int64
	CacheControl  string
	Metadata      map[string]string
	IfNoneMatch   bool
}

type CreateUploadURLInput struct {
	Key           string
	ContentType   string
	ContentLength int64
	ExpiresIn     time.Duration
	Metadata      map[string]string
	IfNoneMatch   bool
}

type CreateDownloadURLInput struct {
	Key       string
	ExpiresIn time.Duration
}

type CreateDeleteURLInput struct {
	Key       string
	ExpiresIn time.Duration
}

type Object struct {
	Key         string
	ETag        string
	ContentType string
	Size        int64
}

type ObjectReader struct {
	Object
	Body         io.ReadCloser
	LastModified time.Time
	Metadata     map[string]string
}

type ObjectFacts struct {
	Object
	LastModified time.Time
	Metadata     map[string]string
}

type SignedURL struct {
	Method       string
	URL          string
	SignedAt     time.Time
	ExpiresAt    time.Time
	SignedHeader map[string][]string
}

func NewService(store Store) Service {
	return Service{store: store}
}

func (s Service) PutObject(ctx context.Context, input PutObjectInput) (Object, error) {
	if s.store == nil {
		return Object{}, ErrStoreUnavailable
	}
	if err := normalizePutObjectInput(&input); err != nil {
		return Object{}, err
	}

	return s.store.PutObject(ctx, input)
}

func (s Service) GetObject(ctx context.Context, key string) (ObjectReader, error) {
	if s.store == nil {
		return ObjectReader{}, ErrStoreUnavailable
	}

	key, err := objectKey(key)
	if err != nil {
		return ObjectReader{}, ErrInvalidObjectKey
	}

	return s.store.GetObject(ctx, key)
}

func (s Service) InspectObject(ctx context.Context, key string) (ObjectFacts, error) {
	if s.store == nil {
		return ObjectFacts{}, ErrStoreUnavailable
	}

	key, err := objectKey(key)
	if err != nil {
		return ObjectFacts{}, ErrInvalidObjectKey
	}

	return s.store.InspectObject(ctx, key)
}

func (s Service) DeleteObject(ctx context.Context, key string) error {
	if s.store == nil {
		return ErrStoreUnavailable
	}

	key, err := objectKey(key)
	if err != nil {
		return ErrInvalidObjectKey
	}

	return s.store.DeleteObject(ctx, key)
}

func (s Service) CreateUploadURL(ctx context.Context, input CreateUploadURLInput) (SignedURL, error) {
	if s.store == nil {
		return SignedURL{}, ErrStoreUnavailable
	}
	if err := normalizeCreateUploadURLInput(&input); err != nil {
		return SignedURL{}, err
	}

	return s.store.CreateUploadURL(ctx, input)
}

func (s Service) CreateDownloadURL(ctx context.Context, input CreateDownloadURLInput) (SignedURL, error) {
	if s.store == nil {
		return SignedURL{}, ErrStoreUnavailable
	}
	if err := normalizeCreateDownloadURLInput(&input); err != nil {
		return SignedURL{}, err
	}

	return s.store.CreateDownloadURL(ctx, input)
}

func (s Service) CreateDeleteURL(ctx context.Context, input CreateDeleteURLInput) (SignedURL, error) {
	if s.store == nil {
		return SignedURL{}, ErrStoreUnavailable
	}
	key, err := objectKey(input.Key)
	if err != nil {
		return SignedURL{}, ErrInvalidObjectKey
	}
	if input.ExpiresIn <= 0 {
		return SignedURL{}, ErrInvalidURLExpiration
	}
	input.Key = key
	return s.store.CreateDeleteURL(ctx, input)
}

func normalizePutObjectInput(input *PutObjectInput) error {
	key, err := objectKey(input.Key)
	if err != nil {
		return ErrInvalidObjectKey
	}
	input.Key = key

	contentType, err := contentType(input.ContentType)
	if err != nil {
		return ErrInvalidContentType
	}
	input.ContentType = contentType

	if input.Body == nil || input.ContentLength < 0 {
		return ErrInvalidObjectBody
	}
	if err := validateMetadata(input.Metadata); err != nil {
		return err
	}

	return nil
}

func normalizeCreateUploadURLInput(input *CreateUploadURLInput) error {
	key, err := objectKey(input.Key)
	if err != nil {
		return ErrInvalidObjectKey
	}
	input.Key = key

	contentType, err := contentType(input.ContentType)
	if err != nil {
		return ErrInvalidContentType
	}
	input.ContentType = contentType

	if input.ExpiresIn <= 0 {
		return ErrInvalidURLExpiration
	}
	if input.ContentLength < 0 || (input.IfNoneMatch && input.ContentLength == 0) {
		return ErrInvalidObjectSize
	}
	if err := validateMetadata(input.Metadata); err != nil {
		return err
	}

	return nil
}

func normalizeCreateDownloadURLInput(input *CreateDownloadURLInput) error {
	key, err := objectKey(input.Key)
	if err != nil {
		return ErrInvalidObjectKey
	}
	input.Key = key

	if input.ExpiresIn <= 0 {
		return ErrInvalidURLExpiration
	}

	return nil
}

func ValidateKey(value string) error {
	_, err := objectKey(value)
	return err
}

func objectKey(value string) (string, error) {
	value = strings.TrimSpace(value)
	if value == "" || len(value) > maxObjectKeyBytes || strings.HasPrefix(value, "/") {
		return "", ErrInvalidObjectKey
	}

	for _, part := range strings.Split(value, "/") {
		if part == "" || part == "." || part == ".." {
			return "", ErrInvalidObjectKey
		}
	}
	for _, char := range value {
		if unicode.IsControl(char) {
			return "", ErrInvalidObjectKey
		}
	}

	return value, nil
}

func contentType(value string) (string, error) {
	value = strings.TrimSpace(value)
	if value == "" || strings.ContainsFunc(value, unicode.IsControl) {
		return "", ErrInvalidContentType
	}
	mediaType, _, err := mime.ParseMediaType(value)
	if err != nil || !strings.Contains(mediaType, "/") {
		return "", ErrInvalidContentType
	}

	return value, nil
}

func validateMetadata(metadata map[string]string) error {
	if len(metadata) > maxMetadataEntries {
		return ErrInvalidMetadata
	}

	for key, value := range metadata {
		if key == "" || len(key) > maxMetadataKeyBytes || len(value) > maxMetadataValueBytes {
			return ErrInvalidMetadata
		}
		for _, char := range key {
			if !(char >= 'a' && char <= 'z') && !(char >= '0' && char <= '9') && char != '-' && char != '_' {
				return ErrInvalidMetadata
			}
		}
		if strings.ContainsFunc(value, unicode.IsControl) {
			return ErrInvalidMetadata
		}
	}

	return nil
}
