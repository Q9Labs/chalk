package main

import (
	"context"
	"errors"
	"fmt"
	"time"

	recordingkms "github.com/q9labs/chalk/apps/api/internal/adapters/aws/recordingkms"
	sfuadapter "github.com/q9labs/chalk/apps/api/internal/adapters/cloudflare/sfu"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres"
	"github.com/q9labs/chalk/apps/api/internal/captureplan"
	"github.com/q9labs/chalk/apps/api/internal/captureproviders"
	"github.com/q9labs/chalk/apps/api/internal/capturesignaling"
	"github.com/q9labs/chalk/apps/api/internal/mediaplane"
	"github.com/q9labs/chalk/apps/api/internal/observability"
	"github.com/q9labs/chalk/apps/api/internal/recorderhealth"
	"github.com/q9labs/chalk/apps/api/internal/recordingkeys"
	"github.com/q9labs/chalk/apps/api/internal/recordinglifecycle"
	"github.com/q9labs/chalk/apps/api/internal/recordingobjects"
	"github.com/q9labs/chalk/apps/api/internal/recordingpipeline"
	"github.com/q9labs/chalk/apps/api/internal/recordingpreparation"
	"github.com/q9labs/chalk/apps/api/internal/recordingpresentation"
	"github.com/q9labs/chalk/apps/api/internal/recordingrender"
	"github.com/q9labs/chalk/apps/api/internal/recordings"
	"github.com/q9labs/chalk/apps/api/internal/spaces"
	"github.com/q9labs/chalk/apps/api/internal/workeridentity"
)

// buildRecordingFleet wires the recording repositories and, when Recording is
// on, the recorder fleet and capture signaling.
func (w *wiring) buildRecordingFleet() error {
	cfg := w.cfg
	w.opts.Recordings = recordings.NewService(postgres.NewRecordingRepository(w.queries))
	w.recordingRepository = postgres.NewRecordingPipelineRepositoryWithQueriesAndTransactor(w.queries, w.pool, w.obs.diagnostics.Queries).WithTenantLimits(cfg.TenantLimits).WithAdmissionLimits(cfg.RecordingAdmission)
	w.recordingRepository = w.recordingRepository.WithTranscriptionEnabled(cfg.Capabilities.Transcription)
	w.recordingRepository = w.recordingRepository.WithRecordingBundleV2Enabled(cfg.RecordingBundleV2Enabled)
	colocatedGrace := time.Duration(0)
	if w.ownCapture {
		colocatedGrace = cfg.ChalkSFU.ColocatedCaptureGrace
	}
	w.recordingRepository = w.recordingRepository.WithColocatedCapture(colocatedGrace)
	if cfg.Capabilities.Recording {
		profile, err := recordingpresentation.NewComposite720PProfile()
		if err != nil {
			return fmt.Errorf("configure recording presentation profile: %w", err)
		}
		w.recordingRepository, err = w.recordingRepository.WithRecordingPresentationProfile(profile)
		if err != nil {
			return fmt.Errorf("configure recording presentation profile: %w", err)
		}
	}
	capturePlanRepository := postgres.NewRecordingCapturePlanRepositoryWithTransactor(w.pool, w.obs.diagnostics.Queries)
	w.opts.RecorderCapturePlans = captureplan.NewService(capturePlanRepository)
	var err error
	if cfg.DefaultMediaPlane != "" || cfg.ProviderBridge.Enabled {
		w.managedSFU, err = sfuadapter.NewAdapter(cfg.CloudflareRealtime)
		if err != nil {
			return fmt.Errorf("configure Cloudflare SFU adapter: %w", err)
		}
	}
	if !cfg.Capabilities.Recording {
		return nil
	}
	return w.buildRecorderFleet(capturePlanRepository, colocatedGrace)
}

func (w *wiring) buildRecorderFleet(capturePlanRepository postgres.RecordingCapturePlanRepository, colocatedGrace time.Duration) error {
	cfg, logger := w.cfg, w.obs.logger
	if !cfg.ProviderBridge.Enabled {
		return errors.New("recording worker boundary requires the private provider bridge configuration")
	}
	verifier, err := workeridentity.NewVerifier(cfg.ProviderBridge.SPIFFETrustDomain, cfg.Observability.Environment)
	if err != nil {
		return fmt.Errorf("configure recorder worker identity: %w", err)
	}
	fleet, err := newRecorderFleetComponents(cfg, w.queries, verifier, w.ownCapture, colocatedGrace)
	if err != nil {
		return err
	}
	if colocatedGrace > 0 {
		nodeIDs := make([]string, 0, len(cfg.ChalkSFU.Nodes))
		for _, node := range cfg.ChalkSFU.Nodes {
			nodeIDs = append(nodeIDs, node.ID)
		}
		registrations := postgres.NewRecordingFleetAuthorityRepository(w.queries)
		if err := registrations.EnsureColocatedCaptureWorkers(context.Background(), cfg.Observability.Environment, nodeIDs); err != nil {
			return fmt.Errorf("register colocated capture workers: %w", err)
		}
	}
	w.opts.RecorderWorkerVerifier = fleet.workerVerifier
	w.opts.RecorderFleetController = fleet.service
	w.opts.RecorderFleetWorker = fleet.service
	w.opts.RecorderFleetVerifier = fleet.controllerVerifier
	managedBinding, err := mediaplane.NewBinding(string(spaces.MediaPlaneProviderCloudflareSFU), mediaplane.BindingSourceDeploymentDefault, cfg.CloudflareRealtime.RealtimeAppID)
	if err != nil {
		return fmt.Errorf("configure recording application identity: %w", err)
	}
	captureRegistrations := []captureproviders.Registration{{
		Provider: managedBinding.Provider, AdapterFingerprint: managedBinding.AdapterFingerprint, Plane: w.managedSFU,
	}}
	if w.ownCapture {
		ownBinding, err := mediaplane.NewBinding(string(mediaplane.ProviderChalkSFU), mediaplane.BindingSourceDeploymentDefault, w.chalkSFU.ApplicationID())
		if err != nil {
			return fmt.Errorf("configure own SFU recording identity: %w", err)
		}
		captureRegistrations = append(captureRegistrations, captureproviders.Registration{
			Provider: ownBinding.Provider, AdapterFingerprint: ownBinding.AdapterFingerprint, Nodes: w.chalkSFU,
		})
	}
	captureProviderRegistry, err := captureproviders.NewRegistry(postgres.NewRecordingCaptureBindingSource(w.queries), captureRegistrations...)
	if err != nil {
		return fmt.Errorf("configure recording provider registry: %w", err)
	}
	captureSignalingRepository := postgres.NewRecordingCaptureSignalingRepositoryWithTransactor(w.pool, w.obs.diagnostics.Queries)
	captureSignalingService, err := capturesignaling.NewService(captureSignalingRepository, captureProviderRegistry, capturesignaling.Options{
		Retirer: capturePlanRepository,
		OnRetired: func(ctx context.Context, command capturesignaling.Command, count int) {
			logger.InfoContext(ctx, "capture publications retired", "event", "recording.capture_publications_retired", "tenant_id", command.Authority.TenantID.String(),
				"episode_id", command.Authority.EpisodeID.String(), "recording_id", command.Authority.RecordingID.String(),
				"capture_epoch", command.Authority.CaptureEpoch, "plan_revision", command.Identity.PlanRevision,
				"publication_count", count)
		},
	})
	if err != nil {
		return fmt.Errorf("configure recorder capture signaling: %w", err)
	}
	w.opts.RecorderCaptureSignaling = observability.NewObservedCaptureSignalingExecutor(captureSignalingService)
	return nil
}

// buildRecordingAuthority wires the keys, objects and lifecycle authorities the
// recorder workers call, then the pipeline service built on the repository
// those authorities finish configuring.
func (w *wiring) buildRecordingAuthority() error {
	cfg := w.cfg
	if cfg.Capabilities.Recording {
		if w.storage == nil {
			return errors.New("recording authority requires configured R2 object storage")
		}
		presentationFreezer, err := recordingpresentation.NewFreezer(postgres.NewRecordingPresentationCompletionSourceRepository(w.queries), *w.storage)
		if err != nil {
			return fmt.Errorf("configure recording presentation freezer: %w", err)
		}
		w.recordingRepository = w.recordingRepository.WithRecordingPresentationFreezer(presentationFreezer)
		kmsStore, err := recordingkms.NewStore(context.Background(), recordingkms.Config{KeyID: cfg.RecordingKMS.KeyID, Region: cfg.RecordingKMS.Region, RequestTimeout: cfg.RecordingKMS.RequestTimeout})
		if err != nil {
			return fmt.Errorf("configure recording KMS: %w", err)
		}
		w.recordingKMS = kmsStore
		keyService, err := recordingkeys.NewService(kmsStore, postgres.NewRecordingKeyRepository(w.queries), recordingkeys.Config{Environment: cfg.Observability.Environment, KeyID: cfg.RecordingKMS.KeyID})
		if err != nil {
			return fmt.Errorf("configure recording key authority: %w", err)
		}
		objectService, err := recordingobjects.NewService(*w.storage, postgres.NewRecordingObjectRepository(w.queries), recordingobjects.Config{})
		if err != nil {
			return fmt.Errorf("configure recording object authority: %w", err)
		}
		w.opts.RecorderRecordingKeys = keyService
		w.opts.RecorderRecordingObjects = objectService
		lifecycleService, err := recordinglifecycle.NewService(postgres.NewRecordingLifecycleRepository(w.pool), time.Now)
		if err != nil {
			return fmt.Errorf("configure recording capture lifecycle authority: %w", err)
		}
		w.opts.RecorderRecordingLifecycle = lifecycleService
	}
	pipeline := recordingpipeline.NewService(w.recordingRepository).WithCaptureEligibility(postgres.NewEpisodeBindings(w.pool).WithOwnCapture(w.ownCapture))
	w.recordingPipeline = pipeline
	w.opts.RecorderWorker = pipeline
	w.opts.RecordingExports = pipeline
	w.opts.RecordingCapturePool = pipeline
	if cfg.Capabilities.Recording {
		preparations := postgres.NewRecordingPreparationRepository(w.pool).WithAdmissionLimits(cfg.RecordingAdmission).WithOwnCapture(w.ownCapture)
		w.opts.RecordingEntrance = preparations
		w.opts.RecordingPreparations = recordingpreparation.NewService(preparations, w.spaces)
		w.jobs = append(w.jobs, backgroundJob{name: "recording maintenance", awaited: true, run: func(ctx context.Context) error {
			return pipeline.RunMaintenance(ctx, recordingpipeline.DefaultMaintenanceInterval)
		}})
	}
	w.opts.RecorderHealth = recorderhealth.NewService(w.recordingRepository, 2*time.Minute)
	return nil
}

// buildRecordingRender wires the render authority. It follows Transcription,
// which supplies the dispatcher wake the render service calls.
func (w *wiring) buildRecordingRender() error {
	if !w.cfg.Capabilities.Recording {
		return nil
	}
	renderService, err := recordingrender.NewService(*w.storage, w.recordingKMS, postgres.NewRecordingRenderRepositoryWithPool(w.pool, w.cfg.Capabilities.Transcription), recordingrender.Config{
		KeyID: w.cfg.RecordingKMS.KeyID, Wake: w.dispatcherWake,
	})
	if err != nil {
		return fmt.Errorf("configure recording render authority: %w", err)
	}
	w.opts.RecorderRenderAuthority = renderService
	return nil
}
