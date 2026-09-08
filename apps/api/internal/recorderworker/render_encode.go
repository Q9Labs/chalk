package recorderworker

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"os/exec"
	"strconv"
	"time"
)

type VideoEncoder string

const (
	EncoderLibX264      VideoEncoder = "libx264"
	EncoderVideoToolbox VideoEncoder = "h264_videotoolbox"
	EncoderNVENC        VideoEncoder = "h264_nvenc"
)

type RecordingEncodeConfig struct {
	Width      int
	Height     int
	FPS        int
	DurationMs int64
	Encoder    VideoEncoder
}

type RecordingEncodePlan struct {
	AudioInput      string       `json:"audio_input"`
	Output          string       `json:"output"`
	Width           int          `json:"width"`
	Height          int          `json:"height"`
	FPS             int          `json:"fps"`
	FrameCount      int64        `json:"frame_count"`
	SourceDuration  int64        `json:"source_duration_ms"`
	OutputDuration  int64        `json:"output_duration_ms"`
	Encoder         VideoEncoder `json:"encoder"`
	HardwareEncoder bool         `json:"hardware_encoder"`
	Command         []string     `json:"command"`
}

type RecordingMediaExpectation struct {
	Width      int
	Height     int
	FPS        int
	FrameCount int64
	DurationMs int64
}

func BuildRecordingEncodePlan(audioInput, output string, config RecordingEncodeConfig) (RecordingEncodePlan, error) {
	if audioInput == "" || output == "" || config.Width <= 0 || config.Height <= 0 || config.FPS <= 0 || config.DurationMs <= 0 {
		return RecordingEncodePlan{}, errors.New("audio input, output, dimensions, frame rate, and duration are required")
	}
	if config.Width%2 != 0 || config.Height%2 != 0 || config.Width > 3840 || config.Height > 2160 || config.FPS > 60 {
		return RecordingEncodePlan{}, errors.New("recording dimensions and frame rate are unsupported")
	}
	encoderArgs, hardware, err := recordingEncoderArgs(config.Encoder)
	if err != nil {
		return RecordingEncodePlan{}, err
	}
	if config.DurationMs > (math.MaxInt64-999)/int64(config.FPS) {
		return RecordingEncodePlan{}, errors.New("recording duration exceeds the supported frame count")
	}
	frameCount := (config.DurationMs*int64(config.FPS) + 999) / 1000
	if frameCount <= 0 || frameCount > math.MaxInt32 {
		return RecordingEncodePlan{}, errors.New("recording frame count is unsupported")
	}
	outputSeconds := float64(frameCount) / float64(config.FPS)
	outputDurationMs := int64(math.Ceil(outputSeconds * 1000))
	videoFilter := fmt.Sprintf("setpts=N/(%d*TB),scale=%d:%d:flags=lanczos,format=yuv420p", config.FPS, config.Width, config.Height)
	audioFilter := fmt.Sprintf("asetpts=PTS-STARTPTS,aresample=48000:async=1:first_pts=0,apad,atrim=end=%.6f", outputSeconds)
	args := []string{
		"ffmpeg", "-hide_banner", "-nostdin", "-y", "-loglevel", "error",
		"-f", "image2pipe", "-framerate", strconv.Itoa(config.FPS), "-vcodec", "png", "-i", "pipe:0",
		"-i", audioInput,
		"-map", "0:v:0", "-map", "1:a:0",
		"-vf", videoFilter, "-af", audioFilter,
		// setpts can erase the filter output rate; CFR alone otherwise defaults to 25 fps.
		"-frames:v", strconv.FormatInt(frameCount, 10), "-r", strconv.Itoa(config.FPS), "-fps_mode", "cfr",
		"-c:v", string(config.Encoder),
	}
	args = append(args, encoderArgs...)
	args = append(args,
		"-b:v", "2M", "-maxrate", "3M", "-bufsize", "4M", "-pix_fmt", "yuv420p", "-tag:v", "avc1",
		"-c:a", "aac", "-profile:a", "aac_low", "-b:a", "128k", "-ar", "48000", "-ac", "2",
		"-movflags", "+faststart", output,
	)
	return RecordingEncodePlan{
		AudioInput: audioInput, Output: output, Width: config.Width, Height: config.Height, FPS: config.FPS,
		FrameCount: frameCount, SourceDuration: config.DurationMs, OutputDuration: outputDurationMs,
		Encoder: config.Encoder, HardwareEncoder: hardware, Command: args,
	}, nil
}

func VerifyRecordingMedia(ctx context.Context, runner CommandRunner, path string, expected RecordingMediaExpectation) (MediaFacts, error) {
	if runner == nil || path == "" || expected.Width <= 0 || expected.Height <= 0 || expected.FPS <= 0 || expected.FrameCount <= 0 || expected.DurationMs <= 0 {
		return MediaFacts{}, errors.New("ffprobe runner, media path, and expected recording facts are required")
	}
	output, err := runner.Run(ctx, "ffprobe", "-v", "error", "-print_format", "json", "-show_streams", "-show_format", path)
	if err != nil {
		return MediaFacts{}, fmt.Errorf("ffprobe recording: %w: %s", err, string(output))
	}
	var facts MediaFacts
	if err := json.Unmarshal(output, &facts); err != nil {
		return MediaFacts{}, fmt.Errorf("decode recording ffprobe output: %w", err)
	}
	if err := validateRecordingMedia(facts, expected); err != nil {
		return MediaFacts{}, err
	}
	return facts, nil
}

func validateRecordingMedia(facts MediaFacts, expected RecordingMediaExpectation) error {
	var video *MediaStream
	var audio *MediaStream
	for index := range facts.Streams {
		stream := &facts.Streams[index]
		switch stream.CodecType {
		case "video":
			if video != nil {
				return errors.New("recording contains more than one video stream")
			}
			video = stream
		case "audio":
			if audio != nil {
				return errors.New("recording contains more than one audio stream")
			}
			audio = stream
		}
	}
	if video == nil || audio == nil || !isMP4Format(facts.Format.FormatName) {
		return errors.New("recording must contain one video stream, one audio stream, and an MP4 container")
	}
	frameRate, frameRateErr := parseRational(video.FrameRate)
	if video.CodecName != "h264" || video.Width != expected.Width || video.Height != expected.Height || video.PixelFormat != "yuv420p" || frameRateErr != nil || math.Abs(frameRate-float64(expected.FPS)) > 0.01 {
		return fmt.Errorf("recording video is not %dx%d H.264 yuv420p at %dfps", expected.Width, expected.Height, expected.FPS)
	}
	if video.FrameCount != "" {
		frameCount, err := strconv.ParseInt(video.FrameCount, 10, 64)
		if err != nil || frameCount != expected.FrameCount {
			return fmt.Errorf("recording video frame count %q differs from expected %d", video.FrameCount, expected.FrameCount)
		}
	}
	sampleRate, sampleRateErr := strconv.Atoi(audio.SampleRate)
	if audio.CodecName != "aac" || audio.Profile != "LC" || sampleRateErr != nil || sampleRate != 48_000 || audio.Channels != 2 {
		return errors.New("recording audio is not stereo AAC-LC at 48kHz")
	}
	formatDuration, durationErr := ParseDurationMs(facts.Format.Duration)
	toleranceMs := int64(math.Ceil(1000/float64(expected.FPS))) + 10
	if durationErr != nil || absoluteInt64(formatDuration-expected.DurationMs) > toleranceMs {
		return fmt.Errorf("recording duration %dms differs from expected %dms", formatDuration, expected.DurationMs)
	}
	videoStart, videoStartErr := mediaTimeMilliseconds(video.StartTime)
	audioStart, audioStartErr := mediaTimeMilliseconds(audio.StartTime)
	formatStart, formatStartErr := mediaTimeMilliseconds(facts.Format.StartTime)
	if videoStartErr != nil || audioStartErr != nil || formatStartErr != nil || absoluteInt64(videoStart-audioStart) > toleranceMs || absoluteInt64(formatStart) > toleranceMs {
		return fmt.Errorf("recording stream start times are not synchronized: video=%q audio=%q format=%q", video.StartTime, audio.StartTime, facts.Format.StartTime)
	}
	return nil
}

func isMP4Format(value string) bool {
	for _, name := range []string{"mov", "mp4", "m4a", "3gp", "3g2", "mj2"} {
		if containsFormatName(value, name) {
			return true
		}
	}
	return false
}

func containsFormatName(value, expected string) bool {
	start := 0
	for start <= len(value) {
		end := start
		for end < len(value) && value[end] != ',' {
			end++
		}
		if value[start:end] == expected {
			return true
		}
		start = end + 1
	}
	return false
}

func mediaTimeMilliseconds(value string) (int64, error) {
	if value == "" {
		return 0, nil
	}
	return ParseDurationMs(value)
}

func absoluteInt64(value int64) int64 {
	if value < 0 {
		return -value
	}
	return value
}

func ProbeVideoEncoder(ctx context.Context, runner CommandRunner, encoder VideoEncoder) error {
	if runner == nil {
		return errors.New("encoder probe runner is required")
	}
	encoderArgs, _, err := recordingEncoderArgs(encoder)
	if err != nil {
		return err
	}
	// NVENC rejects frames below its hardware minimum even when full-size encoding works.
	args := []string{"-hide_banner", "-nostdin", "-loglevel", "error", "-f", "lavfi", "-i", "color=black:size=192x108:rate=1", "-frames:v", "1", "-c:v", string(encoder)}
	args = append(args, encoderArgs...)
	args = append(args, "-f", "null", "-")
	if output, err := runner.Run(ctx, "ffmpeg", args...); err != nil {
		return fmt.Errorf("probe recording encoder %s: %w: %s", encoder, err, string(output))
	}
	return nil
}

func recordingEncoderArgs(encoder VideoEncoder) ([]string, bool, error) {
	switch encoder {
	case EncoderLibX264:
		return []string{"-preset", "medium", "-profile:v", "high"}, false, nil
	case EncoderVideoToolbox:
		return []string{"-allow_sw", "0", "-realtime", "0", "-profile:v", "high"}, true, nil
	case EncoderNVENC:
		return []string{"-preset", "p4", "-profile:v", "high"}, true, nil
	default:
		return nil, false, fmt.Errorf("unsupported recording encoder %q", encoder)
	}
}

type StreamingCommandRunner interface {
	RunStreaming(context.Context, io.Reader, string, ...string) ([]byte, error)
}

func (ExecCommandRunner) RunStreaming(ctx context.Context, input io.Reader, name string, args ...string) ([]byte, error) {
	command := exec.CommandContext(ctx, name, args...)
	command.Stdin = input
	return command.CombinedOutput()
}

func EncodeRecordingFrames(ctx context.Context, runner StreamingCommandRunner, plan RecordingEncodePlan, frames io.Reader) (time.Duration, error) {
	if runner == nil || frames == nil || len(plan.Command) < 2 {
		return 0, errors.New("streaming encoder runner, frame source, and command are required")
	}
	started := time.Now()
	output, err := runner.RunStreaming(ctx, frames, plan.Command[0], plan.Command[1:]...)
	duration := time.Since(started)
	if err != nil {
		return duration, fmt.Errorf("encode recording frames with %s: %w: %s", plan.Encoder, err, string(output))
	}
	return duration, nil
}
