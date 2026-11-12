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
	"github.com/q9labs/chalk/apps/api/internal/transcripts"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

// buildTranscription wires Transcript storage, the worker boundary and the
// Recording source cleanup. The durable cleanup queue also owns Recording source
// expiry, so a Recording-only deployment still builds the service: turning ASR
// off must not strand capture inputs past their immutable retention deadline.
func (w *wiring) buildTranscription() error {
	cfg := w.cfg
	if cfg.Capabilities.Recording || cfg.Capabilities.Transcription {
		w.transcripts = transcripts.NewService(postgres.NewTranscriptRepositoryWithPool(w.queries, w.pool))
	}
	w.opts.TranscriptTextMetadata = postgres.NewTranscriptTextRepository(w.queries)
	if cfg.Capabilities.Transcription {
		if err := w.buildTranscriptionWorkers(); err != nil {
			return err
		}
	}
	if cfg.Capabilities.Recording && !cfg.Capabilities.Transcription {
		if w.storage == nil {
			return errors.New("recording source cleanup requires configured R2 object storage")
		}
		worker := transcripts.NewLocalCleanupWorker(w.transcripts, *w.storage)
		scheduler := transcripts.NewLocalCleanupScheduler(worker, 0, w.obs.logger)
		w.jobs = append(w.jobs, backgroundJob{name: "recording source cleanup", awaited: true, run: scheduler.Run})
	}
	return nil
}

func (w *wiring) buildTranscriptionWorkers() error {
	cfg := w.cfg
	if w.redis == nil || w.storage == nil {
		return errors.New("transcription workload auth requires Redis and R2")
	}
	waker, err := lambdawaker.New(context.Background(), cfg.Transcription.DispatcherFunction, cfg.RecordingKMS.Region, w.obs.logger)
	if err != nil {
		return fmt.Errorf("configure transcription dispatcher wake (%s): %w", config.RecordingKMSRegion, err)
	}
	w.transcripts = w.transcripts.WithDispatcherWaker(waker)
	w.dispatcherWake = func(ctx context.Context, jobID utilities.ID) {
		waker.Wake(ctx, transcripts.DispatcherWakeInput{JobID: jobID})
	}
	authority := &transcriptionObjectAuthority{storage: *w.storage}
	w.opts.TranscriptArtifacts = w.transcripts
	w.opts.TranscriptWorker = w.transcripts
	w.opts.WorkloadAuthorizer = httpapi.NewHMACWorkloadAuthorizer(httpapi.HMACWorkloadAuthorizerConfig{
		Secret:      []byte(cfg.Transcription.WorkloadAuthSecret),
		Environment: cfg.Observability.Environment,
		ReleaseID:   cfg.Observability.Version,
		Audience:    cfg.Transcription.ControlAudience,
		Nonces:      redisadapter.NewWorkloadNonceStore(w.redis),
	})
	w.opts.ChunkAuthority = authority
	w.opts.ManifestAuthority = authority
	w.opts.ResultAuthority = authority
	w.opts.CleanupWorker = w.transcripts
	w.opts.CleanupDeleteAuthority = authority
	w.opts.FinalizerWorker = w.transcripts
	w.opts.FinalizerAuthority = authority
	return nil
}
