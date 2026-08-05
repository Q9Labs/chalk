package httpapi

import "github.com/go-chi/chi/v5"

func mountWorkerRoutes(r chi.Router, options Options) {
	mountTranscriptWorkerRoutes(r, options.TranscriptWorker, options.WorkloadAuthorizer, options.ManifestAuthority, options.ChunkAuthority, options.ResultAuthority)
	mountTranscriptCleanupRoutes(r, options.CleanupWorker, options.WorkloadAuthorizer, options.CleanupDeleteAuthority)
	mountTranscriptFinalizeRoutes(r, options.FinalizerWorker, options.WorkloadAuthorizer, options.FinalizerAuthority)
}
