package recordingpipeline

// VideoDegradation is internal Render job result metadata, not an Export API field.
type VideoDegradation struct {
	SourceID      string `json:"source_id"`
	Kind          string `json:"kind"`
	FrozenMS      int64  `json:"frozen_ms"`
	DroppedFrames int    `json:"dropped_frames"`
	Recoveries    int    `json:"recoveries"`
	PlaceholderMS int64  `json:"placeholder_ms"`
}
