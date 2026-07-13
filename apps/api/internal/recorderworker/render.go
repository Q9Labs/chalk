package recorderworker

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os/exec"
	"sort"
	"strconv"
	"strings"
	"time"
)

type RenderJob struct {
	ID             string `json:"id"`
	DeadlineMs     int64  `json:"deadline_ms"`
	ServiceMs      int64  `json:"service_ms"`
	InputBytes     int64  `json:"input_bytes"`
	CaptureAttempt int    `json:"capture_attempt"`
}

type RenderNode struct {
	Index     int         `json:"index"`
	ServiceMs int64       `json:"service_ms"`
	Jobs      []RenderJob `json:"jobs"`
}

type RenderSchedule struct {
	Nodes []RenderNode `json:"nodes"`
}

// PackEDF returns the smallest number of nodes (bounded by maxNodes) for which
// all jobs fit the per-node sub-budget. Jobs are sorted by earliest deadline,
// then immutable ID, and are never split or preempted.
func PackEDF(jobs []RenderJob, maxNodes int, subBudgetMs int64) (RenderSchedule, error) {
	if len(jobs) == 0 || maxNodes <= 0 || maxNodes > 10 || subBudgetMs <= 0 {
		return RenderSchedule{}, errors.New("jobs, node bound (at most ten), and positive sub-budget are required")
	}
	ordered := append([]RenderJob(nil), jobs...)
	sort.SliceStable(ordered, func(i, j int) bool {
		if ordered[i].DeadlineMs != ordered[j].DeadlineMs {
			return ordered[i].DeadlineMs < ordered[j].DeadlineMs
		}
		return ordered[i].ID < ordered[j].ID
	})
	for _, job := range ordered {
		if job.ID == "" || job.ServiceMs <= 0 || job.ServiceMs > subBudgetMs || job.DeadlineMs <= 0 {
			return RenderSchedule{}, fmt.Errorf("job %q does not fit render constraints", job.ID)
		}
	}
	for count := 1; count <= maxNodes; count++ {
		nodes := make([]RenderNode, count)
		for i := range nodes {
			nodes[i].Index = i
		}
		if packJobs(ordered, 0, nodes, subBudgetMs) {
			return RenderSchedule{Nodes: nodes}, nil
		}
	}
	return RenderSchedule{}, fmt.Errorf("jobs cannot fit within %d render nodes and %dms sub-budget", maxNodes, subBudgetMs)
}

func packJobs(jobs []RenderJob, index int, nodes []RenderNode, budget int64) bool {
	if index == len(jobs) {
		return true
	}
	job := jobs[index]
	seenLoads := make(map[int64]struct{}, len(nodes))
	for node := range nodes {
		load := nodes[node].ServiceMs
		if _, seen := seenLoads[load]; seen || load+job.ServiceMs > budget || load+job.ServiceMs > job.DeadlineMs {
			continue
		}
		seenLoads[load] = struct{}{}
		nodes[node].ServiceMs += job.ServiceMs
		nodes[node].Jobs = append(nodes[node].Jobs, job)
		if packJobs(jobs, index+1, nodes, budget) {
			return true
		}
		nodes[node].ServiceMs = load
		nodes[node].Jobs = nodes[node].Jobs[:len(nodes[node].Jobs)-1]
	}
	return false
}

type FFmpegPlan struct {
	Input        string   `json:"input"`
	Output       string   `json:"output"`
	Width        int      `json:"width"`
	Height       int      `json:"height"`
	FPS          int      `json:"fps"`
	VideoCodec   string   `json:"video_codec"`
	VideoTarget  string   `json:"video_target"`
	VideoMaximum string   `json:"video_maximum"`
	AudioCodec   string   `json:"audio_codec"`
	AudioBitrate string   `json:"audio_bitrate"`
	Command      []string `json:"command"`
}

func BuildFFmpegPlan(input, output string) (FFmpegPlan, error) {
	if input == "" || output == "" {
		return FFmpegPlan{}, errors.New("input and output paths are required")
	}
	args := []string{"ffmpeg", "-hide_banner", "-nostdin", "-y", "-i", input, "-vf", "scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2", "-r", "30", "-c:v", "libx264", "-b:v", "2M", "-maxrate", "3M", "-bufsize", "4M", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "128k", "-ar", "48000", "-movflags", "+faststart", output}
	return FFmpegPlan{Input: input, Output: output, Width: 1280, Height: 720, FPS: 30, VideoCodec: "h264", VideoTarget: "2 Mbps", VideoMaximum: "3 Mbps", AudioCodec: "aac-lc", AudioBitrate: "128 kbps", Command: args}, nil
}

type CommandRunner interface {
	Run(context.Context, string, ...string) ([]byte, error)
}

type ExecCommandRunner struct{}

func (ExecCommandRunner) Run(ctx context.Context, name string, args ...string) ([]byte, error) {
	return exec.CommandContext(ctx, name, args...).CombinedOutput()
}

type MediaFacts struct {
	Streams []MediaStream `json:"streams"`
	Format  MediaFormat   `json:"format"`
}

type MediaStream struct {
	CodecType  string `json:"codec_type"`
	CodecName  string `json:"codec_name"`
	Profile    string `json:"profile"`
	Width      int    `json:"width"`
	Height     int    `json:"height"`
	SampleRate string `json:"sample_rate"`
	Channels   int    `json:"channels"`
	FrameRate  string `json:"avg_frame_rate"`
	BitRate    string `json:"bit_rate"`
	Duration   string `json:"duration"`
}

type MediaFormat struct {
	Duration   string `json:"duration"`
	FormatName string `json:"format_name"`
}

func VerifyMedia(ctx context.Context, runner CommandRunner, path string) (MediaFacts, error) {
	return VerifyMediaWithExpectedDuration(ctx, runner, path, 0)
}

func VerifyMediaWithExpectedDuration(ctx context.Context, runner CommandRunner, path string, expected time.Duration) (MediaFacts, error) {
	if runner == nil || path == "" {
		return MediaFacts{}, errors.New("ffprobe runner and media path are required")
	}
	output, err := runner.Run(ctx, "ffprobe", "-v", "error", "-print_format", "json", "-show_streams", "-show_format", path)
	if err != nil {
		return MediaFacts{}, fmt.Errorf("ffprobe: %w: %s", err, string(output))
	}
	var facts MediaFacts
	if err := json.Unmarshal(output, &facts); err != nil {
		return MediaFacts{}, fmt.Errorf("decode ffprobe output: %w", err)
	}
	if err := facts.validate(); err != nil {
		return MediaFacts{}, err
	}
	if expected > 0 {
		durationMs, _ := ParseDurationMs(facts.Format.Duration)
		expectedMs := expected.Milliseconds()
		if durationMs < expectedMs-100 || durationMs > expectedMs+100 {
			return MediaFacts{}, fmt.Errorf("media duration %dms differs from expected %dms", durationMs, expectedMs)
		}
	}
	return facts, nil
}

func (f MediaFacts) validate() error {
	video, audio := false, false
	for _, stream := range f.Streams {
		switch stream.CodecType {
		case "video":
			frameRate, err := parseRational(stream.FrameRate)
			if stream.CodecName != "h264" || stream.Width != 1280 || stream.Height != 720 || err != nil || frameRate < 29.99 || frameRate > 30.01 {
				return errors.New("media video is not 1280x720 H.264 at 30fps")
			}
			video = true
		case "audio":
			bitRate, err := strconv.ParseInt(stream.BitRate, 10, 64)
			if stream.CodecName != "aac" || !strings.EqualFold(stream.Profile, "LC") || stream.Channels < 1 || err != nil || bitRate < 96_000 || bitRate > 160_000 {
				return errors.New("media audio is not AAC-LC near 128kbps")
			}
			audio = true
		}
	}
	if !video || !audio || !strings.Contains(f.Format.FormatName, "mp4") {
		return errors.New("media must contain video, audio, and a seekable MP4 container")
	}
	durationMs, err := ParseDurationMs(f.Format.Duration)
	if err != nil || durationMs <= 0 {
		return errors.New("media duration is missing or not playable")
	}
	return nil
}

func parseRational(value string) (float64, error) {
	parts := strings.Split(value, "/")
	if len(parts) == 2 {
		numerator, err := strconv.ParseFloat(parts[0], 64)
		if err != nil {
			return 0, err
		}
		denominator, err := strconv.ParseFloat(parts[1], 64)
		if err != nil || denominator == 0 {
			return 0, errors.New("invalid rational denominator")
		}
		return numerator / denominator, nil
	}
	return strconv.ParseFloat(value, 64)
}

func ParseDurationMs(value string) (int64, error) {
	seconds, err := strconv.ParseFloat(value, 64)
	if err != nil || seconds < 0 {
		return 0, errors.New("invalid media duration")
	}
	return int64(seconds * 1000), nil
}
