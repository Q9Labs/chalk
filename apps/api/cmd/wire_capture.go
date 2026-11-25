package main

import (
	"context"
	"errors"
	"fmt"

	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres"
	"github.com/q9labs/chalk/apps/api/internal/captureplan"
	"github.com/q9labs/chalk/apps/api/internal/captureproviders"
	"github.com/q9labs/chalk/apps/api/internal/capturesignaling"
	"github.com/q9labs/chalk/apps/api/internal/observability"
	"github.com/q9labs/chalk/apps/api/internal/recordingpresentation"
	"github.com/q9labs/chalk/apps/api/internal/recordings"
	"github.com/q9labs/chalk/apps/api/internal/workeridentity"
)

func (w *apiWiring) wireRecordingPipeline() error {
	recordingRepository := postgres.NewRecordingRepositoryWithPool(w.queries, w.pool)
	w.options.Recordings = recordings.NewService(recordingRepository)
	w.recordingPipelineRepository = postgres.NewRecordingPipelineRepositoryWithQueriesAndTransactor(w.queries, w.pool, w.diagnostics.Queries).WithTenantLimits(w.cfg.TenantLimits).WithAdmissionLimits(w.cfg.RecordingAdmission)
	w.recordingPipelineRepository = w.recordingPipelineRepository.WithTranscriptionEnabled(w.cfg.Capabilities.Transcription)
	w.recordingPipelineRepository = w.recordingPipelineRepository.WithRecordingBundleV2Enabled(w.cfg.RecordingBundleV2Enabled)
	if w.ownCapture {
		w.colocatedGrace = w.cfg.ChalkSFU.ColocatedCaptureGrace
	}
	w.recordingPipelineRepository = w.recordingPipelineRepository.WithColocatedCapture(w.colocatedGrace)
	if w.cfg.Capabilities.Recording {
		profile, err := recordingpresentation.NewComposite720PProfile()
		if err != nil {
			return fmt.Errorf("configure recording presentation profile: %w", err)
		}
		w.recordingPipelineRepository, err = w.recordingPipelineRepository.WithRecordingPresentationProfile(profile)
		if err != nil {
			return fmt.Errorf("configure recording presentation profile: %w", err)
		}
	}
	w.recordingCapturePlanRepository = postgres.NewRecordingCapturePlanRepositoryWithTransactor(w.pool, w.diagnostics.Queries)
	w.options.RecorderCapturePlans = captureplan.NewService(w.recordingCapturePlanRepository)
	return nil
}

func (w *apiWiring) wireCaptureWorkers() error {
	if w.cfg.Capabilities.Recording {
		if !w.cfg.ProviderBridge.Enabled {
			return errors.New("recording worker boundary requires the private provider bridge configuration")
		}
		verifier, err := workeridentity.NewVerifier(w.cfg.ProviderBridge.SPIFFETrustDomain, w.cfg.Observability.Environment)
		if err != nil {
			return fmt.Errorf("configure recorder worker identity: %w", err)
		}
		fleet, err := newRecorderFleetComponents(w.cfg, w.queries, verifier, w.ownCapture, w.colocatedGrace)
		if err != nil {
			return err
		}
		if w.colocatedGrace > 0 {
			nodeIDs := make([]string, 0, len(w.cfg.ChalkSFU.Nodes))
			for _, node := range w.cfg.ChalkSFU.Nodes {
				nodeIDs = append(nodeIDs, node.ID)
			}
			registrations := postgres.NewRecordingFleetAuthorityRepository(w.queries)
			if err := registrations.EnsureColocatedCaptureWorkers(context.Background(), w.cfg.Observability.Environment, nodeIDs); err != nil {
				return fmt.Errorf("register colocated capture workers: %w", err)
			}
		}
		w.options.RecorderWorkerVerifier = fleet.workerVerifier
		w.options.RecorderFleetController = fleet.service
		w.options.RecorderFleetWorker = fleet.service
		w.options.RecorderFleetVerifier = fleet.controllerVerifier
		if !w.ownCapture {
			return nil
		}
		binding, err := w.mediaPlaneRegistry.DeploymentBinding()
		if err != nil {
			return fmt.Errorf("configure Chalk SFU recording identity: %w", err)
		}
		captureProviderRegistry, err := captureproviders.NewRegistry(postgres.NewRecordingCaptureBindingSource(w.queries), captureproviders.Registration{Binding: binding, Nodes: w.chalkSFU})
		if err != nil {
			return fmt.Errorf("configure recording provider registry: %w", err)
		}
		captureSignalingRepository := postgres.NewRecordingCaptureSignalingRepositoryWithTransactor(w.pool, w.diagnostics.Queries)
		captureSignalingService, err := capturesignaling.NewService(captureSignalingRepository, captureProviderRegistry, capturesignaling.Options{
			Retirer: w.recordingCapturePlanRepository,
			OnRetired: func(ctx context.Context, command capturesignaling.Command, count int) {
				w.logger.InfoContext(ctx, "capture publications retired", "event", "recording.capture_publications_retired", "tenant_id", command.Authority.TenantID.String(),
					"episode_id", command.Authority.EpisodeID.String(), "recording_id", command.Authority.RecordingID.String(),
					"capture_epoch", command.Authority.CaptureEpoch, "plan_revision", command.Identity.PlanRevision,
					"publication_count", count)
			},
		})
		if err != nil {
			return fmt.Errorf("configure recorder capture signaling: %w", err)
		}
		w.options.RecorderCaptureSignaling = observability.NewObservedCaptureSignalingExecutor(captureSignalingService)
	}
	return nil
}
