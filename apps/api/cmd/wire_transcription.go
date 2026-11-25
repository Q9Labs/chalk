package main

import (
	"context"
	"errors"
	"fmt"

	lambdawaker "github.com/q9labs/chalk/apps/api/internal/adapters/aws/lambdawaker"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres"
	redisadapter "github.com/q9labs/chalk/apps/api/internal/adapters/redis"
	"github.com/q9labs/chalk/apps/api/internal/config"
	"github.com/q9labs/chalk/apps/api/internal/httpapi"
	"github.com/q9labs/chalk/apps/api/internal/presenting"
	"github.com/q9labs/chalk/apps/api/internal/transcripts"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

func (w *apiWiring) wireTranscription() error {
	var transcriptService transcripts.Service
	var transcriptionAuthority *transcriptionObjectAuthority
	// The durable cleanup queue also owns Recording source expiry. Construct it
	// for Recording-only deployments so turning ASR off cannot strand capture
	// inputs past their immutable retention deadline.
	if w.cfg.Capabilities.Recording || w.cfg.Capabilities.Transcription {
		transcriptRepository := postgres.NewTranscriptRepositoryWithPool(w.queries, w.pool)
		transcriptService = transcripts.NewService(transcriptRepository)
	}
	if w.cfg.Capabilities.Transcription {
		if w.redisClient == nil || w.recordingStorage == nil {
			return errors.New("transcription workload auth requires Redis and R2")
		}
		waker, err := lambdawaker.New(context.Background(), w.cfg.Transcription.DispatcherFunction, w.cfg.RecordingKMS.Region, w.logger)
		if err != nil {
			return fmt.Errorf("configure transcription dispatcher wake (%s): %w", config.RecordingKMSRegion, err)
		}
		transcriptService = transcriptService.WithDispatcherWaker(waker)
		w.recordingDispatcherWake = func(ctx context.Context, jobID utilities.ID) {
			waker.Wake(ctx, transcripts.DispatcherWakeInput{JobID: jobID})
		}
		authority := transcriptionObjectAuthority{storage: *w.recordingStorage}
		transcriptionAuthority = &authority
		nonces := redisadapter.NewWorkloadNonceStore(w.redisClient)
		authorizer := httpapi.NewHMACWorkloadAuthorizer(httpapi.HMACWorkloadAuthorizerConfig{
			Secret:      []byte(w.cfg.Transcription.WorkloadAuthSecret),
			Environment: w.cfg.Observability.Environment,
			ReleaseID:   w.cfg.Observability.Version,
			Audience:    w.cfg.Transcription.ControlAudience,
			Nonces:      nonces,
		})
		w.options.TranscriptArtifacts = transcriptService
		w.options.TranscriptWorker = transcriptService
		w.options.WorkloadAuthorizer = authorizer
	}
	if w.cfg.Capabilities.Recording && !w.cfg.Capabilities.Transcription {
		if w.recordingStorage == nil {
			return errors.New("recording source cleanup requires configured R2 object storage")
		}
		worker := transcripts.NewLocalCleanupWorker(transcriptService, *w.recordingStorage)
		w.recordingSourceCleanupScheduler = transcripts.NewLocalCleanupScheduler(worker, 0, w.logger)
	}

	if w.cfg.Capabilities.Presenting {
		capabilitySigner, err := presenting.NewCapabilitySigner(w.cfg.Presenting.CapabilitySecret)
		if err != nil {
			return fmt.Errorf("configure presenting render capability verification: %w", err)
		}
		w.options.PresentingCapabilityAuthorizer = httpapi.NewHMACPresentingCapabilityAuthorizer(capabilitySigner)
	}

	// Keep worker control behind the internal workload boundary.
	w.options.TranscriptTextMetadata = postgres.NewTranscriptTextRepository(w.queries)
	w.options.ChunkAuthority = transcriptionAuthority
	w.options.ManifestAuthority = transcriptionAuthority
	w.options.ResultAuthority = transcriptionAuthority
	w.options.CleanupWorker = transcriptService
	w.options.CleanupDeleteAuthority = transcriptionAuthority
	w.options.FinalizerWorker = transcriptService
	w.options.FinalizerAuthority = transcriptionAuthority
	return nil
}
