package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/mtls"
	"github.com/q9labs/chalk/apps/api/internal/recorderworker"
)

type renderWorkerConfig struct {
	Environment       string
	ControlPlaneURL   string
	WorkerCertificate string
	WorkerKey         string
	ServerCA          string
	ServerName        string
	WorkRoot          string
	NodePath          string
	RendererScript    string
	UIBuildRegistry   string
	FFmpegPath        string
	FFprobePath       string
	Encoder           string
	FrameConcurrency  int
	ExportRenderer    string
	ComposeThreads    string
}

func runWorker(config renderWorkerConfig) error {
	renderer, threads, err := parseExportRenderer(config.ExportRenderer, config.ComposeThreads)
	if err != nil {
		return err
	}
	if config.FrameConcurrency < 1 || config.FrameConcurrency > 8 {
		return errors.New("--frame-concurrency must be between 1 and 8")
	}
	config.Environment = strings.TrimSpace(config.Environment)
	if config.Environment == "" {
		return errors.New("--environment or CHALK_RECORDER_ENVIRONMENT is required")
	}
	base, err := renderControlPlaneURL(config.ControlPlaneURL)
	if err != nil {
		return err
	}
	controlTransport, err := mtls.NewReloadingClientTransport(config.WorkerCertificate, config.WorkerKey, config.ServerCA, config.ServerName)
	if err != nil {
		return fmt.Errorf("load recorder render worker mTLS config: %w", err)
	}
	workRoot, err := existingRenderDirectory(config.WorkRoot, "render work root")
	if err != nil {
		return err
	}
	nodePath, err := renderExecutable(config.NodePath, "node")
	if err != nil {
		return err
	}
	rendererScript, err := existingRenderFile(config.RendererScript, "recording renderer script")
	if err != nil {
		return err
	}
	uiBuildRegistry, err := recorderworker.LoadUIBuildRegistry(strings.TrimSpace(config.UIBuildRegistry))
	if err != nil {
		return fmt.Errorf("load recording UI build registry: %w", err)
	}
	ffmpegPath, err := renderExecutable(config.FFmpegPath, "ffmpeg")
	if err != nil {
		return err
	}
	ffprobePath, err := renderExecutable(config.FFprobePath, "ffprobe")
	if err != nil {
		return err
	}
	encoder := recorderworker.VideoEncoder(strings.TrimSpace(config.Encoder))
	var frames recorderworker.FrameProducer
	var compose recorderworker.ComposeProducer
	if renderer == "native" {
		if encoder != recorderworker.EncoderLibX264 && encoder != recorderworker.EncoderVideoToolbox {
			return errors.New("native Export renderer requires libx264 or h264_videotoolbox")
		}
		composeScript, err := existingRenderFile(filepath.Join(filepath.Dir(rendererScript), "compose.js"), "recording compositor script")
		if err != nil {
			return err
		}
		compose = recorderworker.NodeComposeProducer{NodePath: nodePath, ScriptPath: composeScript, FFmpegPath: ffmpegPath, Encoder: encoder, Threads: threads}
	} else {
		frames = recorderworker.NodeFrameProducer{NodePath: nodePath, ScriptPath: rendererScript, Concurrency: config.FrameConcurrency}
	}

	controlHTTP := &http.Client{Transport: controlTransport, Timeout: 30 * time.Second}
	objectHTTP := &http.Client{Transport: &http.Transport{
		Proxy: http.ProxyFromEnvironment, ForceAttemptHTTP2: true, MaxIdleConns: 8, MaxIdleConnsPerHost: 4, IdleConnTimeout: time.Minute,
		ResponseHeaderTimeout: 30 * time.Second, TLSClientConfig: nil,
	}, CheckRedirect: func(_ *http.Request, _ []*http.Request) error { return http.ErrUseLastResponse }}
	control, err := recorderworker.NewControlPlaneClientWithURLAndUploader(base, controlHTTP, objectHTTP)
	if err != nil {
		return fmt.Errorf("create recorder render control-plane client: %w", err)
	}
	commands := renderMediaCommands{ffmpeg: ffmpegPath, ffprobe: ffprobePath}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	if err := recorderworker.ProbeVideoEncoder(ctx, commands, encoder); err != nil {
		return err
	}
	factory, err := recorderworker.NewProductionRenderAttemptFactory(recorderworker.ProductionRenderAttemptConfig{
		Control: control, WorkRoot: workRoot, Environment: config.Environment, UIBuildRegistry: uiBuildRegistry,
		FFmpegPath: ffmpegPath, Encoder: encoder, Frames: frames, Compose: compose,
		Commands: commands, Streaming: commands,
	})
	if err != nil {
		return fmt.Errorf("create production recording render factory: %w", err)
	}
	daemon, err := recorderworker.NewRenderDaemon(control, factory, recorderworker.RenderDaemonConfig{})
	if err != nil {
		return fmt.Errorf("create recorder render daemon: %w", err)
	}
	reporter, err := recorderworker.NewReadinessReporter(control)
	if err != nil {
		return fmt.Errorf("create recorder render readiness reporter: %w", err)
	}
	return reporter.Run(ctx, daemon)
}

func parseExportRenderer(rawRenderer, rawThreads string) (string, int, error) {
	renderer := strings.TrimSpace(rawRenderer)
	if renderer == "" {
		renderer = "browser"
	}
	if renderer != "browser" && renderer != "native" {
		return "", 0, errors.New("CHALK_RECORDER_EXPORT_RENDERER must be browser or native")
	}
	threads := 2
	if strings.TrimSpace(rawThreads) != "" {
		var err error
		threads, err = strconv.Atoi(strings.TrimSpace(rawThreads))
		if err != nil {
			return "", 0, fmt.Errorf("CHALK_RECORDING_COMPOSE_THREADS: %w", err)
		}
	}
	if threads < 1 || threads > 64 {
		return "", 0, errors.New("CHALK_RECORDING_COMPOSE_THREADS must be between 1 and 64")
	}
	return renderer, threads, nil
}

type renderMediaCommands struct {
	ffmpeg  string
	ffprobe string
}

func (runner renderMediaCommands) Run(ctx context.Context, name string, args ...string) ([]byte, error) {
	resolved, err := runner.resolve(name)
	if err != nil {
		return nil, err
	}
	return exec.CommandContext(ctx, resolved, args...).CombinedOutput()
}

func (runner renderMediaCommands) RunStreaming(ctx context.Context, input io.Reader, name string, args ...string) ([]byte, error) {
	resolved, err := runner.resolve(name)
	if err != nil {
		return nil, err
	}
	command := exec.CommandContext(ctx, resolved, args...)
	command.Stdin = input
	return command.CombinedOutput()
}

func (runner renderMediaCommands) resolve(name string) (string, error) {
	switch name {
	case "ffmpeg":
		return runner.ffmpeg, nil
	case "ffprobe":
		return runner.ffprobe, nil
	default:
		return "", fmt.Errorf("unsupported recording media command %q", name)
	}
}

func renderControlPlaneURL(raw string) (*url.URL, error) {
	parsed, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || parsed.Scheme != "https" || parsed.Host == "" || parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" {
		return nil, errors.New("--control-plane-url must be an HTTPS origin without credentials, query, or fragment")
	}
	parsed.Path = strings.TrimRight(parsed.Path, "/")
	parsed.RawPath = ""
	return parsed, nil
}

func existingRenderDirectory(raw, label string) (string, error) {
	path := strings.TrimSpace(raw)
	if !filepath.IsAbs(path) {
		return "", fmt.Errorf("%s must be absolute", label)
	}
	info, err := os.Stat(path)
	if err != nil || !info.IsDir() {
		return "", fmt.Errorf("%s is unavailable", label)
	}
	return filepath.Clean(path), nil
}

func existingRenderFile(raw, label string) (string, error) {
	path := strings.TrimSpace(raw)
	if !filepath.IsAbs(path) {
		return "", fmt.Errorf("%s must be absolute", label)
	}
	info, err := os.Stat(path)
	if err != nil || !info.Mode().IsRegular() {
		return "", fmt.Errorf("%s is unavailable", label)
	}
	return filepath.Clean(path), nil
}

func renderExecutable(raw, fallback string) (string, error) {
	path := strings.TrimSpace(raw)
	if path == "" {
		var err error
		path, err = exec.LookPath(fallback)
		if err != nil {
			return "", fmt.Errorf("locate %s: %w", fallback, err)
		}
	}
	absolute, err := filepath.Abs(path)
	if err != nil {
		return "", fmt.Errorf("resolve %s executable: %w", fallback, err)
	}
	return existingRenderFile(absolute, fallback+" executable")
}

var _ recorderworker.CommandRunner = renderMediaCommands{}
var _ recorderworker.StreamingCommandRunner = renderMediaCommands{}
