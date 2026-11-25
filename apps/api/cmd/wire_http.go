package main

import (
	"net/http"
	"time"

	"github.com/q9labs/chalk/apps/api/db/migrations"
	"github.com/q9labs/chalk/apps/api/internal/adapters/discordreports"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres"
	"github.com/q9labs/chalk/apps/api/internal/config"
	"github.com/q9labs/chalk/apps/api/internal/httpapi"
	"github.com/q9labs/chalk/apps/api/internal/mcpauth"
	"github.com/q9labs/chalk/apps/api/internal/problemreports"
	"github.com/q9labs/chalk/apps/api/internal/scheduledepisodes"
)

func (w *apiWiring) wireRouters(reportAdapter *discordreports.Adapter) (*http.Server, error) {
	var reportSender problemreports.Sender
	if reportAdapter != nil {
		reportSender = reportAdapter
	}
	w.options.RecorderWorkerLogger = w.logger
	w.options.CORS = httpapi.CORSOptions{AllowedOrigins: w.cfg.API.CORSAllowedOrigins, TenantOrigins: w.tenantService}
	w.options.LocalSystemToken = w.cfg.API.LocalSystemToken
	w.options.ServicePrincipal = w.cfg.API.ServicePrincipal
	w.options.DashboardServiceID = w.cfg.API.ServicePrincipal.ID
	w.options.OperatorReadTokenSHA256 = config.OperatorReadTokenSHA256()
	w.options.Readiness = postgres.Readiness{Pool: w.pool, RequiredMigration: migrations.LatestVersion}
	w.options.RetirementBacklog = func() (int, time.Duration, bool) {
		backlog, observed := w.mediaPlaneRegistry.RetirementBacklog()
		return backlog.Count, backlog.Oldest, observed
	}
	w.options.MediaPublications = w.mediaPublicationService
	w.options.ProblemReports = problemreports.NewService(postgres.NewProblemReportRepository(w.pool), reportSender)
	w.options.ScheduledEpisodes = scheduledepisodes.NewService(postgres.NewScheduledEpisodeRepository(w.pool))
	w.options.RecorderFleetEnvironment = w.cfg.Observability.Environment
	w.options.EpisodeTalkTime = newEpisodeTalkTime(w.cfg.Capabilities.Transcription, w.episodeService, postgres.NewEpisodeTalkTimeRepository(w.queries), w.recordingStorage)

	applyCapabilityProfile(&w.options, w.cfg.Capabilities)
	w.options.Capabilities.ScreenAnnotation = postgres.ScreenAnnotationSettings{
		Queries: w.queries, DefaultEnabled: w.cfg.Capabilities.ScreenAnnotation,
	}.Enabled
	if w.options.HelperAccess != nil {
		w.options.HelperAccess.WithAnnotationAvailability(w.options.Capabilities.ScreenAnnotation)
	}
	w.options.ApplyDiagnostics(w.diagnostics)
	if err := w.wireProviderBridge(); err != nil {
		return nil, err
	}
	if oauth := w.cfg.API.OAuth; oauth.Issuer != "" {
		w.options.OAuth = mcpauth.NewService(postgres.NewMCPOAuthRepository(w.pool), mcpauth.Config{Issuer: oauth.Issuer, ConsentURL: oauth.ConsentURL, ExtraRedirectURIs: oauth.ExtraRedirectURIs})
	}
	w.options.MCP = httpapi.NewMCPHandler(w.options)
	handler := httpapi.NewRouter(w.options)
	return &http.Server{
		Addr:              w.cfg.API.Address,
		Handler:           handler,
		ReadTimeout:       15 * time.Second,
		ReadHeaderTimeout: 5 * time.Second,
		WriteTimeout:      30 * time.Second,
		IdleTimeout:       60 * time.Second,
		MaxHeaderBytes:    1 << 20,
	}, nil
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
