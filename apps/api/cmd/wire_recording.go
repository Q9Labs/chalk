package main

import (
	"context"
	"errors"
	"fmt"
	"time"

	recordingkms "github.com/q9labs/chalk/apps/api/internal/adapters/aws/recordingkms"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres"
	"github.com/q9labs/chalk/apps/api/internal/recorderhealth"
	"github.com/q9labs/chalk/apps/api/internal/recordingkeys"
	"github.com/q9labs/chalk/apps/api/internal/recordinglifecycle"
	"github.com/q9labs/chalk/apps/api/internal/recordingobjects"
	"github.com/q9labs/chalk/apps/api/internal/recordingpipeline"
	"github.com/q9labs/chalk/apps/api/internal/recordingpreparation"
	"github.com/q9labs/chalk/apps/api/internal/recordingpresentation"
	"github.com/q9labs/chalk/apps/api/internal/recordingrender"
	"github.com/q9labs/chalk/apps/api/internal/recordings"
)

func (w *apiWiring) wireRecordingAuthorities() error {
	if w.cfg.Capabilities.Recording {
		if w.recordingStorage == nil {
			return errors.New("recording authority requires configured R2 object storage")
		}
		presentationFreezer, err := recordingpresentation.NewFreezer(postgres.NewRecordingPresentationCompletionSourceRepository(w.queries), *w.recordingStorage)
		if err != nil {
			return fmt.Errorf("configure recording presentation freezer: %w", err)
		}
		w.recordingPipelineRepository = w.recordingPipelineRepository.WithRecordingPresentationFreezer(presentationFreezer)
		kmsStore, err := recordingkms.NewStore(context.Background(), recordingkms.Config{KeyID: w.cfg.RecordingKMS.KeyID, Region: w.cfg.RecordingKMS.Region, RequestTimeout: w.cfg.RecordingKMS.RequestTimeout})
		if err != nil {
			return fmt.Errorf("configure recording KMS: %w", err)
		}
		w.recordingKMS = kmsStore
		keyService, err := recordingkeys.NewService(kmsStore, postgres.NewRecordingKeyRepository(w.queries), recordingkeys.Config{Environment: w.cfg.Observability.Environment, KeyID: w.cfg.RecordingKMS.KeyID})
		if err != nil {
			return fmt.Errorf("configure recording key authority: %w", err)
		}
		objectService, err := recordingobjects.NewService(*w.recordingStorage, postgres.NewRecordingObjectRepository(w.queries), recordingobjects.Config{})
		if err != nil {
			return fmt.Errorf("configure recording object authority: %w", err)
		}
		w.options.RecorderRecordingKeys = keyService
		w.options.RecorderRecordingObjects = objectService
		lifecycleService, err := recordinglifecycle.NewService(postgres.NewRecordingLifecycleRepository(w.pool), time.Now)
		if err != nil {
			return fmt.Errorf("configure recording capture lifecycle authority: %w", err)
		}
		w.options.RecorderRecordingLifecycle = lifecycleService
	}
	return nil
}

func (w *apiWiring) wireRecordingServices() {
	if w.recordingStorage != nil {
		recordingRepository := postgres.NewRecordingRepositoryWithPool(w.queries, w.pool)
		w.options.Recordings = recordings.NewService(recordingRepository).WithObjectDeleter(*w.recordingStorage)
	}
	w.recordingPipelineService = recordingpipeline.NewService(w.recordingPipelineRepository).WithCaptureEligibility(postgres.NewEpisodeBindings(w.pool).WithOwnCapture(w.ownCapture))
	if w.cfg.Capabilities.Recording {
		recordingPreparations := postgres.NewRecordingPreparationRepository(w.pool).WithAdmissionLimits(w.cfg.RecordingAdmission).WithOwnCapture(w.ownCapture)
		w.options.RecordingEntrance = recordingPreparations
		w.options.RecordingPreparations = recordingpreparation.NewService(recordingPreparations, w.options.Spaces)
	}
	w.options.RecorderHealth = recorderhealth.NewService(w.recordingPipelineRepository, 2*time.Minute)
	w.options.RecorderWorker = w.recordingPipelineService
	w.options.RecordingExports = w.recordingPipelineService
	w.options.RecordingCapturePool = w.recordingPipelineService
}

func (w *apiWiring) wireRenderAuthority() error {
	if w.cfg.Capabilities.Recording {
		renderService, err := recordingrender.NewService(*w.recordingStorage, w.recordingKMS, postgres.NewRecordingRenderRepositoryWithPool(w.pool, w.cfg.Capabilities.Transcription), recordingrender.Config{
			KeyID: w.cfg.RecordingKMS.KeyID, Wake: w.recordingDispatcherWake,
		})
		if err != nil {
			return fmt.Errorf("configure recording render authority: %w", err)
		}
		w.options.RecorderRenderAuthority = renderService
	}
	return nil
}
