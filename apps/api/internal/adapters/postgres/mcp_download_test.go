package postgres

import (
	"context"
	"errors"
	"net/http"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/objectstorage"
)

// Only object signing is external to the Postgres-backed application proof.
type mcpDownloadStore struct {
	objectstorage.Store
	key string
}

func (s mcpDownloadStore) CreateDownloadURL(_ context.Context, input objectstorage.CreateDownloadURLInput) (objectstorage.SignedURL, error) {
	if input.Key != s.key || input.ExpiresIn != time.Minute {
		return objectstorage.SignedURL{}, errors.New("incorrect download authorization binding")
	}
	return objectstorage.SignedURL{Method: http.MethodGet, URL: "https://objects.invalid/mcp-fixture.mp4", SignedAt: time.Now(), ExpiresAt: time.Now().Add(input.ExpiresIn)}, nil
}
