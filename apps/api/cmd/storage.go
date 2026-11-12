package main

import (
	"fmt"

	r2adapter "github.com/q9labs/chalk/apps/api/internal/adapters/cloudflare/r2"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres"
	"github.com/q9labs/chalk/apps/api/internal/chatattachments"
	"github.com/q9labs/chalk/apps/api/internal/config"
	"github.com/q9labs/chalk/apps/api/internal/objectstorage"
	"github.com/q9labs/chalk/apps/api/internal/whiteboardfiles"
)

func r2Configured(cfg config.R2Config) bool {
	return cfg.Bucket != "" || cfg.AccountID != "" || cfg.Endpoint != "" || cfg.AccessKeyID != "" || cfg.SecretAccessKey != ""
}

// buildObjectStorage wires R2 and the services that use it: Recording
// downloads, chat attachments and whiteboard files. Without R2 none exists.
func (w *wiring) buildObjectStorage() error {
	if !r2Configured(w.cfg.R2) {
		return nil
	}
	store, err := r2adapter.NewStore(w.cfg.R2)
	if err != nil {
		return fmt.Errorf("configure r2 object storage: %w", err)
	}
	storage := objectstorage.NewService(store)
	w.storage = &storage
	w.opts.RecordingDownloads = storage
	w.opts.RecordingObjects = storage
	w.buildChatAttachments(storage)
	if w.cfg.Capabilities.WhiteboardFiles {
		w.buildWhiteboardFiles(storage)
	}
	return nil
}

func (w *wiring) buildChatAttachments(storage objectstorage.Service) {
	repository := postgres.NewChatAttachmentRepository(w.pool)
	scheduler := chatattachments.NewCleanupScheduler(chatattachments.NewCleanupWorker(repository, storage), 0, w.obs.logger)
	w.jobs = append(w.jobs, backgroundJob{name: "chat cleanup", awaited: true, run: scheduler.Run})
	if w.syncVerifierConfigured {
		w.opts.ChatAttachments = chatattachments.NewService(repository, storage)
		w.opts.ChatParticipants = chatattachments.NewParticipantVerifier(w.syncParticipantVerifier)
	}
}

func (w *wiring) buildWhiteboardFiles(storage objectstorage.Service) {
	repository := postgres.NewWhiteboardFileRepository(w.pool)
	scheduler := whiteboardfiles.NewCleanupScheduler(whiteboardfiles.NewCleanupWorker(repository, storage), 0, w.obs.logger)
	w.jobs = append(w.jobs, backgroundJob{name: "whiteboard cleanup", awaited: true, run: scheduler.Run})
	if w.syncVerifierConfigured {
		w.opts.WhiteboardFiles = whiteboardfiles.NewService(repository, storage)
		w.opts.WhiteboardParticipants = whiteboardfiles.NewParticipantVerifier(w.syncParticipantVerifier)
	}
}
