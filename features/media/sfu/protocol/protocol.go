// Package protocol defines the versioned wire types of the SFU control API.
//
// The SFU and the API adapter import this module, so neither keeps a copy. The adapter
// translates between these types and its own media-plane ports. The track and SDP shapes copy the Cloudflare adapter's, so
// the SDK-facing envelope stays the same for both providers.
package protocol

// Version is the control API version. Every route lives under "/" + Version.
const Version = "v1"

type ErrorResponse struct {
	Error ErrorBody `json:"error"`
}

type ErrorBody struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

// Request-level error codes. The HTTP status carries the class: 400 invalid,
// 403 forbidden, 404 gone, 409 conflict, 429 throttled, 503 unavailable.
const (
	CodeInvalidRequest       = "invalid_request"
	CodeForbidden            = "forbidden"
	CodeSessionGone          = "session_gone"
	CodeNegotiationBusy      = "negotiation_in_progress"
	CodeNoPendingOffer       = "no_pending_offer"
	CodeNegotiationFailed    = "negotiation_failed"
	CodeOperationConflict    = "operation_conflict"
	CodeStaleGeneration      = "stale_generation"
	CodeCapacityExceeded     = "capacity_exceeded"
	CodeUnsupportedOperation = "unsupported_operation"
	CodeDraining             = "draining"
	CodeTimeout              = "timeout"
	CodeInternal             = "internal"
)

// Per-track error codes.
const (
	TrackCodeNotFound            = "track_not_found"
	TrackCodeInvalid             = "invalid_track"
	TrackCodeDuplicate           = "duplicate_track"
	TrackCodeLimitExceeded       = "limit_exceeded"
	TrackCodeSubscriptionFailure = "subscription_failed"
	// TrackCodeScreenShareActive refuses a second screen share in one Episode.
	TrackCodeScreenShareActive = "screen_share_active"
)
