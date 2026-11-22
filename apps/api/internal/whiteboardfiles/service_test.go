package whiteboardfiles

import (
	"context"
	"errors"
	"testing"

	"github.com/q9labs/chalk/apps/api/internal/objectstorage"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

func TestDownloadRejectsLegacySVG(t *testing.T) {
	id := utilities.IDFromBytes([16]byte{1})
	subject := Subject{TenantID: id, SpaceID: id, EpisodeID: id, ParticipantID: id, ParticipantGeneration: 1}
	objects := &downloadSigner{}
	service := NewService(readyFileRepository{file: Upload{MIMEType: "image/svg+xml", ObjectKey: "whiteboard/legacy"}}, objects)

	download, err := service.Download(t.Context(), subject, "legacy-image")
	if !errors.Is(err, ErrFileNotFound) || download != (Download{}) || objects.called {
		t.Fatalf("legacy SVG must return not found without signing: err=%v signed=%t", err, objects.called)
	}
}

type readyFileRepository struct {
	Repository
	file Upload
}

func (repository readyFileRepository) ReadyFile(context.Context, Subject, string) (Upload, error) {
	return repository.file, nil
}

type downloadSigner struct {
	ObjectStore
	called bool
}

func (signer *downloadSigner) CreateDownloadURL(context.Context, objectstorage.CreateDownloadURLInput) (objectstorage.SignedURL, error) {
	signer.called = true
	return objectstorage.SignedURL{URL: "https://storage.example.test/file"}, nil
}
