// Package recorderprotocol is the private contract between recorder workers and
// the API control plane: the routes, the error codes and every request and
// response body. The worker client and the HTTP handlers both import it, so a
// route or field change is a compile error on the other side.
package recorderprotocol

import "github.com/q9labs/chalk/apps/api/internal/captureplane"

// Prefix is the path every worker route lives under.
const Prefix = "/internal/v1/recorder"

// Route is a path relative to Prefix.
type Route string

const (
	RouteJobsClaim                Route = "/jobs/claim"
	RouteJobsHeartbeat            Route = "/jobs/heartbeat"
	RouteJobsProgress             Route = "/jobs/progress"
	RouteJobsFail                 Route = "/jobs/fail"
	RouteJobsRelinquish           Route = "/jobs/capture/relinquish"
	RouteJobsComplete             Route = "/jobs/complete"
	RoutePoolHealth               Route = "/pool-health"
	RoutePlansWait                Route = "/plans/wait"
	RouteKeysAccess               Route = "/keys/access"
	RouteBundlesReserve           Route = "/bundles/reserve"
	RouteBundlesFinalize          Route = "/bundles/finalize"
	RouteBundlesCommit            Route = "/bundles/commit"
	RouteCaptureCreate            Route = "/capture/create"
	RouteCapturePull              Route = "/capture/pull"
	RouteCaptureRenegotiate       Route = "/capture/renegotiate"
	RouteCaptureInspect           Route = "/capture/inspect"
	RouteCaptureCloseTracks       Route = "/capture/close-tracks"
	RouteCaptureCloseConnection   Route = "/capture/close-connection"
	RouteCaptureReady             Route = "/capture/ready"
	RouteCaptureStopped           Route = "/capture/stopped"
	RouteRenderInputsResolve      Route = "/render-inputs/resolve"
	RouteRenderKeysAccess         Route = "/render-keys/access"
	RouteRenderObjectsReserve     Route = "/render-objects/reserve"
	RouteRenderObjectsFinalize    Route = "/render-objects/finalize"
	RouteRenderObjectsCommit      Route = "/render-objects/commit"
	RouteRendersCommit            Route = "/renders/commit"
	RouteRendersTranscriptionDone Route = "/renders/transcription-commit"
)

// Path is the full request path of the route.
func (route Route) Path() string { return Prefix + string(route) }

// CaptureSignalingRoutes maps each capture signaling command to its route. The
// handlers mount exactly these routes, and the worker sends each command to the
// route of its kind.
var CaptureSignalingRoutes = map[captureplane.OperationKind]Route{
	captureplane.OperationCreateCaptureConnection:      RouteCaptureCreate,
	captureplane.OperationPullCaptureTracks:            RouteCapturePull,
	captureplane.OperationRenegotiateCaptureConnection: RouteCaptureRenegotiate,
	captureplane.OperationInspectCaptureConnection:     RouteCaptureInspect,
	captureplane.OperationCloseCaptureTracks:           RouteCaptureCloseTracks,
	captureplane.OperationCloseCaptureConnection:       RouteCaptureCloseConnection,
}

// Error codes the control plane returns and the worker acts on.
const (
	CodeWorkerAdmissionClosed        = "worker.admission_closed"
	CodeWorkerForbidden              = "worker.forbidden"
	CodeWorkerUnauthorized           = "worker.unauthorized"
	CodeWorkerNotFound               = "worker.not_found"
	CodeCaptureMediaStopped          = "recording.capture_media_stopped"
	CodeCaptureStopPublicationFailed = "recording.capture_stop_publication_failed"
)
