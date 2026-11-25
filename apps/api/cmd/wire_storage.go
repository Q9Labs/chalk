package main

import (
	"context"
	"fmt"
	"strings"

	r2adapter "github.com/q9labs/chalk/apps/api/internal/adapters/cloudflare/r2"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres"
	"github.com/q9labs/chalk/apps/api/internal/chatattachments"
	"github.com/q9labs/chalk/apps/api/internal/config"
	"github.com/q9labs/chalk/apps/api/internal/objectcleanup"
	"github.com/q9labs/chalk/apps/api/internal/objectstorage"
	"github.com/q9labs/chalk/apps/api/internal/presenting"
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
		if w.cfg.Capabilities.Presenting {
			var invoker presenting.RendererInvoker
			if strings.TrimSpace(w.cfg.Presenting.RendererEndpoint) != "" {
				invoker = presenting.NewHTTPInvoker(w.cfg.Presenting.RendererEndpoint)
			} else {
				lambdaInvoker, err := presenting.NewLambdaInvoker(context.Background(), w.cfg.Presenting.RendererFunction, w.cfg.RecordingKMS.Region)
				if err != nil {
					return fmt.Errorf("configure presenting renderer invoke: %w", err)
				}
				invoker = lambdaInvoker
			}
			if w.syncParticipantVerifierConfigured {
				presentingRepository := postgres.NewPresentingRepository(w.pool)
				w.presentingCleanupScheduler = objectcleanup.NewScheduler(presenting.NewCleanupWorker(presentingRepository, storage), 0, w.logger)
				capabilitySigner, err := presenting.NewCapabilitySigner(w.cfg.Presenting.CapabilitySecret)
				if err != nil {
					return fmt.Errorf("configure presenting render capabilities: %w", err)
				}
				service := presenting.NewService(presentingRepository, storage, invoker).WithCapabilitySigner(capabilitySigner).WithAvailability(postgres.PresentingSettings{Queries: w.queries, DefaultEnabled: w.cfg.Capabilities.Presenting}.Enabled)
				w.options.Presenting = service
				w.presentingReconcileScheduler = objectcleanup.NewScheduler(presenting.NewReconcileWorker(service), presenting.ReconcileInterval, w.logger)
			}
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
