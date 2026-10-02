package recordingdecode

import (
	"context"
	"fmt"
	"path/filepath"
)

// A simulcast layer switch starts a fresh codec segment. Normalize each segment
// independently before merging: an IVF header cannot describe changing sizes.
func normalizeVP8Segments(ctx context.Context, runner CommandRunner, ffmpegPath, directory string, segments []videoSegment) ([]videoSegment, error) {
	width, height := segments[0].width, segments[0].height
	changed := false
	for _, segment := range segments {
		changed = changed || segment.width != width || segment.height != height
	}
	if !changed {
		return segments, nil
	}
	for index := range segments {
		path := filepath.Join(directory, fmt.Sprintf("normalized-%d.ivf", index))
		filter := fmt.Sprintf("scale=%d:%d:force_original_aspect_ratio=decrease,pad=%d:%d:(ow-iw)/2:(oh-ih)/2", width, height, width, height)
		if err := runFFmpeg(ctx, runner, ffmpegPath, "-hide_banner", "-nostdin", "-y", "-loglevel", "error", "-threads", "1", "-f", "ivf", "-i", segments[index].path,
			"-map", "0:v:0", "-an", "-vf", filter, "-c:v", "libvpx", "-deadline", "realtime", "-cpu-used", "4", "-threads", "1", "-enc_time_base", "1:90000", "-fps_mode", "passthrough", "-f", "ivf", path); err != nil {
			return nil, fmt.Errorf("normalize VP8 layer segment: %w", err)
		}
		segments[index].path, segments[index].width, segments[index].height = path, width, height
	}
	return segments, nil
}
