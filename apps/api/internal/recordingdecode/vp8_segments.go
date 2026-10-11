package recordingdecode

import (
	"context"
	"fmt"
	"path/filepath"
)

// Fixed-size encoders need a chroma-compatible canvas. Never shrink a later
// layer to the first layer: VP8 keyframes carry their own dimensions.
func normalizeVP8Segments(ctx context.Context, runner CommandRunner, ffmpegPath, directory string, segments []videoSegment) ([]videoSegment, error) {
	width, height := 0, 0
	for _, segment := range segments {
		width, height = max(width, int(segment.width)), max(height, int(segment.height))
	}
	width, height = (width+1)&^1, (height+1)&^1
	changed := false
	for _, segment := range segments {
		changed = changed || int(segment.width) != width || int(segment.height) != height
	}
	if !changed {
		return segments, nil
	}
	for index := range segments {
		path := filepath.Join(directory, fmt.Sprintf("normalized-%d.ivf", index))
		filter := fmt.Sprintf("scale=%d:%d:force_original_aspect_ratio=decrease:force_divisible_by=2,pad=%d:%d:(ow-iw)/2:(oh-ih)/2", width, height, width, height)
		if err := runFFmpeg(ctx, runner, ffmpegPath, "-hide_banner", "-nostdin", "-y", "-loglevel", "error", "-threads", "1", "-f", "ivf", "-i", segments[index].path,
			"-map", "0:v:0", "-an", "-vf", filter, "-c:v", "libvpx", "-deadline", "realtime", "-cpu-used", "4", "-threads", "1", "-enc_time_base", "1:90000", "-fps_mode", "passthrough", "-f", "ivf", path); err != nil {
			return nil, fmt.Errorf("normalize VP8 layer segment: %w", err)
		}
		segments[index].path, segments[index].width, segments[index].height = path, uint16(width), uint16(height)
	}
	return segments, nil
}
