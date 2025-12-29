package storage

import (
	"context"
	"io"
	"time"
)

// StorageClient defines the interface for file storage operations
type StorageClient interface {
	// Upload uploads a file to storage
	Upload(ctx context.Context, key string, body io.Reader, contentType string) error

	// Download returns a reader for the file
	Download(ctx context.Context, key string) (io.ReadCloser, error)

	// GetPresignedURL generates a time-limited download URL
	GetPresignedURL(ctx context.Context, key string, expiry time.Duration) (string, error)

	// Delete removes a file from storage
	Delete(ctx context.Context, key string) error

	// Exists checks if a file exists
	Exists(ctx context.Context, key string) (bool, error)

	// ListByPrefix lists files with a given prefix
	ListByPrefix(ctx context.Context, prefix string) ([]StorageObject, error)
}

// StorageObject represents a file stored in cloud storage
type StorageObject struct {
	Key          string
	Size         int64
	LastModified time.Time
	ContentType  string
}
