package protocol

// MaxSourceControls bounds one source control batch: every source of a full Episode.
const MaxSourceControls = 64

// Source control actions.
const (
	SourceGrant  = "grant"
	SourceRevoke = "revoke"
)

// SourceControlRequest grants or revokes Participants' sources in one Episode. These
// controls are separate from SDP and outlive sessions: a revoke recorded for a source
// that has no publication still stops a later publication of that source.
//
// Revision is the Episode's durable control revision at which the API read the
// authorization. The node applies a control only when its revision is at least the
// source's recorded one, and a revoke wins a tie, so a duplicate, delayed or stale
// control can never undo a newer one. That ordering also makes a retry harmless, so
// controls carry no operation ID. A grant at the recorded revision renews the lease.
type SourceControlRequest struct {
	TenantID  string          `json:"tenantId"`
	EpisodeID string          `json:"episodeId"`
	Controls  []SourceControl `json:"controls"`
	// AllocationGeneration is as in CreateSessionRequest: a control below the Episode's retirement
	// floor is refused as stale.
	AllocationGeneration *int64 `json:"allocationGeneration,omitempty"`
}

type SourceControl struct {
	ParticipantID string `json:"participantId"`
	Source        string `json:"source"`
	Action        string `json:"action"`
	Revision      int64  `json:"revision"`
}

type SourceControlResponse struct {
	Results []SourceControlResult `json:"results"`
}

// SourceControlResult is the source's state after one control. Applied is false for
// a control older than the recorded revision, which changed nothing. Closed lists the
// publications a revoke closed, so the API can record them as gone. LeaseMillis is
// how long a granted source forwards without another grant.
type SourceControlResult struct {
	ParticipantID string              `json:"participantId"`
	Source        string              `json:"source"`
	Action        string              `json:"action"`
	Revision      int64               `json:"revision"`
	Applied       bool                `json:"applied"`
	LeaseMillis   int64               `json:"leaseMillis,omitempty"`
	Closed        []ClosedSourceTrack `json:"closed,omitempty"`
}

type ClosedSourceTrack struct {
	SessionID string `json:"sessionId"`
	Mid       string `json:"mid"`
	TrackName string `json:"trackName"`
}
