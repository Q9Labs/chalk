package media

// The loopback tests bound how long video takes to return with these, so the
// bounds follow the allocator and the probes when they change.
const (
	// ProbeBackoffMax is the longest wait after a failed probe.
	ProbeBackoffMax = probeBackoffMax
	// ProbeSettle is the longest a probe takes to reach its verdict.
	ProbeSettle = probeDuration + probeFeedbackWait
	// ResumeHold is how long a paused tile's lowest layer must fit before it resumes.
	ResumeHold = resumeHold
)
