package objectstorage

import (
	"context"
	"errors"
	"io"
	"time"
)

var (
	ErrInvalidObjectKey     = errors.New("invalid object key")
	ErrInvalidContentType   = errors.New("invalid object content type")
	ErrInvalidObjectBody    = errors.New("invalid object body")
	ErrInvalidObjectSize    = errors.New("invalid object size")
	ErrInvalidMetadata      = errors.New("invalid object metadata")
	ErrInvalidChecksum      = errors.New("invalid object checksum")
	ErrInvalidDisposition   = errors.New("invalid content disposition")
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
	Key            string
	ContentType    string
	ContentLength  int64
	ChecksumSHA256 string
	ExpiresIn      time.Duration
	Metadata       map[string]string
	IfNoneMatch    bool
}

type CreateDownloadURLInput struct {
	Key                string
	VersionID          string
	IfMatch            string
	ContentDisposition string
	ExpiresIn          time.Duration
}

type CreateDeleteURLInput struct {
	Key       string
	ExpiresIn time.Duration
}

type Object struct {
	Key            string
	ETag           string
	VersionID      string
	ChecksumSHA256 string
	ContentType    string
	Size           int64
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
