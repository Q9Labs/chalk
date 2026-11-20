package main

import (
	"fmt"

	r2adapter "github.com/q9labs/chalk/apps/api/internal/adapters/cloudflare/r2"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres"
	"github.com/q9labs/chalk/apps/api/internal/chatattachments"
	"github.com/q9labs/chalk/apps/api/internal/config"
	"github.com/q9labs/chalk/apps/api/internal/objectcleanup"
	"github.com/q9labs/chalk/apps/api/internal/objectstorage"
	"github.com/q9labs/chalk/apps/api/internal/whiteboardfiles"
)

func (w *apiWiring) wireStorage() error {
	if r2Configured(w.cfg.R2) {
		store, err := r2adapter.NewStore(w.cfg.R2)
		if err != nil {
			return fmt.Errorf("configure r2 object storage: %w", err)
		}
		storage := objectstorage.NewService(store)
		w.recordingStorage = &storage
		w.options.RecordingDownloads = storage
		w.options.RecordingObjects = storage
		chatRepository := postgres.NewChatAttachmentRepository(w.pool)
		chatCleanupWorker := chatattachments.NewCleanupWorker(chatRepository, storage)
		w.chatCleanupScheduler = objectcleanup.NewScheduler(chatCleanupWorker, 0, w.logger)
		if w.syncParticipantVerifierConfigured {
			chatService := chatattachments.NewService(chatRepository, storage)
			w.options.ChatAttachments = chatService
			w.options.ChatParticipants = w.syncParticipantVerifier
		}
		if w.cfg.Capabilities.WhiteboardFiles {
			whiteboardRepository := postgres.NewWhiteboardFileRepository(w.pool)
			whiteboardCleanupWorker := whiteboardfiles.NewCleanupWorker(whiteboardRepository, storage)
			w.whiteboardCleanupScheduler = objectcleanup.NewScheduler(whiteboardCleanupWorker, 0, w.logger)
			if w.syncParticipantVerifierConfigured {
				service := whiteboardfiles.NewService(whiteboardRepository, storage)
				w.options.WhiteboardFiles = service
				w.options.WhiteboardParticipants = w.syncParticipantVerifier
			}
		}
	}
	return nil
}

func r2Configured(cfg config.R2Config) bool {
	return cfg.Bucket != "" || cfg.AccountID != "" || cfg.Endpoint != "" || cfg.AccessKeyID != "" || cfg.SecretAccessKey != ""
}
