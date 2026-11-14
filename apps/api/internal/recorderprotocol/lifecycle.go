package recorderprotocol

type CaptureLifecycleAuthority struct {
	RecordingAuthority
	SpaceID string `json:"space_id"`
}

type CaptureReadyRequest struct {
	CaptureLifecycleAuthority
	RequestKey  string `json:"request_key"`
	ObservedAt  string `json:"observed_at"`
	NoPublisher bool   `json:"no_publisher"`
}

type CaptureStoppedRequest struct {
	CaptureLifecycleAuthority
	RequestKey string `json:"request_key"`
	ObservedAt string `json:"observed_at"`
}
