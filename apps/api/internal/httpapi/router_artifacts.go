package httpapi

import "github.com/go-chi/chi/v5"

func mountArtifactRoutes(r chi.Router, options Options) {
	mountRecordingRoutes(r, options.Recordings, options.RecordingDownloads, options.TenantAuthz, options.RateLimit)
	mountRecordingPipelineRoutes(r, options.RecordingPipeline, options.RecorderMetrics, options.TenantAuthz, options.RateLimit)
	if options.TranscriptArtifacts != nil {
		mountTranscriptArtifactRoutes(r, options.TranscriptArtifacts, options.RecordingDownloads, options.TenantAuthz, options.RateLimit)
	} else {
		mountTranscriptRoutes(r, options.Transcripts, options.Recordings, options.RecordingObjects, options.Tenants, options.AITranscriptions, options.TenantAuthz, options.RateLimit)
	}
	mountAuditLogRoutes(r, options.AuditLogs, options.TenantAuthz, options.RateLimit)
}
