package main

import (
	"fmt"

	"github.com/q9labs/chalk/apps/api/db/migrations"
	"github.com/q9labs/chalk/apps/api/internal/adapters/chalksfu"
	"github.com/q9labs/chalk/apps/api/internal/adapters/discordreports"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres"
	redisadapter "github.com/q9labs/chalk/apps/api/internal/adapters/redis"
	"github.com/q9labs/chalk/apps/api/internal/config"
	"github.com/q9labs/chalk/apps/api/internal/episodes"
	"github.com/q9labs/chalk/apps/api/internal/httpapi"
	"github.com/q9labs/chalk/apps/api/internal/mcpauth"
	"github.com/q9labs/chalk/apps/api/internal/problemreports"
	"github.com/q9labs/chalk/apps/api/internal/providerbridge"
	"github.com/q9labs/chalk/apps/api/internal/providerbridgeserver"
	"github.com/q9labs/chalk/apps/api/internal/recordingorchestrator"
	"github.com/q9labs/chalk/apps/api/internal/syncidentity"
)

// buildHTTP fills the router options that belong to the HTTP edge itself:
// CORS, rate limits, readiness and problem reports.
func (w *wiring) buildHTTP() error {
	cfg := w.cfg
	reportAdapter, err := discordreports.NewAdapter(cfg.ProblemReportsDiscordWebhookURL)
	if err != nil {
		return fmt.Errorf("configure CHALK_PROBLEM_REPORTS_DISCORD_WEBHOOK_URL: %w", err)
	}
	var reportSender problemreports.Sender
	if reportAdapter != nil {
		reportSender = reportAdapter
	}
	rateLimit := httpapi.DefaultRateLimitOptions()
	rateLimit.DisableAuthenticated = cfg.API.DisableAuthenticatedRateLimits
	rateLimit.ClientIP.TrustedProxyCIDRs = cfg.API.TrustedProxyCIDRs
	if cfg.Observability.Environment != config.DefaultEnvironment {
		rateLimit.Limiter = redisadapter.NewRateLimiter(w.redis)
	}
	w.opts.RecorderWorkerLogger = w.obs.logger
	w.opts.CORS = httpapi.CORSOptions{AllowedOrigins: cfg.API.CORSAllowedOrigins, TenantOrigins: w.tenants}
	w.opts.LocalSystemToken = cfg.API.LocalSystemToken
	w.opts.ServicePrincipal = cfg.API.ServicePrincipal
	w.opts.RateLimit = rateLimit
	w.opts.Readiness = postgres.Readiness{Pool: w.pool, RequiredMigration: migrations.LatestVersion}
	w.opts.ProblemReports = problemreports.NewService(postgres.NewProblemReportRepository(w.pool), reportSender)
	w.opts.RecorderFleetEnvironment = cfg.Observability.Environment
	w.jobs = append(w.jobs, w.deadlineJob())
	applyCapabilityProfile(&w.opts, cfg.Capabilities)
	w.opts.ApplyDiagnostics(w.obs.diagnostics)
	return nil
}

func (w *wiring) deadlineJob() backgroundJob {
	scheduler := episodes.NewDeadlineScheduler(w.episodeRepository, w.cfg.DeadlineScheduler.Interval, w.cfg.DeadlineScheduler.Batch)
	return backgroundJob{name: "episode deadline scheduler", run: scheduler.Run}
}

// chalkNodes is how the provider bridge reaches own SFU nodes. A typed nil
// adapter inside the interface would pass the nil check, so the nil case stays a
// nil interface.
func (w *wiring) chalkNodes() providerbridge.ChalkNodes {
	if w.chalkSFU == nil {
		return nil
	}
	return providerbridge.ChalkNodesOf(func(node string, generation int64) (*chalksfu.Adapter, error) {
		return w.chalkSFU.Allocation(node, "", generation)
	})
}

// buildProviderBridge wires the private worker listener when the bridge is on.
// The private router serves a copy of the finished options, taken before OAuth and MCP.
func (w *wiring) buildProviderBridge() error {
	cfg := w.cfg
	if !cfg.ProviderBridge.Enabled {
		return nil
	}
	controller := recordingorchestrator.NewController(w.recordingPipeline)
	executor := providerbridge.NewSFUExecutor(w.mediaPublications, w.managedSFU, controller)
	executor = executor.WithChalkSFU(postgres.NewEpisodeBindings(w.pool), w.chalkNodes()).WithRetiredAllocations(w.mediaPlaneRegistry.EndRetiredAllocations)
	service := providerbridge.NewService(w.providerOperations, executor)
	verifier, err := syncidentity.NewVerifier(cfg.ProviderBridge.SPIFFETrustDomain, cfg.Observability.Environment)
	if err != nil {
		return fmt.Errorf("configure provider bridge Sync identity: %w", err)
	}
	handler := httpapi.NewProviderBridgeHandler(service, verifier)
	private := w.obs.diagnostics.WrapHTTP(httpapi.NewPrivateWorkerRouter(handler, w.opts))
	w.providerBridge, err = providerbridgeserver.New(cfg.ProviderBridge, private)
	if err != nil {
		return fmt.Errorf("configure provider bridge listener: %w", err)
	}
	return nil
}

// buildAuthAndRouter adds MCP OAuth, then builds the public router.
func (w *wiring) buildAuthAndRouter() error {
	if oauth := w.cfg.API.OAuth; oauth.Issuer != "" {
		w.opts.OAuth = mcpauth.NewService(postgres.NewMCPOAuthRepository(w.pool), mcpauth.Config{Issuer: oauth.Issuer, ConsentURL: oauth.ConsentURL, ExtraRedirectURIs: oauth.ExtraRedirectURIs})
	}
	w.opts.MCP = httpapi.NewMCPHandler(w.opts)
	w.handler = httpapi.NewRouter(w.opts)
	return nil
}

func applyCapabilityProfile(options *httpapi.Options, capabilities config.CapabilityConfig) {
	options.Capabilities = httpapi.CapabilityStatus{
		Recording:       capabilities.Recording,
		Transcription:   capabilities.Transcription,
		WhiteboardFiles: capabilities.WhiteboardFiles,
	}
	if !capabilities.Recording {
		options.RecordingDownloads = nil
		options.RecordingObjects = nil
		options.Recordings = nil
		options.RecorderHealth = nil
		options.RecorderWorker = nil
		options.RecorderCapturePlans = nil
		options.RecorderCaptureSignaling = nil
		options.RecorderRecordingKeys = nil
		options.RecorderRecordingObjects = nil
		options.RecorderRecordingLifecycle = nil
		options.RecorderRenderAuthority = nil
		options.RecorderFleetController = nil
		options.RecorderFleetWorker = nil
		options.RecorderFleetVerifier = nil
		options.RecorderFleetEnvironment = ""
		options.RecorderWorkerVerifier = nil
	}
	if !capabilities.WhiteboardFiles {
		options.WhiteboardFiles = nil
		options.WhiteboardParticipants = nil
	}
	if capabilities.Transcription {
		return
	}
	options.TranscriptArtifacts = nil
	options.TranscriptWorker = nil
	options.WorkloadAuthorizer = nil
	options.ChunkAuthority = nil
	options.ManifestAuthority = nil
	options.ResultAuthority = nil
	options.CleanupWorker = nil
	options.CleanupDeleteAuthority = nil
	options.FinalizerWorker = nil
	options.FinalizerAuthority = nil
}
