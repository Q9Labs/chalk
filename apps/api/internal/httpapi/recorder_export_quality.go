package httpapi

import (
	"github.com/q9labs/chalk/apps/api/internal/recordingpipeline"
	"log/slog"
)

// Limit log size and do not log source, participant, Recording or Episode IDs.
func logExportDegradation(logger *slog.Logger, jobID string, sources []recordingpipeline.VideoDegradation) {
	type sourceQuality struct {
		SourceIndex   int    `json:"source_index"`
		Kind          string `json:"kind"`
		FrozenMS      int64  `json:"frozen_ms"`
		DroppedFrames int    `json:"dropped_frames"`
		Recoveries    int    `json:"recoveries"`
		PlaceholderMS int64  `json:"placeholder_ms"`
	}
	bounded := make([]sourceQuality, 0, min(16, len(sources)))
	count := 0
	var frozenMS int64
	for index, source := range sources {
		if source.FrozenMS == 0 && source.DroppedFrames == 0 && source.PlaceholderMS == 0 {
			continue
		}
		count++
		frozenMS += source.FrozenMS
		if len(bounded) < 16 {
			bounded = append(bounded, sourceQuality{index, source.Kind, source.FrozenMS, source.DroppedFrames, source.Recoveries, source.PlaceholderMS})
		}
	}
	if count == 0 {
		return
	}
	// Do not pass the request context: the production handler adds journey/trace IDs.
	logger.Info("recording.export.degraded", "job_id", jobID, "degraded_sources", count, "frozen_ms", frozenMS, "sources", bounded, "omitted_sources", count-len(bounded))
}
