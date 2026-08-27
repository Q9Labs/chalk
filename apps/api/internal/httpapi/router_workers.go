package httpapi

import (
	"net/http"

	"github.com/go-chi/chi/v5"
)

func mountWorkerRoutes(r chi.Router, options Options) {
	mountTranscriptWorkerRoutes(r, options.TranscriptWorker, options.WorkloadAuthorizer, options.ManifestAuthority, options.ChunkAuthority, options.ResultAuthority)
	mountTranscriptCleanupRoutes(r, options.CleanupWorker, options.WorkloadAuthorizer, options.CleanupDeleteAuthority)
	mountTranscriptFinalizeRoutes(r, options.FinalizerWorker, options.WorkloadAuthorizer, options.FinalizerAuthority)
}

// NewPrivateWorkerRouter composes the mTLS-only worker boundary. The public
// API router never receives the recorder handler; each child handler keeps its
// own role-specific authentication middleware.
func NewPrivateWorkerRouter(providerBridge http.Handler, options Options) http.Handler {
	mux := http.NewServeMux()
	if providerBridge != nil {
		mux.Handle("/internal/v1/sync/", providerBridge)
	}
	if options.Capabilities.Recording {
		mux.Handle("/internal/v1/recorder/", NewRecorderWorkerRouterWithControls(options.RecorderWorker, options.RecorderWorkerVerifier, RecorderWorkerControlServices{
			CapturePlans: options.RecorderCapturePlans, CaptureSignaling: options.RecorderCaptureSignaling,
			RecordingKeys: options.RecorderRecordingKeys, RecordingObjects: options.RecorderRecordingObjects, RecordingLifecycle: options.RecorderRecordingLifecycle,
		}))
	}
	return mux
}
