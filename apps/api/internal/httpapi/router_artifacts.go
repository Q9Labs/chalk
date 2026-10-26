package httpapi

import "github.com/go-chi/chi/v5"

func mountArtifactRoutes(r chi.Router, options Options) {
	mountRecordingRoutes(r, options.Recordings, options.RecordingExports, options.RecordingDownloads, options.TenantAuthz, options.RateLimit)
	mountTranscriptArtifactRoutes(r, options.TranscriptArtifacts, options.RecordingObjects, options.RecordingDownloads, options.TenantAuthz, options.RateLimit)
}
