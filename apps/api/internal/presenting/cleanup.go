package presenting

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/objectcleanup"
	"github.com/q9labs/chalk/apps/api/internal/objectstorage"
)

type CleanupWorker struct {
	repository Repository
	objects    ObjectStore
	now        func() time.Time
}

func NewCleanupWorker(repository Repository, objects ObjectStore) CleanupWorker {
	return CleanupWorker{repository: repository, objects: objects, now: time.Now}
}

func (w CleanupWorker) Kind() objectcleanup.Kind {
	return objectcleanup.Kind{Name: "presenting_documents", Label: "Presenting document"}
}

func (w CleanupWorker) Run(ctx context.Context) (objectcleanup.Result, error) {
	if w.repository == nil || w.objects == nil {
		return objectcleanup.Result{}, objectcleanup.ErrInvalidConfig
	}
	var result objectcleanup.Result
	for batch := 0; batch < 4; batch++ {
		result.Batches++
		documents, err := w.repository.ListExpiredDocuments(ctx, w.now().UTC(), w.now().UTC().Add(-objectcleanup.Retention), 50)
		if err != nil {
			return result, err
		}
		if len(documents) == 0 {
			return result, nil
		}
		result.Claimed += len(documents)
		for _, document := range documents {
			if err := w.deleteDocumentObjects(ctx, document); err != nil {
				result.Failed++
				continue
			}
			if err := w.repository.DeleteDocument(ctx, document); err != nil {
				result.Failed++
				continue
			}
			result.Deleted++
		}
	}
	return result, nil
}

func (w CleanupWorker) deleteDocumentObjects(ctx context.Context, document Document) error {
	for page := 1; page <= document.PageCount; page++ {
		keys := []string{
			imageKey(document.TenantID, document.SpaceID, document.EpisodeID, document.DocumentID, page),
			thumbnailKey(document.TenantID, document.SpaceID, document.EpisodeID, document.DocumentID, page),
			zoomKey(document.TenantID, document.SpaceID, document.EpisodeID, document.DocumentID, page),
		}
		for _, key := range keys {
			if err := w.objects.DeleteObject(ctx, key); err != nil && !errors.Is(err, objectstorage.ErrObjectNotFound) {
				return fmt.Errorf("delete presenting page object: %w", err)
			}
		}
	}
	return nil
}

var _ objectcleanup.Cycle = CleanupWorker{}
